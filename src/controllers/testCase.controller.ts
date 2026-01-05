import { Request, Response, NextFunction } from 'express';
import { testCaseService } from '../services/testCase.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

export class TestCaseController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { agent_id } = req.query;

      let testCases;
      if (agent_id) {
        testCases = await testCaseService.findByAgentId(agent_id as string);
      } else {
        testCases = await testCaseService.findByUserId(effectiveUserId);
      }

      res.json({ testCases });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const testCase = await testCaseService.findById(id);
      
      if (!testCase) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ testCase });
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

      const { agent_id, name, scenario } = req.body;

      if (!agent_id || !name || !scenario) {
        return res.status(400).json({ error: 'Agent ID, name, and scenario are required' });
      }

      const testCase = await testCaseService.create({
        agent_id,
        user_id: effectiveUserId,
        name,
        scenario,
      });

      res.status(201).json({ testCase });
    } catch (error) {
      next(error);
    }
  }

  async createBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const { test_cases } = req.body;

      if (!Array.isArray(test_cases) || test_cases.length === 0) {
        return res.status(400).json({ error: 'Test cases array is required' });
      }

      const testCasesWithUser = test_cases.map(tc => ({
        ...tc,
        user_id: user.id,
      }));

      const created = await testCaseService.createMany(testCasesWithUser);
      res.status(201).json({ testCases: created });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { name, scenario } = req.body;

      const testCase = await testCaseService.update(id, {
        name,
        scenario,
      });
      
      if (!testCase) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ testCase });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const deleted = await testCaseService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}

export const testCaseController = new TestCaseController();
