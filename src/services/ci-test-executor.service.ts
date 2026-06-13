/**
 * CI/CD Test Executor Service
 * Simplified executor for CI/CD triggered test runs
 */

import pool from '../db';
import { logger } from './logger.service';

export async function executeBatchedTestRunFromCI(testRunId: string, agentId: string, userId: string): Promise<void> {
  try {
    await pool.query(`UPDATE test_runs SET status = 'running' WHERE id = $1`, [testRunId]);

    // Get agent config
    const agentQuery = await pool.query(
      `SELECT a.*, i.provider, i.api_key, i.provider_agent_id 
       FROM agents a
       LEFT JOIN integrations i ON a.integration_id = i.id
       WHERE a.id = $1`,
      [agentId]
    );

    if (agentQuery.rows.length === 0) {
      throw new Error('Agent not found');
    }

    const agent = agentQuery.rows[0];
    const agentPrompt = agent.prompt || agent.system_prompt || agent.config?.systemPrompt || '';
    const agentConfig = {
      provider: agent.provider || 'elevenlabs',
      agentId: agent.provider_agent_id || agent.id,
      apiKey: agent.api_key || '',
    };

    // Get test cases
    const testCasesQuery = await pool.query(
      `SELECT tr.test_case_id as id, tr.scenario as name, tr.scenario, tr.user_input as "userInput", 
              tr.expected_response as "expectedOutcome", tr.category
       FROM test_results tr WHERE tr.test_run_id = $1`,
      [testRunId]
    );

    // Import batched executor
    const { batchedTestExecutor } = await import('./batched-test-executor.service');

    // Create a single batch with all test cases
    const batch = {
      id: '1',
      name: 'CI/CD Regression Suite',
      testCases: testCasesQuery.rows,
      testMode: 'chat' as const,
    };

    const result = await batchedTestExecutor.executeBatch(batch as any, agentConfig, agentPrompt);

    // Store results
    for (const r of result.results) {
      await pool.query(
        `UPDATE test_results 
         SET status = $1, actual_response = $2, overall_score = $3, metrics = $4, completed_at = NOW()
         WHERE test_run_id = $5 AND test_case_id = $6`,
        [
          r.passed ? 'passed' : 'failed',
          r.actualResponse,
          r.score,
          JSON.stringify(r.metrics || {}),
          testRunId,
          r.testCaseId,
        ]
      );
    }

    // Calculate pass rate and update test run
    const passed = result.results.filter(r => r.passed).length;
    const failed = result.results.filter(r => !r.passed).length;

    await pool.query(
      `UPDATE test_runs SET status = 'completed', completed_at = NOW(), passed_tests = $1, failed_tests = $2 WHERE id = $3`,
      [passed, failed, testRunId]
    );

    logger.info(`[CI/CD] Test run ${testRunId} completed: ${passed} passed, ${failed} failed`);
    } catch (error: any) {
    logger.error(`[CI/CD] Execution failed: ${error.message}`);
    await pool.query(
      `UPDATE test_runs SET status = 'failed', error_message = $2 WHERE id = $1`,
      [testRunId, String(error?.message || error).slice(0, 1000)],
    );
    throw error;
  }
}
