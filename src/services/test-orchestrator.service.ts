/**
 * Test Execution Orchestrator
 * Coordinates the complete test execution pipeline:
 * TTS → Voice Call → ASR → Analysis → Results
 */

import { Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { TTSService, TTSRequest, TTSResponse } from './tts.service';
import { ASRService, TranscriptionRequest, TranscriptionResponse } from './asr.service';
import { ElevenLabsCaller, RetellCaller, VAPICaller, createCaller } from './voice-caller.service';
import { TestJobData, TestJobResult, testExecutionQueue, TestExecutionQueue } from './queue.service';
import pool from '../db';

// Analysis service for comparing expected vs actual responses
interface ResponseAnalysis {
  intentMatch: boolean;
  responseQuality: number;
  keywordsMatched: string[];
  keywordsMissed: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  confidenceScore: number;
}

/**
 * Main Test Execution Orchestrator
 */
export class TestExecutionOrchestrator {
  private ttsService: TTSService | null = null;
  private asrService: ASRService | null = null;
  private isRunning: boolean = false;

  constructor() {
    // Initialize services with API keys from environment
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
   * Initialize and start the test execution worker
   */
  async startWorker(concurrency: number = 1): Promise<void> {
    if (this.isRunning) {
      console.log('Worker already running');
      return;
    }

    console.log(`Starting test execution worker with concurrency: ${concurrency}`);
    
    testExecutionQueue.startWorker(
      async (job: Job<TestJobData, TestJobResult>) => {
        return this.executeTest(job);
      },
      concurrency
    );

    this.isRunning = true;
    console.log('Test execution worker started');
  }

  /**
   * Execute a single test case
   */
  private async executeTest(job: Job<TestJobData, TestJobResult>): Promise<TestJobResult> {
    const { testCase, agentConfig, ttsConfig, testRunId, testCaseId } = job.data;
    const startTime = Date.now();

    console.log(`Executing test: ${testCase.scenario}`);

    try {
      // Update job progress
      await job.updateProgress(10);

      // Check if we should use mock mode (for testing without real voice agents)
      const useMockMode = process.env.MOCK_VOICE_AGENT === 'true' || !agentConfig.agentId || agentConfig.agentId === 'mock';
      
      if (useMockMode) {
        return this.executeMockTest(job, testCase, testRunId, testCaseId, startTime);
      }

      // Step 1: Generate TTS audio from user input
      console.log('Step 1: Generating TTS audio...');
      if (!this.ttsService) {
        throw new Error('TTS service not initialized. Please set ELEVENLABS_API_KEY.');
      }
      const ttsRequest: TTSRequest = {
        text: testCase.userInput,
        voiceId: ttsConfig.voice,
        modelId: ttsConfig.model,
      };
      const userAudioResponse = await this.ttsService.generateSpeech(ttsRequest);
      const userAudioDurationMs = userAudioResponse.durationMs || this.estimateAudioDuration(userAudioResponse.audioBuffer.length);
      await job.updateProgress(25);

      // Step 2: Call the voice agent
      console.log(`Step 2: Calling ${agentConfig.provider} agent...`);
      const callResult = await this.callAgent(agentConfig, userAudioResponse.audioBuffer);
      await job.updateProgress(60);

      // Step 3: Transcribe agent response
      console.log('Step 3: Transcribing agent response...');
      let agentTranscript = '';
      let agentAudioDurationMs = 0;

      if (callResult.audioBuffer && callResult.audioBuffer.length > 0 && this.asrService) {
        const transcriptionRequest: TranscriptionRequest = {
          audioBuffer: callResult.audioBuffer,
        };
        const transcription = await this.asrService.transcribe(transcriptionRequest);
        agentTranscript = transcription.transcript;
        agentAudioDurationMs = transcription.durationMs;
      } else if (callResult.transcript) {
        agentTranscript = callResult.transcript;
      }
      await job.updateProgress(80);

      // Step 4: Analyze response
      console.log('Step 4: Analyzing response...');
      const analysis = this.analyzeResponse(
        testCase.expectedResponse,
        agentTranscript,
        testCase.category
      );
      await job.updateProgress(90);

      // Step 5: Calculate metrics
      const totalDurationMs = Date.now() - startTime;
      const firstResponseLatencyMs = callResult.firstResponseTime
        ? callResult.firstResponseTime - startTime
        : undefined;

      const result: TestJobResult = {
        testRunId,
        testCaseId,
        success: true,
        metrics: {
          firstResponseLatencyMs,
          totalDurationMs,
          userAudioDurationMs,
          agentAudioDurationMs,
        },
        transcript: {
          userInput: testCase.userInput,
          agentResponse: agentTranscript,
        },
        analysis,
        timestamp: new Date(),
      };

      // Step 6: Store result in database
      await this.storeResult(result);
      await job.updateProgress(100);

      console.log(`Test completed: ${testCase.scenario} - Quality: ${analysis.responseQuality}/5`);
      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Test failed: ${testCase.scenario}`, errorMessage);

      const result: TestJobResult = {
        testRunId,
        testCaseId,
        success: false,
        metrics: {
          totalDurationMs: Date.now() - startTime,
        },
        transcript: {
          userInput: testCase.userInput,
          agentResponse: '',
        },
        error: errorMessage,
        timestamp: new Date(),
      };

      await this.storeResult(result);
      return result;
    }
  }

  /**
   * Call the voice agent based on provider
   */
  private async callAgent(
    agentConfig: TestJobData['agentConfig'],
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
            audioBuffer: Buffer.concat(audioChunks), 
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
            audioBuffer: Buffer.concat(audioChunks), 
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
   * Call VAPI agent
   */
  private async callVAPIAgent(
    agentId: string,
    apiKey: string,
    userAudio: Buffer
  ): Promise<{ audioBuffer?: Buffer; transcript?: string; firstResponseTime?: number }> {
    const caller = new VAPICaller(apiKey);
    
    try {
      const { callId } = await caller.createCall(agentId);
      
      // VAPI doesn't support direct audio streaming in the same way
      // For now, return empty and use transcript from call details
      await new Promise(resolve => setTimeout(resolve, 10000));
      await caller.endCall();
      
      // Get call transcript from API
      const response = await fetch(`https://api.vapi.ai/call/${callId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      
      if (response.ok) {
        const data = await response.json() as { transcript?: string };
        return {
          transcript: data.transcript || '',
          firstResponseTime: Date.now(),
        };
      }
      
      return { transcript: '' };
    } catch (error) {
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
  ): ResponseAnalysis {
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

    // Calculate intent match (simplified)
    const intentMatch = keywordsMatched.length >= expectedKeywords.length * 0.5;

    // Calculate response quality (1-5)
    const keywordScore = expectedKeywords.length > 0 
      ? keywordsMatched.length / expectedKeywords.length 
      : 0.5;
    const lengthScore = actual.length > 10 ? 1 : actual.length / 10;
    const qualityScore = (keywordScore * 0.7 + lengthScore * 0.3) * 5;
    const responseQuality = Math.max(1, Math.min(5, Math.round(qualityScore)));

    // Simple sentiment analysis
    const positiveWords = ['yes', 'sure', 'great', 'happy', 'help', 'welcome', 'thank'];
    const negativeWords = ['no', 'sorry', "can't", 'unable', 'error', 'problem'];
    
    const positiveCount = positiveWords.filter(w => actualLower.includes(w)).length;
    const negativeCount = negativeWords.filter(w => actualLower.includes(w)).length;
    
    let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
    if (positiveCount > negativeCount) sentiment = 'positive';
    else if (negativeCount > positiveCount) sentiment = 'negative';

    // Confidence score
    const confidenceScore = keywordScore;

    const result: ResponseAnalysis = {
      intentMatch,
      responseQuality,
      keywordsMatched,
      keywordsMissed,
      sentiment,
      confidenceScore,
    };
    return result;
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
    ]);

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10); // Limit to top 10 keywords
  }

  /**
   * Estimate audio duration from buffer size (PCM 16kHz, 16-bit mono)
   */
  private estimateAudioDuration(bufferSize: number): number {
    // PCM 16kHz, 16-bit (2 bytes per sample), mono
    const bytesPerSecond = 16000 * 2;
    return (bufferSize / bytesPerSecond) * 1000;
  }

  /**
   * Store test result in database
   */
  private async storeResult(result: TestJobResult): Promise<void> {
    try {
      // Get test case data from job
      const jobData = await testExecutionQueue.getJobData(result.testCaseId);
      
      // Insert into test_results table with all test case info
      await pool.query(
        `INSERT INTO test_results (
          id, test_run_id, test_case_id, 
          scenario, user_input, expected_response, actual_response, category,
          status, latency_ms, completed_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          uuidv4(),
          result.testRunId,
          result.testCaseId,
          jobData?.testCase?.scenario || '',
          result.transcript.userInput,
          jobData?.testCase?.expectedResponse || '',
          result.transcript.agentResponse,
          jobData?.testCase?.category || '',
          result.success ? 'passed' : 'failed',
          result.metrics.firstResponseLatencyMs || result.metrics.totalDurationMs,
          result.timestamp,
          result.timestamp,
        ]
      );

      // Check if test run is complete and update status
      await this.checkAndUpdateTestRunStatus(result.testRunId);
    } catch (error) {
      console.error('Failed to store result:', error);
      // Don't throw - we don't want DB errors to fail the test
    }
  }

  /**
   * Check if all tests are done and update test run status
   */
  private async checkAndUpdateTestRunStatus(testRunId: string): Promise<void> {
    try {
      // Get test run total and completed count
      const result = await pool.query(
        `SELECT 
          tr.total_tests,
          COUNT(tres.id) as completed,
          COUNT(CASE WHEN tres.status = 'passed' THEN 1 END) as passed,
          COUNT(CASE WHEN tres.status = 'failed' THEN 1 END) as failed
         FROM test_runs tr
         LEFT JOIN test_results tres ON tres.test_run_id = tr.id
         WHERE tr.id = $1
         GROUP BY tr.id`,
        [testRunId]
      );

      if (result.rows.length > 0) {
        const { total_tests, completed, passed, failed } = result.rows[0];
        
        if (parseInt(completed) >= parseInt(total_tests)) {
          // All tests done - update status
          await pool.query(
            `UPDATE test_runs 
             SET status = 'completed', 
                 passed_tests = $2, 
                 failed_tests = $3,
                 completed_at = NOW()
             WHERE id = $1`,
            [testRunId, passed, failed]
          );
          console.log(`Test run ${testRunId} completed: ${passed} passed, ${failed} failed`);
        }
      }
    } catch (error) {
      console.error('Failed to update test run status:', error);
    }
  }

  /**
   * Execute a mock test for testing the UI flow without real voice agents
   */
  private async executeMockTest(
    job: Job<TestJobData, TestJobResult>,
    testCase: TestJobData['testCase'],
    testRunId: string,
    testCaseId: string,
    startTime: number
  ): Promise<TestJobResult> {
    console.log(`[MOCK] Executing mock test: ${testCase.scenario}`);

    // Simulate processing time
    await this.sleep(500);
    await job.updateProgress(25);

    // Simulate voice agent call
    await this.sleep(800);
    await job.updateProgress(50);

    // Generate mock response based on expected response
    const mockResponses = [
      `Hello! ${testCase.expectedResponse}`,
      `Sure, I can help with that. ${testCase.expectedResponse}`,
      `Of course! ${testCase.expectedResponse}`,
      testCase.expectedResponse,
    ];
    const mockResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)];

    await this.sleep(500);
    await job.updateProgress(75);

    // Analyze the mock response
    const analysis = this.analyzeResponse(
      testCase.expectedResponse,
      mockResponse,
      testCase.category
    );

    await this.sleep(300);
    await job.updateProgress(90);

    // Randomly make some tests fail for realistic results
    const shouldPass = Math.random() > 0.15; // 85% pass rate

    const result: TestJobResult = {
      testRunId,
      testCaseId,
      success: shouldPass,
      metrics: {
        firstResponseLatencyMs: Math.floor(Math.random() * 500) + 200,
        totalDurationMs: Date.now() - startTime,
        userAudioDurationMs: Math.floor(Math.random() * 2000) + 1000,
        agentAudioDurationMs: Math.floor(Math.random() * 3000) + 1500,
      },
      transcript: {
        userInput: testCase.userInput,
        agentResponse: shouldPass ? mockResponse : 'I apologize, but I encountered an error processing your request.',
      },
      analysis: shouldPass ? analysis : {
        intentMatch: false,
        responseQuality: 2,
        keywordsMatched: [],
        keywordsMissed: this.extractKeywords(testCase.expectedResponse),
        sentiment: 'negative' as const,
        confidenceScore: 0.3,
      },
      timestamp: new Date(),
    };

    if (!shouldPass) {
      result.error = 'Mock: Simulated failure for testing';
    }

    // Store result in database
    await this.storeResult(result);
    await job.updateProgress(100);

    console.log(`[MOCK] Test completed: ${testCase.scenario} - ${shouldPass ? 'PASSED' : 'FAILED'}`);
    return result;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop the worker
   */
  async stopWorker(): Promise<void> {
    this.isRunning = false;
    await testExecutionQueue.close();
    console.log('Test execution worker stopped');
  }
}

// Export singleton instance
export const testOrchestrator = new TestExecutionOrchestrator();
