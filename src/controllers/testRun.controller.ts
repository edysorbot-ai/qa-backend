import { Request, Response, NextFunction } from 'express';
import { testRunService } from '../services/testRun.service';
import { testResultService } from '../services/testResult.service';
import { testCaseService } from '../services/testCase.service';
import { userService } from '../services/user.service';

export class TestRunController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const { agent_id, limit } = req.query;
      console.log('[TestRunController.getAll] agent_id:', agent_id, 'user_id:', user.id);

      let testRuns;
      if (agent_id) {
        // Also match by agent name in test run name for legacy runs without agent_id
        testRuns = await testRunService.findByAgentIdOrName(agent_id as string, user.id, Number(limit) || 50);
        console.log('[TestRunController.getAll] Found by agent_id/name:', testRuns.length);
      } else {
        testRuns = await testRunService.findByUserId(user.id, Number(limit) || 50);
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

      const { agent_id, name, config, test_case_ids } = req.body;

      if (!agent_id) {
        return res.status(400).json({ error: 'Agent ID is required' });
      }

      // Create test run
      const testRun = await testRunService.create({
        user_id: user.id,
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
}

export const testRunController = new TestRunController();
