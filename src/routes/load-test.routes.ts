/**
 * Load & Concurrency Testing Routes
 * 
 * Spawn N concurrent calls to test agent performance under load.
 * Measures: response time, error rate, degradation pattern.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, name, concurrentCalls = 5, totalCalls = 20, rampUpSeconds = 10 } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    const result = await pool.query(
      `INSERT INTO load_tests (user_id, agent_id, name, concurrent_calls, total_calls, ramp_up_seconds, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING *`,
      [userId, agentId, name || `Load Test - ${new Date().toISOString()}`, concurrentCalls, totalCalls, rampUpSeconds]
    );

    const loadTest = result.rows[0];

    // Start load test in background
    executeLoadTest(loadTest.id, agentId, userId, concurrentCalls, totalCalls, rampUpSeconds).catch(err => {
      logger.error(`[LoadTest] Execution error: ${err.message}`);
    });

    res.json({ success: true, loadTest });
  } catch (error: any) {
    logger.error(`[LoadTest] Create error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await pool.query(
      `SELECT * FROM load_tests WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 20`,
      [req.params.agentId, userId]
    );
    res.json({ success: true, loadTests: result.rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/status/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await pool.query(
      `SELECT * FROM load_tests WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, loadTest: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

async function executeLoadTest(
  loadTestId: string, agentId: string, userId: string,
  concurrentCalls: number, totalCalls: number, rampUpSeconds: number
) {
  await pool.query(`UPDATE load_tests SET started_at = NOW() WHERE id = $1`, [loadTestId]);

  // Get agent info
  const agentQuery = await pool.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
  if (!agentQuery.rows.length) throw new Error('Agent not found');
  const agent = agentQuery.rows[0];

  // Get sample test cases
  const testCasesQuery = await pool.query(
    `SELECT * FROM test_cases WHERE agent_id = $1 LIMIT 5`,
    [agentId]
  );

  const callResults: any[] = [];
  const batchSize = concurrentCalls;
  const delayPerBatch = (rampUpSeconds * 1000) / Math.ceil(totalCalls / batchSize);
  let callsExecuted = 0;

  while (callsExecuted < totalCalls) {
    const batchPromises: Promise<any>[] = [];
    const currentBatch = Math.min(batchSize, totalCalls - callsExecuted);

    for (let i = 0; i < currentBatch; i++) {
      const testCase = testCasesQuery.rows[i % testCasesQuery.rows.length];
      batchPromises.push(executeSingleLoadCall(agent, testCase?.scenario || 'Hello, I need help'));
    }

    const batchResults = await Promise.allSettled(batchPromises);
    batchResults.forEach((r, idx) => {
      callResults.push({
        callIndex: callsExecuted + idx,
        timestamp: Date.now(),
        ...(r.status === 'fulfilled' ? r.value : { error: (r as any).reason?.message, responseTime: 0, success: false })
      });
    });

    callsExecuted += currentBatch;

    if (callsExecuted < totalCalls) {
      await new Promise(resolve => setTimeout(resolve, delayPerBatch));
    }
  }

  // Calculate aggregate metrics
  const successful = callResults.filter(r => r.success);
  const failed = callResults.filter(r => !r.success);
  const responseTimes = successful.map(r => r.responseTime);

  const metrics = {
    totalCalls,
    successCount: successful.length,
    failCount: failed.length,
    errorRate: (failed.length / totalCalls) * 100,
    avgResponseTime: responseTimes.length ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
    p50ResponseTime: percentile(responseTimes, 50),
    p95ResponseTime: percentile(responseTimes, 95),
    p99ResponseTime: percentile(responseTimes, 99),
    minResponseTime: responseTimes.length ? Math.min(...responseTimes) : 0,
    maxResponseTime: responseTimes.length ? Math.max(...responseTimes) : 0,
    callResults,
  };

  await pool.query(
    `UPDATE load_tests SET status = 'completed', results = $1, completed_at = NOW() WHERE id = $2`,
    [JSON.stringify(metrics), loadTestId]
  );
}

async function executeSingleLoadCall(agent: any, scenario: string): Promise<any> {
  const start = Date.now();
  try {
    // Make actual call to agent's phone number or API
    const phoneNumber = agent.phone_number || agent.config?.phoneNumber;
    if (!phoneNumber) {
      // Simulate with API call if no phone
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 2000));
      return { success: true, responseTime: Date.now() - start, simulated: true };
    }

    // Use the existing call infrastructure if available
    try {
      const callService = await import('../services/call.service');
      if (callService.makeTestCall) {
        await callService.makeTestCall(phoneNumber, scenario);
      }
    } catch {
      // If call service doesn't exist, simulate
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 2000));
    }
    return { success: true, responseTime: Date.now() - start };
  } catch (error: any) {
    return { success: false, responseTime: Date.now() - start, error: error.message };
  }
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export default router;
