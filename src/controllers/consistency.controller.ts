import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { getConsistencyTestService } from '../services/consistency-test.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

/**
 * Start a consistency test
 * POST /api/agents/:agentId/consistency-tests
 */
export async function startConsistencyTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const { testCaseId, iterations = 30 } = req.body;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify agent access
    const agentResult = await pool.query(
      `SELECT a.*, i.api_key, i.provider 
       FROM agents a
       LEFT JOIN integrations i ON a.integration_id = i.id
       WHERE a.id = $1 AND a.user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!testCaseId) {
      return res.status(400).json({ error: 'testCaseId is required' });
    }

    // Verify test case exists and belongs to agent
    const tcResult = await pool.query(
      `SELECT * FROM test_cases WHERE id = $1 AND agent_id = $2`,
      [testCaseId, agentId]
    );

    if (tcResult.rows.length === 0) {
      return res.status(404).json({ error: 'Test case not found' });
    }

    const service = getConsistencyTestService(pool);

    // Mock agent call function - in production replace with actual agent call
    const mockCallAgent = async (testCase: any) => {
      const startTime = Date.now();
      // This is a mock - in production, this would call the actual voice agent
      const responses = [
        `I'd be happy to help you with ${testCase.name}. Let me process your request.`,
        `Sure, I can assist with ${testCase.name}. Here's what I can do for you.`,
        `Of course! Regarding ${testCase.name}, I'm here to help.`,
      ];
      const response = responses[Math.floor(Math.random() * responses.length)];
      
      // Simulate some latency
      await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
      
      return {
        text: response,
        latencyMs: Date.now() - startTime,
      };
    };

    const result = await service.startConsistencyTest(
      agentId,
      testCaseId,
      effectiveUserId,
      iterations,
      mockCallAgent
    );

    res.status(201).json(result);
  } catch (error) {
    console.error('Error starting consistency test', error);
    next(error);
  }
}

/**
 * Get consistency test run by ID
 * GET /api/consistency-tests/:runId
 */
export async function getConsistencyRun(req: Request, res: Response, next: NextFunction) {
  try {
    const { runId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    const service = getConsistencyTestService(pool);
    const result = await service.getConsistencyRun(runId);

    if (!result) {
      return res.status(404).json({ error: 'Consistency test run not found' });
    }

    // Verify access through agent
    const agentResult = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [result.agentId, effectiveUserId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Consistency test run not found' });
    }

    res.json(result);
  } catch (error) {
    console.error('Error getting consistency run', error);
    next(error);
  }
}

/**
 * Get all consistency test runs for an agent
 * GET /api/agents/:agentId/consistency-tests
 */
export async function getAgentConsistencyRuns(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify agent access
    const agent = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agent.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const service = getConsistencyTestService(pool);
    const runs = await service.getConsistencyRunsForAgent(agentId);

    res.json({ runs });
  } catch (error) {
    console.error('Error getting agent consistency runs', error);
    next(error);
  }
}

/**
 * Get consistency summary for an agent
 * GET /api/agents/:agentId/consistency-summary
 */
export async function getConsistencySummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Verify agent access
    const agent = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agent.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const service = getConsistencyTestService(pool);
    const summary = await service.getConsistencySummary(agentId);

    res.json(summary);
  } catch (error) {
    console.error('Error getting consistency summary', error);
    next(error);
  }
}
