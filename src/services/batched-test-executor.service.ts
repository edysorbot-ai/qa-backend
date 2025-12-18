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
    audioChunks: Buffer[],
    userAudioChunks: Buffer[] = [] // Track user audio separately
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
   * Build prompt for test caller handling multiple test cases
   * IMPORTANT: Include ALL test cases so the test caller knows what to test
   */
  private buildBatchTestCallerPrompt(testCases: SmartTestCase[]): string {
    // Build the list of test scenarios to cover
    const testScenarios = testCases.map((tc, idx) => {
      return `${idx + 1}. "${tc.name}": ${tc.scenario || tc.userInput}`;
    }).join('\n');

    // Extract persona details from test cases
    const budgetCase = testCases.find(tc => 
      tc.name.toLowerCase().includes('budget') || tc.userInput.toLowerCase().includes('lakh') || tc.userInput.toLowerCase().includes('budget')
    );
    const educationCase = testCases.find(tc => 
      tc.name.toLowerCase().includes('cgpa') || tc.name.toLowerCase().includes('academic') || tc.name.toLowerCase().includes('education')
    );
    const countryCase = testCases.find(tc => 
      tc.name.toLowerCase().includes('country') || tc.name.toLowerCase().includes('destination')
    );

    // Build a simple persona with realistic answers
    const persona = {
      name: "Alex",
      budget: budgetCase?.userInput || "around 15 to 20 lakh rupees",
      education: educationCase?.userInput || "I completed my Bachelor's degree with a 7.5 CGPA",
      country: countryCase?.userInput || "I'm interested in studying in Canada or the UK",
    };

    return `You are Alex, a test caller making a phone call to test a voice AI agent. Your job is to have a natural conversation while covering specific test scenarios.

YOUR PERSONA (use these when asked):
- Name: ${persona.name}
- Budget: ${persona.budget}
- Education: ${persona.education}  
- Preferred destination: ${persona.country}

=== TEST SCENARIOS TO COVER ===
You need to naturally bring up or respond to these scenarios during the conversation:
${testScenarios}

=== HOW TO TEST ===
1. Start with "Hello?" when the call begins
2. Let the agent lead the conversation initially
3. Answer their questions naturally using your persona details
4. When appropriate, bring up topics from the test scenarios above
5. If a test scenario involves a specific user input, use that exact input when relevant
6. Keep responses short (1-2 sentences) but make sure to cover the test scenarios
7. Ask follow-up questions to keep the conversation going
8. Don't end the call until you've tried to cover most scenarios

=== IMPORTANT ===
- Be a natural, curious customer - not a robot reading a script
- If the agent asks about something in your test scenarios, that's your chance to test it
- Try to cover ALL ${testCases.length} test scenarios during this call
- Don't rush through scenarios - let the conversation flow naturally`;
  }

  /**
   * Generate test caller response - include remaining test cases to cover
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
    
    // Build list of remaining scenarios to test
    const remainingScenarios = remainingCases.length > 0 
      ? remainingCases.map(tc => `- ${tc.name}: ${tc.userInput || tc.scenario}`).join('\n')
      : 'All scenarios covered!';
    
    // Prompt that includes remaining test cases
    const guidancePrompt = `The agent just said: "${lastAgentMessage}"

REMAINING TEST SCENARIOS TO COVER:
${remainingScenarios}

As Alex (a test caller), respond naturally while trying to cover one of the remaining scenarios if relevant.

RULES:
- If the agent asked a question, answer it (use your persona details)
- If you can naturally bring up one of the remaining scenarios, do it
- Keep response to 1-2 sentences
- Be curious and engaged
- If agent is wrapping up but you have remaining scenarios, ask about something related to them
- Don't try to end the conversation
- Don't ask "how can I help" - you are the customer

Respond naturally as Alex:`;

    messages.push({
      role: 'user',
      content: guidancePrompt,
    });

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages as any,
        temperature: 0.6,
        max_tokens: 80,
      });

      const responseText = response.choices[0]?.message?.content?.trim() || "Okay, I understand.";
      
      // Try to match what was discussed to a test case for tracking
      const relevantCase = this.findRelevantTestCase(lastAgentMessage, remainingCases);
      
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
