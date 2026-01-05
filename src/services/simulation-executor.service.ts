/**
 * Simulation Executor Service
 * 
 * Handles chat-based and voice-based simulation testing for custom agents.
 * Uses our own LLM for agent responses, and TTS/STT for voice simulations.
 */

import { agentService } from './agent.service';
import { testResultService } from './testResult.service';
import { testRunService } from './testRun.service';
import { customProvider, CustomAgentConfig } from '../providers/custom.provider';
import { TTSService } from './tts.service';
import { ASRService } from './asr.service';
import OpenAI from 'openai';

interface SimulationTestCase {
  id: string;
  name: string;
  scenario: string;
  expected_behavior: string;
  category?: string;
  priority?: string;
}

interface SimulationResult {
  testCaseId: string;
  success: boolean;
  transcript: Array<{ role: string; content: string; timestamp: number }>;
  evaluation: {
    passed: boolean;
    score: number;
    reason: string;
    suggestions?: string[];
  };
  metrics: {
    totalTurns: number;
    avgResponseTimeMs: number;
    totalDurationMs: number;
  };
  error?: string;
}

interface SimulationConfig {
  testMode: 'chat' | 'voice';
  maxTurns: number;
  evaluationModel: string;
}

export class SimulationExecutorService {
  private openai: OpenAI | null = null;
  private ttsService: TTSService | null = null;
  private asrService: ASRService | null = null;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (process.env.ELEVENLABS_API_KEY) {
      this.ttsService = new TTSService(process.env.ELEVENLABS_API_KEY);
    }
    if (process.env.DEEPGRAM_API_KEY) {
      this.asrService = new ASRService(process.env.DEEPGRAM_API_KEY);
    }
  }

  /**
   * Execute a single test case simulation
   */
  async executeTestCase(
    agentId: string,
    testCase: SimulationTestCase,
    config: SimulationConfig
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    const agent = await agentService.findById(agentId);
    
    if (!agent || agent.provider !== 'custom') {
      return {
        testCaseId: testCase.id,
        success: false,
        transcript: [],
        evaluation: { passed: false, score: 0, reason: 'Agent not found or not a custom agent' },
        metrics: { totalTurns: 0, avgResponseTimeMs: 0, totalDurationMs: 0 },
        error: 'Agent not found or not a custom agent',
      };
    }

    const agentConfig = agent.config as CustomAgentConfig;
    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    const responseTimes: number[] = [];

    try {
      // Generate user messages based on scenario
      const userMessages = await this.generateUserMessages(testCase.scenario, config.maxTurns);
      
      // Add agent's starting message if present
      if (agentConfig.startingMessage) {
        transcript.push({
          role: 'assistant',
          content: agentConfig.startingMessage,
          timestamp: Date.now(),
        });
      }

      // Run the conversation
      const sessionId = `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      for (const userMessage of userMessages) {
        // Add user message
        transcript.push({
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        });

        // Get agent response
        const responseStart = Date.now();
        const response = await customProvider.chat('custom', agentId, userMessage, {
          sessionId,
          config: agentConfig,
        });
        const responseTime = Date.now() - responseStart;
        responseTimes.push(responseTime);

        if (response && response.output.length > 0) {
          transcript.push({
            role: 'assistant',
            content: response.output[0].message,
            timestamp: Date.now(),
          });
        } else {
          throw new Error('No response from agent');
        }
      }

      // Evaluate the conversation
      const evaluation = await this.evaluateConversation(
        transcript,
        testCase.expected_behavior,
        agentConfig.systemPrompt
      );

      const totalDuration = Date.now() - startTime;
      const avgResponseTime = responseTimes.length > 0 
        ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
        : 0;

      return {
        testCaseId: testCase.id,
        success: true,
        transcript,
        evaluation,
        metrics: {
          totalTurns: transcript.length,
          avgResponseTimeMs: Math.round(avgResponseTime),
          totalDurationMs: totalDuration,
        },
      };
    } catch (error) {
      return {
        testCaseId: testCase.id,
        success: false,
        transcript,
        evaluation: { 
          passed: false, 
          score: 0, 
          reason: error instanceof Error ? error.message : 'Unknown error' 
        },
        metrics: { 
          totalTurns: transcript.length, 
          avgResponseTimeMs: 0, 
          totalDurationMs: Date.now() - startTime 
        },
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Execute multiple test cases with batching
   */
  async executeBatch(
    agentId: string,
    testCases: SimulationTestCase[],
    runId: string,
    config: SimulationConfig,
    concurrency: number = 3
  ): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];
    
    // Process in batches
    for (let i = 0; i < testCases.length; i += concurrency) {
      const batch = testCases.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(tc => this.executeTestCase(agentId, tc, config))
      );
      
      results.push(...batchResults);

      // Save results to database
      for (const result of batchResults) {
        // First create the test result
        const testResult = await testResultService.create({
          test_run_id: runId,
          test_case_id: result.testCaseId,
        });

        // Then update with the full data
        const transcriptText = result.transcript
          .map(t => `${t.role}: ${t.content}`)
          .join('\n');
        
        await testResultService.update(testResult.id, {
          status: result.evaluation.passed ? 'passed' : 'failed',
          user_transcript: result.transcript
            .filter(t => t.role === 'user')
            .map(t => t.content)
            .join('\n'),
          agent_transcript: result.transcript
            .filter(t => t.role === 'assistant')
            .map(t => t.content)
            .join('\n'),
          latency_ms: result.metrics.totalDurationMs,
          error_message: result.error,
          completed_at: new Date(),
        });
      }

      // Update run progress
      const completedCount = results.length;
      const progress = Math.round((completedCount / testCases.length) * 100);
      await testRunService.update(runId, {
        status: completedCount === testCases.length ? 'completed' : 'running',
      });
    }

    return results;
  }

  /**
   * Generate user messages based on test scenario
   */
  private async generateUserMessages(scenario: string, maxTurns: number): Promise<string[]> {
    if (!this.openai) {
      // Fallback: extract or create simple messages from scenario
      return [scenario];
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a test user simulator. Generate realistic user messages for testing a voice agent.
Based on the test scenario, create ${Math.min(maxTurns, 5)} user messages that would naturally occur in this conversation.
Return ONLY a JSON array of strings, no other text.
Example: ["Hello, I need help with my order", "Yes, order number 12345", "Thank you"]`,
          },
          {
            role: 'user',
            content: `Test scenario: ${scenario}\n\nGenerate the user messages:`,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content || '[]';
      // Extract JSON array from response
      const match = content.match(/\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]);
      }
      return [scenario];
    } catch (error) {
      console.error('Error generating user messages:', error);
      return [scenario];
    }
  }

  /**
   * Evaluate the conversation against expected behavior
   */
  private async evaluateConversation(
    transcript: Array<{ role: string; content: string; timestamp: number }>,
    expectedBehavior: string,
    systemPrompt: string
  ): Promise<{ passed: boolean; score: number; reason: string; suggestions?: string[] }> {
    if (!this.openai) {
      // Simple keyword-based evaluation fallback
      const agentResponses = transcript
        .filter(t => t.role === 'assistant')
        .map(t => t.content.toLowerCase())
        .join(' ');
      const expectedLower = expectedBehavior.toLowerCase();
      const keywords = expectedLower.split(/\s+/).filter(w => w.length > 4);
      const matchCount = keywords.filter(k => agentResponses.includes(k)).length;
      const score = keywords.length > 0 ? (matchCount / keywords.length) * 100 : 50;
      
      return {
        passed: score >= 60,
        score: Math.round(score),
        reason: score >= 60 ? 'Response appears to meet expectations' : 'Response may not fully meet expectations',
      };
    }

    try {
      const transcriptText = transcript
        .map(t => `${t.role === 'assistant' ? 'Agent' : 'User'}: ${t.content}`)
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a QA evaluator for voice agents. Evaluate if the agent's responses meet the expected behavior.
Consider:
1. Did the agent address the user's needs?
2. Was the response appropriate and professional?
3. Did the agent follow its intended purpose?

Return a JSON object with:
{
  "passed": boolean,
  "score": number (0-100),
  "reason": "brief explanation",
  "suggestions": ["improvement suggestion 1", "improvement suggestion 2"]
}`,
          },
          {
            role: 'user',
            content: `Agent System Prompt: ${systemPrompt.substring(0, 500)}...

Expected Behavior: ${expectedBehavior}

Conversation Transcript:
${transcriptText}

Evaluate this conversation:`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content || '{}';
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      return { passed: false, score: 50, reason: 'Could not parse evaluation' };
    } catch (error) {
      console.error('Error evaluating conversation:', error);
      return { passed: false, score: 50, reason: 'Evaluation error' };
    }
  }

  /**
   * Execute voice-based simulation (with TTS/STT)
   */
  async executeVoiceSimulation(
    agentId: string,
    testCase: SimulationTestCase,
    config: SimulationConfig
  ): Promise<SimulationResult> {
    // Voice simulation uses the same chat flow but with TTS/STT
    // For now, we use chat-based simulation as the core
    // TTS/STT would be added as a wrapper for actual voice testing
    
    // This could be enhanced to:
    // 1. Generate TTS audio for agent responses
    // 2. Use STT to transcribe user audio input
    // 3. Measure audio-specific latencies
    
    return this.executeTestCase(agentId, testCase, config);
  }
}

export const simulationExecutorService = new SimulationExecutorService();
