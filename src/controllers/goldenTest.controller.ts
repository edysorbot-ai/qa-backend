import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { testResultService } from '../services/testResult.service';
import { testRunService } from '../services/testRun.service';
import * as goldenTestService from '../services/golden-test.service';

export class GoldenTestController {
  /**
   * Get all golden tests for the user
   */
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const goldenTests = await goldenTestService.getGoldenTestsByUser(effectiveUserId);

      res.json({ goldenTests });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get golden tests for a specific agent
   */
  async getByAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const { agentId } = req.params;

      const goldenTests = await goldenTestService.getGoldenTestsByAgent(agentId);

      res.json({ goldenTests });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific golden test
   */
  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const goldenTest = await goldenTestService.getGoldenTest(id);

      if (!goldenTest) {
        return res.status(404).json({ error: 'Golden test not found' });
      }

      res.json({ goldenTest });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a golden test from a test result
   */
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { 
        testResultId, 
        name,
        thresholds, 
        scheduleFrequency 
      } = req.body;

      if (!testResultId) {
        return res.status(400).json({ error: 'Test result ID is required' });
      }

      // Get the test result to extract baseline data
      const testResult = await testResultService.findById(testResultId);
      if (!testResult) {
        return res.status(404).json({ error: 'Test result not found' });
      }

      // Get the test run to get agent_id
      const testRun = await testRunService.findById(testResult.test_run_id);
      if (!testRun || !testRun.agent_id) {
        return res.status(400).json({ error: 'Test run or agent not found' });
      }

      // Extract responses from conversation turns
      const responses: string[] = [];
      if (testResult.conversation_turns && Array.isArray(testResult.conversation_turns)) {
        for (const turn of testResult.conversation_turns) {
          if (turn.role === 'agent' && turn.text) {
            responses.push(turn.text);
          }
        }
      } else if (testResult.agent_transcript) {
        responses.push(testResult.agent_transcript);
      }

      const goldenTest = await goldenTestService.createGoldenTest({
        testCaseId: testResult.test_case_id,
        agentId: testRun.agent_id,
        userId: effectiveUserId,
        name,
        baselineResultId: testResultId,
        baselineResponses: responses,
        baselineMetrics: {
          overallScore: testResult.metrics?.comprehensive?.overallScore ?? testResult.metrics?.intent_accuracy,
          latencyMs: testResult.latency_ms,
        },
        thresholds,
        scheduleFrequency,
      });

