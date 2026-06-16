import { query } from '../index';

/**
 * Internal-only prompt log for test runs (#13).
 *
 * Stores the actual system prompt fed to the test-caller agent for each
 * batch + the evaluator prompt used to grade it. Used for internal review
 * and debugging — NEVER exposed via any UI / API endpoint.
 */
export async function createTestRunPrompts(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS test_run_prompts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_run_id UUID NOT NULL,
      batch_id TEXT,
      prompt_type TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_test_run_prompts_run
      ON test_run_prompts(test_run_id)
  `);
}
