import { query } from '../index';

/**
 * Extends consistency_test_runs to support:
 *  - batch consistency (multiple test cases re-run per iteration)
 *  - security consistency (security tests get adversarial framing on each iteration)
 *  - per-test-case score breakdown for batch runs
 *
 * Safe to re-run.
 */
export async function extendConsistencyRuns(): Promise<void> {
  // mode: 'single' (existing default) or 'batch'
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'single'
  `);
  // Optional reference to a saved_batches.id (kept as TEXT to avoid FK cascade
  // surprises if saved_batches.id is uuid or text in different installs).
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS batch_id TEXT
  `);
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS batch_name TEXT
  `);
  // List of test_case ids participating in this run (any length, including 1).
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS test_case_ids JSONB
  `);
  // Whether this consistency run targets security tests (adversarial mode).
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS is_security BOOLEAN NOT NULL DEFAULT FALSE
  `);
  // Per-test-case scores when mode='batch': [{ testCaseId, name, score, outlierCount }]
  await query(`
    ALTER TABLE consistency_test_runs
      ADD COLUMN IF NOT EXISTS per_test_case_scores JSONB
  `);
  // Allow batch runs that do not target a single test_case_id.
  await query(`
    ALTER TABLE consistency_test_runs
      ALTER COLUMN test_case_id DROP NOT NULL
  `).catch(() => {
    /* column may already be nullable */
  });
  await query(`
    CREATE INDEX IF NOT EXISTS idx_consistency_runs_is_security
      ON consistency_test_runs(is_security)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_consistency_runs_mode
      ON consistency_test_runs(mode)
  `);
  // Add a test_case_id column on iterations so we can identify which test case
  // each iteration belongs to in batch mode.
  await query(`
    ALTER TABLE consistency_test_iterations
      ADD COLUMN IF NOT EXISTS test_case_id UUID
  `);
}