      res.status(201).json({ goldenTest });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Mark a test result as golden (shorthand for create)
   */
  async markAsGolden(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { resultId } = req.params;
      const { thresholds, scheduleFrequency } = req.body;

      // Get the test result
      const testResult = await testResultService.findById(resultId);
      if (!testResult) {
        return res.status(404).json({ error: 'Test result not found' });
      }

      // Get the test run to get agent_id
      const testRun = await testRunService.findById(testResult.test_run_id);
      if (!testRun || !testRun.agent_id) {
        return res.status(400).json({ error: 'Test run or agent not found' });
      }

      // Extract responses
      const responses: string[] = [];
      if (testResult.conversation_turns && Array.isArray(testResult.conversation_turns)) {
        for (const turn of testResult.conversation_turns) {
          if (turn.role === 'agent' && turn.text) {
            responses.push(turn.text);
          }
        }
      } else if (testResult.agent_transcript) {
        responses.push(testResult.agent_transcript);
      }

      const goldenTest = await goldenTestService.createGoldenTest({
        testCaseId: testResult.test_case_id,
        agentId: testRun.agent_id,
        userId: effectiveUserId,
        baselineResultId: resultId,
        baselineResponses: responses,
        baselineMetrics: {
          overallScore: testResult.metrics?.comprehensive?.overallScore ?? testResult.metrics?.intent_accuracy,
          latencyMs: testResult.latency_ms,
        },
        thresholds,
        scheduleFrequency,
      });

      res.status(201).json({ goldenTest });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a golden test
   */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { name, thresholds, scheduleFrequency, status } = req.body;

      const goldenTest = await goldenTestService.updateGoldenTest(id, {
        name,
        thresholds,
        scheduleFrequency,
        status,
      });

      if (!goldenTest) {
        return res.status(404).json({ error: 'Golden test not found' });
      }

      res.json({ goldenTest });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update baseline with a new test result
   */
  async updateBaseline(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { newResultId } = req.body;

      if (!newResultId) {
        return res.status(400).json({ error: 'New result ID is required' });
      }

      // Get the new test result
      const testResult = await testResultService.findById(newResultId);
      if (!testResult) {
        return res.status(404).json({ error: 'Test result not found' });
      }

      // Extract responses
      const responses: string[] = [];
      if (testResult.conversation_turns && Array.isArray(testResult.conversation_turns)) {
        for (const turn of testResult.conversation_turns) {
          if (turn.role === 'agent' && turn.text) {
            responses.push(turn.text);
          }
        }
      } else if (testResult.agent_transcript) {
        responses.push(testResult.agent_transcript);
      }

      const goldenTest = await goldenTestService.updateBaseline(
        id,
        newResultId,
        responses,
        {
          overallScore: testResult.metrics?.comprehensive?.overallScore ?? testResult.metrics?.intent_accuracy,
          latencyMs: testResult.latency_ms,
        }
      );

      if (!goldenTest) {
        return res.status(404).json({ error: 'Golden test not found' });
      }

      res.json({ goldenTest });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a golden test
   */
  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const deleted = await goldenTestService.deleteGoldenTest(id);

      if (!deleted) {
        return res.status(404).json({ error: 'Golden test not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get run history for a golden test
   */
  async getHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const history = await goldenTestService.getGoldenTestHistory(id, limit);

      res.json({ history });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Run a golden test now (manual trigger)
   */
  async runNow(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { currentResponses, currentMetrics } = req.body;

      const goldenTest = await goldenTestService.getGoldenTest(id);
      if (!goldenTest) {
        return res.status(404).json({ error: 'Golden test not found' });
      }

      // If no current responses provided, we'd need to run the test
      // For now, we'll compare with provided responses
      if (!currentResponses || !Array.isArray(currentResponses)) {
        return res.status(400).json({ 
          error: 'Current responses are required. Run the test first and provide the responses.' 
        });
      }

      // Compare responses
      const comparison = goldenTestService.compareResponses(
        goldenTest.baselineResponses,
        currentResponses,
        goldenTest.thresholds
      );

      // Calculate latency and cost changes if metrics provided
      let latencyChange = 0;
      let costChange = 0;
      
      if (currentMetrics && goldenTest.baselineMetrics) {
        if (currentMetrics.latencyMs && goldenTest.baselineMetrics.latencyMs) {
          latencyChange = (currentMetrics.latencyMs - goldenTest.baselineMetrics.latencyMs) / 
                          goldenTest.baselineMetrics.latencyMs;
          
          if (latencyChange > goldenTest.thresholds.maxLatencyIncrease) {
            comparison.alerts.push({
              type: 'latency_increase',
              severity: 'warning',
              message: `Latency increased by ${Math.round(latencyChange * 100)}%`,
              details: { 
                baseline: goldenTest.baselineMetrics.latencyMs,
                current: currentMetrics.latencyMs
              }
            });
          }
        }
      }

      // Record the run
      const run = await goldenTestService.recordGoldenTestRun(id, null, {
        passed: comparison.passed,
        semanticSimilarity: comparison.semanticSimilarity,
        latencyChange,
        costChange,
        driftDetails: comparison.driftDetails,
        alerts: comparison.alerts,
      });

      res.json({ 
        run,
        comparison: {
          passed: comparison.passed,
          semanticSimilarity: comparison.semanticSimilarity,
          latencyChange,
          costChange,
          driftDetails: comparison.driftDetails,
          alerts: comparison.alerts,
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get summary stats for user's golden tests
   */
  async getSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const summary = await goldenTestService.getGoldenTestsSummary(effectiveUserId);

      res.json({ summary });
    } catch (error) {
      next(error);
    }
  }
}

export const goldenTestController = new GoldenTestController();
