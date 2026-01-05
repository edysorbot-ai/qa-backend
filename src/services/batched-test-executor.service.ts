/**
 * Batched Test Executor Service
 * 
 * Executes multiple test cases in a single voice call.
 * The test caller will cover all test scenarios within one conversation.
 */

import WebSocket from 'ws';
import OpenAI from 'openai';
import { 
  CallBatch, 
  SmartTestCase,
  TestResultAnalysis,
  smartTestCaseGeneratorService,
} from './smart-testcase-generator.service';
import { TTSService } from './tts.service';
import { promptSuggestionService } from './prompt-suggestion.service';
import { PromptSuggestion } from '../models/testResult.model';
import { vapiProvider } from '../providers/vapi.provider';
import { retellProvider } from '../providers/retell.provider';
import { haptikProvider } from '../providers/haptik.provider';
import { twilioCallerService } from './twilio-caller.service';

interface BatchTestResult {
  testCaseId: string;
  testCaseName: string;
  passed: boolean;
  score: number;
  actualResponse: string;
  metrics: Record<string, any>;
  turnsCovered: number[];
  promptSuggestions?: PromptSuggestion[];
}

interface BatchExecutionResult {
  results: BatchTestResult[];
  transcript: ConversationTurn[];
  totalTurns: number;
  durationMs: number;
  audioBuffer?: Buffer;
}

interface ConversationTurn {
  role: 'test_caller' | 'ai_agent';
  content: string;
  timestamp: number;
  testCaseId?: string;
}

/**
 * Helper to concatenate MP3 files properly
 * Strips ID3v2 headers from subsequent files to create valid concatenated MP3
 */
function concatenateMP3Buffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];
  
  const processedBuffers: Buffer[] = [];
  
  for (let i = 0; i < buffers.length; i++) {
    let buffer = buffers[i];
    
    // For files after the first one, skip the ID3v2 header if present
    // ID3v2 header starts with "ID3" (0x49 0x44 0x33)
    if (i > 0 && buffer.length > 10 && 
        buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      // Calculate ID3v2 header size
      // Size is stored in bytes 6-9 as syncsafe integer
      const size = ((buffer[6] & 0x7F) << 21) |
                   ((buffer[7] & 0x7F) << 14) |
                   ((buffer[8] & 0x7F) << 7) |
                   (buffer[9] & 0x7F);
      const headerSize = 10 + size;
      
      // Skip the ID3v2 header
      if (headerSize < buffer.length) {
        buffer = buffer.slice(headerSize);
      }
    }
    
    processedBuffers.push(buffer);
  }
  
  return Buffer.concat(processedBuffers);
}

/**
 * Interleave two sets of audio buffers (user and agent)
 * Creates a combined audio track with proper sequencing
 */
function interleaveAudioBuffers(
  agentBuffers: Buffer[],
  userBuffers: Buffer[]
): Buffer {
  const combined: Buffer[] = [];
  const maxLen = Math.max(agentBuffers.length, userBuffers.length);
  
  // Create small silence gap between turns (100ms at 128kbps MP3 ≈ 1.6KB)
  // Actually, let's not add silence since the MP3 files already have natural pauses
  
  for (let i = 0; i < maxLen; i++) {
    // Agent speaks first (starting message), then alternates
    if (i < agentBuffers.length && i === 0) {
      combined.push(agentBuffers[i]);
    }
    if (i < userBuffers.length) {
      combined.push(userBuffers[i]);
    }
    if (i < agentBuffers.length && i > 0) {
      combined.push(agentBuffers[i]);
    }
  }
  
  return concatenateMP3Buffers(combined);
}

