/**
 * Real Test Executor Service
 * Executes voice agent tests with REAL voice calls
 * 
 * Full Pipeline:
 * 1. Test Agent (your platform) acts as a customer - powered by OpenAI
 * 2. Connects to the voice agent being tested (ElevenLabs/Retell/VAPI)
 * 3. Real two-way conversation: Agent speaks → STT → OpenAI → TTS → responds
 * 4. Continues until conversation concludes naturally
 * 5. Fetches full transcript and recording from provider API
 * 6. Uses OpenAI to evaluate the full conversation against test criteria
 */

import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';
import OpenAI from 'openai';
import pool from '../db';
import { config } from '../config';
import { TTSService, TTSRequest } from './tts.service';
import { ASRService } from './asr.service';
import { conversationalTestAgent, ConversationalTestAgentService } from './conversational-test-agent.service';

// ============= TYPES =============

export interface ConversationTurn {
  role: 'user' | 'agent';
  text: string;
  audioBase64?: string;
  timestamp: number;
  latencyMs?: number;
}

export interface TestCase {
  id: string;
  name: string;
  scenario: string;
  userInput: string;
  expectedOutcome: string;
  category: string;
  priority?: string;
}

export interface AgentConfig {
  provider: 'elevenlabs' | 'retell' | 'vapi';
  agentId: string;
  apiKey: string;
  agentName?: string;
}

export interface TTSConfig {
  voice?: string;
  model?: string;
}

export interface TestRunConfig {
  testRunId: string;
  name: string;
  agentConfig: AgentConfig;
  ttsConfig?: TTSConfig;
  testCases: TestCase[];
  concurrency?: number;
}

export interface EvaluationResult {
  overallScore: number; // 0-100
  passed: boolean;
  metrics: {
    accuracy: number;      // 0-100 - How accurate was the response
    relevance: number;     // 0-100 - How relevant to the question
    coherence: number;     // 0-100 - How coherent/understandable
    completeness: number;  // 0-100 - How complete was the answer
  };
  advancedMetrics: {
    noHallucination: number;   // 0-10
    responseSpeed: number;     // 0-10
    infoAccuracy: number;      // 0-10
    protocol: number;          // 0-10
    resolution: number;        // 0-10
    voiceQuality: number;      // 0-10
    tone: number;              // 0-10
    empathy: number;           // 0-10
  };
  analysis: {
    summary: string;
    strengths: string[];
    issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      category: string;
      turn: number;
      agentSaid: string;
      problem: string;
      impact: string;
      shouldHaveSaid: string;
    }>;
  };
}

export interface TestResult {
  testCaseId: string;
  testCaseName: string;
  scenario: string;
  category: string;
  userInput: string;  // Original test case user input
  expectedOutcome: string;  // Original expected response
  status: 'passed' | 'failed';
  durationMs: number;
  callId?: string;
  hasRecording: boolean;
  recordingUrl?: string | null;
  conversationTurns: ConversationTurn[];
  evaluation: EvaluationResult;
  error?: string;
  agentTranscript?: string;
  testCallerTranscript?: string;
}

// ============= SERVICE =============

export class RealTestExecutorService {
  private ttsService: TTSService | null = null;
  private asrService: ASRService | null = null;
  private openai: OpenAI;

