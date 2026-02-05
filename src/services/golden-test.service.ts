import { pool } from '../db';

/**
 * Golden Conversation Replay Service
 * 
 * Saves baseline "golden" test results and automatically replays them
 * to detect model drift when providers update their models.
 */

// Interfaces
export interface GoldenTestThresholds {
  minSemanticSimilarity: number;  // Default: 0.90
  maxLatencyIncrease: number;     // Default: 0.20 (20%)
  maxCostIncrease: number;        // Default: 0.15 (15%)
}

export interface DriftDetail {
  turnNumber: number;
  baseline: string;
  current: string;
  similarity: number;
  isDrifted: boolean;
}

export interface GoldenTestAlert {
  type: 'drift' | 'regression' | 'cost_increase' | 'latency_increase';
  severity: 'warning' | 'critical';
  message: string;
  details?: Record<string, any>;
}

export interface GoldenTest {
  id: string;
  testCaseId: string;
  agentId: string;
  userId: string;
  name: string;
  baselineResultId: string;
  baselineResponses: string[];
  baselineMetrics: {
    overallScore?: number;
    latencyMs?: number;
    tokenCount?: number;
  };
  baselineCapturedAt: Date;
  thresholds: GoldenTestThresholds;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  lastRunAt: Date | null;
  nextScheduledRun: Date | null;
  status: 'active' | 'paused' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

export interface GoldenTestRun {
  id: string;
  goldenTestId: string;
  currentResultId: string | null;
  passed: boolean;
  semanticSimilarity: number;
  latencyChange: number;
  costChange: number;
  driftDetails: DriftDetail[];
  alerts: GoldenTestAlert[];
  runAt: Date;
}

export interface CreateGoldenTestInput {
  testCaseId: string;
  agentId: string;
  userId: string;
  name?: string;
  baselineResultId: string;
  baselineResponses: string[];
  baselineMetrics?: Record<string, any>;
  thresholds?: Partial<GoldenTestThresholds>;
  scheduleFrequency?: 'daily' | 'weekly' | 'monthly';
}

const DEFAULT_THRESHOLDS: GoldenTestThresholds = {
  minSemanticSimilarity: 0.90,
  maxLatencyIncrease: 0.20,
  maxCostIncrease: 0.15,
};

/**
 * Calculate next scheduled run based on frequency
 */
function calculateNextRun(frequency: string, from: Date = new Date()): Date {
  const next = new Date(from);
  
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      next.setHours(3, 0, 0, 0); // Run at 3 AM
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      next.setHours(3, 0, 0, 0);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(3, 0, 0, 0);
      break;
    default:
      next.setDate(next.getDate() + 7);
  }
  
  return next;
}

/**
 * Create a new golden test from a test result
 */
