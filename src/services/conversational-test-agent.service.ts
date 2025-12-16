/**
 * Conversational Test Agent Service
 * 
 * This service acts as a "test customer" that has real voice conversations
 * with the AI agent being tested. It uses:
 * - STT (Speech-to-Text) to transcribe agent responses
 * - OpenAI to generate contextual customer responses based on test scenario
 * - TTS (Text-to-Speech) to speak back to the agent
 * 
 * Flow:
 * 1. Connect to the voice agent (ElevenLabs/Retell/VAPI)
 * 2. Agent speaks greeting → STT transcribes
 * 3. OpenAI generates test customer response based on scenario
 * 4. TTS converts to audio → Send to agent
 * 5. Repeat until conversation concludes
 * 6. Fetch full transcript + recording from provider API
 */

import WebSocket from 'ws';
import OpenAI from 'openai';

// Use native fetch (Node 18+)
declare const fetch: typeof globalThis.fetch;

interface TestCase {
  id: string;
  name: string;
  scenario: string;
  userInput: string;
  expectedOutcome: string;
  category: string;
}

interface AgentConfig {
  provider: 'elevenlabs' | 'retell' | 'vapi';
  agentId: string;
  apiKey: string;
}

interface ConversationTurn {
  role: 'test_caller' | 'ai_agent';
  content: string;
  timestamp: number;
  durationMs?: number;
}

interface ConversationResult {
  callId: string;
  durationMs: number;
  transcript: ConversationTurn[];
  recordingUrl: string | null;
  agentTranscript: string;
  testCallerTranscript: string;
  messageCount: number;
  success: boolean;
  error?: string;
}

export class ConversationalTestAgentService {
  private openai: OpenAI;
  private elevenLabsApiKey: string;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || '';
  }

  /**
   * Execute a full conversational test with the voice agent
   */
  async executeConversationalTest(
    testCase: TestCase,
    agentConfig: AgentConfig
  ): Promise<ConversationResult> {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[ConversationalTestAgent] Starting test: ${testCase.name}`);
    console.log(`[ConversationalTestAgent] Provider: ${agentConfig.provider}`);
    console.log(`[ConversationalTestAgent] Agent ID: ${agentConfig.agentId}`);
    console.log(`[ConversationalTestAgent] API Key: ${agentConfig.apiKey?.substring(0, 10)}...`);
    console.log(`${'='.repeat(50)}\n`);
    
    const startTime = Date.now();

    try {
      switch (agentConfig.provider) {
        case 'elevenlabs':
          return await this.testWithElevenLabs(testCase, agentConfig, startTime);
        case 'retell':
          return await this.testWithRetell(testCase, agentConfig, startTime);
        case 'vapi':
          return await this.testWithVAPI(testCase, agentConfig, startTime);
        default:
          throw new Error(`Unsupported provider: ${agentConfig.provider}`);
      }
    } catch (error) {
      console.error(`[ConversationalTestAgent] Test failed:`, error);
      return {
        callId: '',
        durationMs: Date.now() - startTime,
        transcript: [],
        recordingUrl: null,
        agentTranscript: '',
        testCallerTranscript: '',
        messageCount: 0,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Test with ElevenLabs Conversational AI using Simulate Conversation API
   * This is text-based simulation that allows us to test the agent's responses
   * without needing actual voice/audio processing.
   * 
   * Set useRealAudio=true in agentConfig to use WebSocket with TTS for real recordings.
   */
  private async testWithElevenLabs(
    testCase: TestCase,
    agentConfig: AgentConfig,
    startTime: number
  ): Promise<ConversationResult> {
    const effectiveApiKey = this.elevenLabsApiKey || agentConfig.apiKey;
    
    // Check if we should use real audio mode for recordings
    if ((agentConfig as any).useRealAudio) {
      console.log(`[ConversationalTestAgent] Using ElevenLabs WebSocket with Real Audio`);
      return this.testWithElevenLabsRealAudio(testCase, agentConfig, startTime);
    }
    
    console.log(`[ConversationalTestAgent] Using ElevenLabs Simulate Conversation API`);
    console.log(`[ConversationalTestAgent] Agent ID: ${agentConfig.agentId}`);
    
    try {
      // Build the simulated user prompt based on the test case
      const simulatedUserPrompt = this.buildSimulatedUserPrompt(testCase);
      
      console.log(`[ConversationalTestAgent] Starting simulation with prompt for: ${testCase.name}`);
      
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/agents/${agentConfig.agentId}/simulate-conversation`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': effectiveApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            simulation_specification: {
              simulated_user_config: {
                first_message: testCase.userInput || 'Hello',
                prompt: {
                  prompt: simulatedUserPrompt,
                  llm: 'gpt-4o-mini',
                  temperature: 0.7,
                },
              },
            },
            new_turns_limit: 10, // Limit conversation to 10 turns
          }),
        }
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[ConversationalTestAgent] Simulation API error: ${errorText}`);
        throw new Error(`Simulation failed: ${errorText}`);
      }
      
      const data = await response.json() as {
        simulated_conversation: Array<{
          role: 'agent' | 'user';
          message: string | null;
          tool_calls?: Array<{ tool_name: string }>;
          time_in_call_secs?: number;
        }>;
        analysis?: {
          call_successful?: string;
          transcript_summary?: string;
        };
      };
      
      console.log(`[ConversationalTestAgent] Simulation completed with ${data.simulated_conversation.length} turns`);
      
      // Convert simulated conversation to our transcript format
      const transcript: ConversationTurn[] = data.simulated_conversation
        .filter(turn => turn.message) // Filter out turns with no message
        .map((turn, index) => ({
          role: turn.role === 'agent' ? 'ai_agent' : 'test_caller',
          content: turn.message || '',
          timestamp: startTime + (index * 5000), // Estimate 5 seconds per turn
          durationMs: 5000,
        }));
      
      // Build agent and test caller transcripts
      const agentTranscript = transcript
        .filter(t => t.role === 'ai_agent')
        .map(t => t.content)
        .join('\n');
      
      const testCallerTranscript = transcript
        .filter(t => t.role === 'test_caller')
        .map(t => t.content)
        .join('\n');
      
      // Log the conversation
      console.log(`[ConversationalTestAgent] Conversation transcript:`);
      transcript.forEach((turn, i) => {
        const role = turn.role === 'ai_agent' ? 'AGENT' : 'TEST CALLER';
        console.log(`  [${role}]: ${turn.content.substring(0, 100)}...`);
      });
      
      const durationMs = Date.now() - startTime;
      const success = transcript.length > 0;
      
      console.log(`[ConversationalTestAgent] Test ${success ? 'PASSED' : 'FAILED'}: ${transcript.length} messages in ${durationMs}ms`);
      
      return {
        callId: `sim_${Date.now()}`,
        durationMs,
        transcript,
        recordingUrl: null, // No recording for simulated conversations
        agentTranscript,
        testCallerTranscript,
        messageCount: transcript.length,
        success,
        error: success ? undefined : 'No conversation recorded',
      };
      
    } catch (error) {
      console.error(`[ConversationalTestAgent] Simulation error:`, error);
      throw error;
    }
  }
  
  /**
   * Build the simulated user prompt based on test case
   */
  private buildSimulatedUserPrompt(testCase: TestCase): string {
    console.log(`[SimulatedUserPrompt] Building prompt with test case:`);
    console.log(`  - Scenario: ${testCase.scenario}`);
    console.log(`  - UserInput: ${testCase.userInput}`);
    console.log(`  - ExpectedOutcome: ${testCase.expectedOutcome}`);
    
    return `You are a TEST CALLER simulating a real customer for QA testing of a voice AI agent.

