import { Pool } from 'pg';

/**
 * Two additions:
 *
 * 1. test_cases.reference_link — free-text URL the test author can attach
 *    to a test case to point reviewers at the discussion / spec / video
 *    that motivated the case (e.g. the "rude customer" reference clip).
 *
 * 2. agent_prompt_amendments — persistent record of every AI-proposed
 *    fix to an *agent's* system prompt that came out of a user feedback
 *    loop. Distinct from false_positive_patterns (which only steers the
 *    evaluator). An amendment is created in status='proposed', moves to
 *    'verified' once a dry-run against N scenarios shows it fixes the
 *    failing case without regressing the others, and finally to
 *    'applied' when the user explicitly writes it back to agents.system_prompt.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_cases
      ADD COLUMN IF NOT EXISTS reference_link TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_prompt_amendments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      source_result_id UUID,
      user_feedback TEXT NOT NULL,
      original_prompt TEXT NOT NULL,
      amended_prompt TEXT NOT NULL,
      amendment_summary TEXT,
      verification_runs JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed', 'verified', 'rejected', 'applied')),
      created_at TIMESTAMP DEFAULT NOW(),
      applied_at TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_amendments_agent
      ON agent_prompt_amendments(agent_id);
    CREATE INDEX IF NOT EXISTS idx_prompt_amendments_status
      ON agent_prompt_amendments(status);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS reference_link;`);
  await pool.query(`DROP TABLE IF EXISTS agent_prompt_amendments CASCADE;`);
}