export async function createGoldenTest(input: CreateGoldenTestInput): Promise<GoldenTest> {
  const client = await pool.connect();
  
  try {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
    const scheduleFrequency = input.scheduleFrequency || 'weekly';
    const nextScheduledRun = calculateNextRun(scheduleFrequency);
    
    // Get test case name for default naming
    let name = input.name;
    if (!name) {
      const tcResult = await client.query(
        'SELECT name FROM test_cases WHERE id = $1',
        [input.testCaseId]
      );
      name = tcResult.rows[0]?.name || 'Golden Test';
    }
    
    const result = await client.query(
      `INSERT INTO golden_tests (
        test_case_id,
        agent_id,
        user_id,
        name,
        baseline_result_id,
        baseline_responses,
        baseline_metrics,
        baseline_captured_at,
        thresholds,
        schedule_frequency,
        next_scheduled_run,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8, $9, $10, 'active')
      RETURNING *`,
      [
        input.testCaseId,
        input.agentId,
        input.userId,
        name,
        input.baselineResultId,
        JSON.stringify(input.baselineResponses),
        JSON.stringify(input.baselineMetrics || {}),
        JSON.stringify(thresholds),
        scheduleFrequency,
        nextScheduledRun
      ]
    );
    
    return mapRowToGoldenTest(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Get a golden test by ID
 */
export async function getGoldenTest(id: string): Promise<GoldenTest | null> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT * FROM golden_tests WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) return null;
    return mapRowToGoldenTest(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Get all golden tests for an agent
 */
export async function getGoldenTestsByAgent(agentId: string): Promise<GoldenTest[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT gt.*, tc.name as test_case_name
       FROM golden_tests gt
       LEFT JOIN test_cases tc ON gt.test_case_id = tc.id
       WHERE gt.agent_id = $1
       ORDER BY gt.created_at DESC`,
      [agentId]
    );
    
    return result.rows.map(mapRowToGoldenTest);
  } finally {
    client.release();
  }
}

/**
 * Get all golden tests for a user
 */
export async function getGoldenTestsByUser(userId: string): Promise<GoldenTest[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT gt.*, tc.name as test_case_name, a.name as agent_name
       FROM golden_tests gt
       LEFT JOIN test_cases tc ON gt.test_case_id = tc.id
       LEFT JOIN agents a ON gt.agent_id = a.id
       WHERE gt.user_id = $1
       ORDER BY gt.created_at DESC`,
      [userId]
    );
    
    return result.rows.map(mapRowToGoldenTest);
  } finally {
    client.release();
  }
}

/**
 * Get golden tests that are due to run
 */
export async function getDueGoldenTests(): Promise<GoldenTest[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT * FROM golden_tests 
       WHERE status = 'active' 
       AND next_scheduled_run <= CURRENT_TIMESTAMP
       ORDER BY next_scheduled_run ASC`
    );
    
    return result.rows.map(mapRowToGoldenTest);
  } finally {
    client.release();
  }
}

/**
 * Update golden test
 */
export async function updateGoldenTest(
  id: string, 
  updates: Partial<{
    name: string;
    thresholds: Partial<GoldenTestThresholds>;
    scheduleFrequency: string;
    status: string;
  }>
): Promise<GoldenTest | null> {
  const client = await pool.connect();
  
  try {
    // Get current golden test
    const current = await getGoldenTest(id);
    if (!current) return null;
    
    const newThresholds = updates.thresholds 
      ? { ...current.thresholds, ...updates.thresholds }
      : current.thresholds;
    
    const newFrequency = updates.scheduleFrequency || current.scheduleFrequency;
    const nextRun = updates.scheduleFrequency 
      ? calculateNextRun(updates.scheduleFrequency)
      : current.nextScheduledRun;
    
    const result = await client.query(
      `UPDATE golden_tests SET
        name = COALESCE($1, name),
        thresholds = $2,
        schedule_frequency = $3,
        next_scheduled_run = $4,
        status = COALESCE($5, status),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [
        updates.name,
        JSON.stringify(newThresholds),
        newFrequency,
        nextRun,
        updates.status,
        id
      ]
    );
    
    if (result.rows.length === 0) return null;
    return mapRowToGoldenTest(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Update baseline for a golden test
 */
export async function updateBaseline(
  id: string,
  newResultId: string,
  newResponses: string[],
  newMetrics?: Record<string, any>
): Promise<GoldenTest | null> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `UPDATE golden_tests SET
        baseline_result_id = $1,
        baseline_responses = $2,
        baseline_metrics = $3,
        baseline_captured_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [
        newResultId,
        JSON.stringify(newResponses),
        JSON.stringify(newMetrics || {}),
        id
      ]
    );
    
    if (result.rows.length === 0) return null;
    return mapRowToGoldenTest(result.rows[0]);
  } finally {
    client.release();
  }
}

/**
 * Delete a golden test
 */
export async function deleteGoldenTest(id: string): Promise<boolean> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'DELETE FROM golden_tests WHERE id = $1',
      [id]
    );
    return (result.rowCount || 0) > 0;
  } finally {
    client.release();
  }
}

/**
 * Record a golden test run result
 */
export async function recordGoldenTestRun(
  goldenTestId: string,
  currentResultId: string | null,
  comparison: {
    passed: boolean;
    semanticSimilarity: number;
    latencyChange: number;
    costChange: number;
    driftDetails: DriftDetail[];
    alerts: GoldenTestAlert[];
  }
): Promise<GoldenTestRun> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Insert the run
    const result = await client.query(
      `INSERT INTO golden_test_runs (
        golden_test_id,
        current_result_id,
        passed,
        semantic_similarity,
        latency_change,
        cost_change,
        drift_details,
        alerts
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        goldenTestId,
        currentResultId,
        comparison.passed,
        comparison.semanticSimilarity,
        comparison.latencyChange,
        comparison.costChange,
        JSON.stringify(comparison.driftDetails),
        JSON.stringify(comparison.alerts)
      ]
    );
    
    // Update the golden test with last run info
    const goldenTest = await getGoldenTest(goldenTestId);
    if (goldenTest) {
      const nextRun = calculateNextRun(goldenTest.scheduleFrequency);
      await client.query(
        `UPDATE golden_tests SET
          last_run_at = CURRENT_TIMESTAMP,
          next_scheduled_run = $1,
          status = $2,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [
          nextRun,
          comparison.passed ? 'active' : 'failed',
          goldenTestId
        ]
      );
    }
    
    await client.query('COMMIT');
    return mapRowToGoldenTestRun(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get run history for a golden test
 */
export async function getGoldenTestHistory(
  goldenTestId: string,
  limit: number = 20
): Promise<GoldenTestRun[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT * FROM golden_test_runs 
       WHERE golden_test_id = $1 
       ORDER BY run_at DESC 
       LIMIT $2`,
      [goldenTestId, limit]
    );
    
    return result.rows.map(mapRowToGoldenTestRun);
  } finally {
    client.release();
  }
}

/**
 * Calculate semantic similarity between two texts
 * Simple implementation using word overlap - can be enhanced with embeddings
 */
