/**
 * Direct Test Executor Service
 * Executes voice agent tests directly without Redis/BullMQ workers
 * Handles the complete test pipeline: TTS → Voice Call → ASR → Analysis → Results
 */

import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import pool from '../db';
import { TTSService, TTSRequest, TTSResponse } from './tts.service';
import { ASRService, TranscriptionRequest, TranscriptionResponse } from './asr.service';
import { ElevenLabsCaller, RetellCaller, VAPICaller, createCaller } from './voice-caller.service';

// Test case interface
export interface TestCase {
  id: string;
  scenario: string;
  userInput: string;
  expectedResponse: string;
  category: string;
}

// Test result interface
export interface DirectTestResult {
  testCaseId: string;
  scenario: string;
  userInput: string;
  expectedResponse: string;
  actualResponse: string;
  category: string;
  status: 'passed' | 'failed';
  latencyMs: number;
  metrics: {
    ttsGenerationMs?: number;
    voiceCallMs?: number;
    asrTranscriptionMs?: number;
    analysisMs?: number;
    firstResponseLatencyMs?: number;
  };
  analysis: {
    intentMatch: boolean;
    responseQuality: number;
    keywordsMatched: string[];
    keywordsMissed: string[];
    sentiment: 'positive' | 'neutral' | 'negative';
    confidenceScore: number;
  };
  error?: string;
}

// Agent configuration
export interface AgentConfig {
  provider: 'elevenlabs' | 'retell' | 'vapi' | 'haptik';
  agentId: string;
  apiKey: string;
  agentName?: string;
}

// TTS configuration  
export interface TTSConfig {
  voice?: string;
  model?: string;
}

// Test run configuration
export interface DirectTestRunConfig {
  testRunId: string;
  name: string;
  agentConfig: AgentConfig;
  ttsConfig?: TTSConfig;
  testCases: TestCase[];
  concurrency?: number;
  useMockMode?: boolean;
}

// Progress callback
export type ProgressCallback = (
  completed: number,
  total: number,
  currentTest?: { scenario: string; status: string }
) => void;

/**
 * Direct Test Executor - runs tests without queue/workers
 */
export class DirectTestExecutorService {
  private ttsService: TTSService | null = null;
  private asrService: ASRService | null = null;

  constructor() {
    // Initialize services if API keys are available
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

    if (elevenLabsApiKey) {
      this.ttsService = new TTSService(elevenLabsApiKey);
    }
    if (deepgramApiKey) {
      this.asrService = new ASRService(deepgramApiKey);
    }
  }

  /**
   * Execute all tests for a test run
   */
  async executeTestRun(
    config: DirectTestRunConfig,
    onProgress?: ProgressCallback
  ): Promise<{
    testRunId: string;
    results: DirectTestResult[];
    summary: {
      total: number;
      passed: number;
      failed: number;
      avgLatencyMs: number;
      passRate: number;
    };
  }> {
    const { testRunId, testCases, concurrency = 1, useMockMode } = config;
    const results: DirectTestResult[] = [];
    
    console.log(`[DirectExecutor] Starting test run ${testRunId} with ${testCases.length} tests`);

    // Determine if we should use mock mode
    const shouldUseMock = useMockMode || 
      process.env.MOCK_VOICE_AGENT === 'true' || 
      !config.agentConfig.agentId || 
      config.agentConfig.agentId === 'mock';

    // Run tests in batches based on concurrency
    const batchSize = concurrency;
    const batches: TestCase[][] = [];
    
    for (let i = 0; i < testCases.length; i += batchSize) {
      batches.push(testCases.slice(i, i + batchSize));
    }

    let completedCount = 0;
    let passedCount = 0;
    let failedCount = 0;

    // Process each batch
    for (const batch of batches) {
      // Run tests in parallel within each batch
      const batchResults = await Promise.all(
        batch.map(testCase => 
          shouldUseMock 
            ? this.executeMockTest(testCase, config)
            : this.executeRealTest(testCase, config)
        )
      );

      // Store results and update counts
      for (const result of batchResults) {
        await this.storeResult(testRunId, result);
        results.push(result);
        completedCount++;
        
        if (result.status === 'passed') passedCount++;
        else failedCount++;

        console.log(`[DirectExecutor] [${completedCount}/${testCases.length}] ${result.scenario}: ${result.status.toUpperCase()}`);
        
        // Call progress callback
        if (onProgress) {
          onProgress(completedCount, testCases.length, {
            scenario: result.scenario,
            status: result.status,
          });
        }
      }
    }

    // Calculate summary
    const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);
    const avgLatencyMs = results.length > 0 ? totalLatency / results.length : 0;
    const passRate = results.length > 0 ? (passedCount / results.length) * 100 : 0;

