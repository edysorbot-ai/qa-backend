import { Pool } from 'pg';

/**
 * Migration 040: AI re-evaluation support for test results
 * Item 3 — "Feedback to the test agent: if a test outcome is wrongly provided,
 * user can give feedback and AI will reevaluate it and correct the testing agent"
 *
 * - user_feedback     : free-form text from the user explaining why the verdict was wrong
 * - feedback_at       : timestamp of latest feedback
 * - reevaluation_count: number of times AI re-evaluated this result
 * - reevaluation_history: append-only log of { at, previousPassed, newPassed, previousScore, newScore, reasoning, feedback }
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_results
      ADD COLUMN IF NOT EXISTS user_feedback TEXT,
      ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS reevaluation_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS reevaluation_history JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_test_results_reevaluated
      ON test_results(reevaluation_count) WHERE reevaluation_count > 0;
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_results
      DROP COLUMN IF EXISTS user_feedback,
      DROP COLUMN IF EXISTS feedback_at,
      DROP COLUMN IF EXISTS reevaluation_count,
      DROP COLUMN IF EXISTS reevaluation_history;
  `);
}
