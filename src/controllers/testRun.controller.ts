import { Request, Response, NextFunction } from 'express';
import { testRunService } from '../services/testRun.service';
import { testResultService } from '../services/testResult.service';
import { testCaseService } from '../services/testCase.service';
import { userService } from '../services/user.service';
import { agentService } from '../services/agent.service';
import { integrationService } from '../services/integration.service';
import { workflowTestExecutorService } from '../services/workflow-test-executor.service';
import { WorkflowExecutionPlan } from '../models/workflow.model';
import { teamMemberService } from '../services/teamMember.service';
import { testExecutionQueue } from '../services/queue.service';
import { contextGrowthService } from '../services/context-growth.service';

export class TestRunController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { agent_id, limit } = req.query;
      console.log('[TestRunController.getAll] agent_id:', agent_id, 'effective_user_id:', effectiveUserId);

      let testRuns;
      if (agent_id) {
        // Also match by agent name in test run name for legacy runs without agent_id
        testRuns = await testRunService.findByAgentIdOrName(agent_id as string, effectiveUserId, Number(limit) || 50);
        console.log('[TestRunController.getAll] Found by agent_id/name:', testRuns.length);
      } else {
        testRuns = await testRunService.findByUserId(effectiveUserId, Number(limit) || 50);
        console.log('[TestRunController.getAll] Found by user_id:', testRuns.length);
      }

      res.json({ testRuns });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const testRun = await testRunService.getRunWithResults(id);
      
      if (!testRun) {
        return res.status(404).json({ error: 'Test run not found' });
      }

      res.json({ testRun });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { agent_id, name, config, test_case_ids } = req.body;

      if (!agent_id) {
        return res.status(400).json({ error: 'Agent ID is required' });
      }

      // Create test run
      const testRun = await testRunService.create({
        user_id: effectiveUserId,
        agent_id,
        name,
        config,
      });

      // Get test cases for the agent
      let testCases;
      if (test_case_ids && test_case_ids.length > 0) {
        testCases = await Promise.all(
          test_case_ids.map((id: string) => testCaseService.findById(id))
        );
        testCases = testCases.filter(Boolean);
      } else {
        testCases = await testCaseService.findByAgentId(agent_id);
      }

      // Create test results for each test case
      const results = await testResultService.createMany(
        testCases.map(tc => ({
          test_run_id: testRun.id,
          test_case_id: tc!.id,
        }))
      );

      // Update test run with total tests
      await testRunService.update(testRun.id, {
        total_tests: results.length,
      });

      res.status(201).json({ 
        testRun: {
          ...testRun,
          total_tests: results.length,
        },
        results 
      });
    } catch (error) {
      next(error);
    }
  }

  async start(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const testRun = await testRunService.update(id, {
        status: 'running',
        started_at: new Date(),
      });

      if (!testRun) {
        return res.status(404).json({ error: 'Test run not found' });
      }

      // TODO: Trigger actual test execution via worker queue
      // This would be handled by BullMQ/Temporal workers

      res.json({ testRun, message: 'Test run started' });
    } catch (error) {
      next(error);
    }
  }

  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      // Cancel any queued/running jobs for this test run
      try {
        const cancelledJobs = await testExecutionQueue.cancelTestRun(id);
        console.log(`[TestRunController.cancel] Cancelled ${cancelledJobs} jobs for test run ${id}`);
      } catch (queueError) {
        console.error('[TestRunController.cancel] Error cancelling queue jobs:', queueError);
        // Continue to update status even if queue cancellation fails
      }

      const testRun = await testRunService.update(id, {
        status: 'cancelled',
        completed_at: new Date(),
      });

      if (!testRun) {
        return res.status(404).json({ error: 'Test run not found' });
      }

      res.json({ testRun, message: 'Test run cancelled' });
    } catch (error) {
      next(error);
    }
  }

  async getStats(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const stats = await testRunService.getStats(user.id);
      res.json({ stats });
    } catch (error) {
      next(error);
    }
  }

  async compare(req: Request, res: Response, next: NextFunction) {
    try {
      const { ids } = req.query;
      
      if (!ids || typeof ids !== 'string') {
        return res.status(400).json({ error: 'Test run IDs required (comma-separated)' });
      }

      const testRunIds = ids.split(',').filter(Boolean);
      
      if (testRunIds.length < 2) {
        return res.status(400).json({ error: 'At least 2 test runs required for comparison' });
      }

      // Fetch all test runs with their results
      const testRuns = await Promise.all(
        testRunIds.map(id => testRunService.getRunWithResults(id))
      );

      // Filter out any null results
      const validRuns = testRuns.filter(Boolean);
      
      console.log('[compare] Valid runs:', validRuns.length);
      validRuns.forEach((run: any) => {
        console.log(`[compare] Run ${run.id}: ${run.name}, results count: ${run.results?.length || 0}`);
        if (run.results?.length > 0) {
          console.log('[compare] First result sample:', JSON.stringify(run.results[0], null, 2));
        }
      });

      if (validRuns.length < 2) {
        return res.status(404).json({ error: 'Could not find enough valid test runs' });
      }

      // Build comparison data
      const comparison = this.buildComparisonData(validRuns);
      
      console.log('[compare] Comparison metrics:', comparison.runMetrics);
      console.log('[compare] Total test cases:', comparison.totalTestCases);

      res.json({ comparison, testRuns: validRuns });
    } catch (error) {
      next(error);
    }
  }

  private buildComparisonData(testRuns: any[]) {
    // Sort runs by date (oldest first)
    const sortedRuns = [...testRuns].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    // Get all unique test case names across all runs
    const allTestCaseNames = new Set<string>();
    sortedRuns.forEach(run => {
      (run.results || []).forEach((result: any) => {
        if (result.test_case_name) {
          allTestCaseNames.add(result.test_case_name);
        }
      });
    });

    // Build per-test-case comparison
    const testCaseComparison: Record<string, any[]> = {};
    allTestCaseNames.forEach(name => {
      testCaseComparison[name] = sortedRuns.map(run => {
        const result = (run.results || []).find((r: any) => r.test_case_name === name);
        return result ? {
          runId: run.id,
          runName: run.name,
          runDate: run.created_at,
          passed: result.passed,
          score: result.score || 0,
          metrics: result.metrics || {},
          actualResponse: result.actual_response,
          errorMessage: result.error_message,
          expectedBehavior: result.expected_behavior,
          scenario: result.scenario,
        } : null;
      });
    });

    // Calculate overall metrics per run
    const runMetrics = sortedRuns.map(run => {
      const results = run.results || [];
      const passed = results.filter((r: any) => r.passed).length;
      const total = results.length;
      const avgScore = results.length > 0 
        ? results.reduce((sum: number, r: any) => sum + (r.score || 0), 0) / results.length
        : 0;
      
      return {
        runId: run.id,
        runName: run.name,
        runDate: run.created_at,
        passed,
        failed: total - passed,
        total,
        passRate: total > 0 ? (passed / total) * 100 : 0,
        avgScore,
      };
    });

    // Calculate improvements between consecutive runs
    const improvements: any[] = [];
    for (let i = 1; i < runMetrics.length; i++) {
      const prev = runMetrics[i - 1];
      const curr = runMetrics[i];
      improvements.push({
        from: prev.runName,
        to: curr.runName,
        passRateChange: curr.passRate - prev.passRate,
        avgScoreChange: curr.avgScore - prev.avgScore,
        passedChange: curr.passed - prev.passed,
      });
    }

    return {
      runMetrics,
      testCaseComparison,
      improvements,
      totalTestCases: allTestCaseNames.size,
    };
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const deleted = await testRunService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Test run not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get context growth metrics for a specific test result
   */
  async getResultContextMetrics(req: Request, res: Response, next: NextFunction) {
    try {
      const { resultId } = req.params;

      const metrics = await contextGrowthService.getContextMetrics(resultId);

      if (!metrics) {
        return res.status(404).json({ error: 'Test result not found or has no conversation data' });
      }

      res.json({ metrics });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get context growth summary for an agent
   */
  async getAgentContextSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const { agentId } = req.params;

      const summary = await contextGrowthService.getAgentContextSummary(agentId);

      res.json({ summary });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Start a workflow-based test run
   */
  async startWorkflow(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const { agent_id, name, execution_plan, execution_mode } = req.body;

      if (!agent_id) {
        return res.status(400).json({ error: 'Agent ID is required' });
      }

      if (!execution_plan) {
        return res.status(400).json({ error: 'Execution plan is required' });
      }

      const executionPlan = execution_plan as WorkflowExecutionPlan;

      // Get agent details
      const agent = await agentService.findById(agent_id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Get integration for API key
      const integration = agent.integration_id 
        ? await integrationService.findById(agent.integration_id)
        : null;
      
      if (!integration) {
        return res.status(400).json({ error: 'Agent integration not found' });
      }

      // Count total test cases from execution plan
      const totalTestCases = executionPlan.executionGroups.reduce(
        (sum, group) => sum + group.calls.reduce((s, call) => s + call.testCases.length, 0),
        0
      );

      // Create test run
      const testRun = await testRunService.create({
        user_id: user.id,
        agent_id,
        name: name || `Workflow Test - ${new Date().toLocaleString()}`,
        config: {
          execution_mode: execution_mode || 'workflow',
          execution_plan: executionPlan,
        },
      });

      // Update with total tests
      await testRunService.update(testRun.id, {
        total_tests: totalTestCases,
        status: 'running',
        started_at: new Date(),
      });

      // Execute the workflow in background
      const agentConfig = {
        provider: agent.provider,
        agentId: agent.external_agent_id || '',
        apiKey: integration.api_key,
      };

      const agentPrompt = agent.prompt || '';

      // Start execution asynchronously
      setImmediate(async () => {
        try {
          const result = await workflowTestExecutorService.executeWorkflow(
            testRun.id,
            executionPlan,
            agentConfig,
            agentPrompt,
            async (progress) => {
              // Update test run progress
              console.log(`[WorkflowController] Progress: ${progress.completedCalls}/${progress.totalCalls} calls`);
            }
          );

          // Update test run with final results
          await testRunService.update(testRun.id, {
            status: result.status === 'completed' ? 'completed' : 'failed',
            completed_at: new Date(),
            passed_tests: result.passedTestCases,
            failed_tests: result.failedTestCases,
          });

          console.log(`[WorkflowController] Workflow execution completed: ${result.status}`);
        } catch (error) {
          console.error('[WorkflowController] Workflow execution error:', error);
          await testRunService.update(testRun.id, {
            status: 'failed',
            completed_at: new Date(),
          });
        }
      });

      res.status(201).json({
        testRun: {
          ...testRun,
          total_tests: totalTestCases,
          status: 'running',
        },
        message: 'Workflow test run started',
      });
    } catch (error) {
      next(error);
    }
  }
}

export const testRunController = new TestRunController();
