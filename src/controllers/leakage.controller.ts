import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { getLeakageTestService, BUILTIN_SCENARIOS } from '../services/leakage-test.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

/**
 * Get all leakage test scenarios for an agent
 * GET /api/agents/:agentId/leakage-scenarios
 */
export async function getLeakageScenarios(req: Request, res: Response, next: NextFunction) {
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

    const service = getLeakageTestService(pool);
    const scenarios = await service.getScenariosForAgent(agentId, effectiveUserId);

    res.json({ scenarios });
  } catch (error) {
    console.error('Error getting leakage scenarios', error);
    next(error);
  }
}

/**
 * Create a custom leakage test scenario
 * POST /api/agents/:agentId/leakage-scenarios
 */
export async function createLeakageScenario(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const { name, description, sensitiveData, conversationFlow } = req.body;
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

    if (!name || !sensitiveData || !conversationFlow) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const service = getLeakageTestService(pool);
    const scenario = await service.createScenario(
      agentId,
      effectiveUserId,
      name,
      description || '',
      sensitiveData,
      conversationFlow
    );

    res.status(201).json(scenario);
  } catch (error) {
    console.error('Error creating leakage scenario', error);
    next(error);
  }
}

/**
 * Run a leakage test
 * POST /api/agents/:agentId/leakage-tests/:scenarioId/run
 */
export async function runLeakageTest(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId, scenarioId } = req.params;
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

    const agent = agentResult.rows[0];

    // For now, return a mock result since real agent calling requires full setup
    // In production, this would integrate with the actual agent calling service
    const service = getLeakageTestService(pool);
    
    // Mock agent call function - in production replace with actual agent call
    const mockCallAgent = async (message: string, history: Array<{ role: string; content: string }>) => {
      // This is a mock - in production, this would call the actual voice agent
      return {
        text: `Mock response to: ${message}. This is a simulated response for security testing.`,
        toolCalls: undefined,
      };
    };

    const result = await service.runLeakageTest(
      scenarioId,
      agentId,
      effectiveUserId,
      mockCallAgent
    );

    res.json(result);
  } catch (error) {
    console.error('Error running leakage test', error);
    next(error);
  }
}

/**
 * Get leakage test runs for an agent
 * GET /api/agents/:agentId/leakage-tests
 */
export async function getLeakageTestRuns(req: Request, res: Response, next: NextFunction) {
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

    const service = getLeakageTestService(pool);
    const runs = await service.getTestRunsForAgent(agentId);

    res.json({ runs });
  } catch (error) {
    console.error('Error getting leakage test runs', error);
    next(error);
  }
}

/**
 * Get security summary for an agent
 * GET /api/agents/:agentId/security-summary
 */
export async function getSecuritySummary(req: Request, res: Response, next: NextFunction) {
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

    const service = getLeakageTestService(pool);
    const summary = await service.getSecuritySummary(agentId);

    res.json(summary);
  } catch (error) {
    console.error('Error getting security summary', error);
    next(error);
  }
}

/**
 * Get builtin scenarios list (no auth needed for displaying options)
 * GET /api/leakage-tests/builtin-scenarios
 */
export async function getBuiltinScenarios(req: Request, res: Response, next: NextFunction) {
  try {
    const scenarios = BUILTIN_SCENARIOS.map((s, idx) => ({
      id: `builtin-${idx}`,
      name: s.name,
      description: s.description,
      sensitiveDataTypes: s.sensitiveData.map(d => d.type),
      turnCount: s.conversationFlow.length,
    }));

    res.json({ scenarios });
  } catch (error) {
    console.error('Error getting builtin scenarios', error);
    next(error);
  }
}

/**
 * Analyze agent for sensitive data patterns
 * POST /api/agents/:agentId/analyze-sensitive-data
 */
export async function analyzeSensitiveData(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Get agent with prompt
    const agentResult = await pool.query(
      `SELECT a.*, i.provider 
       FROM agents a
       LEFT JOIN integrations i ON a.integration_id = i.id
       WHERE a.id = $1 AND a.user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = agentResult.rows[0];
    const prompt = agent.prompt || '';
    const knowledgeBase = agent.config?.knowledgeBase || agent.config?.documents || '';

    const service = getLeakageTestService(pool);
    const detectedData = await service.analyzeAgentForSensitiveData(
      agentId,
      prompt,
      typeof knowledgeBase === 'string' ? knowledgeBase : JSON.stringify(knowledgeBase)
    );

    res.json({ 
      agentId,
      agentName: agent.name,
      promptLength: prompt.length,
      detectedSensitiveData: detectedData,
      message: detectedData.length > 0 
        ? `Found ${detectedData.length} potential sensitive data categories`
        : 'No sensitive data patterns detected in prompt'
    });
  } catch (error) {
    console.error('Error analyzing sensitive data', error);
    next(error);
  }
}

/**
 * Auto-generate leakage test scenarios based on agent's prompt
 * POST /api/agents/:agentId/generate-leakage-scenarios
 */
export async function generateLeakageScenarios(req: Request, res: Response, next: NextFunction) {
  try {
    const { agentId } = req.params;
    const clerkUser = (req as any).auth;
    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

    // Get agent with prompt
    const agentResult = await pool.query(
      `SELECT a.*, i.provider 
       FROM agents a
       LEFT JOIN integrations i ON a.integration_id = i.id
       WHERE a.id = $1 AND a.user_id = $2`,
      [agentId, effectiveUserId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = agentResult.rows[0];
    const prompt = agent.prompt || '';
    
    if (!prompt || prompt.length < 50) {
      return res.status(400).json({ 
        error: 'Agent prompt is too short or missing. Add a system prompt to enable auto-generation.' 
      });
    }

    const knowledgeBase = agent.config?.knowledgeBase || agent.config?.documents || '';

    const service = getLeakageTestService(pool);
    const scenarios = await service.generateScenariosFromPrompt(
      agentId,
      effectiveUserId,
      prompt,
      agent.name,
      typeof knowledgeBase === 'string' ? knowledgeBase : JSON.stringify(knowledgeBase)
    );

    res.json({ 
      agentId,
      generatedScenarios: scenarios,
      message: scenarios.length > 0 
        ? `Generated ${scenarios.length} leakage test scenarios based on agent configuration`
        : 'Could not generate scenarios. Try adding more details to the agent prompt.'
    });
  } catch (error) {
    console.error('Error generating leakage scenarios', error);
    next(error);
  }
}