YOUR ROLE:
- You are testing the AI agent by acting as a REAL CUSTOMER
- Behave naturally like a human would on a phone call
- Follow the test scenario to evaluate the agent's responses

TEST SCENARIO:
${testCase.scenario}

YOUR GOAL/OBJECTIVE (this is what you should be testing):
${testCase.userInput}

EXPECTED AGENT BEHAVIOR:
${testCase.expectedOutcome}

CRITICAL INSTRUCTIONS:
1. Your FIRST response after the agent's greeting should work towards the test objective: "${testCase.userInput}"
2. Stay focused on the test scenario throughout the conversation
3. Ask relevant questions a real customer would ask
4. React naturally to the agent's responses
5. If the agent asks questions, answer them based on the scenario
6. Keep responses conversational (1-3 sentences typically)
7. If the agent provides incorrect information, gently challenge it
8. When the conversation reaches a natural conclusion, say goodbye politely

REMEMBER: You are testing whether the agent handles "${testCase.scenario}" correctly.

Respond with ONLY what you would say as the customer. No explanations or meta-commentary.`;
  }

  /**
   * Test with ElevenLabs using WebSocket with REAL AUDIO
   * This method generates TTS audio for test caller responses and captures agent audio for recording.
   */
  private async testWithElevenLabsRealAudio(
    testCase: TestCase,
    agentConfig: AgentConfig,
    startTime: number
  ): Promise<ConversationResult> {
    return new Promise(async (resolve, reject) => {
      const transcript: ConversationTurn[] = [];
      const allAudioChunks: Buffer[] = []; // Collect all agent audio for recording
      const userAudioChunks: Buffer[] = []; // Collect all user audio
      // Combined recording with both sides interleaved in order
      const conversationAudioSegments: Array<{ role: 'agent' | 'user'; audio: Buffer }> = [];
      let callId = '';
      let currentAgentResponse = '';
      let currentAgentAudioChunks: Buffer[] = []; // Temp buffer for current agent turn
      let conversationComplete = false;
      let turnCount = 0;
      const maxTurns = 30; // High safety limit - conversation ends naturally on goodbye, not by turn count
      let agentSpeaking = false;
      let silenceTimer: NodeJS.Timeout | null = null;
      let isProcessingResponse = false;
      let waitingForAgentGreeting = true;
      let agentResponseTimer: NodeJS.Timeout | null = null; // Timer to detect when agent stops responding
      
      const effectiveApiKey = this.elevenLabsApiKey || agentConfig.apiKey;
      
      // Audio format expected by the agent (will be set by conversation_initiation_metadata)
      let expectedInputFormat = 'pcm_16000';
      
      // Initialize TTS service for generating test caller audio
      const ttsService = new (require('./tts.service').TTSService)(effectiveApiKey);
      
      // Build conversation history for OpenAI
      const systemPrompt = this.buildTestCallerPrompt(testCase);
      const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      // Process agent's turn and generate test caller response
      const processAgentTurn = async (ws: WebSocket) => {
        if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) return;
        isProcessingResponse = true;
        
        turnCount++;
        const agentMessage = currentAgentResponse.trim();
        console.log(`[RealAudio] Agent (turn ${turnCount}): ${agentMessage.substring(0, 100)}...`);
        
        // Save agent audio segment for this turn
        if (currentAgentAudioChunks.length > 0) {
          const agentTurnAudio = Buffer.concat(currentAgentAudioChunks);
          conversationAudioSegments.push({ role: 'agent', audio: agentTurnAudio });
          console.log(`[RealAudio] Saved agent audio segment: ${agentTurnAudio.length} bytes`);
          currentAgentAudioChunks = []; // Reset for next turn
        }
        
        // Record agent turn
        transcript.push({
          role: 'ai_agent',
          content: agentMessage,
          timestamp: Date.now(),
        });

        conversationHistory.push({ role: 'user', content: agentMessage });
        waitingForAgentGreeting = false;

        // Check if conversation should end
        if (this.shouldEndConversation(agentMessage, turnCount, maxTurns, testCase)) {
          console.log(`[RealAudio] Ending conversation after ${turnCount} turns`);
          conversationComplete = true;
          
          // Generate goodbye
          const goodbyeResponse = await this.generateTestCallerResponse(conversationHistory, true);
          if (goodbyeResponse) {
            console.log(`[RealAudio] Test Caller (goodbye): ${goodbyeResponse}`);
            transcript.push({
              role: 'test_caller',
              content: goodbyeResponse,
              timestamp: Date.now(),
            });
            
            // Generate and send audio in the correct format
            try {
              const ttsResult = expectedInputFormat.includes('ulaw') 
                ? await ttsService.generateSpeechUlaw({ text: goodbyeResponse })
                : await ttsService.generateSpeechPCM({ text: goodbyeResponse });
              userAudioChunks.push(ttsResult.audioBuffer);
              // Add to conversation recording
              conversationAudioSegments.push({ role: 'user', audio: ttsResult.audioBuffer });
              console.log(`[RealAudio] Saved user goodbye audio: ${ttsResult.audioBuffer.length} bytes`);
              await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
            } catch (e) {
              console.error(`[RealAudio] TTS error for goodbye:`, e);
            }
          }
          
          setTimeout(() => ws.close(), 3000);
        } else {
          // Generate test caller response - THIS MUST ALWAYS SUCCEED
          let testCallerResponse = '';
          let retryCount = 0;
          const maxRetries = 3;
          
          while (!testCallerResponse && retryCount < maxRetries) {
            try {
              testCallerResponse = await this.generateTestCallerResponse(conversationHistory);
              if (!testCallerResponse) {
                retryCount++;
                console.log(`[RealAudio] Empty response from OpenAI, retry ${retryCount}/${maxRetries}`);
                await new Promise(r => setTimeout(r, 500)); // Small delay before retry
              }
            } catch (openAiError) {
              retryCount++;
              console.error(`[RealAudio] OpenAI error (retry ${retryCount}/${maxRetries}):`, openAiError);
              await new Promise(r => setTimeout(r, 500));
            }
          }
          
          // Fallback response if OpenAI fails completely
          if (!testCallerResponse) {
            console.log(`[RealAudio] Using fallback response after ${maxRetries} failed attempts`);
            testCallerResponse = this.getFallbackResponse(testCase, turnCount);
          }
          
          console.log(`[RealAudio] Test Caller (turn ${turnCount}): ${testCallerResponse}`);
          
          transcript.push({
            role: 'test_caller',
            content: testCallerResponse,
            timestamp: Date.now(),
          });
          
          conversationHistory.push({ role: 'assistant', content: testCallerResponse });
          
          // Generate and send audio in the correct format - with retry
          let ttsSuccess = false;
          let ttsRetries = 0;
          
          while (!ttsSuccess && ttsRetries < 3) {
            try {
              const ttsResult = expectedInputFormat.includes('ulaw') 
                ? await ttsService.generateSpeechUlaw({ text: testCallerResponse })
                : await ttsService.generateSpeechPCM({ text: testCallerResponse });
              userAudioChunks.push(ttsResult.audioBuffer);
              // Add to conversation recording
              conversationAudioSegments.push({ role: 'user', audio: ttsResult.audioBuffer });
              console.log(`[RealAudio] Saved user audio segment: ${ttsResult.audioBuffer.length} bytes, sending ${expectedInputFormat}`);
              await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
              ttsSuccess = true;
              
              // Start a timer to detect if agent doesn't respond within 30 seconds
              if (agentResponseTimer) clearTimeout(agentResponseTimer);
              agentResponseTimer = setTimeout(() => {
                if (!conversationComplete && !isProcessingResponse && !currentAgentResponse.trim()) {
                  console.log(`[RealAudio] Agent not responding for 30s after turn ${turnCount}, ending conversation`);
                  conversationComplete = true;
                  ws.close();
                }
              }, 30000);
            } catch (e) {
              ttsRetries++;
              console.error(`[RealAudio] TTS error (retry ${ttsRetries}/3):`, e);
              await new Promise(r => setTimeout(r, 500));
            }
          }
          
          if (!ttsSuccess) {
            console.error(`[RealAudio] TTS failed after 3 retries, but test caller response was recorded`);
          }
        }

        currentAgentResponse = '';
        isProcessingResponse = false;
      };

      try {
        // Get signed URL for WebSocket
        console.log(`[RealAudio] Getting signed URL for agent: ${agentConfig.agentId}`);
        
        const signedUrlResponse = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentConfig.agentId}`,
          {
            method: 'GET',
            headers: { 'xi-api-key': effectiveApiKey },
          }
        );

        if (!signedUrlResponse.ok) {
          const errorText = await signedUrlResponse.text();
          throw new Error(`Failed to get signed URL: ${errorText}`);
        }

        const { signed_url } = await signedUrlResponse.json() as { signed_url: string };
        console.log(`[RealAudio] Connecting to WebSocket...`);
        
        const ws = new WebSocket(signed_url);
        let conversationInitialized = false;

        const timeout = setTimeout(() => {
          console.log(`[RealAudio] Timeout after 3 minutes`);
          conversationComplete = true;
          ws.close();
        }, 180000);

        // Function to send initial greeting only after conversation is initialized
        const sendInitialGreetingIfNeeded = async () => {
          if (!conversationInitialized || !waitingForAgentGreeting) return;
          
          // Wait a bit for agent to potentially send its own greeting first
          setTimeout(async () => {
            if (waitingForAgentGreeting && transcript.length === 0 && turnCount === 0) {
              console.log(`[RealAudio] Sending initial greeting with format: ${expectedInputFormat}`);
              try {
                const initialGreeting = "Hello?";
                // Use the correct audio format based on what the agent expects
                const ttsResult = expectedInputFormat.includes('ulaw') 
                  ? await ttsService.generateSpeechUlaw({ text: initialGreeting })
                  : await ttsService.generateSpeechPCM({ text: initialGreeting });
                userAudioChunks.push(ttsResult.audioBuffer);
                await this.sendAudioToAgent(ws, ttsResult.audioBuffer);
                console.log(`[RealAudio] Initial greeting sent (${expectedInputFormat}, ${ttsResult.audioBuffer.length} bytes)`);
              } catch (e) {
                console.error(`[RealAudio] Error sending initial greeting:`, e);
              }
            }
          }, 3000); // Wait 3 seconds for agent to greet first
        };

        ws.on('open', async () => {
          console.log(`[RealAudio] WebSocket connected, waiting for conversation_initiation_metadata...`);
        });

        let messageCount = 0;
        
        ws.on('message', async (data: Buffer) => {
          messageCount++;
          
          // Log all incoming messages for debugging
          if (messageCount <= 20 || messageCount % 50 === 0) {
            if (Buffer.isBuffer(data) && data[0] !== 123) {
              console.log(`[RealAudio] Message #${messageCount}: Binary audio (${data.length} bytes)`);
            } else {
              try {
                const parsed = JSON.parse(data.toString());
                console.log(`[RealAudio] Message #${messageCount}: ${parsed.type || 'unknown'}`);
              } catch {
                console.log(`[RealAudio] Message #${messageCount}: Raw data (${data.length} bytes)`);
              }
            }
          }
          try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
              case 'conversation_initiation_metadata':
                callId = message.conversation_initiation_metadata_event?.conversation_id || message.conversation_id;
                const inputFormat = message.conversation_initiation_metadata_event?.user_input_audio_format;
                const outputFormat = message.conversation_initiation_metadata_event?.agent_output_audio_format;
                console.log(`[RealAudio] Conversation started: ${callId}`);
                console.log(`[RealAudio] Expected input format: ${inputFormat}, output format: ${outputFormat}`);
                expectedInputFormat = inputFormat || 'pcm_16000';
                conversationInitialized = true;
                
                // Now that conversation is initialized, we can send audio if needed
                sendInitialGreetingIfNeeded();
                break;

              case 'agent_response':
                console.log(`[RealAudio] agent_response raw:`, JSON.stringify(message).substring(0, 500));
                // Clear the "no response" timer since agent is responding
                if (agentResponseTimer) clearTimeout(agentResponseTimer);
                
                const agentText = message.agent_response_event?.agent_response || 
                                  message.agent_response || 
                                  message.text || '';
                if (agentText) {
                  console.log(`[RealAudio] Agent speaking: "${agentText}"`);
                  agentSpeaking = true;
                  currentAgentResponse += agentText + ' ';
                  
                  // Set a timer to process after agent finishes speaking
                  if (silenceTimer) clearTimeout(silenceTimer);
                  silenceTimer = setTimeout(() => {
                    if (currentAgentResponse.trim()) {
                      console.log(`[RealAudio] Agent response complete, processing turn...`);
                      agentSpeaking = false;
                      processAgentTurn(ws);
                    }
                  }, 3000); // Wait 3 seconds after text to confirm agent is done
                }
                break;

              case 'audio':
              case 'audio_event':
                // Agent audio - capture for recording
                const audioData = message.audio_event?.audio_base_64 || message.audio_base_64;
                if (audioData) {
                  const audioBuffer = Buffer.from(audioData, 'base64');
                  allAudioChunks.push(audioBuffer);
                  currentAgentAudioChunks.push(audioBuffer); // Also add to current turn buffer
                }
                
                agentSpeaking = true;
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  if (agentSpeaking && currentAgentResponse.trim()) {
                    agentSpeaking = false;
                    processAgentTurn(ws);
                  }
                }, 2500);
                break;

              case 'user_transcript':
                const userText = message.user_transcript_event?.user_transcript || message.user_transcript;
                if (userText) {
                  console.log(`[RealAudio] Agent transcribed: "${userText.substring(0, 50)}..."`);
                }
                break;

              case 'ping':
                const pingEventId = message.ping_event?.event_id || message.event_id;
                console.log(`[RealAudio] Received ping, responding with pong (event_id: ${pingEventId})`);
                ws.send(JSON.stringify({ type: 'pong', event_id: pingEventId }));
                break;

              case 'interruption':
                console.log(`[RealAudio] 🚨 INTERRUPTION event received:`, JSON.stringify(message));
                break;

              case 'agent_response_correction':
                console.log(`[RealAudio] 📝 Agent response correction:`, JSON.stringify(message));
                break;

              case 'internal_tentative_agent_response':
                console.log(`[RealAudio] 📝 Tentative agent response:`, JSON.stringify(message).substring(0, 200));
                break;

              case 'conversation_ended':
              case 'end':
              case 'session_end':
              case 'call_ended':
                console.log(`[RealAudio] 🛑 CONVERSATION END EVENT received: ${message.type}`, JSON.stringify(message));
                conversationComplete = true;
                break;

              default:
                // Log any unknown message types
                if (message.type && !['audio', 'audio_event'].includes(message.type)) {
                  console.log(`[RealAudio] 📨 Unknown message type: ${message.type}`, JSON.stringify(message).substring(0, 300));
                }
                break;
            }
          } catch (e) {
            // Binary audio data from agent
            if (Buffer.isBuffer(data)) {
              allAudioChunks.push(data);
              agentSpeaking = true;
              
              if (silenceTimer) clearTimeout(silenceTimer);
              silenceTimer = setTimeout(() => {
                if (agentSpeaking && currentAgentResponse.trim()) {
                  agentSpeaking = false;
                  processAgentTurn(ws);
                }
              }, 2500);
            }
          }
        });

        ws.on('close', async (code, reason) => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          if (agentResponseTimer) clearTimeout(agentResponseTimer);
          
          // Interpret close code
          const closeCodeMeaning: Record<number, string> = {
            1000: 'Normal closure',
            1001: 'Endpoint going away (agent ended call)',
            1002: 'Protocol error',
            1003: 'Unsupported data',
            1005: 'No status received',
            1006: 'Abnormal closure (connection lost)',
            1007: 'Invalid frame payload data',
            1008: 'Policy violation',
            1009: 'Message too big',
            1010: 'Missing extension',
            1011: 'Internal error',
            1012: 'Service restart',
            1013: 'Try again later',
            1014: 'Bad gateway',
            1015: 'TLS handshake failed',
          };
          
          console.log(`[RealAudio] 🔴 WebSocket closed:`);
          console.log(`[RealAudio]   Code: ${code} (${closeCodeMeaning[code] || 'Unknown'})`);
          console.log(`[RealAudio]   Reason: ${reason?.toString() || 'none'}`);
          console.log(`[RealAudio]   Transcript messages: ${transcript.length}`);
          console.log(`[RealAudio]   Turn count: ${turnCount}`);
          console.log(`[RealAudio]   conversationComplete flag: ${conversationComplete}`);
          console.log(`[RealAudio]   Current agent response buffer: "${currentAgentResponse.substring(0, 100)}"`);
          console.log(`[RealAudio]   Audio chunks: ${allAudioChunks.length}, Conversation segments: ${conversationAudioSegments.length}`);

          // Save any remaining agent audio
          if (currentAgentAudioChunks.length > 0) {
            const finalAgentAudio = Buffer.concat(currentAgentAudioChunks);
            conversationAudioSegments.push({ role: 'agent', audio: finalAgentAudio });
            console.log(`[RealAudio] Saved final agent audio segment: ${finalAgentAudio.length} bytes`);
          }

          // If we have a buffered agent response but processAgentTurn never fired, process it now
          // AND generate a test caller response - TEST CALLER MUST ALWAYS RESPOND
          if (currentAgentResponse.trim()) {
            const agentMessage = currentAgentResponse.trim();
            
            // Only add to transcript if not already there
            if (transcript.length === 0 || transcript[transcript.length - 1].content !== agentMessage) {
              console.log(`[RealAudio] Processing final agent response from buffer...`);
              transcript.push({
                role: 'ai_agent',
                content: agentMessage,
                timestamp: Date.now(),
              });
            }
            
            // Generate test caller response for the agent's message
            // This ensures we ALWAYS have at least one test caller response
            if (transcript.filter(t => t.role === 'test_caller').length === 0) {
              console.log(`[RealAudio] No test caller response yet, generating one...`);
              conversationHistory.push({ role: 'user', content: agentMessage });
              
              let testCallerResponse = '';
              try {
                testCallerResponse = await this.generateTestCallerResponse(conversationHistory);
              } catch (e) {
                console.error(`[RealAudio] Failed to generate response on close:`, e);
              }
              
              if (!testCallerResponse) {
                testCallerResponse = this.getFallbackResponse(testCase, 1);
              }
              
              console.log(`[RealAudio] Test Caller (final): ${testCallerResponse}`);
              transcript.push({
                role: 'test_caller',
                content: testCallerResponse,
                timestamp: Date.now(),
              });
            }
          }

          // Try to get recording from ElevenLabs API
          let recordingUrl: string | null = null;
          if (callId) {
            const conversationData = await this.fetchElevenLabsConversation(callId, effectiveApiKey);
            recordingUrl = conversationData?.recordingUrl || null;
          }
          
          // If no recording from API, create one from captured conversation audio segments
          // This combines BOTH agent and user audio in the order they occurred
          if (!recordingUrl && conversationAudioSegments.length > 0) {
            console.log(`[RealAudio] Creating full conversation recording from ${conversationAudioSegments.length} segments`);
            
            // Combine all segments in order (agent and user interleaved)
            const allSegments = conversationAudioSegments.map(s => s.audio);
            const combinedAudio = Buffer.concat(allSegments);
            
            const totalAgentBytes = conversationAudioSegments.filter(s => s.role === 'agent').reduce((sum, s) => sum + s.audio.length, 0);
            const totalUserBytes = conversationAudioSegments.filter(s => s.role === 'user').reduce((sum, s) => sum + s.audio.length, 0);
            console.log(`[RealAudio] Combined audio: ${combinedAudio.length} bytes (Agent: ${totalAgentBytes}, User: ${totalUserBytes})`);
            
            // Convert mu-law to WAV format for browser playback
            if (combinedAudio.length < 10 * 1024 * 1024) { // Allow up to 10MB
              // Convert ulaw to PCM-16 for WAV
              const pcmBuffer = this.ulawToPcm16(combinedAudio);
              
              // Create WAV file with proper header
              const wavBuffer = this.createWavBuffer(pcmBuffer, 8000, 1, 16);
              
              const base64Audio = wavBuffer.toString('base64');
              recordingUrl = `data:audio/wav;base64,${base64Audio}`;
              
              // Calculate duration: ulaw is 8000 samples/sec, 1 byte per sample
              const durationSecs = combinedAudio.length / 8000;
              console.log(`[RealAudio] Created full conversation WAV recording (${durationSecs.toFixed(1)}s, ${base64Audio.length} chars base64)`);
            } else {
              console.log(`[RealAudio] Audio too large for data URL (${combinedAudio.length} bytes), skipping`);
            }
          }

          const agentTranscript = transcript
            .filter(t => t.role === 'ai_agent')
            .map(t => t.content)
            .join('\n');
          const testCallerTranscript = transcript
            .filter(t => t.role === 'test_caller')
            .map(t => t.content)
            .join('\n');

          resolve({
            callId,
            durationMs: Date.now() - startTime,
            transcript,
            recordingUrl,
            agentTranscript,
            testCallerTranscript,
            messageCount: transcript.length,
            success: transcript.length > 0,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          if (agentResponseTimer) clearTimeout(agentResponseTimer);
          console.error(`[RealAudio] WebSocket error:`, error);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Legacy WebSocket-based test (kept for reference but not used)
   * This method uses real-time audio streaming via WebSocket.
   */
  private async testWithElevenLabsWebSocket(
    testCase: TestCase,
    agentConfig: AgentConfig,
    startTime: number
  ): Promise<ConversationResult> {
    return new Promise(async (resolve, reject) => {
      const transcript: ConversationTurn[] = [];
      let callId = '';
      let currentAgentResponse = '';
      let conversationComplete = false;
      let turnCount = 0;
      const maxTurns = 30; // High safety limit - conversation ends naturally on goodbye
      let lastAudioTime = Date.now();
      let agentSpeaking = false;
      let silenceTimer: NodeJS.Timeout | null = null;
      let isProcessingResponse = false;
      
      // Build the test caller persona prompt
      const systemPrompt = this.buildTestCallerPrompt(testCase);
      const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      // Function to process agent response and generate test caller reply
      const processAgentTurn = async (ws: WebSocket) => {
        if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) return;
        isProcessingResponse = true;
        
        turnCount++;
        const agentMessage = currentAgentResponse.trim();
        console.log(`[ConversationalTestAgent] Agent (turn ${turnCount}): ${agentMessage}`);
        
        // Record agent turn
        transcript.push({
          role: 'ai_agent',
          content: agentMessage,
          timestamp: Date.now(),
        });

        // Add to conversation history for OpenAI
        conversationHistory.push({ role: 'user', content: agentMessage });

        // Check if conversation should end
        if (this.shouldEndConversation(agentMessage, turnCount, maxTurns, testCase)) {
          console.log(`[ConversationalTestAgent] Ending conversation after ${turnCount} turns`);
          conversationComplete = true;
          
          // Generate final response (goodbye)
          const finalResponse = await this.generateTestCallerResponse(conversationHistory, true);
          
          if (finalResponse) {
            console.log(`[ConversationalTestAgent] Test Caller (goodbye): ${finalResponse}`);
            transcript.push({
              role: 'test_caller',
              content: finalResponse,
              timestamp: Date.now(),
            });
            
            // Send final audio
            const audioBuffer = await this.textToSpeech(finalResponse);
            if (audioBuffer) {
              await this.sendAudioToAgent(ws, audioBuffer);
            }
          }
          
          // Close after sending goodbye
          setTimeout(() => ws.close(), 5000);
        } else {
          // Generate test caller response
          const testCallerResponse = await this.generateTestCallerResponse(conversationHistory);
          
          if (testCallerResponse) {
            console.log(`[ConversationalTestAgent] Test Caller (turn ${turnCount}): ${testCallerResponse}`);
            
            // Record test caller turn
            transcript.push({
              role: 'test_caller',
              content: testCallerResponse,
              timestamp: Date.now(),
            });
            
            // Add to history
            conversationHistory.push({ role: 'assistant', content: testCallerResponse });
            
            // Convert to speech and send
            const audioBuffer = await this.textToSpeech(testCallerResponse);
            if (audioBuffer) {
              console.log(`[ConversationalTestAgent] Sending audio to agent (${audioBuffer.length} bytes)`);
              await this.sendAudioToAgent(ws, audioBuffer);
            }
          }
        }

        currentAgentResponse = '';
        isProcessingResponse = false;
      };

      try {
        // Get signed URL for WebSocket
        const effectiveApiKey = this.elevenLabsApiKey || agentConfig.apiKey;
        console.log(`[ConversationalTestAgent] Getting signed URL for agent: ${agentConfig.agentId}`);
        
        const signedUrlResponse = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentConfig.agentId}`,
          {
            method: 'GET',
            headers: { 'xi-api-key': effectiveApiKey },
          }
        );

        if (!signedUrlResponse.ok) {
          const errorText = await signedUrlResponse.text();
          console.error(`[ConversationalTestAgent] Failed to get signed URL: ${errorText}`);
          throw new Error(`Failed to get signed URL: ${errorText}`);
        }

        const { signed_url } = await signedUrlResponse.json() as { signed_url: string };
        console.log(`[ConversationalTestAgent] Got signed URL, connecting...`);
        
        const ws = new WebSocket(signed_url);

        // Timeout after 3 minutes (shorter for testing)
        const timeout = setTimeout(() => {
          console.log(`[ConversationalTestAgent] Conversation timeout after 3 minutes`);
          conversationComplete = true;
          ws.close();
        }, 180000);

        ws.on('open', () => {
          console.log(`[ConversationalTestAgent] WebSocket connected to ElevenLabs`);
        });

        let messageCount = 0;
        let audioChunkCount = 0;
        
        ws.on('message', async (data: Buffer) => {
          messageCount++;
          
          try {
            const message = JSON.parse(data.toString());
            
            // Log ALL message types initially for debugging
            console.log(`[ConversationalTestAgent] Message #${messageCount}: type=${message.type}`);
            
            // Log important messages in full
            if (message.type !== 'ping') {
              console.log(`[ConversationalTestAgent] ${message.type}:`, 
                JSON.stringify(message).substring(0, 600));
            }

            switch (message.type) {
              case 'conversation_initiation_metadata':
                // Parse conversation_id from the correct location
                callId = message.conversation_initiation_metadata_event?.conversation_id || message.conversation_id;
                console.log(`[ConversationalTestAgent] Conversation started: ${callId}`);
                break;

              case 'agent_response':
                // Agent text response (streaming)
                const agentText = message.agent_response_event?.agent_response || 
                                  message.agent_response || 
                                  message.text || '';
                if (agentText) {
                  agentSpeaking = true;
                  currentAgentResponse += agentText + ' ';
                  lastAudioTime = Date.now();
                  console.log(`[ConversationalTestAgent] Agent speaking: "${agentText.substring(0, 100)}..."`);
                }
                break;

              case 'audio':
              case 'audio_event':
                // Agent is sending audio - they're speaking
                agentSpeaking = true;
                lastAudioTime = Date.now();
                
                // Reset silence timer
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                  // 2 seconds of silence = agent done speaking
                  if (agentSpeaking && currentAgentResponse.trim()) {
                    console.log(`[ConversationalTestAgent] Silence detected, processing response`);
                    agentSpeaking = false;
                    processAgentTurn(ws);
                  }
                }, 2000);
                break;

              case 'user_transcript':
                // Our audio was transcribed
                const userText = message.user_transcript_event?.user_transcript || 
                                message.user_transcript || 
                                message.text || '';
                if (userText) {
                  console.log(`[ConversationalTestAgent] Agent transcribed us: "${userText}"`);
                }
                break;

              case 'ping':
                const pingEventId2 = message.ping_event?.event_id || message.event_id;
                ws.send(JSON.stringify({ type: 'pong', event_id: pingEventId2 }));
                break;

              case 'error':
                console.error(`[ConversationalTestAgent] Error from ElevenLabs:`, message);
                break;
                
              default:
                // Log unknown message types for debugging
                if (message.type) {
                  console.log(`[ConversationalTestAgent] Unknown message type: ${message.type}`, 
                    JSON.stringify(message).substring(0, 500));
                }
            }
          } catch (e) {
            // Binary audio data - agent is speaking
            audioChunkCount++;
            if (audioChunkCount === 1 || audioChunkCount % 50 === 0) {
              console.log(`[ConversationalTestAgent] Received audio chunk #${audioChunkCount}, ${data.length} bytes`);
            }
            agentSpeaking = true;
            lastAudioTime = Date.now();
            
            // Reset silence timer for binary audio too
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
              if (agentSpeaking && currentAgentResponse.trim()) {
                console.log(`[ConversationalTestAgent] Silence detected (binary), processing response`);
                agentSpeaking = false;
                processAgentTurn(ws);
              }
            }, 2000);
          }
        });

        ws.on('close', async () => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          console.log(`[ConversationalTestAgent] WebSocket closed, ${transcript.length} messages recorded`);

          // Fetch full conversation data from ElevenLabs API
          const conversationData = await this.fetchElevenLabsConversation(callId, effectiveApiKey);
          
          // Build transcripts
          const agentTranscript = transcript
            .filter(t => t.role === 'ai_agent')
            .map(t => t.content)
            .join('\n');
          const testCallerTranscript = transcript
            .filter(t => t.role === 'test_caller')
            .map(t => t.content)
            .join('\n');

          resolve({
            callId,
            durationMs: Date.now() - startTime,
            transcript: conversationData?.transcript?.length ? conversationData.transcript : transcript,
            recordingUrl: conversationData?.recordingUrl || null,
            agentTranscript: conversationData?.agentTranscript || agentTranscript,
            testCallerTranscript: conversationData?.testCallerTranscript || testCallerTranscript,
            messageCount: transcript.length,
            success: transcript.length > 0,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          console.error(`[ConversationalTestAgent] WebSocket error:`, error);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Build the system prompt for the test caller (acting as customer)
   */
  private buildTestCallerPrompt(testCase: TestCase): string {
    console.log(`[TestCallerPrompt] Building prompt with test case:`);
    console.log(`  - Scenario: ${testCase.scenario}`);
    console.log(`  - UserInput: ${testCase.userInput}`);
    console.log(`  - ExpectedOutcome: ${testCase.expectedOutcome}`);
    
    return `You are a TEST CALLER simulating a real customer for QA testing of a voice AI agent.

YOUR ROLE:
- You are testing the AI agent by acting as a REAL CUSTOMER
- Behave naturally like a human would on a phone call
- Follow the test scenario to evaluate the agent's responses

TEST SCENARIO:
${testCase.scenario}

YOUR GOAL/OBJECTIVE (this is what you should be testing):
${testCase.userInput}

EXPECTED AGENT BEHAVIOR:
${testCase.expectedOutcome}

CRITICAL INSTRUCTIONS:
1. Your FIRST response after the agent's greeting should work towards the test objective: "${testCase.userInput}"
2. Stay focused on the test scenario throughout the conversation
3. Ask relevant questions a real customer would ask
4. React naturally to the agent's responses
5. If the agent asks questions, answer them based on the scenario
6. Keep responses conversational (1-3 sentences typically)
7. If the agent provides incorrect information, gently challenge it
8. KEEP THE CONVERSATION GOING - always have follow-up questions

FOLLOW-UP QUESTIONS TO USE (when the agent asks if you have more questions):
- "What about the application deadlines?"
- "Can you tell me about the costs or fees involved?"
- "What documents do I need to prepare?"
- "How long does the process usually take?"
- "Are there any scholarships available?"
- "What are the language requirements?"
- "Can you explain the visa process?"
- "What support do you provide after I apply?"

IMPORTANT - NEVER DO THESE:
- NEVER say "I don't have any other questions"
- NEVER say "That's all I needed" or "That's all for now"
- NEVER say "I think I understand now" or "I think that covers everything"
- NEVER say "No more questions" or "Nothing else"
- NEVER end the conversation yourself
- NEVER give up or conclude the call
- NEVER say "thank you, that's helpful" as a final statement

CONVERSATION ENDING RULES:
- ONLY say goodbye AFTER the agent says "goodbye", "bye", or "take care" FIRST
- If the agent asks "Is there anything else?" - ALWAYS ask another question from the list above
- If the agent says "goodbye" or "bye" - THEN you respond with "Thank you! Goodbye!"
- Do NOT end the conversation prematurely - the AGENT must end it
- Wait for the agent's farewell before saying yours

RESPONSE LENGTH:
- Make your responses conversational and detailed (2-4 sentences minimum)
- Include context, questions, and relevant details
- Don't give one-word or very short answers
- Ask follow-up questions to keep the conversation going

REMEMBER: You are testing whether the agent handles "${testCase.scenario}" correctly.

Respond with ONLY what you would say as the customer. No explanations or meta-commentary.`;
  }

  /**
   * Generate test caller response using OpenAI
   */
  private async generateTestCallerResponse(
    conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    isEnding: boolean = false
  ): Promise<string> {
    try {
      const messages = [...conversationHistory];
      
      if (isEnding) {
        messages.push({
          role: 'user',
          content: 'The conversation is ending. Generate a brief, natural goodbye response.',
        });
      } else {
        // Encourage longer, more engaging responses
        messages.push({
          role: 'user',
          content: 'Generate a conversational response (2-4 sentences). Include relevant details and ask a follow-up question.',
        });
      }

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 200,
      });

      return response.choices[0]?.message?.content?.trim() || '';
    } catch (error) {
      console.error(`[ConversationalTestAgent] OpenAI error:`, error);
      return '';
    }
  }

  /**
   * Get a fallback response when OpenAI fails
   * This ensures the test caller ALWAYS responds, even if AI generation fails
   */
  private getFallbackResponse(testCase: TestCase, turnCount: number): string {
    // Use the test case userInput if it's the first turn
    if (turnCount === 1 && testCase.userInput && testCase.userInput !== testCase.scenario) {
      return testCase.userInput;
    }
    
    // Fallback responses based on turn count
    const fallbacks = [
      "Yes, I'm available. Can you tell me more about that?",
      "That's interesting. Could you explain further?",
      "I see. What other options do you have?",
      "Thanks for the information. What would you recommend?",
      "Okay, that makes sense. What are the next steps?",
      "I appreciate your help. Is there anything else I should know?",
      "Thank you for explaining that. I'll think about it.",
    ];
    
    const index = Math.min(turnCount - 1, fallbacks.length - 1);
    return fallbacks[index];
  }

  /**
   * Convert text to speech using ElevenLabs
   */
  private async textToSpeech(text: string): Promise<Buffer | null> {
    try {
      // Use a neutral voice for test caller
      const voiceId = 'EXAVITQu4vr4xnSDxMaL'; // Sarah - neutral American voice
      
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.elevenLabsApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            output_format: 'pcm_16000', // 16kHz PCM for WebSocket
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              speed: 1.0,
            },
          }),
        }
      );

      if (!response.ok) {
        console.error(`[ConversationalTestAgent] TTS error: ${await response.text()}`);
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error(`[ConversationalTestAgent] TTS error:`, error);
      return null;
    }
  }

  /**
   * Send audio to the agent via WebSocket
   */
  private async sendAudioToAgent(ws: WebSocket, audioBuffer: Buffer): Promise<void> {
    return new Promise((resolve) => {
      // For ulaw_8000, 8000 bytes = 1 second of audio
      // For pcm_16000, 32000 bytes = 1 second of audio
      const chunkSize = 8000; // ~1 second of audio at 8kHz ulaw (or ~250ms at 16kHz PCM)
      let offset = 0;
      let chunkCount = 0;
      
      // Add 1.5 seconds of silence at the end (µ-law silence is 0xFF or 127)
      // This helps the agent's VAD detect end of speech
      const silenceDuration = 1.5; // seconds
      const silenceBytes = Math.floor(8000 * silenceDuration);
      const silenceBuffer = Buffer.alloc(silenceBytes, 0xFF); // µ-law silence
      const audioWithSilence = Buffer.concat([audioBuffer, silenceBuffer]);
      
      console.log(`[SendAudio] Starting to send ${audioBuffer.length} bytes of audio + ${silenceBytes} bytes silence`);

      const sendChunk = () => {
        if (offset >= audioWithSilence.length) {
          console.log(`[SendAudio] Finished sending ${chunkCount} chunks (total ${audioWithSilence.length} bytes)`);
          resolve();
          return;
        }

        const chunk = audioWithSilence.slice(offset, offset + chunkSize);
        offset += chunkSize;
        chunkCount++;

        try {
          const message = JSON.stringify({
            user_audio_chunk: chunk.toString('base64'),
          });
          ws.send(message);
          if (chunkCount <= 3 || offset >= audioWithSilence.length) {
            console.log(`[SendAudio] Sent chunk #${chunkCount}, ${chunk.length} bytes`);
          }
        } catch (e) {
          console.error(`[SendAudio] Error sending audio chunk:`, e);
        }

        // Send next chunk after small delay to simulate real-time speech
        setTimeout(sendChunk, 100);
      };

      sendChunk();
    });
  }

  /**
   * Send text message to agent via WebSocket (alternative to audio)
   */
  private sendTextToAgent(ws: WebSocket, text: string): void {
    try {
      ws.send(JSON.stringify({
        type: 'user_message',
        text: text,
      }));
      console.log(`[RealAudio] Sent text message: "${text.substring(0, 50)}..."`);
    } catch (e) {
      console.error(`[ConversationalTestAgent] Error sending text message:`, e);
    }
  }

  /**
   * Check if conversation should end
   * IMPORTANT: Only returns true when agent has said a FINAL goodbye
   * This ensures the conversation completes naturally with proper farewell
   */
  private shouldEndConversation(
    agentMessage: string,
    turnCount: number,
    maxTurns: number,
    testCase: TestCase
  ): boolean {
    // Safety limit: End if max turns reached (but this is a high limit)
    if (turnCount >= maxTurns) {
      console.log(`[ConversationalTestAgent] Ending: Safety max turns (${maxTurns}) reached`);
      return true;
    }

    // FINAL goodbye patterns - these indicate the agent is ending the call
    const finalGoodbyePatterns = [
      /\bgoodbye\b/i,
      /\bbye\s*bye\b/i,
      /\bbye[.!]?$/i,
      /take care[.!,]?\s*(bye|goodbye)?/i,
      /have a (great|good|nice|wonderful) (day|one)[.!]?$/i,
      /thank you.*\bbye\b/i,
      /thanks.*\bbye\b/i,
    ];

    // Soft ending patterns - agent is wrapping up but may continue
    const softEndingPatterns = [
      /is there anything else I can help/i,
      /can I help you with anything else/i,
      /do you have any other questions/i,
      /anything else (you need|I can assist)/i,
    ];

    // Only check for endings after minimum conversation (4 turns = 2 exchanges)
    if (turnCount >= 4) {
      // Check for FINAL goodbye - agent is clearly ending the call
      for (const pattern of finalGoodbyePatterns) {
        if (pattern.test(agentMessage)) {
          console.log(`[ConversationalTestAgent] Ending: Agent said final goodbye - "${pattern}"`);
          return true;
        }
      }
    }

    // After 8 turns, also accept soft endings as conversation is mature
    if (turnCount >= 8) {
      for (const pattern of softEndingPatterns) {
        if (pattern.test(agentMessage)) {
          console.log(`[ConversationalTestAgent] Ending: Detected soft ending after ${turnCount} turns - "${pattern}"`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Fetch conversation data from ElevenLabs API after call ends
   */
  private async fetchElevenLabsConversation(
    conversationId: string,
    apiKey: string
  ): Promise<{
    transcript: ConversationTurn[];
    recordingUrl: string | null;
    agentTranscript: string;
    testCallerTranscript: string;
  } | null> {
    if (!conversationId) return null;

    try {
      // Wait a bit for the conversation to be processed
      await this.sleep(2000);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
        {
          headers: { 'xi-api-key': apiKey },
        }
      );

      if (!response.ok) {
        console.error(`[ConversationalTestAgent] Failed to fetch conversation: ${await response.text()}`);
        return null;
      }

      const data = await response.json() as {
        conversation_id: string;
        status: string;
        transcript?: Array<{
          role: string;
          message: string;
          timestamp?: number;
        }>;
        metadata?: {
          recording_url?: string;
        };
      };

      // Transform transcript
      const transcript: ConversationTurn[] = (data.transcript || []).map((turn) => ({
        role: turn.role === 'agent' ? 'ai_agent' : 'test_caller',
        content: turn.message,
        timestamp: turn.timestamp || Date.now(),
      }));

      const agentTranscript = transcript
        .filter(t => t.role === 'ai_agent')
        .map(t => t.content)
        .join('\n');

      const testCallerTranscript = transcript
        .filter(t => t.role === 'test_caller')
        .map(t => t.content)
        .join('\n');

      return {
        transcript,
        recordingUrl: data.metadata?.recording_url || null,
        agentTranscript,
        testCallerTranscript,
      };
    } catch (error) {
      console.error(`[ConversationalTestAgent] Error fetching conversation:`, error);
      return null;
    }
  }

  /**
   * Test with Retell AI
   */
  private async testWithRetell(
    testCase: TestCase,
    agentConfig: AgentConfig,
    startTime: number
  ): Promise<ConversationResult> {
    // Similar implementation for Retell
    // Retell uses WebSocket with different message format
    
    return new Promise(async (resolve, reject) => {
      const transcript: ConversationTurn[] = [];
      let callId = '';
      
      try {
        // Create web call
        const createResponse = await fetch('https://api.retellai.com/v2/create-web-call', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agent_id: agentConfig.agentId,
          }),
        });

        if (!createResponse.ok) {
          throw new Error(`Failed to create Retell call: ${await createResponse.text()}`);
        }

        const { call_id, access_token } = await createResponse.json() as { 
          call_id: string; 
          access_token: string;
        };
        callId = call_id;

        // Build test caller prompt
        const systemPrompt = this.buildTestCallerPrompt(testCase);
        const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt }
        ];

        // Connect to Retell WebSocket
        const ws = new WebSocket(`wss://api.retellai.com/audio-websocket/${call_id}`, {
          headers: { 'Authorization': `Bearer ${access_token}` },
        });

        let currentAgentUtterance = '';
        let turnCount = 0;
        const maxTurns = 30; // High safety limit - ends naturally on goodbye
        let conversationComplete = false;

        const timeout = setTimeout(() => {
          conversationComplete = true;
          ws.close();
        }, 300000);

        ws.on('open', () => {
          console.log(`[ConversationalTestAgent] Connected to Retell: ${callId}`);
          // Send initial config
          ws.send(JSON.stringify({
            response_type: 'config',
            config: {
              auto_reconnect: false,
              call_details: true,
            },
          }));
        });

        ws.on('message', async (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());

            if (message.response_type === 'agent_response') {
              currentAgentUtterance = message.content || '';
            } else if (message.response_type === 'turn_end' || message.response_type === 'agent_turn_end') {
              if (currentAgentUtterance && !conversationComplete) {
                turnCount++;
                
                transcript.push({
                  role: 'ai_agent',
                  content: currentAgentUtterance,
                  timestamp: Date.now(),
                });

                conversationHistory.push({ role: 'user', content: currentAgentUtterance });

                if (this.shouldEndConversation(currentAgentUtterance, turnCount, maxTurns, testCase)) {
                  conversationComplete = true;
                  const finalResponse = await this.generateTestCallerResponse(conversationHistory, true);
                  if (finalResponse) {
                    transcript.push({
                      role: 'test_caller',
                      content: finalResponse,
                      timestamp: Date.now(),
                    });
                    const audio = await this.textToSpeech(finalResponse);
                    if (audio) {
                      ws.send(audio);
                    }
                  }
                  setTimeout(() => ws.close(), 3000);
                } else {
                  const testResponse = await this.generateTestCallerResponse(conversationHistory);
                  if (testResponse) {
                    transcript.push({
                      role: 'test_caller',
                      content: testResponse,
                      timestamp: Date.now(),
                    });
                    conversationHistory.push({ role: 'assistant', content: testResponse });
                    const audio = await this.textToSpeech(testResponse);
                    if (audio) {
                      ws.send(audio);
                    }
                  }
                }
                currentAgentUtterance = '';
              }
            }
          } catch (e) {
            // Binary audio
          }
        });

        ws.on('close', async () => {
          clearTimeout(timeout);
          
          // Fetch call data from Retell
          const callData = await this.fetchRetellCallData(callId, agentConfig.apiKey);

          resolve({
            callId,
            durationMs: Date.now() - startTime,
            transcript: callData?.transcript || transcript,
            recordingUrl: callData?.recordingUrl || null,
            agentTranscript: transcript.filter(t => t.role === 'ai_agent').map(t => t.content).join('\n'),
            testCallerTranscript: transcript.filter(t => t.role === 'test_caller').map(t => t.content).join('\n'),
            messageCount: transcript.length,
            success: true,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Fetch call data from Retell API
   */
  private async fetchRetellCallData(
    callId: string,
    apiKey: string
  ): Promise<{
    transcript: ConversationTurn[];
    recordingUrl: string | null;
  } | null> {
    try {
      await this.sleep(2000);

      const response = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!response.ok) return null;

      const data = await response.json() as {
        transcript?: string;
        recording_url?: string;
        transcript_object?: Array<{ role: string; content: string }>;
      };

      const transcript: ConversationTurn[] = (data.transcript_object || []).map((turn) => ({
        role: turn.role === 'agent' ? 'ai_agent' : 'test_caller',
        content: turn.content,
        timestamp: Date.now(),
      }));

      return {
        transcript,
        recordingUrl: data.recording_url || null,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Test with VAPI
   */
  private async testWithVAPI(
    testCase: TestCase,
    agentConfig: AgentConfig,
    startTime: number
  ): Promise<ConversationResult> {
    return new Promise(async (resolve, reject) => {
      const transcript: ConversationTurn[] = [];
      let callId = '';

      try {
        // Create VAPI web call
        const createResponse = await fetch('https://api.vapi.ai/call/web', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assistantId: agentConfig.agentId,
          }),
        });

        if (!createResponse.ok) {
          throw new Error(`Failed to create VAPI call: ${await createResponse.text()}`);
        }

        const { id: vapiCallId, webCallUrl } = await createResponse.json() as { 
          id: string; 
          webCallUrl: string;
        };
        callId = vapiCallId;

        const systemPrompt = this.buildTestCallerPrompt(testCase);
        const conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt }
        ];

        // VAPI uses Daily.co for WebRTC, but we can use their WebSocket API
        const ws = new WebSocket(webCallUrl);
        
        let currentAgentMessage = '';
        let turnCount = 0;
        const maxTurns = 30; // High safety limit - ends naturally on goodbye
        let conversationComplete = false;

        const timeout = setTimeout(() => {
          conversationComplete = true;
          // End VAPI call
          fetch(`https://api.vapi.ai/call/${callId}/stop`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${agentConfig.apiKey}` },
          });
        }, 300000);

        ws.on('message', async (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());

            if (message.type === 'transcript' && message.role === 'assistant') {
              currentAgentMessage = message.transcript || '';
            } else if (message.type === 'speech-end' && message.role === 'assistant') {
              if (currentAgentMessage && !conversationComplete) {
                turnCount++;
                
                transcript.push({
                  role: 'ai_agent',
                  content: currentAgentMessage,
                  timestamp: Date.now(),
                });

                conversationHistory.push({ role: 'user', content: currentAgentMessage });

                if (this.shouldEndConversation(currentAgentMessage, turnCount, maxTurns, testCase)) {
                  conversationComplete = true;
                  setTimeout(() => {
                    fetch(`https://api.vapi.ai/call/${callId}/stop`, {
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${agentConfig.apiKey}` },
                    });
                  }, 3000);
                } else {
                  const testResponse = await this.generateTestCallerResponse(conversationHistory);
                  if (testResponse) {
                    transcript.push({
                      role: 'test_caller',
                      content: testResponse,
                      timestamp: Date.now(),
                    });
                    conversationHistory.push({ role: 'assistant', content: testResponse });
                    // VAPI accepts audio or we can use their say endpoint
                    // For now, send text command
                    ws.send(JSON.stringify({
                      type: 'say',
                      text: testResponse,
                    }));
                  }
                }
                currentAgentMessage = '';
              }
            }
          } catch (e) {
            // Binary audio
          }
        });

        ws.on('close', async () => {
          clearTimeout(timeout);
          
          // Fetch call data from VAPI
          const callData = await this.fetchVAPICallData(callId, agentConfig.apiKey);

          resolve({
            callId,
            durationMs: Date.now() - startTime,
            transcript: callData?.transcript || transcript,
            recordingUrl: callData?.recordingUrl || null,
            agentTranscript: transcript.filter(t => t.role === 'ai_agent').map(t => t.content).join('\n'),
            testCallerTranscript: transcript.filter(t => t.role === 'test_caller').map(t => t.content).join('\n'),
            messageCount: transcript.length,
            success: true,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Fetch call data from VAPI API
   */
  private async fetchVAPICallData(
    callId: string,
    apiKey: string
  ): Promise<{
    transcript: ConversationTurn[];
    recordingUrl: string | null;
  } | null> {
    try {
      await this.sleep(2000);

      const response = await fetch(`https://api.vapi.ai/call/${callId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!response.ok) return null;

      const data = await response.json() as {
        messages?: Array<{ role: string; content: string }>;
        recordingUrl?: string;
      };

      const transcript: ConversationTurn[] = (data.messages || []).map((msg) => ({
        role: msg.role === 'assistant' ? 'ai_agent' : 'test_caller',
        content: msg.content,
        timestamp: Date.now(),
      }));

      return {
        transcript,
        recordingUrl: data.recordingUrl || null,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Convert mu-law (ulaw) encoded audio to signed 16-bit PCM
   * μ-law is an audio companding algorithm used in telephony
   */
  private ulawToPcm16(ulawBuffer: Buffer): Buffer {
    // μ-law decoding table for faster conversion
    const ULAW_DECODE: number[] = [];
    for (let i = 0; i < 256; i++) {
      // Invert the bits (μ-law uses inverted values)
      const ulaw = ~i & 0xFF;
      
      // Extract sign, exponent, and mantissa
      const sign = (ulaw & 0x80) ? -1 : 1;
      const exponent = (ulaw >> 4) & 0x07;
      const mantissa = ulaw & 0x0F;
      
      // Convert to linear PCM
      let sample = (mantissa << 3) + 0x84;
      sample <<= exponent;
      sample -= 0x84;
      sample *= sign;
      
      ULAW_DECODE[i] = sample;
    }
    
    // Convert each byte
    const pcmBuffer = Buffer.alloc(ulawBuffer.length * 2);
    for (let i = 0; i < ulawBuffer.length; i++) {
      const pcmSample = ULAW_DECODE[ulawBuffer[i]];
      pcmBuffer.writeInt16LE(pcmSample, i * 2);
    }
    
    return pcmBuffer;
  }

  /**
   * Create a WAV file buffer with proper RIFF header
   */
  private createWavBuffer(
    pcmData: Buffer,
    sampleRate: number,
    numChannels: number,
    bitsPerSample: number
  ): Buffer {
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.length;
    const headerSize = 44;
    
    const wavBuffer = Buffer.alloc(headerSize + dataSize);
    
    // RIFF header
    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(36 + dataSize, 4); // File size - 8
    wavBuffer.write('WAVE', 8);
    
    // fmt subchunk
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16); // Subchunk1 size (16 for PCM)
    wavBuffer.writeUInt16LE(1, 20); // Audio format (1 = PCM)
    wavBuffer.writeUInt16LE(numChannels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitsPerSample, 34);
    
    // data subchunk
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);
    
    // Copy PCM data
    pcmData.copy(wavBuffer, 44);
    
    return wavBuffer;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const conversationalTestAgent = new ConversationalTestAgentService();
