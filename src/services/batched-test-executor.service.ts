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

interface BatchTestResult {
  testCaseId: string;
  testCaseName: string;
  passed: boolean;
  score: number;
  actualResponse: string;
  metrics: Record<string, any>;
  turnsCovered: number[];
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
    
    // Analyze the conversation against each test case
    const results = await this.analyzeTranscriptForTestCases(
      transcript,
      batch.testCases,
      agentPrompt
    );
    
    const durationMs = Date.now() - startTime;
    
    // Combine audio chunks into a single buffer
    const audioBuffer = audioChunks.length > 0 ? Buffer.concat(audioChunks) : undefined;
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
   */
  private async executeConversation(
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
      const maxTurns = Math.min(batch.testCases.reduce((sum, tc) => sum + tc.estimatedTurns, 0) + 5, 40);
      let currentAgentResponse = '';
      let conversationComplete = false;
      let isProcessingResponse = false;
      let expectedInputFormat = 'ulaw_8000';
      let currentTestCaseIndex = 0;
      let testedCases = new Set<string>();
      
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

        const processAgentTurn = async () => {
          if (isProcessingResponse || !currentAgentResponse.trim() || conversationComplete) return;
          isProcessingResponse = true;
          
          turnCount++;
          const agentMessage = currentAgentResponse.trim();
          console.log(`[BatchedExecutor] Agent (turn ${turnCount}): ${agentMessage.substring(0, 100)}...`);
          
          transcript.push({
            role: 'ai_agent',
            content: agentMessage,
            timestamp: Date.now(),
          });
          
          conversationHistory.push({ role: 'user', content: agentMessage });
          
          // Check if we should end
          if (turnCount >= maxTurns || this.shouldEndBatchConversation(agentMessage, turnCount, testedCases.size, batch.testCases.length)) {
            conversationComplete = true;
            
            // Send goodbye
            const goodbye = "Thank you so much for all this information! You've been very helpful. Goodbye!";
            transcript.push({ role: 'test_caller', content: goodbye, timestamp: Date.now() });
            
            try {
              const ttsResult = await ttsService.generateSpeechUlaw({ text: goodbye });
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
          try {
            const message = JSON.parse(data.toString());
            
            switch (message.type) {
              case 'conversation_initiation_metadata':
                expectedInputFormat = message.conversation_initiation_metadata_event?.user_input_audio_format || 'ulaw_8000';
                console.log(`[BatchedExecutor] Conversation started, format: ${expectedInputFormat}`);
                
                // Send initial greeting after a short delay
                setTimeout(async () => {
                  try {
                    const greeting = "Hello?";
                    const ttsResult = await ttsService.generateSpeechUlaw({ text: greeting });
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
                  }, 3000);
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
            }
          } catch (e) {
            // Binary audio data - capture it
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          if (silenceTimer) clearTimeout(silenceTimer);
          if (agentResponseTimer) clearTimeout(agentResponseTimer);
          console.log(`[BatchedExecutor] WebSocket closed, ${transcript.length} messages`);
          resolve({ success: true });
        });

        ws.on('error', (error) => {
          console.error('[BatchedExecutor] WebSocket error:', error);
          resolve({ success: false, error: error.message });
        });

      } catch (error) {
        console.error('[BatchedExecutor] Error:', error);
        resolve({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  /**
   * Build prompt for test caller handling multiple test cases
   */
  private buildBatchTestCallerPrompt(testCases: SmartTestCase[]): string {
    const testCaseDescriptions = testCases.map((tc, idx) => 
      `${idx + 1}. ${tc.name}\n   Scenario: ${tc.scenario}\n   User Input: ${tc.userInput}\n   Expected: ${tc.expectedOutcome}`
    ).join('\n\n');

    return `You are a TEST CALLER conducting a QA test on a voice AI agent. You need to test MULTIPLE scenarios in this SINGLE conversation.

TEST SCENARIOS TO COVER (in order):
${testCaseDescriptions}

INSTRUCTIONS:
1. Start by engaging with the first test scenario
2. After the agent responds adequately to each scenario, naturally transition to the next one
3. You can transition by saying things like "I also wanted to ask about..." or "Another question I have is..."
4. Keep track of which scenarios you've covered
5. Make the conversation flow naturally - don't make it feel like a checklist
6. For each scenario, ensure you get enough response from the agent to evaluate it

CONVERSATION RULES:
- Keep responses natural and conversational (2-4 sentences)
- Ask follow-up questions when the agent's response is incomplete
- Don't end the conversation until you've covered all scenarios
- Only say goodbye after the agent says goodbye first, or after covering all scenarios

RESPONSE FORMAT:
Just provide your natural response as the test caller. No meta-commentary.`;
  }

  /**
   * Generate test caller response that covers remaining test cases
   */
  private async generateBatchTestCallerResponse(
    conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    remainingCases: SmartTestCase[],
    currentIndex: number
  ): Promise<{ text: string; testCaseId?: string }> {
    const nextCase = remainingCases[0];
    
    const messages = [...conversationHistory];
    
    if (nextCase) {
      messages.push({
        role: 'user',
        content: `Generate a response that naturally covers this test scenario: "${nextCase.scenario}". 
User input to test: "${nextCase.userInput}"
Make it conversational and natural. If this is not the first scenario, transition smoothly from the previous topic.`,
      });
    } else {
      messages.push({
        role: 'user',
        content: 'All test scenarios have been covered. Generate a polite closing response.',
      });
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 200,
      });

      return {
        text: response.choices[0]?.message?.content?.trim() || "I have another question for you.",
        testCaseId: nextCase?.id,
      };
    } catch (error) {
      console.error('[BatchedExecutor] OpenAI error:', error);
      return {
        text: nextCase ? nextCase.userInput : "Thank you for your help!",
        testCaseId: nextCase?.id,
      };
    }
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
    // End if all test cases have been covered
    if (testedCount >= totalCount) {
      return true;
    }
    
    // End if agent says goodbye and we've covered at least half
    const goodbyePatterns = [/\bgoodbye\b/i, /\bbye\b/i, /take care/i];
    if (turnCount >= 8 && testedCount >= totalCount / 2) {
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
      
      return (analysis.results || []).map((r: any) => {
        // Look up the original test case to ensure we use exact name
        const originalTc = testCaseMap.get(r.testCaseId);
        return {
          testCaseId: r.testCaseId,
          // Use the original test case name, not what GPT returned
          testCaseName: originalTc?.name || r.testCaseName,
          passed: r.passed || false,
          score: r.score || 0,
          actualResponse: r.actualResponse || '',
          metrics: { reasoning: r.reasoning },
          turnsCovered: r.turnsCovered || [],
        };
      });
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