  constructor() {
    // Initialize TTS (ElevenLabs)
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    if (elevenLabsApiKey) {
      this.ttsService = new TTSService(elevenLabsApiKey);
    } else {
      console.warn('[RealTestExecutor] No ELEVENLABS_API_KEY - TTS disabled');
    }

    // Initialize ASR (Deepgram)
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
    if (deepgramApiKey) {
      this.asrService = new ASRService(deepgramApiKey);
    } else {
      console.warn('[RealTestExecutor] No DEEPGRAM_API_KEY - ASR disabled');
    }

    // Initialize OpenAI for evaluation
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      organization: config.openai.orgId,
    });
  }

  /**
   * Execute all tests for a test run
   */
  async executeTestRun(
    testConfig: TestRunConfig,
    onProgress?: (completed: number, total: number, currentTest: { scenario: string; status: string }) => void
  ): Promise<{
    testRunId: string;
    results: TestResult[];
    summary: {
      total: number;
      passed: number;
      failed: number;
      avgDurationMs: number;
      overallScore: number;
    };
  }> {
    const { testRunId, testCases, agentConfig } = testConfig;
    const results: TestResult[] = [];
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RealTestExecutor] Starting test run: ${testRunId}`);
    console.log(`[RealTestExecutor] Agent: ${agentConfig.agentName || agentConfig.agentId}`);
    console.log(`[RealTestExecutor] Provider: ${agentConfig.provider}`);
    console.log(`[RealTestExecutor] Total tests: ${testCases.length}`);
    console.log(`${'='.repeat(60)}\n`);

    let passedCount = 0;
    let failedCount = 0;
    let totalScore = 0;

    // Execute tests sequentially for voice calls (WebSocket doesn't support parallel well)
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      
      console.log(`\n[RealTestExecutor] Test ${i + 1}/${testCases.length}: ${testCase.name}`);
      console.log(`[RealTestExecutor] Category: ${testCase.category}`);
      
      // Update test status to "running" when it starts
      await pool.query(
        `UPDATE test_results SET status = 'running', started_at = NOW()
         WHERE test_run_id = $1 AND test_case_id = $2`,
        [testRunId, testCase.id]
      );
      
      try {
        const result = await this.executeTest(testCase, agentConfig, testConfig.ttsConfig);
        results.push(result);
        
        if (result.status === 'passed') {
          passedCount++;
        } else {
          failedCount++;
        }
        totalScore += result.evaluation.overallScore;

        // Store result in database
        await this.storeResult(testRunId, result);

        console.log(`[RealTestExecutor] Result: ${result.status.toUpperCase()} (Score: ${result.evaluation.overallScore})`);

        // Progress callback
        if (onProgress) {
          onProgress(i + 1, testCases.length, {
            scenario: result.scenario,
            status: result.status,
          });
        }
      } catch (error) {
        console.error(`[RealTestExecutor] Test failed:`, error);
        
        const failedResult: TestResult = {
          testCaseId: testCase.id,
          testCaseName: testCase.name,
          scenario: testCase.scenario,
          category: testCase.category,
          userInput: testCase.userInput,
          expectedOutcome: testCase.expectedOutcome,
          status: 'failed',
          durationMs: 0,
          hasRecording: false,
          conversationTurns: [],
          evaluation: this.createFailedEvaluation(),
          error: error instanceof Error ? error.message : 'Unknown error',
        };
        
        results.push(failedResult);
        failedCount++;
        await this.storeResult(testRunId, failedResult);
      }

      // Small delay between tests to avoid rate limiting
      await this.sleep(1000);
    }

    // Update test run status
    await pool.query(
      `UPDATE test_runs 
       SET status = 'completed', 
           passed_tests = $2, 
           failed_tests = $3,
           completed_at = NOW()
       WHERE id = $1`,
      [testRunId, passedCount, failedCount]
    );

    const avgDurationMs = results.length > 0 
      ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length 
      : 0;
    const overallScore = results.length > 0 ? totalScore / results.length : 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[RealTestExecutor] Test run completed: ${testRunId}`);
    console.log(`[RealTestExecutor] Passed: ${passedCount}, Failed: ${failedCount}`);
    console.log(`[RealTestExecutor] Overall Score: ${overallScore.toFixed(1)}%`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      testRunId,
      results,
      summary: {
        total: testCases.length,
        passed: passedCount,
        failed: failedCount,
        avgDurationMs,
        overallScore,
      },
    };
  }

  /**
   * Execute a single test with real voice agent call
   * Uses ConversationalTestAgent for multi-turn conversation
   */
  private async executeTest(
    testCase: TestCase,
    agentConfig: AgentConfig,
    ttsConfig?: TTSConfig
  ): Promise<TestResult> {
    const startTime = Date.now();

    try {
      // Use the conversational test agent for real two-way conversation
      console.log(`[RealTestExecutor] Starting conversational test with ${agentConfig.provider}...`);
      
      const conversationResult = await conversationalTestAgent.executeConversationalTest(
        {
          id: testCase.id,
          name: testCase.name,
          scenario: testCase.scenario,
          userInput: testCase.userInput,
          expectedOutcome: testCase.expectedOutcome,
          category: testCase.category,
        },
        {
          provider: agentConfig.provider,
          agentId: agentConfig.agentId,
          apiKey: agentConfig.apiKey,
          useRealAudio: true, // Enable real audio mode for recordings
        } as any
      );

      if (!conversationResult.success) {
        throw new Error(conversationResult.error || 'Conversation failed');
      }

      // Convert conversation turns to our format
      const conversationTurns: ConversationTurn[] = conversationResult.transcript.map(turn => ({
        role: turn.role === 'test_caller' ? 'user' : 'agent',
        text: turn.content,
        timestamp: turn.timestamp,
        latencyMs: turn.durationMs,
      }));

      console.log(`[RealTestExecutor] Conversation completed: ${conversationResult.messageCount} messages, ${conversationResult.durationMs}ms`);
      console.log(`[RealTestExecutor] Recording URL: ${conversationResult.recordingUrl || 'None'}`);

      // Evaluate the conversation with OpenAI
      console.log(`[RealTestExecutor] Evaluating conversation with AI...`);
      const evaluation = await this.evaluateConversation(
        testCase,
        conversationTurns,
        conversationResult.durationMs
      );

      return {
        testCaseId: testCase.id,
        testCaseName: testCase.name,
        scenario: testCase.scenario,
        category: testCase.category,
        userInput: testCase.userInput,
        expectedOutcome: testCase.expectedOutcome,
        status: evaluation.passed ? 'passed' : 'failed',
        durationMs: conversationResult.durationMs,
        callId: conversationResult.callId,
        hasRecording: !!conversationResult.recordingUrl,
        recordingUrl: conversationResult.recordingUrl,
        conversationTurns,
        evaluation,
        agentTranscript: conversationResult.agentTranscript,
        testCallerTranscript: conversationResult.testCallerTranscript,
      };

    } catch (error) {
      console.error(`[RealTestExecutor] Test execution error:`, error);
      throw error;
    }
  }

  /**
   * Call the voice agent via WebSocket
   */
  private async callVoiceAgent(
    agentConfig: AgentConfig,
    userInput: string,
    userAudioBuffer: Buffer | null
  ): Promise<{
    callId?: string;
    agentGreeting?: string;
    transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }>;
    hasRecording: boolean;
    firstResponseLatencyMs?: number;
  }> {
    const { provider, agentId, apiKey } = agentConfig;

    switch (provider) {
      case 'elevenlabs':
        return this.callElevenLabsAgent(agentId, apiKey, userInput, userAudioBuffer);
      case 'retell':
        return this.callRetellAgent(agentId, apiKey, userInput, userAudioBuffer);
      case 'vapi':
        return this.callVAPIAgent(agentId, apiKey, userInput);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Call ElevenLabs Conversational AI agent
   */
  private async callElevenLabsAgent(
    agentId: string,
    apiKey: string,
    userInput: string,
    userAudioBuffer: Buffer | null
  ): Promise<{
    callId?: string;
    agentGreeting?: string;
    transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }>;
    hasRecording: boolean;
    firstResponseLatencyMs?: number;
  }> {
    return new Promise(async (resolve, reject) => {
      const transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }> = [];
      let callId: string | undefined;
      let agentGreeting: string | undefined;
      let firstResponseLatencyMs: number | undefined;
      let lastUserInputTime = Date.now();
      const audioChunks: Buffer[] = [];

      // Use environment API key if available (same as TTS), otherwise use passed key
      const effectiveApiKey = process.env.ELEVENLABS_API_KEY || apiKey;
      console.log(`[RealTestExecutor] Using ElevenLabs API key: ${effectiveApiKey.substring(0, 8)}...`);

      try {
        // Get signed URL for WebSocket connection
        const response = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
          {
            method: 'GET',
            headers: { 'xi-api-key': effectiveApiKey },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to get ElevenLabs signed URL: ${await response.text()}`);
        }

        const { signed_url } = await response.json() as { signed_url: string };
        
        const ws = new WebSocket(signed_url);
        const startTime = Date.now();

        const timeout = setTimeout(() => {
          console.log(`[RealTestExecutor] ElevenLabs call timeout - closing`);
          ws.close();
          resolve({
            callId,
            agentGreeting,
            transcript,
            hasRecording: audioChunks.length > 0,
            firstResponseLatencyMs,
          });
        }, 60000); // 60 second timeout

        ws.on('open', () => {
          console.log(`[RealTestExecutor] ElevenLabs WebSocket connected`);
        });

        ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            
            switch (message.type) {
              case 'conversation_initiation_metadata':
                callId = message.conversation_id;
                console.log(`[RealTestExecutor] Conversation started: ${callId}`);
                
                // Send user audio after connection is established
                if (userAudioBuffer) {
                  setTimeout(() => {
                    lastUserInputTime = Date.now();
                    ws.send(JSON.stringify({
                      user_audio_chunk: userAudioBuffer.toString('base64'),
                    }));
                    console.log(`[RealTestExecutor] Sent user audio to agent`);
                  }, 1000);
                } else {
                  // Send text if no audio
                  setTimeout(() => {
                    lastUserInputTime = Date.now();
                    ws.send(JSON.stringify({
                      type: 'user_message',
                      text: userInput,
                    }));
                    console.log(`[RealTestExecutor] Sent user text to agent`);
                  }, 1000);
                }
                break;

              case 'agent_response':
                if (!firstResponseLatencyMs) {
                  firstResponseLatencyMs = Date.now() - lastUserInputTime;
                }
                const agentText = message.agent_response_event?.agent_response || message.agent_response;
                if (agentText) {
                  console.log(`[RealTestExecutor] Agent: ${agentText.substring(0, 100)}...`);
                  if (!agentGreeting) {
                    agentGreeting = agentText;
                  } else {
                    transcript.push({
                      role: 'agent',
                      text: agentText,
                      timestamp: Date.now(),
                      latencyMs: Date.now() - lastUserInputTime,
                    });
                  }
                }
                break;

              case 'user_transcript':
                const userText = message.user_transcript_event?.user_transcript || message.user_transcript;
                if (userText) {
                  console.log(`[RealTestExecutor] User (transcribed): ${userText}`);
                  transcript.push({
                    role: 'user',
                    text: userText,
                    timestamp: Date.now(),
                  });
                  lastUserInputTime = Date.now();
                }
                break;

              case 'audio':
                if (message.audio_event?.audio_base_64) {
                  audioChunks.push(Buffer.from(message.audio_event.audio_base_64, 'base64'));
                }
                break;

              case 'ping':
                ws.send(JSON.stringify({
                  type: 'pong',
                  event_id: message.event_id,
                }));
                break;
            }
          } catch (e) {
            // Binary audio data - collect it
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          console.log(`[RealTestExecutor] ElevenLabs WebSocket closed`);
          resolve({
            callId,
            agentGreeting,
            transcript,
            hasRecording: audioChunks.length > 0,
            firstResponseLatencyMs,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          console.error(`[RealTestExecutor] WebSocket error:`, error);
          reject(error);
        });

        // End call after conversation time
        setTimeout(() => {
          console.log(`[RealTestExecutor] Ending conversation...`);
          ws.close();
        }, 20000); // 20 seconds for conversation

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Call Retell AI agent
   */
  private async callRetellAgent(
    agentId: string,
    apiKey: string,
    userInput: string,
    userAudioBuffer: Buffer | null
  ): Promise<{
    callId?: string;
    agentGreeting?: string;
    transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }>;
    hasRecording: boolean;
    firstResponseLatencyMs?: number;
  }> {
    const transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }> = [];
    let callId: string | undefined;
    let firstResponseLatencyMs: number | undefined;

    try {
      // Create web call
      const createResponse = await fetch('https://api.retellai.com/v2/create-web-call', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agent_id: agentId }),
      });

      if (!createResponse.ok) {
        throw new Error(`Failed to create Retell call: ${await createResponse.text()}`);
      }

      const { call_id, access_token } = await createResponse.json() as { call_id: string; access_token: string };
      callId = call_id;
      console.log(`[RealTestExecutor] Retell call created: ${callId}`);

      // Connect to WebSocket and stream conversation
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://api.retellai.com/audio-websocket/${access_token}`);
        const startTime = Date.now();
        const audioChunks: Buffer[] = [];
        let lastUserInputTime = startTime;
        let agentGreeting: string | undefined;

        const timeout = setTimeout(() => {
          ws.close();
          resolve({
            callId,
            agentGreeting,
            transcript,
            hasRecording: audioChunks.length > 0,
            firstResponseLatencyMs,
          });
        }, 60000);

        ws.on('open', () => {
          console.log(`[RealTestExecutor] Retell WebSocket connected`);
          
          // Send user audio
          if (userAudioBuffer) {
            setTimeout(() => {
              lastUserInputTime = Date.now();
              ws.send(userAudioBuffer);
              console.log(`[RealTestExecutor] Sent user audio to Retell agent`);
            }, 1000);
          }
        });

        ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            
            if (message.response_type === 'transcript') {
              if (!firstResponseLatencyMs && message.role === 'agent') {
                firstResponseLatencyMs = Date.now() - lastUserInputTime;
              }
              
              if (message.role === 'agent') {
                if (!agentGreeting) {
                  agentGreeting = message.content;
                }
                transcript.push({
                  role: 'agent',
                  text: message.content,
                  timestamp: Date.now(),
                  latencyMs: Date.now() - lastUserInputTime,
                });
              } else {
                transcript.push({
                  role: 'user',
                  text: message.content,
                  timestamp: Date.now(),
                });
                lastUserInputTime = Date.now();
              }
            } else if (message.response_type === 'audio') {
              audioChunks.push(Buffer.from(message.audio, 'base64'));
            }
          } catch {
            if (Buffer.isBuffer(data)) {
              audioChunks.push(data);
            }
          }
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          resolve({
            callId,
            agentGreeting,
            transcript,
            hasRecording: audioChunks.length > 0,
            firstResponseLatencyMs,
          });
        });

        ws.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        setTimeout(() => {
          ws.close();
        }, 20000);
      });

    } catch (error) {
      throw error;
    }
  }

  /**
   * Call VAPI agent
   */
  private async callVAPIAgent(
    agentId: string,
    apiKey: string,
    userInput: string
  ): Promise<{
    callId?: string;
    agentGreeting?: string;
    transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number; latencyMs?: number }>;
    hasRecording: boolean;
    firstResponseLatencyMs?: number;
  }> {
    try {
      // Create call
      const createResponse = await fetch('https://api.vapi.ai/call/web', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assistantId: agentId }),
      });

      if (!createResponse.ok) {
        throw new Error(`Failed to create VAPI call: ${await createResponse.text()}`);
      }

      const { id: callId } = await createResponse.json() as { id: string };
      console.log(`[RealTestExecutor] VAPI call created: ${callId}`);

      // Wait for conversation
      await this.sleep(15000);

      // End call
      await fetch(`https://api.vapi.ai/call/${callId}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      // Get call details
      const callResponse = await fetch(`https://api.vapi.ai/call/${callId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      const callData = await callResponse.json() as { 
        transcript?: string;
        recordingUrl?: string;
        messages?: Array<{ role: string; content: string }>;
      };

      const transcript: Array<{ role: 'user' | 'agent'; text: string; timestamp: number }> = [];
      
      if (callData.messages) {
        callData.messages.forEach((msg, idx) => {
          transcript.push({
            role: msg.role === 'assistant' ? 'agent' : 'user',
            text: msg.content,
            timestamp: Date.now() - (callData.messages!.length - idx) * 1000,
          });
        });
      }

      return {
        callId,
        transcript,
        hasRecording: !!callData.recordingUrl,
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Evaluate conversation using OpenAI
   */
  private async evaluateConversation(
    testCase: TestCase,
    conversationTurns: ConversationTurn[],
    durationMs: number
  ): Promise<EvaluationResult> {
    const conversationText = conversationTurns
      .map(turn => `${turn.role.toUpperCase()}: ${turn.text}`)
      .join('\n');

    const systemPrompt = `You are an expert QA evaluator for voice AI agents. Analyze the following conversation and evaluate the agent's performance against the test criteria.

Return a JSON object with this exact structure:
{
  "overallScore": <number 0-100>,
  "passed": <boolean>,
  "metrics": {
    "accuracy": <number 0-100>,
    "relevance": <number 0-100>,
    "coherence": <number 0-100>,
    "completeness": <number 0-100>
  },
  "advancedMetrics": {
    "noHallucination": <number 0-10>,
    "responseSpeed": <number 0-10>,
    "infoAccuracy": <number 0-10>,
    "protocol": <number 0-10>,
    "resolution": <number 0-10>,
    "voiceQuality": <number 0-10>,
    "tone": <number 0-10>,
    "empathy": <number 0-10>
  },
  "analysis": {
    "summary": "<brief summary of the test result>",
    "strengths": ["<strength 1>", "<strength 2>"],
    "issues": [
      {
        "severity": "<critical|warning|info>",
        "category": "<category like Coherence, Empathy, Protocol, etc>",
        "turn": <turn number>,
        "agentSaid": "<what the agent actually said>",
        "problem": "<description of the issue>",
        "impact": "<impact on user experience>",
        "shouldHaveSaid": "<suggested better response>"
      }
    ]
  }
}

Evaluation criteria:
- Score 70+ = passed
- Check if agent meets the expected outcome
- Look for hallucinations, incorrect information, tone issues
- Evaluate if agent handled the scenario appropriately`;

    const userPrompt = `Test Case: ${testCase.name}

Scenario: ${testCase.scenario}

User Input: ${testCase.userInput}

Expected Outcome: ${testCase.expectedOutcome}

Duration: ${durationMs}ms

Conversation:
${conversationText || 'No conversation recorded'}

Evaluate this conversation and return the JSON evaluation.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const evaluation = JSON.parse(response.choices[0].message.content || '{}');

      return {
        overallScore: evaluation.overallScore || 0,
        passed: evaluation.passed ?? (evaluation.overallScore >= 70),
        metrics: {
          accuracy: evaluation.metrics?.accuracy || 0,
          relevance: evaluation.metrics?.relevance || 0,
          coherence: evaluation.metrics?.coherence || 0,
          completeness: evaluation.metrics?.completeness || 0,
        },
        advancedMetrics: {
          noHallucination: evaluation.advancedMetrics?.noHallucination || 0,
          responseSpeed: evaluation.advancedMetrics?.responseSpeed || 0,
          infoAccuracy: evaluation.advancedMetrics?.infoAccuracy || 0,
          protocol: evaluation.advancedMetrics?.protocol || 0,
          resolution: evaluation.advancedMetrics?.resolution || 0,
          voiceQuality: evaluation.advancedMetrics?.voiceQuality || 0,
          tone: evaluation.advancedMetrics?.tone || 0,
          empathy: evaluation.advancedMetrics?.empathy || 0,
        },
        analysis: {
          summary: evaluation.analysis?.summary || 'Evaluation complete',
          strengths: evaluation.analysis?.strengths || [],
          issues: evaluation.analysis?.issues || [],
        },
      };

    } catch (error) {
      console.error('[RealTestExecutor] OpenAI evaluation error:', error);
      return this.createFailedEvaluation();
    }
  }

  /**
   * Create a failed evaluation result
   */
  private createFailedEvaluation(): EvaluationResult {
    return {
      overallScore: 0,
      passed: false,
      metrics: {
        accuracy: 0,
        relevance: 0,
        coherence: 0,
        completeness: 0,
      },
      advancedMetrics: {
        noHallucination: 0,
        responseSpeed: 0,
        infoAccuracy: 0,
        protocol: 0,
        resolution: 0,
        voiceQuality: 0,
        tone: 0,
        empathy: 0,
      },
      analysis: {
        summary: 'Test failed due to execution error',
        strengths: [],
        issues: [],
      },
    };
  }

  /**
   * Check if string is a valid UUID
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Store test result in database
   * Updates the existing pending test result instead of inserting a new one
   */
  private async storeResult(testRunId: string, result: TestResult): Promise<void> {
    try {
      const testCaseId = this.isValidUUID(result.testCaseId) ? result.testCaseId : uuidv4();
      
      // Update the existing pending test result instead of inserting
      const updateResult = await pool.query(
        `UPDATE test_results SET
          actual_response = $1,
          status = $2,
          latency_ms = $3,
          intent_match = $4,
          output_match = $5,
          user_transcript = $6,
          agent_transcript = $7,
          conversation_turns = $8,
          metrics = $9,
          agent_audio_url = $10,
          started_at = $11,
          completed_at = NOW()
        WHERE test_run_id = $12 AND test_case_id = $13`,
        [
          result.agentTranscript || result.conversationTurns.filter(t => t.role === 'agent').map(t => t.text).join('\n'),  // Actual response from agent
          result.status,
          result.durationMs,
          result.evaluation.passed,
          result.evaluation.metrics.accuracy >= 70,
          result.testCallerTranscript || result.conversationTurns.filter(t => t.role === 'user').map(t => t.text).join('\n'),
          result.agentTranscript || result.conversationTurns.filter(t => t.role === 'agent').map(t => t.text).join('\n'),
          JSON.stringify(result.conversationTurns),
          JSON.stringify({
            overallScore: result.evaluation.overallScore,
            metrics: result.evaluation.metrics,
            advancedMetrics: result.evaluation.advancedMetrics,
            analysis: result.evaluation.analysis,
            callId: result.callId,
            hasRecording: result.hasRecording,
            recordingUrl: result.recordingUrl,
          }),
          result.recordingUrl || null,
          new Date(Date.now() - result.durationMs),
          testRunId,
          testCaseId,
        ]
      );

      // If no row was updated (legacy case), insert a new one
      if (updateResult.rowCount === 0) {
        await pool.query(
          `INSERT INTO test_results (
            id, test_run_id, test_case_id,
            scenario, user_input, expected_response, actual_response, category,
            status, latency_ms, intent_match, output_match,
            user_transcript, agent_transcript, conversation_turns, metrics,
            agent_audio_url,
            started_at, completed_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW())`,
          [
            uuidv4(),
            testRunId,
            testCaseId,
            result.scenario,
            result.userInput || '',
            result.expectedOutcome || '',
            result.agentTranscript || result.conversationTurns.filter(t => t.role === 'agent').map(t => t.text).join('\n'),
            result.category || 'General',
            result.status,
            result.durationMs,
            result.evaluation.passed,
            result.evaluation.metrics.accuracy >= 70,
            result.testCallerTranscript || result.conversationTurns.filter(t => t.role === 'user').map(t => t.text).join('\n'),
            result.agentTranscript || result.conversationTurns.filter(t => t.role === 'agent').map(t => t.text).join('\n'),
            JSON.stringify(result.conversationTurns),
            JSON.stringify({
              overallScore: result.evaluation.overallScore,
              metrics: result.evaluation.metrics,
              advancedMetrics: result.evaluation.advancedMetrics,
              analysis: result.evaluation.analysis,
              callId: result.callId,
              hasRecording: result.hasRecording,
              recordingUrl: result.recordingUrl,
            }),
            result.recordingUrl || null,
            new Date(Date.now() - result.durationMs),
          ]
        );
      }

      console.log(`[RealTestExecutor] Result stored for test: ${result.testCaseName}`);

    } catch (error) {
      console.error('[RealTestExecutor] Failed to store result:', error);
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const realTestExecutor = new RealTestExecutorService();
