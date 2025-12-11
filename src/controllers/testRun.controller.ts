import { Request, Response, NextFunction } from 'express';
import { testRunService } from '../services/testRun.service';
import { testResultService } from '../services/testResult.service';
import { testCaseService } from '../services/testCase.service';
import { userService } from '../services/user.service';

export class TestRunController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { agent_id, limit } = req.query;

      let testRuns;
      if (agent_id) {
        testRuns = await testRunService.findByAgentId(agent_id as string, Number(limit) || 50);
      } else {
        testRuns = await testRunService.findByUserId(user.id, Number(limit) || 50);
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
      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

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
      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const stats = await testRunService.getStats(user.id);
      res.json({ stats });
    } catch (error) {
      next(error);
    }
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
