import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  // Add false_positive tracking to test_results
  await pool.query(`
    ALTER TABLE test_results 
    ADD COLUMN IF NOT EXISTS is_false_positive BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS false_positive_reason TEXT;
  `);

  // Create a table for false positive patterns (used to tune the test agent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS false_positive_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      test_case_scenario TEXT NOT NULL,
      actual_response TEXT NOT NULL,
      reason TEXT,
      pattern_context TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX idx_false_positive_agent ON false_positive_patterns(agent_id);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_results 
    DROP COLUMN IF EXISTS is_false_positive,
    DROP COLUMN IF EXISTS false_positive_reason;
  `);
  await pool.query(`DROP TABLE IF EXISTS false_positive_patterns CASCADE;`);
}