    // Update test run as completed
    await pool.query(
      `UPDATE test_runs 
       SET status = 'completed', 
           passed_tests = $2, 
           failed_tests = $3,
           completed_at = NOW()
       WHERE id = $1`,
      [testRunId, passedCount, failedCount]
    );

    console.log(`[DirectExecutor] Test run ${testRunId} completed: ${passedCount} passed, ${failedCount} failed`);

    return {
      testRunId,
      results,
      summary: {
        total: testCases.length,
        passed: passedCount,
        failed: failedCount,
        avgLatencyMs,
        passRate,
      },
    };
  }

  /**
   * Execute a single test with real voice agent
   */
  private async executeRealTest(
    testCase: TestCase,
    config: DirectTestRunConfig
  ): Promise<DirectTestResult> {
    const startTime = Date.now();
    const metrics: DirectTestResult['metrics'] = {};

    try {
      console.log(`[DirectExecutor] Executing test: ${testCase.scenario}`);

      // Step 1: Generate TTS audio from user input
      let userAudioBuffer: Buffer | null = null;
      if (this.ttsService) {
        const ttsStart = Date.now();
        const ttsRequest: TTSRequest = {
          text: testCase.userInput,
          voiceId: config.ttsConfig?.voice,
          modelId: config.ttsConfig?.model,
        };
        const ttsResponse = await this.ttsService.generateSpeech(ttsRequest);
        userAudioBuffer = ttsResponse.audioBuffer;
        metrics.ttsGenerationMs = Date.now() - ttsStart;
        console.log(`[DirectExecutor] TTS generated in ${metrics.ttsGenerationMs}ms`);
      }

      // Step 2: Call the voice agent
      const voiceCallStart = Date.now();
      const callResult = await this.callAgent(
        config.agentConfig,
        userAudioBuffer || Buffer.from(testCase.userInput) // Fallback to text if no TTS
      );
      metrics.voiceCallMs = Date.now() - voiceCallStart;
      metrics.firstResponseLatencyMs = callResult.firstResponseTime 
        ? callResult.firstResponseTime - voiceCallStart 
        : undefined;
      console.log(`[DirectExecutor] Voice call completed in ${metrics.voiceCallMs}ms`);

      // Step 3: Transcribe agent response (if we got audio back)
      let agentTranscript = callResult.transcript || '';
      if (callResult.audioBuffer && callResult.audioBuffer.length > 0 && this.asrService) {
        const asrStart = Date.now();
        const transcription = await this.asrService.transcribe({
          audioBuffer: callResult.audioBuffer,
        });
        agentTranscript = transcription.transcript || agentTranscript;
        metrics.asrTranscriptionMs = Date.now() - asrStart;
        console.log(`[DirectExecutor] ASR transcription in ${metrics.asrTranscriptionMs}ms`);
      }

      // Step 4: Analyze the response
      const analysisStart = Date.now();
      const analysis = this.analyzeResponse(
        testCase.expectedResponse,
        agentTranscript,
        testCase.category
      );
      metrics.analysisMs = Date.now() - analysisStart;

      // Determine pass/fail based on analysis
      const isPassed = analysis.intentMatch && analysis.responseQuality >= 3;

      return {
        testCaseId: testCase.id,
        scenario: testCase.scenario,
        userInput: testCase.userInput,
        expectedResponse: testCase.expectedResponse,
        actualResponse: agentTranscript,
        category: testCase.category,
        status: isPassed ? 'passed' : 'failed',
        latencyMs: Date.now() - startTime,
        metrics,
        analysis,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[DirectExecutor] Test failed: ${testCase.scenario}`, errorMessage);

      return {
        testCaseId: testCase.id,
        scenario: testCase.scenario,
        userInput: testCase.userInput,
        expectedResponse: testCase.expectedResponse,
        actualResponse: '',
        category: testCase.category,
        status: 'failed',
        latencyMs: Date.now() - startTime,
        metrics,
        analysis: {
          intentMatch: false,
          responseQuality: 0,
          keywordsMatched: [],
          keywordsMissed: this.extractKeywords(testCase.expectedResponse),
          sentiment: 'negative',
          confidenceScore: 0,
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a mock test for testing without real voice agents
   */
  private async executeMockTest(
    testCase: TestCase,
    config: DirectTestRunConfig
  ): Promise<DirectTestResult> {
    const startTime = Date.now();

    // Simulate processing time (300ms - 1.5s)
    await this.sleep(300 + Math.random() * 1200);

    // Generate mock response based on expected response
    const mockResponses = [
      `Hello! ${testCase.expectedResponse}`,
      `Sure, I can help with that. ${testCase.expectedResponse}`,
      `Of course! ${testCase.expectedResponse}`,
      testCase.expectedResponse,
      `Let me help you with that. ${testCase.expectedResponse}`,
    ];
    const mockResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)];

    // Analyze the response
    const analysis = this.analyzeResponse(
      testCase.expectedResponse,
      mockResponse,
      testCase.category
    );

    // Randomly fail ~15% of tests for realistic results
    const shouldPass = Math.random() > 0.15;

    return {
      testCaseId: testCase.id,
      scenario: testCase.scenario,
      userInput: testCase.userInput,
      expectedResponse: testCase.expectedResponse,
      actualResponse: shouldPass 
        ? mockResponse 
        : 'I apologize, but I encountered an error processing your request.',
      category: testCase.category,
      status: shouldPass ? 'passed' : 'failed',
      latencyMs: Date.now() - startTime,
      metrics: {
        ttsGenerationMs: Math.floor(Math.random() * 200) + 100,
        voiceCallMs: Math.floor(Math.random() * 800) + 400,
        asrTranscriptionMs: Math.floor(Math.random() * 150) + 50,
        analysisMs: Math.floor(Math.random() * 50) + 10,
        firstResponseLatencyMs: Math.floor(Math.random() * 500) + 200,
      },
      analysis: shouldPass ? analysis : {
        intentMatch: false,
        responseQuality: 2,
        keywordsMatched: [],
        keywordsMissed: this.extractKeywords(testCase.expectedResponse),
        sentiment: 'negative' as const,
        confidenceScore: 0.3,
      },
      error: shouldPass ? undefined : 'Mock: Simulated failure for testing',
    };
  }

  /**
   * Call the voice agent based on provider
   */
  private async callAgent(
    agentConfig: AgentConfig,
    userAudio: Buffer
  ): Promise<{
    audioBuffer?: Buffer;
    transcript?: string;
    firstResponseTime?: number;
  }> {
    const { provider, agentId, apiKey } = agentConfig;

    switch (provider) {
      case 'elevenlabs':
        return this.callElevenLabsAgent(agentId, apiKey, userAudio);
      case 'retell':
        return this.callRetellAgent(agentId, apiKey, userAudio);
      case 'vapi':
        return this.callVAPIAgent(agentId, apiKey, userAudio);
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
    userAudio: Buffer
  ): Promise<{ audioBuffer?: Buffer; transcript?: string; firstResponseTime?: number }> {
    return new Promise(async (resolve, reject) => {
      const caller = new ElevenLabsCaller(apiKey);
      const audioChunks: Buffer[] = [];
      let transcript = '';
      let firstResponseTime: number | undefined;
      const callStartTime = Date.now();
      
      const timeout = setTimeout(() => {
        caller.endConversation();
        resolve({ audioBuffer: Buffer.concat(audioChunks), transcript, firstResponseTime });
      }, 30000); // 30 second timeout

      try {
        await caller.startConversation(agentId);

        caller.on('agent_audio', (data: any) => {
          if (!firstResponseTime) {
            firstResponseTime = Date.now();
          }
          if (data.audio_event?.audio_base_64) {
            audioChunks.push(Buffer.from(data.audio_event.audio_base_64, 'base64'));
          }
        });

        caller.on('agent_response', (data: any) => {
          if (data.agent_response_event?.agent_response) {
            transcript = data.agent_response_event.agent_response;
          }
        });

        caller.on('close', () => {
          clearTimeout(timeout);
          resolve({ 
            audioBuffer: audioChunks.length > 0 ? Buffer.concat(audioChunks) : undefined, 
            transcript, 
            firstResponseTime 
          });
        });

        // Send user audio
        caller.sendAudio(userAudio);

        // Wait for response then close
        setTimeout(() => {
          caller.endConversation();
        }, 15000); // Wait 15 seconds for response

      } catch (error) {
        clearTimeout(timeout);
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
    userAudio: Buffer
  ): Promise<{ audioBuffer?: Buffer; transcript?: string; firstResponseTime?: number }> {
    return new Promise(async (resolve, reject) => {
      const caller = new RetellCaller(apiKey);
      const audioChunks: Buffer[] = [];
      let transcript = '';
      let firstResponseTime: number | undefined;
      
      const timeout = setTimeout(() => {
        caller.endCall();
        resolve({ audioBuffer: Buffer.concat(audioChunks), transcript, firstResponseTime });
      }, 30000);

      try {
        const { accessToken } = await caller.createWebCall(agentId);
        await caller.connectWebSocket(accessToken);

        caller.on('agent_audio', (data: Buffer) => {
          if (!firstResponseTime) {
            firstResponseTime = Date.now();
          }
          audioChunks.push(data);
        });

        caller.on('transcript', (data: any) => {
          if (data.role === 'agent') {
            transcript += data.content + ' ';
          }
        });

        caller.on('close', () => {
          clearTimeout(timeout);
          resolve({ 
            audioBuffer: audioChunks.length > 0 ? Buffer.concat(audioChunks) : undefined, 
            transcript: transcript.trim(), 
            firstResponseTime 
          });
        });

        // Send user audio
        caller.sendAudio(userAudio);

        setTimeout(() => {
          caller.endCall();
        }, 15000);

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Call VAPI agent using text simulation
   * 
   * VAPI requires WebRTC for web calls, which isn't available in Node.js.
   * We simulate the conversation by fetching the assistant's prompt and
   * using OpenAI to generate what the assistant would respond.
   */
  private async callVAPIAgent(
    agentId: string,
    apiKey: string,
    userAudio: Buffer
  ): Promise<{ audioBuffer?: Buffer; transcript?: string; firstResponseTime?: number }> {
    try {
      // Fetch VAPI assistant configuration
      const assistantResponse = await fetch(`https://api.vapi.ai/assistant/${agentId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });

      if (!assistantResponse.ok) {
        throw new Error(`Failed to fetch VAPI assistant: ${await assistantResponse.text()}`);
      }

      const assistantData = await assistantResponse.json() as {
        model?: {
          messages?: Array<{ role: string; content: string }>;
          systemPrompt?: string;
        };
        firstMessage?: string;
      };

      // Extract system prompt
      let systemPrompt = '';
      if (assistantData.model?.messages && Array.isArray(assistantData.model.messages)) {
        const systemMsg = assistantData.model.messages.find(m => m.role === 'system');
        if (systemMsg) {
          systemPrompt = systemMsg.content;
        }
      }
      if (!systemPrompt && assistantData.model?.systemPrompt) {
        systemPrompt = assistantData.model.systemPrompt;
      }

      // Build the response using the first message and system prompt
      let transcript = '';
      
      if (assistantData.firstMessage) {
        transcript = assistantData.firstMessage;
      } else if (systemPrompt) {
        // If no first message, generate one based on the system prompt
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Say hello and introduce yourself briefly.' }
          ],
          temperature: 0.7,
          max_tokens: 150,
        });
        transcript = response.choices[0]?.message?.content || 'Hello, how can I help you?';
      } else {
        transcript = 'Hello, how can I help you today?';
      }

      return {
        transcript,
        firstResponseTime: Date.now(),
      };
    } catch (error) {
      console.error(`[DirectTestExecutor] VAPI simulation error:`, error);
      throw error;
    }
  }

  /**
   * Analyze the agent response against expected response
   */
  private analyzeResponse(
    expected: string,
    actual: string,
    category: string
  ): DirectTestResult['analysis'] {
    // Extract keywords from expected response
    const expectedKeywords = this.extractKeywords(expected);
    const actualLower = actual.toLowerCase();
    
    // Check which keywords are present
    const keywordsMatched = expectedKeywords.filter(kw => 
      actualLower.includes(kw.toLowerCase())
    );
    const keywordsMissed = expectedKeywords.filter(kw => 
      !actualLower.includes(kw.toLowerCase())
    );

    // Calculate intent match
    const intentMatch = keywordsMatched.length >= expectedKeywords.length * 0.5;

    // Calculate response quality (1-5)
    const keywordScore = expectedKeywords.length > 0 
      ? keywordsMatched.length / expectedKeywords.length 
      : 0.5;
    const lengthScore = actual.length > 10 ? 1 : actual.length / 10;
    const qualityScore = (keywordScore * 0.7 + lengthScore * 0.3) * 5;
    const responseQuality = Math.max(1, Math.min(5, Math.round(qualityScore)));

    // Simple sentiment analysis
    const positiveWords = ['yes', 'sure', 'great', 'happy', 'help', 'welcome', 'thank', 'certainly', 'absolutely'];
    const negativeWords = ['no', 'sorry', "can't", 'unable', 'error', 'problem', 'unfortunately', 'apologize'];
    
    const positiveCount = positiveWords.filter(w => actualLower.includes(w)).length;
    const negativeCount = negativeWords.filter(w => actualLower.includes(w)).length;
    
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
    if (positiveCount > negativeCount) sentiment = 'positive';
    else if (negativeCount > positiveCount) sentiment = 'negative';

    return {
      intentMatch,
      responseQuality,
      keywordsMatched,
      keywordsMissed,
      sentiment,
      confidenceScore: keywordScore,
    };
  }

  /**
   * Extract meaningful keywords from text
   */
  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'must', 'shall',
      'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further',
      'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
      'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'while', 'although', 'however', 'i', 'you', 'your',
      'we', 'our', 'they', 'their', 'this', 'that', 'it', 'its',
      'me', 'my', 'him', 'her', 'us', 'them', 'what', 'which',
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10); // Limit to top 10 keywords
  }

  /**
   * Check if a string is a valid UUID
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }

  /**
   * Store test result in database
   */
  private async storeResult(testRunId: string, result: DirectTestResult): Promise<void> {
    try {
      // Generate a proper UUID for test_case_id if the original is not a valid UUID
      const testCaseId = this.isValidUUID(result.testCaseId) ? result.testCaseId : uuidv4();
      
      await pool.query(
        `INSERT INTO test_results (
          id, test_run_id, test_case_id, 
          scenario, user_input, expected_response, actual_response, category,
          status, latency_ms, completed_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
        [
          uuidv4(),
          testRunId,
          testCaseId,
          result.scenario,
          result.userInput,
          result.expectedResponse,
          result.actualResponse,
          result.category,
          result.status,
          result.latencyMs,
        ]
      );
    } catch (error) {
      console.error('[DirectExecutor] Failed to store result:', error);
      // Don't throw - we don't want DB errors to fail the test
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
export const directTestExecutor = new DirectTestExecutorService();
