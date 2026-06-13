import { logger } from '../services/logger.service';
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
    const {
      testCaseId,
      testCaseIds,
      batchId,
      mode = 'single',
      isSecurity = false,
      iterations = 30,
    } = req.body;
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

    // Resolve which test cases to run
    let testCases: any[] = [];
    let resolvedBatchName: string | null = null;
    let resolvedBatchId: string | null = null;

    if (mode === 'batch') {
      if (!batchId) {
        return res.status(400).json({ error: 'batchId is required when mode=batch' });
      }
      const batchRes = await pool.query(
        `SELECT * FROM saved_batches WHERE id = $1 AND agent_id = $2`,
        [batchId, agentId]
      );
      if (batchRes.rows.length === 0) {
        return res.status(404).json({ error: 'Saved batch not found' });
      }
      const batch = batchRes.rows[0];
      resolvedBatchName = batch.name;
      resolvedBatchId = batch.id;

      const ids: string[] = Array.isArray(batch.test_case_ids)
        ? batch.test_case_ids
        : (batch.test_case_ids ? JSON.parse(batch.test_case_ids) : []);

      if (!ids.length) {
        return res.status(400).json({ error: 'Saved batch contains no test cases' });
      }

      const tcRes = await pool.query(
        `SELECT * FROM test_cases WHERE id = ANY($1::uuid[]) AND agent_id = $2`,
        [ids, agentId]
      );
      testCases = tcRes.rows;
    } else {
      // single mode: accept testCaseId (legacy) or testCaseIds[0]
      const id = testCaseId || (Array.isArray(testCaseIds) ? testCaseIds[0] : null);
      if (!id) {
        return res.status(400).json({ error: 'testCaseId is required' });
      }
      const tcRes = await pool.query(
        `SELECT * FROM test_cases WHERE id = $1 AND agent_id = $2`,
        [id, agentId]
      );
      if (tcRes.rows.length === 0) {
        return res.status(404).json({ error: 'Test case not found' });
      }
      testCases = tcRes.rows;
    }

    if (!testCases.length) {
      return res.status(400).json({ error: 'No test cases resolved' });
    }

    const service = getConsistencyTestService(pool);
    const agent = agentResult.rows[0];
    const provider = (agent.provider || 'custom').toLowerCase() as Provider;
    const apiKey = agent.api_key || '';
    const externalAgentId = agent.external_agent_id || agent.id;

    // Build the user message; for security tests, prefix with the
    // adversarial objective from the test case so the agent sees the
    // attack input it would in a real security run.
    const buildUserMessage = (testCase: any): string => {
      const base = testCase.steps?.[0]?.input
        || testCase.input
        || testCase.description
        || testCase.name;
      if (testCase.is_security_test && testCase.adversarial_prompt) {
        return testCase.adversarial_prompt;
      }
      return base;
    };

    const callAgent = async (testCase: any) => {
      const startTime = Date.now();
      const userMessage = buildUserMessage(testCase);

      let responseText = '';

      if (provider === 'custom') {
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
        const sessionId = `consistency_${agent.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const chatResult = await customProvider.chat('custom', externalAgentId, userMessage, { sessionId, config });
        responseText = chatResult?.output?.[0]?.message || '';
      } else {
        const providerClient = getProviderClient(provider);
        if (providerClient.supportsChatTesting?.() === false || !providerClient.chat) {
          throw new Error(`Provider "${provider}" does not support text-based chat testing. Use voice-based tests instead.`);
        }
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

    const resolvedIsSecurity = mode === 'batch'
      ? !!isSecurity || testCases.some(tc => tc.is_security_test)
      : !!testCases[0].is_security_test;

    const result = await service.startConsistencyTestMulti(
      agentId,
      testCases,
      effectiveUserId,
      iterations,
      callAgent,
      {
        mode: mode === 'batch' ? 'batch' : 'single',
        isSecurity: resolvedIsSecurity,
        batchId: resolvedBatchId,
        batchName: resolvedBatchName,
      }
    );

    res.status(201).json(result);
  } catch (error) {
    logger.error(`Error starting consistency test`, { error });
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
    logger.error(`Error getting consistency run`, { error });
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
    logger.error(`Error getting agent consistency runs`, { error });
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
    logger.error(`Error getting consistency summary`, { error });
    next(error);
  }
}
