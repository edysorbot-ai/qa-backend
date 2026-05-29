/**
 * CI/CD Integration Routes
 * 
 * Provides webhook endpoints for GitHub Actions / GitLab CI to:
 * 1. Trigger regression test suites when prompt changes
 * 2. Report results back to PRs
 * 3. Block deployment if pass rate drops below threshold
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const router = Router();

/**
 * Generate a CI/CD API key for an agent
 */
router.post('/generate-key', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const apiKey = `stablr_ci_${crypto.randomBytes(32).toString('hex')}`;
    const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');

    await pool.query(
      `INSERT INTO ci_cd_keys (user_id, agent_id, key_hash, key_prefix)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id) DO UPDATE SET key_hash = $3, key_prefix = $4, updated_at = NOW()`,
      [userId, agentId, hashedKey, apiKey.substring(0, 15)]
    );

    res.json({ success: true, apiKey, message: 'Save this key - it cannot be shown again' });
  } catch (error: any) {
    logger.error(`[CI/CD] Generate key error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Trigger a test run via CI/CD (authenticated with CI key)
 * POST /api/ci/trigger
 */
router.post('/trigger', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer stablr_ci_')) {
      return res.status(401).json({ success: false, error: 'Invalid CI/CD API key' });
    }

    const apiKey = authHeader.replace('Bearer ', '');
    const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');

    // Validate key
    const keyQuery = await pool.query(
      `SELECT user_id, agent_id FROM ci_cd_keys WHERE key_hash = $1`,
      [hashedKey]
    );

    if (keyQuery.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid API key' });
    }

    const { user_id: userId, agent_id: agentId } = keyQuery.rows[0];
    const { commitSha, branch, prNumber, threshold, promptContent } = req.body;

    // Get test cases for the agent
    const testCasesQuery = await pool.query(
      `SELECT id, name, scenario, user_input, expected_response, category FROM test_cases WHERE agent_id = $1`,
      [agentId]
    );

    if (testCasesQuery.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No test cases found for this agent' });
    }

    // Create a test run
    const testRunId = uuidv4();
    await pool.query(
      `INSERT INTO test_runs (id, name, agent_id, user_id, status, metadata)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [
        testRunId,
        `CI/CD Run - ${branch || 'main'}${commitSha ? ` @ ${commitSha.substring(0, 7)}` : ''}`,
        agentId,
        userId,
        JSON.stringify({ source: 'ci_cd', commitSha, branch, prNumber, threshold: threshold || 80 }),
      ]
    );

    // Create test result placeholders
    for (const tc of testCasesQuery.rows) {
      await pool.query(
        `INSERT INTO test_results (id, test_run_id, test_case_id, scenario, user_input, expected_response, category, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [uuidv4(), testRunId, tc.id, tc.scenario, tc.user_input, tc.expected_response, tc.category]
      );
    }

    // If prompt content provided, update agent and use it for testing
    if (promptContent) {
      await pool.query(`UPDATE agents SET system_prompt = $1 WHERE id = $2`, [promptContent, agentId]);
    }

    // Start execution asynchronously
    const { executeBatchedTestRunFromCI } = await import('../services/ci-test-executor.service');
    executeBatchedTestRunFromCI(testRunId, agentId, userId).catch(err => {
      logger.error(`[CI/CD] Background execution failed: ${err.message}`);
    });

    res.json({
      success: true,
      testRunId,
      statusUrl: `/api/ci/status/${testRunId}`,
      message: 'Test run triggered. Poll status URL for results.',
    });
  } catch (error: any) {
    logger.error(`[CI/CD] Trigger error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get CI/CD test run status (for polling from GitHub Actions)
 */
router.get('/status/:testRunId', async (req: Request, res: Response) => {
  try {
    const { testRunId } = req.params;

    const runQuery = await pool.query(
      `SELECT id, name, status, metadata, created_at, completed_at FROM test_runs WHERE id = $1`,
      [testRunId]
    );

    if (runQuery.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Test run not found' });
    }

    const run = runQuery.rows[0];
    const metadata = run.metadata || {};

    // Get result counts
    const countsQuery = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'passed' THEN 1 END) as passed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'pending' OR status = 'running' THEN 1 END) as pending,
        AVG(overall_score) as avg_score
       FROM test_results WHERE test_run_id = $1`,
      [testRunId]
    );

    const counts = countsQuery.rows[0];
    const passRate = counts.total > 0 ? (parseInt(counts.passed) / parseInt(counts.total)) * 100 : 0;
    const threshold = metadata.threshold || 80;
    const deployAllowed = passRate >= threshold;

    res.json({
      success: true,
      status: run.status,
      passRate: Math.round(passRate * 10) / 10,
      threshold,
      deployAllowed,
      counts: {
        total: parseInt(counts.total),
        passed: parseInt(counts.passed),
        failed: parseInt(counts.failed),
        pending: parseInt(counts.pending),
      },
      avgScore: counts.avg_score ? Math.round(parseFloat(counts.avg_score) * 10) / 10 : null,
      metadata,
      createdAt: run.created_at,
      completedAt: run.completed_at,
    });
  } catch (error: any) {
    logger.error(`[CI/CD] Status error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