export class BatchedTestExecutorService {
  private openai: OpenAI;
  private elevenLabsApiKey: string;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || '';
  }

  /**
   * Execute a batch of test cases in a single call
   */
  async executeBatch(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    agentPrompt: string
  ): Promise<BatchExecutionResult> {
    console.log(`[BatchedExecutor] Starting batch: ${batch.name}`);
    console.log(`[BatchedExecutor] Test cases: ${batch.testCases.map(tc => tc.name).join(', ')}`);
    console.log(`[BatchedExecutor] TestMode: ${batch.testMode || 'voice (default)'}`);
    
    const startTime = Date.now();
    const transcript: ConversationTurn[] = [];
    const audioChunks: Buffer[] = [];
    const testCaseResults = new Map<string, BatchTestResult>();
    
    // Initialize results for all test cases
    batch.testCases.forEach(tc => {
      testCaseResults.set(tc.id, {
        testCaseId: tc.id,
        testCaseName: tc.name,
        passed: false,
        score: 0,
        actualResponse: '',
        metrics: {},
        turnsCovered: [],
      });
    });
    
    // Execute the conversation
    const conversationResult = await this.executeConversation(
      batch,
      agentConfig,
      transcript,
      audioChunks
    );
    
    console.log(`[BatchedExecutor] After executeConversation: ${transcript.length} turns, provider: ${agentConfig.provider}`);
    console.log(`[BatchedExecutor] Transcript preview:`, transcript.slice(0, 3).map(t => ({ role: t.role, content: t.content.substring(0, 50) })));
    
    // Analyze the conversation against each test case
    const results = await this.analyzeTranscriptForTestCases(
      transcript,
      batch.testCases,
      agentPrompt
    );
    
    const durationMs = Date.now() - startTime;
    
    // Combine audio chunks into a single buffer (using proper MP3 concatenation)
    const audioBuffer = audioChunks.length > 0 ? concatenateMP3Buffers(audioChunks) : undefined;
    console.log(`[BatchedExecutor] Audio chunks: ${audioChunks.length}, total size: ${audioBuffer?.length || 0} bytes`);
    
    return {
      results,
      transcript,
      totalTurns: transcript.length,
      durationMs,
      audioBuffer,
    };
  }

  /**
   * Execute a multi-test-case conversation
   * Routes to provider-specific implementations based on test mode (chat vs voice)
   */
  private async executeConversation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[],
    userAudioChunks: Buffer[] = [] // Track user audio separately
  ): Promise<{ success: boolean; error?: string }> {
    const testMode = batch.testMode || 'voice'; // Default to voice for backward compatibility
    console.log(`[BatchedExecutor] Routing conversation for provider: ${agentConfig.provider}, testMode: ${testMode}`);
    
    // If testMode is 'chat', use chat-based testing for cost efficiency
    if (testMode === 'chat') {
      return this.executeChatBasedTest(batch, agentConfig, transcript);
    }
    
    // Otherwise, use voice-based testing (original implementation)
    return this.executeVoiceBasedTest(batch, agentConfig, transcript, audioChunks, userAudioChunks);
  }

  /**
   * Execute chat-based test for cost efficiency
   * Routes to provider-specific chat API implementations
   */
  private async executeChatBasedTest(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    console.log(`[BatchedExecutor] Starting chat-based test for batch: ${batch.name}`);
    console.log(`[BatchedExecutor] Provider: ${agentConfig.provider}, Test cases: ${batch.testCases.length}`);
    console.log(`[BatchedExecutor] Transcript array reference before execution:`, transcript.length);

    let result: { success: boolean; error?: string };

    // Route to provider-specific chat implementations
    switch (agentConfig.provider.toLowerCase()) {
      case 'vapi':
        result = await this.executeVAPIChatAPI(batch, agentConfig, transcript);
        break;
      
      case 'elevenlabs':
        result = await this.executeElevenLabsChatAPI(batch, agentConfig, transcript);
        break;
      
      case 'retell':
        // Retell: Use chat simulation (Retell doesn't have a text API)
        result = await this.executeRetellChatSimulation(batch, agentConfig, transcript);
        break;
      
      case 'haptik':
        result = await this.executeHaptikMessageAPI(batch, agentConfig, transcript);
        break;
      
      case 'custom':
        result = await this.executeCustomAgentChatAPI(batch, agentConfig, transcript);
        break;
      
      default:
        console.log(`[BatchedExecutor] Unknown provider ${agentConfig.provider}, falling back to voice`);
        result = await this.executeVoiceBasedTest(batch, agentConfig, transcript, [], []);
    }

    console.log(`[BatchedExecutor] Chat-based test completed for ${batch.name}`);
    console.log(`[BatchedExecutor] Transcript array after execution: ${transcript.length} turns`);
    if (transcript.length > 0) {
      console.log(`[BatchedExecutor] First few turns:`, transcript.slice(0, 3).map(t => ({ role: t.role, content: t.content.substring(0, 50) })));
    } else {
      console.log(`[BatchedExecutor] WARNING: Transcript is EMPTY after chat execution!`);
    }

    return result;
  }

  /**
   * Execute voice-based test (original implementation)
   * Routes to provider-specific voice API implementations
   */
  private async executeVoiceBasedTest(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[],
    userAudioChunks: Buffer[] = []
  ): Promise<{ success: boolean; error?: string }> {
    console.log(`[BatchedExecutor] Starting voice-based test for batch: ${batch.name}`);
    
    // Route to provider-specific voice testing implementations
    switch (agentConfig.provider.toLowerCase()) {
      case 'vapi':
        // VAPI: Use Twilio phone call for real voice testing (1st preference)
        // Falls back to Voice Simulation if Twilio not configured or no phone number
        if (twilioCallerService.isConfigured() && agentConfig.phoneNumber) {
          return this.executeTwilioPhoneCall(batch, agentConfig, transcript, audioChunks);
        }
        console.log(`[BatchedExecutor] VAPI: Twilio not configured or no phone number, using Voice Simulation`);
        return this.executeVAPIVoiceSimulation(batch, agentConfig, transcript, audioChunks, userAudioChunks);
      
      case 'haptik':
        // Haptik: Use Twilio phone call for real voice testing (1st preference)
        // Falls back to Message API if Twilio not configured or no phone number
        if (twilioCallerService.isConfigured() && agentConfig.phoneNumber) {
          return this.executeTwilioPhoneCall(batch, agentConfig, transcript, audioChunks);
        }
        console.log(`[BatchedExecutor] Haptik: Twilio not configured or no phone number, falling back to Message API`);
        return this.executeHaptikMessageAPI(batch, agentConfig, transcript);
      
      case 'retell':
        // Retell: Use voice simulation (Retell Web Call API has issues)
        // Fetches agent config and simulates with TTS + LLM
        return this.executeRetellVoiceSimulation(batch, agentConfig, transcript, audioChunks, userAudioChunks);
      
      case 'custom':
        // Custom Agent: Simulated voice call using STT + LLM + TTS on both sides
        return this.executeCustomAgentVoiceSimulation(batch, agentConfig, transcript, audioChunks, userAudioChunks);
      
      case 'elevenlabs':
      default:
        // ElevenLabs: Use native WebSocket (existing implementation)
        return this.executeElevenLabsVoiceCall(batch, agentConfig, transcript, audioChunks);
    }
  }

  /**
   * Execute test using Twilio phone call
   * Makes a real phone call to the agent's phone number
   * Used for VAPI and Haptik testing
   */
  private async executeTwilioPhoneCall(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Twilio phone call for ${agentConfig.provider}`);
      console.log(`[BatchedExecutor] Calling phone number: ${agentConfig.phoneNumber}`);

      if (!agentConfig.phoneNumber) {
        return { success: false, error: 'No phone number configured for agent' };
      }

      // Build test caller system prompt
      const systemPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      
      // Convert test cases to scenarios format
      const scenarios = batch.testCases.map(tc => ({
        id: tc.id,
        name: tc.name,
        scenario: tc.scenario,
        userInput: tc.userInput,
      }));

      // Make the phone call
      const result = await twilioCallerService.makeTestCall(
        agentConfig.phoneNumber,
        scenarios,
        systemPrompt
      );

      if (!result.success) {
        console.error(`[BatchedExecutor] Twilio call failed: ${result.error}`);
        return { success: false, error: result.error };
      }

      console.log(`[BatchedExecutor] Twilio call completed: ${result.callSid}`);
      console.log(`[BatchedExecutor] Call duration: ${result.durationMs}ms`);

      // Convert Twilio transcript to our format
      for (const turn of result.transcript) {
        transcript.push({
          role: turn.role,
          content: turn.content,
          timestamp: turn.timestamp,
        });
      }

      // If we got a recording, we could download it and add to audioChunks
      if (result.recordingUrl) {
        console.log(`[BatchedExecutor] Recording available: ${result.recordingUrl}`);
      }

      console.log(`[BatchedExecutor] Twilio call completed with ${transcript.length} turns`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Twilio phone call error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute ElevenLabs voice call using native WebSocket
   * This is the original implementation - voice-based testing
   */
  private async executeElevenLabsVoiceCall(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise(async (resolve) => {
      const effectiveApiKey = this.elevenLabsApiKey || agentConfig.apiKey;
      const ttsService = new TTSService(effectiveApiKey);
      
      // Build the multi-scenario test caller prompt
      const systemPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];
      
      let turnCount = 0;
      // Allow more turns for natural conversation flow - at least 20 turns or 4 per test case
      const minTurns = Math.max(20, batch.testCases.length * 4);
      const maxTurns = Math.min(minTurns + 10, 60);
      let currentAgentResponse = '';
      let conversationComplete = false;
      let isProcessingResponse = false;
      let expectedInputFormat = 'ulaw_8000';
      let currentTestCaseIndex = 0;
      let testedCases = new Set<string>();
      let lastActivity = Date.now();
      
      console.log(`[BatchedExecutor] Config: minTurns=${minTurns}, maxTurns=${maxTurns}, testCases=${batch.testCases.length}`);
      
      try {
        // Get signed URL for WebSocket
        const signedUrlResponse = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentConfig.agentId}`,
          {
            method: 'GET',
            headers: { 'xi-api-key': effectiveApiKey },
          }
        );

        if (!signedUrlResponse.ok) {
          throw new Error(`Failed to get signed URL: ${await signedUrlResponse.text()}`);
        }

        const { signed_url } = await signedUrlResponse.json() as { signed_url: string };
        const ws = new WebSocket(signed_url);

        const timeout = setTimeout(() => {
          conversationComplete = true;
          ws.close();
        }, 300000); // 5 minute timeout

        let silenceTimer: NodeJS.Timeout | null = null;
        let agentResponseTimer: NodeJS.Timeout | null = null;
        
        // Send keepalive audio every 5 seconds to prevent timeout
        const keepaliveInterval = setInterval(() => {
          if (!conversationComplete && ws.readyState === WebSocket.OPEN) {
            try {
              // Send minimal silence to keep connection alive
              ws.send(JSON.stringify({ user_audio_chunk: Buffer.alloc(160, 0xFF).toString('base64') }));
            } catch (e) {
              // Ignore errors
            }
          }
        }, 5000);

        const processAgentTurn = async () => {
          if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) {
            console.log(`[BatchedExecutor] processAgentTurn skipped: isProcessing=${isProcessingResponse}, hasResponse=${!!currentAgentResponse.trim()}, complete=${conversationComplete}`);
            return;
          }
          isProcessingResponse = true;
          
          turnCount++;
          const agentMessage = currentAgentResponse.trim();
          console.log(`[BatchedExecutor] Agent (turn ${turnCount}): ${agentMessage.substring(0, 150)}...`);
          
          transcript.push({
            role: 'ai_agent',
            content: agentMessage,
            timestamp: Date.now(),
          });
          
          conversationHistory.push({ role: 'user', content: agentMessage });
          
          // Check if we should end
          const shouldEnd = this.shouldEndBatchConversation(agentMessage, turnCount, testedCases.size, batch.testCases.length);
          console.log(`[BatchedExecutor] Should end check: turnCount=${turnCount}, maxTurns=${maxTurns}, testedCases=${testedCases.size}/${batch.testCases.length}, shouldEnd=${shouldEnd}`);
          
          if (turnCount >= maxTurns || shouldEnd) {
            conversationComplete = true;
            console.log(`[BatchedExecutor] Ending conversation: turnCount=${turnCount} >= maxTurns=${maxTurns} || shouldEnd=${shouldEnd}`);
            
            // Send goodbye
            const goodbye = "Thank you so much for all this information! You've been very helpful. Goodbye!";
            transcript.push({ role: 'test_caller', content: goodbye, timestamp: Date.now() });
            
            try {
              const ttsResult = await ttsService.generateSpeechUlaw({ text: goodbye });
              // Add test caller audio to recording
              audioChunks.push(ttsResult.audioBuffer);
              await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] TTS error for goodbye:', e);
            }
            
            setTimeout(() => ws.close(), 3000);
          } else {
            // Generate response covering remaining test cases
            const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
            const response = await this.generateBatchTestCallerResponse(
              conversationHistory,
              remainingCases,
              currentTestCaseIndex
            );
            
            if (response.testCaseId) {
              testedCases.add(response.testCaseId);
              currentTestCaseIndex++;
            }
            
            console.log(`[BatchedExecutor] Test Caller (turn ${turnCount}): ${response.text}`);
            
            transcript.push({
              role: 'test_caller',
              content: response.text,
              timestamp: Date.now(),
              testCaseId: response.testCaseId,
            });
            
            conversationHistory.push({ role: 'assistant', content: response.text });
            
            // Send audio
            try {
              const ttsResult = await ttsService.generateSpeechUlaw({ text: response.text });
              // Add test caller audio to recording
              audioChunks.push(ttsResult.audioBuffer);
              await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
              
              // Set response timer
              if (agentResponseTimer) clearTimeout(agentResponseTimer);
              agentResponseTimer = setTimeout(() => {
                if (!conversationComplete && !currentAgentResponse.trim()) {
                  console.log(`[BatchedExecutor] Agent not responding, ending conversation`);
                  conversationComplete = true;
                  ws.close();
                }
              }, 30000);
            } catch (e) {
              console.error('[BatchedExecutor] TTS error:', e);
            }
          }
          
          currentAgentResponse = '';
          isProcessingResponse = false;
        };

        ws.on('open', () => {
          console.log(`[BatchedExecutor] WebSocket connected`);
        });

        ws.on('message', async (data: Buffer) => {
          lastActivity = Date.now();
          try {
            const message = JSON.parse(data.toString());
            
            // Log all message types for debugging
            console.log(`[BatchedExecutor] Received message type: ${message.type}`);
            
            switch (message.type) {
              case 'conversation_initiation_metadata':
                expectedInputFormat = message.conversation_initiation_metadata_event?.user_input_audio_format || 'ulaw_8000';
                console.log(`[BatchedExecutor] Conversation started, format: ${expectedInputFormat}`);
                
                // Send initial greeting after a short delay
                setTimeout(async () => {
                  try {
                    const greeting = "Hello?";
                    const ttsResult = await ttsService.generateSpeechUlaw({ text: greeting });
                    // Add test caller audio to recording
                    audioChunks.push(ttsResult.audioBuffer);
                    await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
                  } catch (e) {
                    console.error('[BatchedExecutor] Error sending greeting:', e);
                  }
                }, 2000);
                break;
                
              case 'agent_response':
                if (agentResponseTimer) clearTimeout(agentResponseTimer);
                
                const agentText = message.agent_response_event?.agent_response || message.agent_response || '';
                if (agentText) {
                  currentAgentResponse += agentText + ' ';
                  
                  if (silenceTimer) clearTimeout(silenceTimer);
                  silenceTimer = setTimeout(() => {
                    if (currentAgentResponse.trim()) {
                      processAgentTurn();
                    }
                  }, 1500);
                }
                break;
                
              case 'ping':
                const pingEventId = message.ping_event?.event_id || message.event_id;
                ws.send(JSON.stringify({ type: 'pong', event_id: pingEventId }));
                break;
                
              case 'audio':
                // Audio event with base64 encoded audio
                if (message.audio_event?.audio_base_64) {
                  audioChunks.push(Buffer.from(message.audio_event.audio_base_64, 'base64'));
                }
                break;
              
              case 'error':
                console.error(`[BatchedExecutor] Received error from agent:`, message);
                break;
                
              case 'interruption':
                console.log(`[BatchedExecutor] Interruption event received`);
                break;
                
              case 'conversation_ended':
              case 'session_ended':
              case 'connection_closed':
                console.log(`[BatchedExecutor] Agent ended conversation: ${message.type}`);
                conversationComplete = true;
                break;
                
              default:
                // Log unknown message types to understand what's happening
                if (!['user_transcript', 'audio_event', 'internal_vad_score', 'internal_turn_probability', 'user_started_speaking'].includes(message.type)) {
                  console.log(`[BatchedExecutor] Unknown message type: ${message.type}`, JSON.stringify(message).substring(0, 200));
                }
            }
          } catch (e) {
            // Binary audio data - capture it
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });

        ws.on('close', (code, reason) => {
          clearTimeout(timeout);
          clearInterval(keepaliveInterval);
          if (silenceTimer) clearTimeout(silenceTimer);
          if (agentResponseTimer) clearTimeout(agentResponseTimer);
          const closeReason = reason ? reason.toString() : 'unknown';
          console.log(`[BatchedExecutor] WebSocket closed. Code: ${code}, Reason: ${closeReason}`);
          console.log(`[BatchedExecutor] Final stats: ${transcript.length} messages, turnCount=${turnCount}, testedCases=${testedCases.size}`);
          console.log(`[BatchedExecutor] Was conversation marked complete? ${conversationComplete}`);
          resolve({ success: true });
        });

        ws.on('error', (error) => {
          console.error('[BatchedExecutor] WebSocket error:', error);
          console.error('[BatchedExecutor] Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
          resolve({ success: false, error: error.message });
        });

      } catch (error) {
        console.error('[BatchedExecutor] Error:', error);
        resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  /**
   * Execute VAPI test using VAPI's native Chat API
   * This is VAPI's in-house text-based testing feature
   * @see https://docs.vapi.ai/api-reference/chats/create
   */
  private async executeVAPIChatAPI(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting VAPI Chat API test for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Assistant ID: ${agentConfig.agentId}`);

      // Step 1: Build test caller prompt to generate conversation
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      // Step 2: Generate test caller messages based on test cases
      const testedCases = new Set<string>();
      let previousChatId: string | undefined;
      let sessionId: string | undefined;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      // Initial greeting from test caller
      const initialGreeting = await this.generateBatchTestCallerResponse(
        testCallerHistory,
        batch.testCases,
        0
      );

      if (initialGreeting.text) {
        console.log(`[BatchedExecutor] Test caller greeting: ${initialGreeting.text.substring(0, 50)}...`);
        
        // Send to VAPI Chat API and get response
        const chatResponse = await vapiProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          initialGreeting.text,
          { sessionId, previousChatId }
        );

        if (!chatResponse) {
          return { success: false, error: 'Failed to get initial response from VAPI Chat API' };
        }

        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: initialGreeting.text,
          timestamp: Date.now(),
          testCaseId: initialGreeting.testCaseId,
        });

        // Track session for conversation continuity
        previousChatId = chatResponse.id;
        if (chatResponse.sessionId) {
          sessionId = chatResponse.sessionId;
        }

        // Add assistant responses to transcript
        console.log(`[BatchedExecutor] VAPI Chat API returned ${chatResponse.output.length} output messages`);
        if (chatResponse.output.length === 0) {
          console.log(`[BatchedExecutor] WARNING: No output messages from VAPI Chat API`);
          console.log(`[BatchedExecutor] Raw response keys:`, chatResponse.rawResponse ? Object.keys(chatResponse.rawResponse) : 'none');
        }
        
        for (const output of chatResponse.output) {
          console.log(`[BatchedExecutor] Processing output:`, JSON.stringify(output));
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
            console.log(`[BatchedExecutor] Added AI_AGENT message: ${output.message.substring(0, 80)}...`);
          }
        }

        if (initialGreeting.testCaseId) {
          testedCases.add(initialGreeting.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: initialGreeting.text });
        turnCount++;
      }

      // Step 3: Continue conversation until all test cases covered
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        // Generate next test caller response
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] VAPI Chat: Test caller ending conversation`);
          break;
        }

        console.log(`[BatchedExecutor] Test caller (turn ${turnCount}): ${testCallerResponse.text.substring(0, 80)}...`);

        // Send to VAPI Chat API
        const chatResponse = await vapiProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          testCallerResponse.text,
          { sessionId, previousChatId }
        );

        if (!chatResponse) {
          console.log(`[BatchedExecutor] VAPI Chat: No response from API, breaking...`);
          break;
        }

        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        // Update session tracking
        previousChatId = chatResponse.id;
        if (chatResponse.sessionId) {
          sessionId = chatResponse.sessionId;
        }

        // Add assistant responses to transcript
        console.log(`[BatchedExecutor] VAPI Chat returned ${chatResponse.output.length} output messages for turn ${turnCount}`);
        if (chatResponse.output.length === 0) {
          console.log(`[BatchedExecutor] WARNING: Empty output from VAPI for turn ${turnCount}`);
        }
        
        for (const output of chatResponse.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
            console.log(`[BatchedExecutor] VAPI response (turn ${turnCount}): ${output.message.substring(0, 80)}...`);
          }
        }

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        // Small delay between turns
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`[BatchedExecutor] VAPI Chat API test completed: ${transcript.length} total turns, ${testedCases.size}/${batch.testCases.length} scenarios tested`);
      console.log(`[BatchedExecutor] Final transcript roles:`, transcript.map(t => t.role));
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] VAPI Chat API error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute ElevenLabs test using Chat API
   * Text-based testing for cost optimization
   */
  private async executeElevenLabsChatAPI(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting ElevenLabs Chat API test for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Agent ID: ${agentConfig.agentId}`);

      const { elevenlabsProvider } = await import('../providers/elevenlabs.provider');

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      const testedCases = new Set<string>();
      let conversationId: string | undefined;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      // Initial greeting from test caller
      const initialGreeting = await this.generateBatchTestCallerResponse(
        testCallerHistory,
        batch.testCases,
        0
      );

      if (initialGreeting.text) {
        console.log(`[BatchedExecutor] ElevenLabs Chat: Test caller greeting: ${initialGreeting.text.substring(0, 50)}...`);
        
        // Send to ElevenLabs Chat API
        const chatResponse = await elevenlabsProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          initialGreeting.text,
          { sessionId: conversationId }
        );

        if (!chatResponse) {
          return { success: false, error: 'Failed to get initial response from ElevenLabs Chat API' };
        }

        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: initialGreeting.text,
          timestamp: Date.now(),
          testCaseId: initialGreeting.testCaseId,
        });

        // Track conversation for continuity
        if (chatResponse.sessionId) {
          conversationId = chatResponse.sessionId;
        }

        // Add assistant responses to transcript
        for (const output of chatResponse.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
          }
        }

        if (initialGreeting.testCaseId) {
          testedCases.add(initialGreeting.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: initialGreeting.text });
        turnCount++;
      }

      // Continue conversation until all test cases covered
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          break;
        }

        const chatResponse = await elevenlabsProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          testCallerResponse.text,
          { sessionId: conversationId }
        );

        if (!chatResponse) break;

        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        if (chatResponse.sessionId) {
          conversationId = chatResponse.sessionId;
        }

        for (const output of chatResponse.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
          }
        }

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`[BatchedExecutor] ElevenLabs Chat test completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios tested`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] ElevenLabs Chat API error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Retell test using Chat API
   * Text-based testing for cost optimization
   */
  private async executeRetellChatAPI(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Retell Chat API test for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Agent ID: ${agentConfig.agentId}`);

      const { retellProvider } = await import('../providers/retell.provider');

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      const testedCases = new Set<string>();
      let sessionId: string | undefined;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      // Initial greeting from test caller
      const initialGreeting = await this.generateBatchTestCallerResponse(
        testCallerHistory,
        batch.testCases,
        0
      );

      if (initialGreeting.text) {
        console.log(`[BatchedExecutor] Retell Chat: Test caller greeting: ${initialGreeting.text.substring(0, 50)}...`);
        
        // Send to Retell Chat API
        const chatResponse = await retellProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          initialGreeting.text,
          { sessionId }
        );

        if (!chatResponse) {
          return { success: false, error: 'Failed to get initial response from Retell Chat API' };
        }

        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: initialGreeting.text,
          timestamp: Date.now(),
          testCaseId: initialGreeting.testCaseId,
        });

        // Track session for continuity
        if (chatResponse.sessionId) {
          sessionId = chatResponse.sessionId;
        }

        // Add assistant responses to transcript
        for (const output of chatResponse.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
          }
        }

        if (initialGreeting.testCaseId) {
          testedCases.add(initialGreeting.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: initialGreeting.text });
        turnCount++;
      }

      // Continue conversation until all test cases covered
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          break;
        }

        const chatResponse = await retellProvider.chat(
          agentConfig.apiKey,
          agentConfig.agentId,
          testCallerResponse.text,
          { sessionId }
        );

        if (!chatResponse) break;

        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        if (chatResponse.sessionId) {
          sessionId = chatResponse.sessionId;
        }

        for (const output of chatResponse.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
            testCallerHistory.push({ role: 'user', content: output.message });
          }
        }

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      console.log(`[BatchedExecutor] Retell Chat test completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios tested`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Retell Chat API error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Retell voice call using Web Call API + WebSocket
   * Voice-based testing using Retell's native infrastructure
   * @see https://docs.retellai.com/api-references/create-web-call
   */
  private async executeRetellVoiceCall(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise(async (resolve) => {
      const ttsService = new TTSService(this.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '');
      
      try {
        console.log(`[BatchedExecutor] Starting Retell voice call for batch: ${batch.name}`);
        console.log(`[BatchedExecutor] Retell Agent ID: ${agentConfig.agentId}`);
        
        // Step 1: Create a web call to get access token
        const webCall = await retellProvider.createWebCall(
          agentConfig.apiKey,
          agentConfig.agentId,
          { testBatch: batch.name }
        );
        
        if (!webCall) {
          return resolve({ success: false, error: 'Failed to create Retell web call' });
        }
        
        console.log(`[BatchedExecutor] Retell call created: ${webCall.callId}`);
        
        // Step 2: Build test caller prompt
        const systemPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
        const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt }
        ];
        
        let turnCount = 0;
        const maxTurns = Math.min(batch.testCases.length * 4 + 10, 40);
        let currentAgentResponse = '';
        let conversationComplete = false;
        let isProcessingResponse = false;
        const testedCases = new Set<string>();
        
        // Step 3: Connect to Retell WebSocket
        const wsUrl = retellProvider.getWebSocketUrl(webCall.callId, true);
        console.log(`[BatchedExecutor] Connecting to Retell WebSocket: ${wsUrl}`);
        
        const ws = new WebSocket(wsUrl);
        
        const timeout = setTimeout(() => {
          conversationComplete = true;
          ws.close();
        }, 300000); // 5 minute timeout
        
        let silenceTimer: NodeJS.Timeout | null = null;
        
        const processAgentTurn = async () => {
          if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) {
            return;
          }
          isProcessingResponse = true;
          
          turnCount++;
          const agentMessage = currentAgentResponse.trim();
          console.log(`[BatchedExecutor] Retell Agent (turn ${turnCount}): ${agentMessage.substring(0, 150)}...`);
          
          transcript.push({
            role: 'ai_agent',
            content: agentMessage,
            timestamp: Date.now(),
          });
          
          conversationHistory.push({ role: 'user', content: agentMessage });
          
          // Check if we should end
          const shouldEnd = this.shouldEndBatchConversation(agentMessage, turnCount, testedCases.size, batch.testCases.length);
          
          if (turnCount >= maxTurns || shouldEnd) {
            conversationComplete = true;
            const goodbye = "Thank you for all the information! Goodbye!";
            transcript.push({ role: 'test_caller', content: goodbye, timestamp: Date.now() });
            
            try {
              const ttsResult = await ttsService.generateSpeech({ text: goodbye });
              await this.sendAudioToRetell(ws, ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Retell TTS error:', e);
            }
            
            setTimeout(() => ws.close(), 3000);
          } else {
            // Generate response
            const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
            const response = await this.generateBatchTestCallerResponse(
              conversationHistory,
              remainingCases,
              testedCases.size
            );
            
            if (response.testCaseId) {
              testedCases.add(response.testCaseId);
            }
            
            console.log(`[BatchedExecutor] Retell Test Caller (turn ${turnCount}): ${response.text}`);
            
            transcript.push({
              role: 'test_caller',
              content: response.text,
              timestamp: Date.now(),
              testCaseId: response.testCaseId,
            });
            
            conversationHistory.push({ role: 'assistant', content: response.text });
            
            // Send audio to Retell
            try {
              const ttsResult = await ttsService.generateSpeech({ text: response.text });
              audioChunks.push(ttsResult.audioBuffer);
              await this.sendAudioToRetell(ws, ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Retell TTS error:', e);
            }
          }
          
          currentAgentResponse = '';
          isProcessingResponse = false;
        };
        
        ws.on('open', () => {
          console.log(`[BatchedExecutor] Retell WebSocket connected`);
          
          // Send initial greeting after connection
          setTimeout(async () => {
            try {
              const greeting = "Hello?";
              const ttsResult = await ttsService.generateSpeech({ text: greeting });
              await this.sendAudioToRetell(ws, ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Retell greeting error:', e);
            }
          }, 2000);
        });
        
        ws.on('message', async (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            
            // Handle update events with transcript
            if (message.event_type === 'update' && message.transcript) {
              // Extract agent utterances from transcript
              const agentUtterances = (message.transcript || [])
                .filter((t: any) => t.role === 'agent')
                .map((t: any) => t.content)
                .join(' ');
              
              if (agentUtterances && agentUtterances !== currentAgentResponse) {
                currentAgentResponse = agentUtterances;
                
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  if (currentAgentResponse.trim()) {
                    processAgentTurn();
                  }
                }, 1500);
              }
            }
            
            // Handle clear events (interruption)
            if (data.toString() === 'clear') {
              console.log(`[BatchedExecutor] Retell clear event received`);
            }
            
          } catch (e) {
            // Binary audio data
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });
        
        ws.on('close', async (code, reason) => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          console.log(`[BatchedExecutor] Retell WebSocket closed. Code: ${code}`);
          
          // Fetch final transcript from Retell API
          try {
            await new Promise(r => setTimeout(r, 2000)); // Wait for call to finalize
            const callDetails = await retellProvider.getCall(agentConfig.apiKey, webCall.callId);
            
            if (callDetails?.transcriptObject && callDetails.transcriptObject.length > 0) {
              console.log(`[BatchedExecutor] Got Retell transcript with ${callDetails.transcriptObject.length} utterances`);
              
              // If we didn't get messages via WebSocket, use the final transcript
              if (transcript.length < 3) {
                transcript.length = 0; // Clear existing
                for (const turn of callDetails.transcriptObject) {
                  transcript.push({
                    role: turn.role === 'agent' ? 'ai_agent' : 'test_caller',
                    content: turn.content,
                    timestamp: Date.now(),
                  });
                }
              }
            }
          } catch (e) {
            console.error('[BatchedExecutor] Error fetching Retell transcript:', e);
          }
          
          console.log(`[BatchedExecutor] Retell final stats: ${transcript.length} messages`);
          resolve({ success: true });
        });
        
        ws.on('error', (error) => {
          console.error('[BatchedExecutor] Retell WebSocket error:', error);
          resolve({ success: false, error: error.message });
        });
        
      } catch (error) {
        console.error('[BatchedExecutor] Retell error:', error);
        resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  /**
   * Send audio to Retell WebSocket
   * Retell expects raw PCM audio bytes
   */
  private async sendAudioToRetell(ws: WebSocket, audioBuffer: Buffer): Promise<void> {
    const CHUNK_SIZE = 3200; // ~100ms at 16kHz
    
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      if (ws.readyState !== WebSocket.OPEN) break;
      
      const chunk = audioBuffer.slice(i, Math.min(i + CHUNK_SIZE, audioBuffer.length));
      ws.send(chunk);
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Execute Haptik voice call using Voice Call API + WebSocket
   * Voice-based testing using Haptik's native infrastructure
   */
  private async executeHaptikVoiceCall(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise(async (resolve) => {
      const ttsService = new TTSService(this.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '');
      
      try {
        console.log(`[BatchedExecutor] Starting Haptik voice call for batch: ${batch.name}`);
        console.log(`[BatchedExecutor] Haptik Bot ID: ${agentConfig.agentId}`);
        
        // Step 1: Initiate voice call to get WebSocket URL
        const voiceCall = await haptikProvider.initiateVoiceCall(
          agentConfig.apiKey,
          agentConfig.agentId
        );
        
        if (!voiceCall || !voiceCall.webSocketUrl) {
          console.log(`[BatchedExecutor] Haptik voice call initiation failed, falling back to message API`);
          // Fallback to text-based messaging
          return resolve(await this.executeHaptikMessageAPI(batch, agentConfig, transcript));
        }
        
        console.log(`[BatchedExecutor] Haptik call created: ${voiceCall.callId}`);
        
        // Step 2: Build test caller prompt
        const systemPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
        const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt }
        ];
        
        let turnCount = 0;
        const maxTurns = Math.min(batch.testCases.length * 4 + 10, 40);
        let currentAgentResponse = '';
        let conversationComplete = false;
        let isProcessingResponse = false;
        const testedCases = new Set<string>();
        
        // Step 3: Connect to Haptik WebSocket
        console.log(`[BatchedExecutor] Connecting to Haptik WebSocket: ${voiceCall.webSocketUrl}`);
        
        const ws = new WebSocket(voiceCall.webSocketUrl);
        
        const timeout = setTimeout(() => {
          conversationComplete = true;
          haptikProvider.endVoiceCall(agentConfig.apiKey, voiceCall.callId);
          ws.close();
        }, 300000); // 5 minute timeout
        
        let silenceTimer: NodeJS.Timeout | null = null;
        
        const processAgentTurn = async () => {
          if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) {
            return;
          }
          isProcessingResponse = true;
          
          turnCount++;
          const agentMessage = currentAgentResponse.trim();
          console.log(`[BatchedExecutor] Haptik Agent (turn ${turnCount}): ${agentMessage.substring(0, 150)}...`);
          
          transcript.push({
            role: 'ai_agent',
            content: agentMessage,
            timestamp: Date.now(),
          });
          
          conversationHistory.push({ role: 'user', content: agentMessage });
          
          // Check if we should end
          const shouldEnd = this.shouldEndBatchConversation(agentMessage, turnCount, testedCases.size, batch.testCases.length);
          
          if (turnCount >= maxTurns || shouldEnd) {
            conversationComplete = true;
            const goodbye = "Thank you for all the information! Goodbye!";
            transcript.push({ role: 'test_caller', content: goodbye, timestamp: Date.now() });
            
            try {
              const ttsResult = await ttsService.generateSpeech({ text: goodbye });
              ws.send(ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Haptik TTS error:', e);
            }
            
            setTimeout(() => {
              haptikProvider.endVoiceCall(agentConfig.apiKey, voiceCall.callId);
              ws.close();
            }, 3000);
          } else {
            // Generate response
            const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
            const response = await this.generateBatchTestCallerResponse(
              conversationHistory,
              remainingCases,
              testedCases.size
            );
            
            if (response.testCaseId) {
              testedCases.add(response.testCaseId);
            }
            
            console.log(`[BatchedExecutor] Haptik Test Caller (turn ${turnCount}): ${response.text}`);
            
            transcript.push({
              role: 'test_caller',
              content: response.text,
              timestamp: Date.now(),
              testCaseId: response.testCaseId,
            });
            
            conversationHistory.push({ role: 'assistant', content: response.text });
            
            // Send audio to Haptik
            try {
              const ttsResult = await ttsService.generateSpeech({ text: response.text });
              audioChunks.push(ttsResult.audioBuffer);
              ws.send(ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Haptik TTS error:', e);
            }
          }
          
          currentAgentResponse = '';
          isProcessingResponse = false;
        };
        
        ws.on('open', () => {
          console.log(`[BatchedExecutor] Haptik WebSocket connected`);
          
          // Send initial greeting
          setTimeout(async () => {
            try {
              const greeting = "Hello?";
              const ttsResult = await ttsService.generateSpeech({ text: greeting });
              ws.send(ttsResult.audioBuffer);
            } catch (e) {
              console.error('[BatchedExecutor] Haptik greeting error:', e);
            }
          }, 2000);
        });
        
        ws.on('message', async (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            
            // Handle transcript messages
            if (message.type === 'transcript' || message.type === 'bot_response') {
              const agentText = message.text || message.content || message.response || '';
              if (agentText) {
                currentAgentResponse += agentText + ' ';
                
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  if (currentAgentResponse.trim()) {
                    processAgentTurn();
                  }
                }, 1500);
              }
            }
            
          } catch (e) {
            // Binary audio data
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });
        
        ws.on('close', async (code, reason) => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          console.log(`[BatchedExecutor] Haptik WebSocket closed. Code: ${code}`);
          
          // Fetch final transcript from Haptik API
          try {
            await new Promise(r => setTimeout(r, 2000));
            const callTranscript = await haptikProvider.getCallTranscript(agentConfig.apiKey, voiceCall.callId);
            
            if (callTranscript?.turns && callTranscript.turns.length > 0) {
              console.log(`[BatchedExecutor] Got Haptik transcript with ${callTranscript.turns.length} turns`);
              
              // If we didn't get messages via WebSocket, use the final transcript
              if (transcript.length < 3) {
                transcript.length = 0;
                for (const turn of callTranscript.turns) {
                  transcript.push({
                    role: turn.role === 'bot' ? 'ai_agent' : 'test_caller',
                    content: turn.text,
                    timestamp: Date.now(),
                  });
                }
              }
            }
          } catch (e) {
            console.error('[BatchedExecutor] Error fetching Haptik transcript:', e);
          }
          
          console.log(`[BatchedExecutor] Haptik final stats: ${transcript.length} messages`);
          resolve({ success: true });
        });
        
        ws.on('error', (error) => {
          console.error('[BatchedExecutor] Haptik WebSocket error:', error);
          resolve({ success: false, error: error.message });
        });
        
      } catch (error) {
        console.error('[BatchedExecutor] Haptik error:', error);
        resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  /**
   * Execute Haptik test using Message API (fallback for when voice is not available)
   * Text-based testing using Haptik's sendMessage API
   */
  private async executeHaptikMessageAPI(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Using Haptik Message API for batch: ${batch.name}`);
      
      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];
      
      const testedCases = new Set<string>();
      let sessionId: string | undefined;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);
      
      // Initial greeting
      const initialGreeting = await this.generateBatchTestCallerResponse(
        testCallerHistory,
        batch.testCases,
        0
      );
      
      if (initialGreeting.text) {
        console.log(`[BatchedExecutor] Haptik test caller: ${initialGreeting.text.substring(0, 50)}...`);
        
        // Send to Haptik Message API
        const response = await haptikProvider.sendMessage(
          agentConfig.apiKey,
          agentConfig.agentId,
          initialGreeting.text,
          undefined,
          sessionId
        );
        
        if (!response) {
          return { success: false, error: 'Failed to get initial response from Haptik' };
        }
        
        transcript.push({
          role: 'test_caller',
          content: initialGreeting.text,
          timestamp: Date.now(),
          testCaseId: initialGreeting.testCaseId,
        });
        
        sessionId = response.sessionId;
        
        if (response.response) {
          transcript.push({
            role: 'ai_agent',
            content: response.response,
            timestamp: Date.now(),
          });
          testCallerHistory.push({ role: 'user', content: response.response });
        }
        
        if (initialGreeting.testCaseId) {
          testedCases.add(initialGreeting.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: initialGreeting.text });
        turnCount++;
      }
      
      // Continue conversation
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );
        
        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          break;
        }
        
        console.log(`[BatchedExecutor] Haptik turn ${turnCount}: ${testCallerResponse.text.substring(0, 80)}...`);
        
        const response = await haptikProvider.sendMessage(
          agentConfig.apiKey,
          agentConfig.agentId,
          testCallerResponse.text,
          undefined,
          sessionId
        );
        
        if (!response) {
          break;
        }
        
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });
        
        sessionId = response.sessionId;
        
        if (response.response) {
          transcript.push({
            role: 'ai_agent',
            content: response.response,
            timestamp: Date.now(),
          });
          testCallerHistory.push({ role: 'user', content: response.response });
        }
        
        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      
      console.log(`[BatchedExecutor] Haptik Message API completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} tested`);
      return { success: true };
      
    } catch (error) {
      console.error(`[BatchedExecutor] Haptik Message API error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Custom Agent test using our own LLM
   * For agents created in Agent Builder without external provider APIs
   */
  private async executeCustomAgentChatAPI(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Custom Agent test for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Agent ID: ${agentConfig.agentId}`);

      const { customProvider } = await import('../providers/custom.provider');
      const pool = (await import('../db')).default;

      // Strip 'custom_' prefix if present (external_agent_id format)
      let agentId = agentConfig.agentId;
      if (agentId.startsWith('custom_')) {
        agentId = agentId.replace('custom_', '');
      }
      console.log(`[BatchedExecutor] Resolved Agent ID: ${agentId}`);

      // Fetch the custom agent configuration from database
      const agentResult = await pool.query(
        'SELECT config, prompt FROM agents WHERE id = $1 OR external_agent_id = $2',
        [agentId, agentConfig.agentId]
      );

      if (agentResult.rows.length === 0) {
        return { success: false, error: 'Custom agent not found in database' };
      }

      const agentData = agentResult.rows[0];
      const config = agentData.config || {};
      const systemPrompt = config.systemPrompt || agentData.prompt || 'You are a helpful assistant.';
      const startingMessage = config.startingMessage || 'Hello! How can I help you today?';

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      const testedCases = new Set<string>();
      const sessionId = `custom_batch_${Date.now()}`;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      // Start with agent's starting message if available
      if (startingMessage) {
        transcript.push({
          role: 'ai_agent',
          content: startingMessage,
          timestamp: Date.now(),
        });
        testCallerHistory.push({ role: 'user', content: startingMessage });
        turnCount++;
      }

      // Continue conversation until all test cases covered
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          break;
        }

        console.log(`[BatchedExecutor] Custom Agent turn ${turnCount}: ${testCallerResponse.text.substring(0, 80)}...`);

        // Send to custom agent using our LLM provider
        const chatResult = await customProvider.chat(
          'custom',
          agentConfig.agentId,
          testCallerResponse.text,
          { sessionId, config: { ...config, systemPrompt } }
        );

        if (!chatResult || !chatResult.output || chatResult.output.length === 0) {
          console.error('[BatchedExecutor] Custom agent returned no response');
          break;
        }

        // Extract the response text from the ChatResponse object
        const agentResponseText = chatResult.output[0]?.message || '';
        if (!agentResponseText) {
          console.error('[BatchedExecutor] Custom agent response message is empty');
          break;
        }

        console.log(`[BatchedExecutor] Custom Agent response: ${agentResponseText.substring(0, 80)}...`);

        // Add test caller message to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        // Add agent response to transcript
        transcript.push({
          role: 'ai_agent',
          content: agentResponseText,
          timestamp: Date.now(),
        });
        testCallerHistory.push({ role: 'user', content: agentResponseText });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between turns
      }

      console.log(`[BatchedExecutor] Custom Agent test completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios tested`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Custom Agent Chat API error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Custom Agent Voice Simulation
   * Simulates a voice call where both test caller and agent use STT + LLM + TTS
   * Test caller: Uses test caller prompt + LLM + TTS (to speak) + ASR (to hear agent)
   * Agent: Uses agent's configured LLM/prompt + TTS (to speak) + ASR (to hear test caller)
   */
  private async executeCustomAgentVoiceSimulation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[],
    userAudioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Custom Agent Voice Simulation for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Agent ID: ${agentConfig.agentId}`);

      const { customProvider } = await import('../providers/custom.provider');
      const { TTSService, DEFAULT_VOICES } = await import('./tts.service');
      const { ASRService } = await import('./asr.service');
      const pool = (await import('../db')).default;

      // Initialize TTS and ASR services
      const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
      const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

      if (!elevenLabsApiKey || !deepgramApiKey) {
        console.error('[BatchedExecutor] Missing API keys for voice simulation');
        // Fall back to chat-based testing if voice services unavailable
        console.log('[BatchedExecutor] Falling back to chat-based testing');
        return this.executeCustomAgentChatAPI(batch, agentConfig, transcript);
      }

      const ttsService = new TTSService(elevenLabsApiKey);
      const asrService = new ASRService(deepgramApiKey);

      // Strip 'custom_' prefix if present
      let agentId = agentConfig.agentId;
      if (agentId.startsWith('custom_')) {
        agentId = agentId.replace('custom_', '');
      }
      console.log(`[BatchedExecutor] Resolved Agent ID: ${agentId}`);

      // Fetch the custom agent configuration from database
      const agentResult = await pool.query(
        'SELECT config, prompt FROM agents WHERE id = $1 OR external_agent_id = $2',
        [agentId, agentConfig.agentId]
      );

      if (agentResult.rows.length === 0) {
        return { success: false, error: 'Custom agent not found in database' };
      }

      const agentData = agentResult.rows[0];
      const config = agentData.config || {};
      const systemPrompt = config.systemPrompt || agentData.prompt || 'You are a helpful assistant.';
      const startingMessage = config.startingMessage || 'Hello! How can I help you today?';
      const agentVoiceId = config.voiceId || DEFAULT_VOICES.female; // Agent voice
      const testCallerVoiceId = DEFAULT_VOICES.male; // Test caller voice (different from agent)

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      const testedCases = new Set<string>();
      const sessionId = `custom_voice_${Date.now()}`;
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      console.log(`[BatchedExecutor] Voice Simulation: Agent voice: ${agentVoiceId}, Test caller voice: ${testCallerVoiceId}`);

      // Start with agent's starting message (with TTS)
      if (startingMessage) {
        console.log(`[BatchedExecutor] Agent starting message: ${startingMessage.substring(0, 50)}...`);
        
        try {
          // Generate agent's starting message audio
          const agentAudio = await ttsService.generateSpeech({
            text: startingMessage,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Generated agent starting audio: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] TTS failed for agent starting message:`, ttsError);
        }

        transcript.push({
          role: 'ai_agent',
          content: startingMessage,
          timestamp: Date.now(),
        });
        testCallerHistory.push({ role: 'user', content: startingMessage });
        turnCount++;
      }

      // Voice conversation loop
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        
        // 1. Test caller thinks and generates text response
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] Conversation ending (goodbye or no response)`);
          break;
        }

        console.log(`[BatchedExecutor] Test caller turn ${turnCount}: ${testCallerResponse.text.substring(0, 60)}...`);

        // 2. Test caller TTS - convert text to speech
        try {
          const testCallerAudio = await ttsService.generateSpeech({
            text: testCallerResponse.text,
            voiceId: testCallerVoiceId,
          });
          // Push to main audioChunks in conversation order (test caller speaks)
          audioChunks.push(testCallerAudio.audioBuffer);
          userAudioChunks.push(testCallerAudio.audioBuffer); // Also track separately
          console.log(`[BatchedExecutor] Test caller TTS: ${testCallerAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Test caller TTS failed:`, ttsError);
        }

        // 3. Agent STT - transcribe test caller's audio (simulated in voice context)
        // In real voice scenario, agent would hear the audio. Here we pass the text directly.
        // But we record the audio for playback.

        // 4. Agent LLM - generate response using agent's model and prompt
        const chatResult = await customProvider.chat(
          'custom',
          agentConfig.agentId,
          testCallerResponse.text,
          { sessionId, config: { ...config, systemPrompt } }
        );

        if (!chatResult || !chatResult.output || chatResult.output.length === 0) {
          console.error('[BatchedExecutor] Custom agent returned no response');
          break;
        }

        const agentResponseText = chatResult.output[0]?.message || '';
        if (!agentResponseText) {
          console.error('[BatchedExecutor] Custom agent response message is empty');
          break;
        }

        console.log(`[BatchedExecutor] Agent response: ${agentResponseText.substring(0, 60)}...`);

        // 5. Agent TTS - convert agent response to speech
        try {
          const agentAudio = await ttsService.generateSpeech({
            text: agentResponseText,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Agent TTS: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Agent TTS failed:`, ttsError);
        }

        // Add test caller message to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        // Add agent response to transcript
        transcript.push({
          role: 'ai_agent',
          content: agentResponseText,
          timestamp: Date.now(),
        });
        testCallerHistory.push({ role: 'user', content: agentResponseText });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 200)); // Simulate realistic conversation pacing
      }

      console.log(`[BatchedExecutor] Voice Simulation completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios`);
      console.log(`[BatchedExecutor] Audio chunks: Agent=${audioChunks.length}, TestCaller=${userAudioChunks.length}`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Custom Agent Voice Simulation error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute VAPI Voice Simulation
   * Simulates a voice call for VAPI agents when Twilio is not configured
   * Fetches VAPI assistant config (prompt, model, first message) and uses TTS/ASR simulation
   */
  private async executeVAPIVoiceSimulation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[],
    userAudioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting VAPI Voice Simulation for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] VAPI Agent ID: ${agentConfig.agentId}`);

      const { vapiProvider } = await import('../providers/vapi.provider');
      const { TTSService, DEFAULT_VOICES } = await import('./tts.service');

      // Initialize TTS service
      const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsApiKey) {
        console.error('[BatchedExecutor] Missing ElevenLabs API key for voice simulation');
        console.log('[BatchedExecutor] Falling back to chat-based testing');
        return this.executeVAPIChatAPI(batch, agentConfig, transcript);
      }

      const ttsService = new TTSService(elevenLabsApiKey);

      // Fetch VAPI assistant configuration
      const agent = await vapiProvider.getAgent(agentConfig.apiKey, agentConfig.agentId);
      if (!agent) {
        return { success: false, error: 'Failed to fetch VAPI assistant configuration' };
      }

      const systemPrompt = agent.description || agent.metadata?.systemPrompt || agent.metadata?.prompt || 'You are a helpful assistant.';
      const firstMessage = agent.metadata?.firstMessage || 'Hello! How can I help you today?';
      const agentVoiceId = agent.voice || DEFAULT_VOICES.female;
      const testCallerVoiceId = DEFAULT_VOICES.male;

      console.log(`[BatchedExecutor] VAPI agent loaded: ${agent.name}`);
      console.log(`[BatchedExecutor] System prompt length: ${systemPrompt.length}`);
      console.log(`[BatchedExecutor] First message: ${firstMessage.substring(0, 50)}...`);

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      // Build agent history for simulating agent responses
      const agentHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      const testedCases = new Set<string>();
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      console.log(`[BatchedExecutor] Voice Simulation: Agent voice: ${agentVoiceId}, Test caller voice: ${testCallerVoiceId}`);

      // Start with agent's first message (with TTS)
      if (firstMessage) {
        console.log(`[BatchedExecutor] Agent first message: ${firstMessage.substring(0, 50)}...`);
        
        try {
          const agentAudio = await ttsService.generateSpeech({
            text: firstMessage,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Generated agent starting audio: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] TTS failed for agent first message:`, ttsError);
        }

        transcript.push({
          role: 'ai_agent',
          content: firstMessage,
          timestamp: Date.now(),
        });
        agentHistory.push({ role: 'assistant', content: firstMessage });
        testCallerHistory.push({ role: 'user', content: firstMessage });
        turnCount++;
      }

      // Voice conversation loop
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        
        // 1. Test caller generates text response
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] Conversation ending (goodbye or no response)`);
          break;
        }

        console.log(`[BatchedExecutor] Test caller turn ${turnCount}: ${testCallerResponse.text.substring(0, 60)}...`);

        // 2. Test caller TTS
        try {
          const testCallerAudio = await ttsService.generateSpeech({
            text: testCallerResponse.text,
            voiceId: testCallerVoiceId,
          });
          audioChunks.push(testCallerAudio.audioBuffer);
          userAudioChunks.push(testCallerAudio.audioBuffer);
          console.log(`[BatchedExecutor] Test caller TTS: ${testCallerAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Test caller TTS failed:`, ttsError);
        }

        // 3. Simulate agent response using OpenAI with VAPI's prompt
        agentHistory.push({ role: 'user', content: testCallerResponse.text });
        
        const agentResponseText = await this.generateAgentSimulationResponse(agentHistory);
        
        if (!agentResponseText) {
          console.error('[BatchedExecutor] Agent simulation returned no response');
          break;
        }

        console.log(`[BatchedExecutor] Agent response: ${agentResponseText.substring(0, 60)}...`);

        // 4. Agent TTS
        try {
          const agentAudio = await ttsService.generateSpeech({
            text: agentResponseText,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Agent TTS: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Agent TTS failed:`, ttsError);
        }

        // Add messages to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        transcript.push({
          role: 'ai_agent',
          content: agentResponseText,
          timestamp: Date.now(),
        });

        agentHistory.push({ role: 'assistant', content: agentResponseText });
        testCallerHistory.push({ role: 'user', content: agentResponseText });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log(`[BatchedExecutor] VAPI Voice Simulation completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios`);
      console.log(`[BatchedExecutor] Audio chunks: Agent=${audioChunks.length}, TestCaller=${userAudioChunks.length}`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] VAPI Voice Simulation error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Retell Voice Simulation
   * Simulates a voice call for Retell agents (Retell Web Call API has issues)
   * Fetches Retell agent config (LLM, prompt) and uses TTS + LLM simulation
   */
  private async executeRetellVoiceSimulation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[],
    audioChunks: Buffer[],
    userAudioChunks: Buffer[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Retell Voice Simulation for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Retell Agent ID: ${agentConfig.agentId}`);

      const { retellProvider } = await import('../providers/retell.provider');
      const { TTSService, DEFAULT_VOICES } = await import('./tts.service');

      // Initialize TTS service
      const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
      if (!elevenLabsApiKey) {
        console.error('[BatchedExecutor] Missing ElevenLabs API key for voice simulation');
        console.log('[BatchedExecutor] Falling back to chat simulation');
        return this.executeRetellChatSimulation(batch, agentConfig, transcript);
      }

      const ttsService = new TTSService(elevenLabsApiKey);

      // Fetch Retell agent configuration
      const agent = await retellProvider.getAgent(agentConfig.apiKey, agentConfig.agentId);
      if (!agent) {
        return { success: false, error: 'Failed to fetch Retell agent configuration' };
      }

      // Extract prompt from agent - check multiple locations
      const systemPrompt = agent.description || 
                          agent.metadata?.prompt || 
                          agent.metadata?.general_prompt ||
                          agent.metadata?.statePrompts?.[0]?.prompt ||
                          'You are a helpful voice assistant.';
      
      const beginMessage = agent.metadata?.beginMessage || agent.metadata?.begin_message || 'Hello! How can I help you today?';
      const agentVoiceId = agent.voice || DEFAULT_VOICES.female;
      const testCallerVoiceId = DEFAULT_VOICES.male;

      console.log(`[BatchedExecutor] Retell agent loaded: ${agent.name}`);
      console.log(`[BatchedExecutor] System prompt length: ${systemPrompt.length}`);
      console.log(`[BatchedExecutor] Begin message: ${beginMessage.substring(0, 50)}...`);

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      // Build agent history for simulating agent responses
      const agentHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      const testedCases = new Set<string>();
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      console.log(`[BatchedExecutor] Voice Simulation: Agent voice: ${agentVoiceId}, Test caller voice: ${testCallerVoiceId}`);

      // Start with agent's begin message (with TTS)
      if (beginMessage) {
        console.log(`[BatchedExecutor] Agent begin message: ${beginMessage.substring(0, 50)}...`);
        
        try {
          const agentAudio = await ttsService.generateSpeech({
            text: beginMessage,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Generated agent starting audio: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] TTS failed for agent begin message:`, ttsError);
        }

        transcript.push({
          role: 'ai_agent',
          content: beginMessage,
          timestamp: Date.now(),
        });
        agentHistory.push({ role: 'assistant', content: beginMessage });
        testCallerHistory.push({ role: 'user', content: beginMessage });
        turnCount++;
      }

      // Voice conversation loop
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        
        // 1. Test caller generates text response
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] Conversation ending (goodbye or no response)`);
          break;
        }

        console.log(`[BatchedExecutor] Test caller turn ${turnCount}: ${testCallerResponse.text.substring(0, 60)}...`);

        // 2. Test caller TTS
        try {
          const testCallerAudio = await ttsService.generateSpeech({
            text: testCallerResponse.text,
            voiceId: testCallerVoiceId,
          });
          audioChunks.push(testCallerAudio.audioBuffer);
          userAudioChunks.push(testCallerAudio.audioBuffer);
          console.log(`[BatchedExecutor] Test caller TTS: ${testCallerAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Test caller TTS failed:`, ttsError);
        }

        // 3. Simulate agent response using OpenAI with Retell's prompt
        agentHistory.push({ role: 'user', content: testCallerResponse.text });
        
        const agentResponseText = await this.generateAgentSimulationResponse(agentHistory);
        
        if (!agentResponseText) {
          console.error('[BatchedExecutor] Agent simulation returned no response');
          break;
        }

        console.log(`[BatchedExecutor] Agent response: ${agentResponseText.substring(0, 60)}...`);

        // 4. Agent TTS
        try {
          const agentAudio = await ttsService.generateSpeech({
            text: agentResponseText,
            voiceId: agentVoiceId,
          });
          audioChunks.push(agentAudio.audioBuffer);
          console.log(`[BatchedExecutor] Agent TTS: ${agentAudio.audioBuffer.length} bytes`);
        } catch (ttsError) {
          console.warn(`[BatchedExecutor] Agent TTS failed:`, ttsError);
        }

        // Add messages to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        transcript.push({
          role: 'ai_agent',
          content: agentResponseText,
          timestamp: Date.now(),
        });

        agentHistory.push({ role: 'assistant', content: agentResponseText });
        testCallerHistory.push({ role: 'user', content: agentResponseText });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log(`[BatchedExecutor] Retell Voice Simulation completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios`);
      console.log(`[BatchedExecutor] Audio chunks: Agent=${audioChunks.length}, TestCaller=${userAudioChunks.length}`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Retell Voice Simulation error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Execute Retell Chat Simulation
   * Simulates a chat conversation for Retell agents (Retell doesn't have a text API)
   * Fetches Retell agent config (LLM, prompt) and simulates conversation using OpenAI
   */
  private async executeRetellChatSimulation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting Retell Chat Simulation for batch: ${batch.name}`);
      console.log(`[BatchedExecutor] Retell Agent ID: ${agentConfig.agentId}`);

      const { retellProvider } = await import('../providers/retell.provider');

      // Fetch Retell agent configuration
      const agent = await retellProvider.getAgent(agentConfig.apiKey, agentConfig.agentId);
      if (!agent) {
        return { success: false, error: 'Failed to fetch Retell agent configuration' };
      }

      // Extract prompt from agent - check multiple locations
      const systemPrompt = agent.description || 
                          agent.metadata?.prompt || 
                          agent.metadata?.general_prompt ||
                          agent.metadata?.statePrompts?.[0]?.prompt ||
                          'You are a helpful voice assistant.';
      
      const beginMessage = agent.metadata?.beginMessage || agent.metadata?.begin_message || 'Hello! How can I help you today?';

      console.log(`[BatchedExecutor] Retell agent loaded: ${agent.name}`);
      console.log(`[BatchedExecutor] System prompt length: ${systemPrompt.length}`);
      console.log(`[BatchedExecutor] Begin message: ${beginMessage.substring(0, 50)}...`);

      // Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      // Build agent history for simulating agent responses
      const agentHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      const testedCases = new Set<string>();
      let turnCount = 0;
      const maxTurns = Math.min(batch.testCases.length * 3 + 5, 30);

      // Start with agent's begin message
      if (beginMessage) {
        console.log(`[BatchedExecutor] Agent begin message: ${beginMessage.substring(0, 50)}...`);
        
        transcript.push({
          role: 'ai_agent',
          content: beginMessage,
          timestamp: Date.now(),
        });
        agentHistory.push({ role: 'assistant', content: beginMessage });
        testCallerHistory.push({ role: 'user', content: beginMessage });
        turnCount++;
      }

      // Chat conversation loop
      while (turnCount < maxTurns && testedCases.size < batch.testCases.length) {
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        
        // 1. Test caller generates response
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text || this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] Conversation ending (goodbye or no response)`);
          break;
        }

        console.log(`[BatchedExecutor] Test caller: ${testCallerResponse.text.substring(0, 60)}...`);

        // 2. Simulate agent response using OpenAI with Retell's prompt
        agentHistory.push({ role: 'user', content: testCallerResponse.text });
        
        const agentResponseText = await this.generateAgentSimulationResponse(agentHistory);
        
        if (!agentResponseText) {
          console.error('[BatchedExecutor] Agent simulation returned no response');
          break;
        }

        console.log(`[BatchedExecutor] Agent response: ${agentResponseText.substring(0, 60)}...`);

        // Add messages to transcript
        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });

        transcript.push({
          role: 'ai_agent',
          content: agentResponseText,
          timestamp: Date.now(),
        });

        agentHistory.push({ role: 'assistant', content: agentResponseText });
        testCallerHistory.push({ role: 'user', content: agentResponseText });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });
        turnCount++;

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log(`[BatchedExecutor] Retell Chat Simulation completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] Retell Chat Simulation error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Generate a simulated agent response using OpenAI
   * Used for VAPI and Retell simulations where we have the prompt but no direct API
   */
  private async generateAgentSimulationResponse(
    history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  ): Promise<string | null> {
    try {
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        console.error('[BatchedExecutor] OpenAI API key not configured for agent simulation');
        return null;
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: history,
          max_tokens: 500,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[BatchedExecutor] OpenAI API error:', error);
        return null;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content || null;

    } catch (error) {
      console.error('[BatchedExecutor] Agent simulation error:', error);
      return null;
    }
  }

  /**
   * Execute VAPI test using text simulation (fallback if Chat API fails)
   * Fetches assistant config and simulates conversation using OpenAI
   */
  private async executeVAPITextSimulation(
    batch: CallBatch,
    agentConfig: { provider: string; agentId: string; apiKey: string },
    transcript: ConversationTurn[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log(`[BatchedExecutor] Starting VAPI text simulation for batch: ${batch.name}`);

      // Step 1: Fetch VAPI assistant configuration
      const assistantConfig = await this.fetchVAPIAssistantConfig(agentConfig.agentId, agentConfig.apiKey);
      if (!assistantConfig) {
        return { success: false, error: 'Failed to fetch VAPI assistant configuration' };
      }

      console.log(`[BatchedExecutor] VAPI assistant: ${assistantConfig.firstMessage?.substring(0, 50)}...`);

      // Step 2: Build test caller prompt
      const testCallerPrompt = this.buildBatchTestCallerPrompt(batch.testCases);
      const testCallerHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: testCallerPrompt }
      ];

      // Step 3: Build agent history
      const agentHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
      if (assistantConfig.systemPrompt) {
        agentHistory.push({ role: 'system', content: assistantConfig.systemPrompt });
      }

      // Step 4: Start with agent's first message
      let turnCount = 0;
      const minTurns = Math.max(15, batch.testCases.length * 3);
      const maxTurns = Math.min(minTurns + 10, 40);

      if (assistantConfig.firstMessage) {
        transcript.push({
          role: 'ai_agent',
          content: assistantConfig.firstMessage,
          timestamp: Date.now(),
        });
        agentHistory.push({ role: 'assistant', content: assistantConfig.firstMessage });
        testCallerHistory.push({ role: 'user', content: assistantConfig.firstMessage });
        turnCount++;
      }

      // Step 5: Run multi-turn conversation
      const testedCases = new Set<string>();
      
      while (turnCount < maxTurns) {
        // Generate test caller response
        const remainingCases = batch.testCases.filter(tc => !testedCases.has(tc.id));
        const testCallerResponse = await this.generateBatchTestCallerResponse(
          testCallerHistory,
          remainingCases,
          testedCases.size
        );

        if (!testCallerResponse.text) {
          console.log(`[BatchedExecutor] VAPI sim: Test caller ended conversation`);
          break;
        }

        transcript.push({
          role: 'test_caller',
          content: testCallerResponse.text,
          timestamp: Date.now(),
          testCaseId: testCallerResponse.testCaseId,
        });
        agentHistory.push({ role: 'user', content: testCallerResponse.text });
        testCallerHistory.push({ role: 'assistant', content: testCallerResponse.text });

        if (testCallerResponse.testCaseId) {
          testedCases.add(testCallerResponse.testCaseId);
        }

        // Check for goodbye
        if (this.isGoodbyeMessage(testCallerResponse.text)) {
          console.log(`[BatchedExecutor] VAPI sim: Test caller said goodbye`);
          break;
        }

        // Generate agent response
        const agentResponse = await this.generateVAPIAgentResponse(agentHistory, assistantConfig);

        if (!agentResponse) {
          console.log(`[BatchedExecutor] VAPI sim: Agent ended conversation`);
          break;
        }

        transcript.push({
          role: 'ai_agent',
          content: agentResponse,
          timestamp: Date.now(),
        });
        agentHistory.push({ role: 'assistant', content: agentResponse });
        testCallerHistory.push({ role: 'user', content: agentResponse });
        turnCount++;

        // Check for end conditions
        if (this.shouldEndBatchConversation(agentResponse, turnCount, testedCases.size, batch.testCases.length)) {
          console.log(`[BatchedExecutor] VAPI sim: Ending conversation`);
          break;
        }
      }

      console.log(`[BatchedExecutor] VAPI simulation completed: ${transcript.length} turns, ${testedCases.size}/${batch.testCases.length} scenarios tested`);
      return { success: true };

    } catch (error) {
      console.error(`[BatchedExecutor] VAPI simulation error:`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Fetch VAPI assistant configuration
   */
  private async fetchVAPIAssistantConfig(
    assistantId: string,
    apiKey: string
  ): Promise<{ systemPrompt: string | null; firstMessage: string | null; model: string | null } | null> {
    try {
      const response = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        console.error(`[BatchedExecutor] Failed to fetch VAPI assistant: ${await response.text()}`);
        return null;
      }

      const data = await response.json() as {
        model?: {
          messages?: Array<{ role: string; content: string }>;
          systemPrompt?: string;
          model?: string;
        };
        firstMessage?: string;
      };

      let systemPrompt: string | null = null;
      if (data.model?.messages && Array.isArray(data.model.messages)) {
        const systemMsg = data.model.messages.find(m => m.role === 'system');
        if (systemMsg) systemPrompt = systemMsg.content;
      }
      if (!systemPrompt && data.model?.systemPrompt) {
        systemPrompt = data.model.systemPrompt;
      }

      return {
        systemPrompt,
        firstMessage: data.firstMessage || null,
        model: data.model?.model || null,
      };
    } catch (error) {
      console.error(`[BatchedExecutor] Error fetching VAPI assistant:`, error);
      return null;
    }
  }

  /**
   * Generate VAPI agent response using OpenAI
   */
  private async generateVAPIAgentResponse(
    conversation: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    config: { model: string | null }
  ): Promise<string | null> {
    try {
      const model = (config.model?.includes('gpt') ? config.model : 'gpt-4o-mini') as 'gpt-4o-mini' | 'gpt-4o' | 'gpt-4';

      const response = await this.openai.chat.completions.create({
        model,
        messages: conversation,
        temperature: 0.7,
        max_tokens: 300,
      });

      return response.choices[0]?.message?.content || null;
    } catch (error) {
      console.error(`[BatchedExecutor] Error generating VAPI agent response:`, error);
      return null;
    }
  }

  /**
   * Check if message is a goodbye
   */
  private isGoodbyeMessage(message: string): boolean {
    const patterns = [/\bgoodbye\b/i, /\bbye\b/i, /\btake care\b/i, /\bthank you.*that's all\b/i];
    return patterns.some(p => p.test(message));
  }

  /**
   * Build prompt for test caller handling multiple test cases
   * IMPORTANT: Include ALL test cases so the test caller knows what to test
   * NOW USING INTELLIGENT BATCHING - test cases are already ordered optimally
   */
  private buildBatchTestCallerPrompt(testCases: SmartTestCase[]): string {
    // Analyze test cases to understand what's being tested
    const testCaseAnalysis = this.analyzeTestCasesForPrompt(testCases);
    
    // Build ordered test scenarios with intelligent ordering metadata
    const testScenarios = testCases.map((tc, idx) => {
      const isLast = idx === testCases.length - 1;
      const callEndingHint = (tc.isCallClosing || tc.scenario?.toLowerCase().includes('bye') || 
        tc.scenario?.toLowerCase().includes('end') || tc.scenario?.toLowerCase().includes('close')) 
        ? ' [CALL ENDING - DO THIS LAST]' : '';
      
      return `${idx + 1}. "${tc.name}": ${tc.scenario || tc.userInput}${callEndingHint}
   - Expected: ${tc.expectedOutcome || 'Natural response'}
   - When to trigger: ${this.getOptimalTriggerPoint(tc, idx, testCases.length)}`;
    }).join('\n\n');

    // Build a dynamic persona based on test case requirements
    const persona = this.buildDynamicPersona(testCases);

    // Identify conversation flow expectations
    const flowAnalysis = this.analyzeExpectedConversationFlow(testCases);

    return `You are ${persona.name}, a test caller making a phone call to test a voice AI agent. Your job is to have a NATURAL conversation while systematically covering specific test scenarios.

=== YOUR PERSONA ===
${persona.details}

=== UNDERSTANDING THE TEST ===
You are testing: ${testCaseAnalysis.agentPurpose}
Key topics to cover: ${testCaseAnalysis.keyTopics.join(', ')}
Call ending scenarios: ${testCaseAnalysis.callEndingScenarios.join(', ') || 'None specified'}

=== CONVERSATION FLOW ===
Expected flow: ${flowAnalysis}
IMPORTANT: The test scenarios below are ALREADY OPTIMALLY ORDERED. Follow this order for natural conversation.

=== TEST SCENARIOS (IN ORDER) ===
${testScenarios}

=== INTELLIGENT TESTING RULES ===
1. START: Say "Hello?" or a natural greeting when the call begins
2. FOLLOW THE ORDER: Cover test scenarios in the order listed above
3. BE NATURAL: Don't just read scenarios - weave them into natural conversation
4. RESPOND APPROPRIATELY: When the agent asks questions, answer from your persona
5. PIVOT NATURALLY: When moving to a new test scenario, transition smoothly
6. TRACK PROGRESS: Mentally note which scenarios you've covered
7. HANDLE FAILURES: If a scenario doesn't get the expected response, note it and move on
8. SAVE ENDING FOR LAST: Any [CALL ENDING] scenario should be your FINAL action

=== HOW TO TRIGGER EACH SCENARIO ===
- For information requests: Ask direct questions
- For objections: Express concerns naturally ("I'm worried about...")
- For edge cases: Present the scenario when relevant
- For call endings: Wait until you've covered other scenarios first

=== FAILURE HANDLING ===
If the agent says something unexpected or the conversation goes off-track:
1. Acknowledge their response naturally
2. Gently steer back to your remaining scenarios
3. If they try to end the call early, say you have more questions
4. Only let the call end after covering call-ending scenarios

=== IMPORTANT REMINDERS ===
- You are a CUSTOMER, not an assistant
- Keep responses SHORT (1-2 sentences)
- Be curious, engaged, and slightly persistent
- Don't skip scenarios - cover ALL ${testCases.length} test cases
- The scenarios are ordered for OPTIMAL conversation flow - trust the order`;
  }

  /**
   * Analyze test cases to extract insights for prompt building
   */
  private analyzeTestCasesForPrompt(testCases: SmartTestCase[]): {
    agentPurpose: string;
    keyTopics: string[];
    callEndingScenarios: string[];
    requiresContext: boolean;
  } {
    const topics = new Set<string>();
    const callEnding: string[] = [];
    
    testCases.forEach(tc => {
      if (tc.keyTopicName) topics.add(tc.keyTopicName);
      if (tc.category) topics.add(tc.category);
      
      if (tc.isCallClosing || 
          tc.scenario?.toLowerCase().includes('bye') ||
          tc.scenario?.toLowerCase().includes('end') ||
          tc.scenario?.toLowerCase().includes('close') ||
          tc.scenario?.toLowerCase().includes('callback') ||
          tc.scenario?.toLowerCase().includes('hang up')) {
        callEnding.push(tc.name);
      }
    });
    
    // Infer agent purpose from test cases
    const allText = testCases.map(tc => `${tc.name} ${tc.scenario || ''} ${tc.userInput || ''}`).join(' ').toLowerCase();
    let purpose = 'a customer service agent';
    if (allText.includes('study') || allText.includes('abroad') || allText.includes('university')) {
      purpose = 'a study abroad counselor';
    } else if (allText.includes('insurance') || allText.includes('policy')) {
      purpose = 'an insurance agent';
    } else if (allText.includes('appointment') || allText.includes('booking')) {
      purpose = 'an appointment booking agent';
    } else if (allText.includes('support') || allText.includes('technical')) {
      purpose = 'a technical support agent';
    } else if (allText.includes('sales') || allText.includes('product')) {
      purpose = 'a sales agent';
    }
    
    return {
      agentPurpose: purpose,
      keyTopics: Array.from(topics),
      callEndingScenarios: callEnding,
      requiresContext: testCases.some(tc => 
        tc.scenario?.toLowerCase().includes('earlier') ||
        tc.scenario?.toLowerCase().includes('previous') ||
        tc.scenario?.toLowerCase().includes('mentioned')
      ),
    };
  }

  /**
   * Build a dynamic persona based on what the test cases need
   */
  private buildDynamicPersona(testCases: SmartTestCase[]): { name: string; details: string } {
    const allText = testCases.map(tc => `${tc.scenario || ''} ${tc.userInput || ''}`).join(' ').toLowerCase();
    
    // Extract specific values from test cases to use as persona details
    const extractValue = (patterns: RegExp[]): string | null => {
      for (const pattern of patterns) {
        for (const tc of testCases) {
          const text = `${tc.scenario || ''} ${tc.userInput || ''}`;
          const match = text.match(pattern);
          if (match) return match[1] || match[0];
        }
      }
      return null;
    };
    
    // Build persona parts
    const parts: string[] = [];
    
    // Name
    parts.push('- Name: Alex (you can use this if asked)');
    
    // Budget (for study abroad, real estate, etc.)
    const budgetValue = extractValue([
      /budget\s*(?:is|of)?\s*(\d+[\s]*(?:lakh|lac|crore|million|k|thousand)[^,.\n]*)/i,
      /(\d+[\s]*(?:lakh|lac|crore|million|k|thousand)[^,.\n]*)\s*budget/i,
    ]);
    if (budgetValue || allText.includes('budget')) {
      parts.push(`- Budget: ${budgetValue || 'around 15 to 20 lakh rupees'}`);
    }
    
    // Education (for study abroad)
    const educationValue = extractValue([
      /cgpa\s*(?:is|of)?\s*([\d.]+)/i,
      /gpa\s*(?:is|of)?\s*([\d.]+)/i,
      /(bachelor'?s?|master'?s?|phd|undergraduate)/i,
    ]);
    if (educationValue || allText.includes('education') || allText.includes('degree')) {
      parts.push(`- Education: ${educationValue ? `CGPA of ${educationValue}` : "I completed my Bachelor's degree with a 7.5 CGPA"}`);
    }
    
    // Country/destination preferences
    const countryValue = extractValue([
      /(?:interested in|prefer|want to (?:go to|study in))\s*([a-zA-Z]+(?:\s+(?:or|and)\s+[a-zA-Z]+)?)/i,
    ]);
    if (countryValue || allText.includes('country') || allText.includes('destination')) {
      parts.push(`- Preferred destination: ${countryValue || "Canada or the UK"}`);
    }
    
    // Contact info (if needed)
    if (allText.includes('phone') || allText.includes('email') || allText.includes('contact')) {
      parts.push('- Phone: 9876543210');
      parts.push('- Email: alex@example.com');
    }
    
    // Age (if relevant)
    if (allText.includes('age') || allText.includes('old')) {
      parts.push('- Age: 24 years old');
    }
    
    // Add flexibility note
    parts.push('- Use these details when asked, but be flexible and natural');
    
    return {
      name: 'Alex',
      details: parts.join('\n'),
    };
  }

  /**
   * Determine optimal trigger point for each test case
   */
  private getOptimalTriggerPoint(tc: SmartTestCase, index: number, total: number): string {
    // Based on position
    if (index === 0) {
      return 'Early in conversation, after initial greeting';
    }
    if (index === total - 1) {
      return 'At the END of conversation, just before closing';
    }
    
    // Based on content
    const scenario = `${tc.scenario || ''} ${tc.userInput || ''}`.toLowerCase();
    
    if (scenario.includes('clarif') || scenario.includes('repeat')) {
      return 'When you need clarification or didn\'t understand something';
    }
    if (scenario.includes('object') || scenario.includes('concern') || scenario.includes('worried')) {
      return 'After receiving information/recommendation you can question';
    }
    if (scenario.includes('off-topic') || scenario.includes('unrelated')) {
      return 'Mid-conversation, to test agent\'s handling';
    }
    if (scenario.includes('budget') || scenario.includes('price') || scenario.includes('cost')) {
      return 'When discussing options or recommendations';
    }
    
    // Default based on position
    if (index < total / 3) {
      return 'Early in conversation, during information gathering';
    }
    if (index < 2 * total / 3) {
      return 'Mid-conversation, during main discussion';
    }
    return 'Later in conversation, before wrapping up';
  }

  /**
   * Analyze expected conversation flow from test cases
   */
  private analyzeExpectedConversationFlow(testCases: SmartTestCase[]): string {
    const phases: string[] = [];
    
    // Identify phases based on test case order
    const firstThird = testCases.slice(0, Math.ceil(testCases.length / 3));
    const middleThird = testCases.slice(Math.ceil(testCases.length / 3), Math.ceil(2 * testCases.length / 3));
    const lastThird = testCases.slice(Math.ceil(2 * testCases.length / 3));
    
    // Analyze first third
    const firstTopics = [...new Set(firstThird.map(tc => tc.keyTopicName || 'general'))];
    phases.push(`Opening (${firstTopics.join(', ')})`);
    
    // Analyze middle
    if (middleThird.length > 0) {
      const middleTopics = [...new Set(middleThird.map(tc => tc.keyTopicName || 'general'))];
      phases.push(`Main (${middleTopics.join(', ')})`);
    }
    
    // Analyze last third
    const lastTopics = [...new Set(lastThird.map(tc => tc.keyTopicName || 'closing'))];
    phases.push(`Closing (${lastTopics.join(', ')})`);
    
    return phases.join(' → ');
  }

  /**
   * Analyze what the agent is trying to do based on their message
   */
  private analyzeAgentIntent(message: string): string {
    const lowerMsg = message.toLowerCase();
    
    // Check for questions
    if (/\?/.test(message)) {
      if (/name|who are you|speaking with/i.test(lowerMsg)) {
        return 'Asking for your name/introduction';
      }
      if (/budget|cost|price|afford|how much|spend/i.test(lowerMsg)) {
        return 'Asking about budget/financial situation';
      }
      if (/education|degree|academic|study|cgpa|gpa|qualification/i.test(lowerMsg)) {
        return 'Asking about educational background';
      }
      if (/country|where|destination|prefer|interested/i.test(lowerMsg)) {
        return 'Asking about destination/location preferences';
      }
      if (/email|contact|phone|reach|number/i.test(lowerMsg)) {
        return 'Asking for contact information';
      }
      if (/anything else|other questions|help.*with/i.test(lowerMsg)) {
        return 'Checking if you have more questions (opportunity to bring up scenarios!)';
      }
      if (/confirm|correct|right/i.test(lowerMsg)) {
        return 'Asking for confirmation';
      }
      return 'Asking a question - answer it, then pivot to next scenario';
    }
    
    // Check for statements/information
    if (/recommend|suggest|option|consider/i.test(lowerMsg)) {
      return 'Giving recommendations - opportunity to ask follow-up or raise objection';
    }
    if (/eligible|qualify|meet.*requirement/i.test(lowerMsg)) {
      return 'Discussing eligibility - can ask clarifying questions';
    }
    if (/sorry|unfortunately|cannot|can\'t/i.test(lowerMsg)) {
      return 'Giving negative/limiting information - can ask for alternatives';
    }
    if (/goodbye|bye|thank.*calling|nice talking/i.test(lowerMsg)) {
      return 'Trying to end call - keep going if scenarios remain!';
    }
    
    return 'Providing information - acknowledge and guide toward next scenario';
  }

  /**
   * Get the action the test caller should take for a specific test case
   */
  private getTestCaseAction(tc: SmartTestCase): string {
    const scenario = `${tc.scenario || ''} ${tc.userInput || ''}`.toLowerCase();
    const name = tc.name.toLowerCase();
    
    // Determine action based on test case type
    if (name.includes('budget') || scenario.includes('budget')) {
      return 'State your budget when asked, or ask "What budget range would you recommend?"';
    }
    if (name.includes('education') || scenario.includes('cgpa') || scenario.includes('degree')) {
      return 'Share your educational background when asked, or mention your qualifications';
    }
    if (name.includes('country') || scenario.includes('destination')) {
      return 'Express your country preferences when asked, or ask about specific destinations';
    }
    if (name.includes('objection') || scenario.includes('concern') || scenario.includes('worried')) {
      return 'Express doubt or concern about something the agent mentioned';
    }
    if (name.includes('off-topic') || scenario.includes('unrelated')) {
      return 'Bring up an unrelated topic to test agent\'s handling';
    }
    if (name.includes('clarif') || scenario.includes('repeat') || scenario.includes('unclear')) {
      return 'Ask the agent to repeat or clarify something';
    }
    if (name.includes('callback') || scenario.includes('call back')) {
      return 'Ask if they can call you back later';
    }
    if (tc.isCallClosing || scenario.includes('bye') || scenario.includes('end')) {
      return 'ONLY use at END: Thank them and say goodbye';
    }
    if (scenario.includes('eligib')) {
      return 'Ask about eligibility requirements or if you qualify';
    }
    
    // Default action based on user input
    if (tc.userInput) {
      return `Say something like: "${tc.userInput.substring(0, 50)}..."`;
    }
    
    return 'Bring up this topic naturally in conversation';
  }

  /**
   * Generate test caller response - INTELLIGENT version
   * Uses the pre-ordered test cases and understands conversation context
   */
  private async generateBatchTestCallerResponse(
    conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    remainingCases: SmartTestCase[],
    currentIndex: number
  ): Promise<{ text: string; testCaseId?: string }> {
    const messages = [...conversationHistory];
    
    // Get the last agent message to understand what they asked
    const lastAgentMessage = conversationHistory
      .filter(m => m.role === 'user') // In our history, agent messages are stored as 'user'
      .pop()?.content || '';
    
    // Identify the NEXT test case we should focus on (first in remaining)
    const nextTestCase = remainingCases[0];
    const isLastTestCase = remainingCases.length === 1;
    const isCallEnding = nextTestCase?.isCallClosing || 
      nextTestCase?.scenario?.toLowerCase().includes('bye') ||
      nextTestCase?.scenario?.toLowerCase().includes('end') ||
      nextTestCase?.scenario?.toLowerCase().includes('close');
    
    // Build prioritized remaining scenarios
    const remainingScenarios = remainingCases.length > 0 
      ? remainingCases.map((tc, idx) => {
          const priority = idx === 0 ? '🎯 NEXT' : idx < 3 ? '📌 SOON' : '📝 LATER';
          const callEndingTag = tc.isCallClosing ? ' [ENDS CALL]' : '';
          return `${priority}: "${tc.name}" - ${tc.userInput || tc.scenario}${callEndingTag}`;
        }).join('\n')
      : '✅ All scenarios covered!';
    
    // Determine response strategy based on context
    let responseStrategy = '';
    if (remainingCases.length === 0) {
      responseStrategy = 'All scenarios covered. You can now end the call naturally.';
    } else if (isLastTestCase && isCallEnding) {
      responseStrategy = `This is the LAST scenario and it will END the call. Execute it now: "${nextTestCase.scenario}"`;
    } else if (isCallEnding && remainingCases.length > 1) {
      responseStrategy = `The next scenario ends the call, but you have ${remainingCases.length - 1} more scenarios. Skip to the non-ending scenarios first.`;
    } else {
      responseStrategy = `Focus on the NEXT scenario: "${nextTestCase?.name}". Trigger it naturally based on what the agent said.`;
    }
    
    // Analyze what the agent said
    const agentIntent = this.analyzeAgentIntent(lastAgentMessage);
    
    // Build intelligent guidance
    const guidancePrompt = `The agent just said: "${lastAgentMessage}"

AGENT'S LIKELY INTENT: ${agentIntent}

=== YOUR RESPONSE STRATEGY ===
${responseStrategy}

=== REMAINING TEST SCENARIOS (PRIORITIZED) ===
${remainingScenarios}

=== NEXT SCENARIO DETAILS ===
${nextTestCase ? `Name: ${nextTestCase.name}
Scenario: ${nextTestCase.scenario || nextTestCase.userInput}
Expected outcome: ${nextTestCase.expectedOutcome || 'Natural response'}
Your action: ${this.getTestCaseAction(nextTestCase)}` : 'None - all scenarios covered!'}

=== RESPONSE RULES ===
1. If agent ASKED A QUESTION: Answer it (use persona), then pivot to next scenario
2. If agent gave INFORMATION: Acknowledge, then trigger the next scenario
3. If agent is WRAPPING UP: Say you have more questions to keep conversation going
4. If next scenario is CALL ENDING: Only use it if all other scenarios are done
5. Keep response to 1-2 sentences
6. Be natural - you're a curious customer, not a robot

=== DO NOT ===
- Don't end the call until call-ending scenario
- Don't skip scenarios
- Don't be passive - actively drive toward remaining scenarios
- Don't say "as you mentioned" unless they actually mentioned it

Generate Alex's natural response:`;

    messages.push({
      role: 'user',
      content: guidancePrompt,
    });

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',  // Use GPT-4 for better context understanding
        messages: messages as any,
        temperature: 0.5,
        max_tokens: 100,
      });

      const responseText = response.choices[0]?.message?.content?.trim() || "Okay, I understand.";
      
      // Try to match what was discussed to a test case for tracking
      const relevantCase = this.findRelevantTestCase(lastAgentMessage, remainingCases) || nextTestCase;
      
      return {
        text: responseText,
        testCaseId: relevantCase?.id,
      };
    } catch (error) {
      console.error('[BatchedExecutor] OpenAI error:', error);
      return {
        text: "Okay, please continue.",
        testCaseId: undefined,
      };
    }
  }

  /**
   * Find a test case that's relevant to the agent's current question
   */
  private findRelevantTestCase(
    agentMessage: string, 
    remainingCases: SmartTestCase[]
  ): SmartTestCase | null {
    if (!agentMessage || remainingCases.length === 0) return null;
    
    const agentLower = agentMessage.toLowerCase();
    
    // Common question patterns and their related test case keywords
    const questionMappings: Array<{ patterns: RegExp[]; keywords: string[] }> = [
      { 
        patterns: [/budget/i, /how much/i, /price/i, /cost/i, /afford/i, /money/i, /spend/i, /lakh/i, /rupee/i],
        keywords: ['budget', 'cost', 'price', 'money', 'afford', 'lakh', 'rupee', 'currency']
      },
      { 
        patterns: [/name/i, /who.*(?:am|are|speaking)/i, /call you/i, /your name/i],
        keywords: ['name', 'introduction', 'greeting']
      },
      { 
        patterns: [/education/i, /degree/i, /academic/i, /study/i, /school/i, /college/i, /university/i, /cgpa/i, /gpa/i, /grade/i],
        keywords: ['education', 'academic', 'degree', 'cgpa', 'gpa', 'grade', 'background', 'qualification']
      },
      { 
        patterns: [/country/i, /where.*(?:want|like|go|study)/i, /destination/i, /location/i, /abroad/i],
        keywords: ['country', 'destination', 'abroad', 'location', 'where']
      },
      { 
        patterns: [/eligible/i, /qualify/i, /requirements/i, /criteria/i],
        keywords: ['eligible', 'eligibility', 'qualify', 'requirement', 'criteria']
      },
      { 
        patterns: [/email/i, /contact/i, /reach/i, /phone/i, /number/i],
        keywords: ['email', 'contact', 'phone', 'number', 'reach']
      },
      { 
        patterns: [/callback/i, /call.*back/i, /later/i, /schedule/i],
        keywords: ['callback', 'call back', 'later', 'schedule']
      },
      {
        patterns: [/thank/i, /goodbye/i, /bye/i, /helpful/i],
        keywords: ['thank', 'goodbye', 'bye', 'end', 'closing']
      }
    ];
    
    // First try to match based on question patterns
    for (const mapping of questionMappings) {
      const matchesQuestion = mapping.patterns.some(p => p.test(agentMessage));
      if (matchesQuestion) {
        // Find a test case that matches these keywords
        for (const tc of remainingCases) {
          const tcText = `${tc.name} ${tc.scenario} ${tc.userInput} ${tc.category}`.toLowerCase();
          const matchCount = mapping.keywords.filter(kw => tcText.includes(kw)).length;
          if (matchCount >= 1) {
            return tc;
          }
        }
      }
    }
    
    // Fallback: Look for keyword matches between agent's question and test cases
    for (const tc of remainingCases) {
      const testKeywords = [
        ...tc.name.toLowerCase().split(/\s+/),
        ...tc.scenario.toLowerCase().split(/\s+/),
        ...(tc.category?.toLowerCase().split(/\s+/) || []),
      ].filter(w => w.length > 3);
      
      // Check if agent is asking about something related to this test case
      const matchCount = testKeywords.filter(keyword => 
        agentLower.includes(keyword)
      ).length;
      
      if (matchCount >= 2) {
        return tc;
      }
    }
    
    // If agent is asking ANY question, return the first remaining case
    const isAskingQuestion = /\?/.test(agentMessage) || 
      /(?:what|where|when|how|who|which|could you|can you|would you|tell me)/i.test(agentMessage);
    
    if (isAskingQuestion && remainingCases.length > 0) {
      return remainingCases[0];
    }
    
    return null;
  }

  /**
   * Check if batch conversation should end
   */
  private shouldEndBatchConversation(
    agentMessage: string,
    turnCount: number,
    testedCount: number,
    totalCount: number
  ): boolean {
    // Don't end too early - need at least some turns
    if (turnCount < 10) {
      return false;
    }
    
    // End if all test cases have been covered and agent is wrapping up
    if (testedCount >= totalCount) {
      return true;
    }
    
    // End if agent says goodbye and we've covered most cases
    const goodbyePatterns = [/\bgoodbye\b/i, /\bbye\b/i, /take care/i, /have a (?:good|great|nice)/i];
    if (turnCount >= 15 && testedCount >= totalCount * 0.7) {
      for (const pattern of goodbyePatterns) {
        if (pattern.test(agentMessage)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Analyze transcript to evaluate each test case
   */
  private async analyzeTranscriptForTestCases(
    transcript: ConversationTurn[],
    testCases: SmartTestCase[],
    agentPrompt: string
  ): Promise<BatchTestResult[]> {
    const transcriptText = transcript
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const systemPrompt = `You are a QA analyst evaluating a voice AI agent conversation. 
Analyze the transcript and determine if each test case was successfully tested and passed.

For each test case, evaluate:
1. Was the scenario covered in the conversation?
2. Did the agent respond appropriately?
3. Did the response meet the expected outcome?

Return JSON:
{
  "results": [
    {
      "testCaseId": "id",
      "testCaseName": "name",
      "passed": true/false,
      "score": 0-100,
      "actualResponse": "What the agent actually said for this test case",
      "reasoning": "Why it passed or failed",
      "turnsCovered": [1, 2, 3]
    }
  ]
}`;

    const testCaseContext = testCases.map(tc => 
      `- ID: ${tc.id}\n  Name: ${tc.name}\n  Scenario: ${tc.scenario}\n  Expected: ${tc.expectedOutcome}`
    ).join('\n\n');

    const userPrompt = `TRANSCRIPT:
${transcriptText}

TEST CASES TO EVALUATE:
${testCaseContext}

AGENT PROMPT (for context):
${agentPrompt}

Analyze and return results as JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
        max_tokens: 2000,
      });

      const analysis = JSON.parse(response.choices[0].message.content || '{"results": []}');
      
      // Create a map of test cases for lookup
      const testCaseMap = new Map(testCases.map(tc => [tc.id, tc]));
      
      // Process results and generate AI suggestions for failed tests
      const results = await Promise.all((analysis.results || []).map(async (r: any) => {
        // Look up the original test case to ensure we use exact name
        const originalTc = testCaseMap.get(r.testCaseId);
        
        const result: BatchTestResult = {
          testCaseId: r.testCaseId,
          // Use the original test case name, not what GPT returned
          testCaseName: originalTc?.name || r.testCaseName,
          passed: r.passed || false,
          score: r.score || 0,
          actualResponse: r.actualResponse || '',
          metrics: { reasoning: r.reasoning },
          turnsCovered: r.turnsCovered || [],
        };

        // Generate AI-powered prompt suggestions for failed tests
        if (!result.passed && originalTc) {
          try {
            const suggestions = await promptSuggestionService.generatePromptSuggestions({
              testCaseName: originalTc.name,
              category: originalTc.category || 'General',
              scenario: originalTc.scenario,
              userInput: originalTc.userInput,
              expectedResponse: originalTc.expectedOutcome,
              actualResponse: result.actualResponse,
              agentTranscript: transcriptText,
            });
            result.promptSuggestions = suggestions;
            console.log(`[BatchedExecutor] Generated ${suggestions.length} AI suggestions for failed test: ${originalTc.name}`);
          } catch (error) {
            console.error(`[BatchedExecutor] Failed to generate suggestions for ${originalTc.name}:`, error);
          }
        }

        return result;
      }));

      return results;
    } catch (error) {
      console.error('[BatchedExecutor] Analysis error:', error);
      
      // Return failed results for all test cases
      return testCases.map(tc => ({
        testCaseId: tc.id,
        testCaseName: tc.name,
        passed: false,
        score: 0,
        actualResponse: 'Analysis failed',
        metrics: {},
        turnsCovered: [],
      }));
    }
  }

  /**
   * Send audio to agent via WebSocket with silence padding
   */
  private async sendAudioToAgent(ws: WebSocket, audioBuffer: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const chunkSize = 8000;
      let offset = 0;
      
      // Add silence at the end
      const silenceBuffer = Buffer.alloc(12000, 0xFF);
      const audioWithSilence = Buffer.concat([audioBuffer, silenceBuffer]);

      const sendChunk = () => {
        if (offset >= audioWithSilence.length) {
          resolve();
          return;
        }

        const chunk = audioWithSilence.slice(offset, offset + chunkSize);
        offset += chunkSize;

        try {
          ws.send(JSON.stringify({
            user_audio_chunk: chunk.toString('base64'),
          }));
        } catch (e) {
          console.error('[BatchedExecutor] Error sending audio:', e);
        }

        setTimeout(sendChunk, 100);
      };

      sendChunk();
    });
  }
}

export const batchedTestExecutor = new BatchedTestExecutorService();
