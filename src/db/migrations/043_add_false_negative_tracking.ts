import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_results 
    ADD COLUMN IF NOT EXISTS is_false_negative BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS false_negative_reason TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS false_negative_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      test_case_scenario TEXT NOT NULL,
      actual_response TEXT NOT NULL,
      reason TEXT,
      pattern_context TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_false_negative_agent ON false_negative_patterns(agent_id);
  `);

  console.log('[Migration 043] false_negative_patterns table ready');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_results 
    DROP COLUMN IF EXISTS is_false_negative,
    DROP COLUMN IF EXISTS false_negative_reason;
  `);
  await pool.query(`DROP TABLE IF EXISTS false_negative_patterns CASCADE;`);
}