export function calculateSimpleSimilarity(baseline: string, current: string): number {
  const baselineWords = new Set(baseline.toLowerCase().split(/\s+/));
  const currentWords = new Set(current.toLowerCase().split(/\s+/));
  
  let intersection = 0;
  for (const word of currentWords) {
    if (baselineWords.has(word)) {
      intersection++;
    }
  }
  
  const union = new Set([...baselineWords, ...currentWords]).size;
  
  if (union === 0) return 1.0;
  return intersection / union;
}

/**
 * Compare current responses against baseline
 */
export function compareResponses(
  baselineResponses: string[],
  currentResponses: string[],
  thresholds: GoldenTestThresholds
): {
  passed: boolean;
  semanticSimilarity: number;
  driftDetails: DriftDetail[];
  alerts: GoldenTestAlert[];
} {
  const driftDetails: DriftDetail[] = [];
  const alerts: GoldenTestAlert[] = [];
  let totalSimilarity = 0;
  let comparedTurns = 0;
  
  const maxTurns = Math.max(baselineResponses.length, currentResponses.length);
  
  for (let i = 0; i < maxTurns; i++) {
    const baseline = baselineResponses[i] || '';
    const current = currentResponses[i] || '';
    
    if (!baseline && !current) continue;
    
    const similarity = calculateSimpleSimilarity(baseline, current);
    const isDrifted = similarity < thresholds.minSemanticSimilarity;
    
    driftDetails.push({
      turnNumber: i + 1,
      baseline,
      current,
      similarity,
      isDrifted
    });
    
    if (isDrifted) {
      const severity = similarity < 0.7 ? 'critical' : 'warning';
      alerts.push({
        type: 'drift',
        severity,
        message: `Turn ${i + 1}: Response drifted from baseline (${Math.round(similarity * 100)}% similarity)`,
        details: { turnNumber: i + 1, similarity }
      });
    }
    
    totalSimilarity += similarity;
    comparedTurns++;
  }
  
  const avgSimilarity = comparedTurns > 0 ? totalSimilarity / comparedTurns : 1.0;
  const passed = avgSimilarity >= thresholds.minSemanticSimilarity && 
                 alerts.filter(a => a.severity === 'critical').length === 0;
  
  return {
    passed,
    semanticSimilarity: Math.round(avgSimilarity * 10000) / 10000,
    driftDetails,
    alerts
  };
}

/**
 * Get summary stats for user's golden tests
 */
export async function getGoldenTestsSummary(userId: string): Promise<{
  totalGoldenTests: number;
  activeTests: number;
  passingTests: number;
  failingTests: number;
  recentAlerts: GoldenTestAlert[];
}> {
  const client = await pool.connect();
  
  try {
    // Get counts
    const statsResult = await client.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'failed') as failing
       FROM golden_tests 
       WHERE user_id = $1`,
      [userId]
    );
    
    const stats = statsResult.rows[0];
    const total = parseInt(stats.total) || 0;
    const active = parseInt(stats.active) || 0;
    const failing = parseInt(stats.failing) || 0;
    
    // Get recent alerts from failed runs
    const alertsResult = await client.query(
      `SELECT gtr.alerts, gt.name
       FROM golden_test_runs gtr
       JOIN golden_tests gt ON gtr.golden_test_id = gt.id
       WHERE gt.user_id = $1 AND gtr.passed = FALSE
       ORDER BY gtr.run_at DESC
       LIMIT 5`,
      [userId]
    );
    
    const recentAlerts: GoldenTestAlert[] = [];
    for (const row of alertsResult.rows) {
      const alerts = row.alerts || [];
      recentAlerts.push(...alerts.slice(0, 2));
    }
    
    return {
      totalGoldenTests: total,
      activeTests: active,
      passingTests: active - failing,
      failingTests: failing,
      recentAlerts: recentAlerts.slice(0, 5)
    };
  } finally {
    client.release();
  }
}

// Helper functions
function mapRowToGoldenTest(row: any): GoldenTest {
  return {
    id: row.id,
    testCaseId: row.test_case_id,
    agentId: row.agent_id,
    userId: row.user_id,
    name: row.name || row.test_case_name || 'Golden Test',
    baselineResultId: row.baseline_result_id,
    baselineResponses: row.baseline_responses || [],
    baselineMetrics: row.baseline_metrics || {},
    baselineCapturedAt: row.baseline_captured_at,
    thresholds: row.thresholds || DEFAULT_THRESHOLDS,
    scheduleFrequency: row.schedule_frequency || 'weekly',
    lastRunAt: row.last_run_at,
    nextScheduledRun: row.next_scheduled_run,
    status: row.status || 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRowToGoldenTestRun(row: any): GoldenTestRun {
  return {
    id: row.id,
    goldenTestId: row.golden_test_id,
    currentResultId: row.current_result_id,
    passed: row.passed,
    semanticSimilarity: parseFloat(row.semantic_similarity) || 0,
    latencyChange: parseFloat(row.latency_change) || 0,
    costChange: parseFloat(row.cost_change) || 0,
    driftDetails: row.drift_details || [],
    alerts: row.alerts || [],
    runAt: row.run_at,
  };
}
