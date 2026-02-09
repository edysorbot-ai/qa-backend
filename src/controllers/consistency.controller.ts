import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { getConsistencyTestService } from '../services/consistency-test.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { getProviderClient } from '../providers/provider.factory';
import { customProvider, CustomAgentConfig } from '../providers/custom.provider';
import { Provider } from '../models/integration.model';

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
    const agent = agentResult.rows[0];
    const provider = (agent.provider || 'custom').toLowerCase() as Provider;
    const apiKey = agent.api_key || '';
    const externalAgentId = agent.external_agent_id || agent.id;

    // Real agent call function using provider chat APIs
    const callAgent = async (testCase: any) => {
      const startTime = Date.now();

      // Build the user message from the test case
      const userMessage = testCase.steps?.[0]?.input
        || testCase.input
        || testCase.description
        || testCase.name;

      let responseText = '';

      if (provider === 'custom') {
        // Custom agents need the config object from agent.config
        const config: CustomAgentConfig = {
          name: agent.name || 'Custom Agent',
          systemPrompt: agent.config?.system_prompt || agent.config?.systemPrompt || agent.prompt || '',
          startingMessage: agent.config?.starting_message || agent.config?.startingMessage || '',
          llmModel: agent.config?.llm_model || agent.config?.llmModel || 'openai/gpt-4o-mini',
          llmProvider: agent.config?.llm_provider || agent.config?.llmProvider || 'openrouter',
          temperature: agent.config?.temperature ?? 0.7,
          maxTokens: agent.config?.max_tokens || agent.config?.maxTokens || 1024,
          knowledgeBase: agent.config?.knowledge_base || agent.config?.knowledgeBase || '',
          responseStyle: agent.config?.response_style || agent.config?.responseStyle || 'conversational',
        };

        // Each iteration gets a fresh session so responses are independent
        const sessionId = `consistency_${agent.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const chatResult = await customProvider.chat('custom', externalAgentId, userMessage, { sessionId, config });
        responseText = chatResult?.output?.[0]?.message || '';
      } else {
        // External providers (vapi, elevenlabs, haptik, etc.) use the standard chat interface
        const providerClient = getProviderClient(provider);

        if (providerClient.supportsChatTesting?.() === false || !providerClient.chat) {
          throw new Error(`Provider "${provider}" does not support text-based chat testing. Use voice-based tests instead.`);
        }

        // Each iteration gets a fresh session so responses are independent
        const chatResult = await providerClient.chat(apiKey, externalAgentId, userMessage);
        responseText = chatResult?.output?.[0]?.message || '';
      }

      if (!responseText) {
        throw new Error(`Empty response from ${provider} agent for test case "${testCase.name}"`);
      }

      return {
        text: responseText,
        latencyMs: Date.now() - startTime,
      };
    };

    const result = await service.startConsistencyTest(
      agentId,
      testCaseId,
      effectiveUserId,
      iterations,
      callAgent
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
