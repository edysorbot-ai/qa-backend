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
      // Add agent's starting message if present
      if (agentConfig.startingMessage) {
        transcript.push({
          role: 'assistant',
          content: agentConfig.startingMessage,
          timestamp: Date.now(),
        });
      }

      // Run a REACTIVE conversation that follows the agent's flow
      // Instead of pre-generating all user messages, we generate each response
      // based on what the agent says, simulating a real user who follows the flow
      const sessionId = `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const maxTurns = config.maxTurns || 10;
      let testObjectiveReached = false;
      
      // Generate the first user message (a natural greeting/opener)
      let currentUserMessage = await this.generateFlowAwareResponse(
        transcript,
        testCase,
        0,
        maxTurns,
        testObjectiveReached
      );
      
      for (let turn = 0; turn < maxTurns; turn++) {
        // Add user message
        transcript.push({
          role: 'user',
          content: currentUserMessage,
          timestamp: Date.now(),
        });

        // Get agent response
        const responseStart = Date.now();
        const response = await customProvider.chat('custom', agentId, currentUserMessage, {
          sessionId,
          config: agentConfig,
        });
        const responseTime = Date.now() - responseStart;
        responseTimes.push(responseTime);

        if (response && response.output.length > 0) {
          const agentMessage = response.output[0].message;
          transcript.push({
            role: 'assistant',
            content: agentMessage,
            timestamp: Date.now(),
          });
          
          // Check if we've reached the test objective
          const agentText = agentMessage.toLowerCase();
          const expectedText = testCase.expected_behavior.toLowerCase();
          const expectedKeywords = expectedText.split(/\s+/).filter(w => w.length > 4);
          const matchCount = expectedKeywords.filter(k => agentText.includes(k)).length;
          if (matchCount >= expectedKeywords.length * 0.3) {
            testObjectiveReached = true;
          }
          
          // Check for natural conversation end
          if (agentText.includes('goodbye') || agentText.includes('bye') || agentText.includes('take care')) {
            // Agent is ending the conversation
            transcript.push({
              role: 'user',
              content: 'Thank you! Goodbye!',
              timestamp: Date.now(),
            });
            break;
          }
          
          // Generate next user response reactively based on what the agent said
          currentUserMessage = await this.generateFlowAwareResponse(
            transcript,
            testCase,
            turn + 1,
            maxTurns,
            testObjectiveReached
          );
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
   * Generate user messages based on test scenario (legacy fallback)
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

IMPORTANT: The messages should follow a natural conversation flow:
1. First message should be a GREETING and general statement of need (not the specific test question)
2. Following messages should ANSWER the agent's likely qualifying questions (name, preferences, context)
3. Only the later messages should get to the specific test scenario question
4. This is because AI agents follow a conversation flow and won't answer specific questions until earlier steps are completed

Return ONLY a JSON array of strings, no other text.
Example: ["Hello, I need some help with something", "My name is Alex", "I'm interested in learning about your services", "Can you tell me about the pricing?", "Thank you, that's helpful"]`,
          },
          {
            role: 'user',
            content: `Test scenario: ${scenario}\n\nGenerate the user messages that follow a natural conversation flow:`,
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
   * Generate a flow-aware user response based on the current conversation state
   * This reacts to what the agent says instead of using pre-generated messages
   */
  private async generateFlowAwareResponse(
    transcript: Array<{ role: string; content: string; timestamp: number }>,
    testCase: SimulationTestCase,
    turnIndex: number,
    maxTurns: number,
    testObjectiveReached: boolean
  ): Promise<string> {
    if (!this.openai) {
      // Simple fallback
      if (turnIndex === 0) return `Hello, I need help with something.`;
      if (turnIndex === 1) return `I'm interested in ${testCase.scenario}`;
      return testCase.scenario;
    }

    try {
      const conversationSoFar = transcript
        .map(t => `${t.role === 'assistant' ? 'Agent' : 'User'}: ${t.content}`)
        .join('\n');

      const phase = turnIndex < 2 ? 'EARLY' : (turnIndex < maxTurns - 2 ? 'MIDDLE' : 'LATE');
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are simulating a real customer testing a voice agent. Generate the next user response.

TEST SCENARIO: ${testCase.scenario}
EXPECTED BEHAVIOR: ${testCase.expected_behavior}
CONVERSATION PHASE: ${phase}
TEST OBJECTIVE REACHED: ${testObjectiveReached ? 'YES' : 'NOT YET'}

CRITICAL RULES:
1. FOLLOW THE AGENT'S FLOW - if the agent asks you questions, ANSWER them cooperatively
2. In EARLY phase: Focus on greeting and answering the agent's qualifying questions
3. In MIDDLE phase: Continue cooperating with the agent's flow, start steering toward the test scenario
4. In LATE phase: Make sure to bring up the test scenario directly if not already covered
5. NEVER refuse to answer the agent's questions
6. Give realistic, relevant answers to whatever the agent asks
7. Keep responses conversational (1-3 sentences)

Return ONLY the user's response, nothing else.`,
          },
          {
            role: 'user',
            content: conversationSoFar 
              ? `Conversation so far:\n${conversationSoFar}\n\nGenerate the next user response:` 
              : `The agent just greeted you. Respond naturally as a customer who needs help with: ${testCase.scenario}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 150,
      });

      return response.choices[0]?.message?.content?.trim() || testCase.scenario;
    } catch (error) {
      console.error('Error generating flow-aware response:', error);
      return testCase.scenario;
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

IMPORTANT - CONVERSATION FLOW AWARENESS:
The test was conducted by following the agent's natural conversation flow. The test caller cooperated with the agent's qualifying questions and information-gathering process before navigating to the test scenario. This is the CORRECT approach because agents won't answer specific questions until their designed flow is followed.

Consider:
1. Did the agent EVENTUALLY address the user's needs at any point in the conversation?
2. Was the response appropriate and professional?
3. Did the agent follow its intended purpose?
4. The test scenario may have been raised later in the conversation after flow-following — this is normal and correct
5. Evaluate the agent's handling of the test scenario when it was eventually reached, not just the first response

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
