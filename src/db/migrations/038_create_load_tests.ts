import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS load_tests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      concurrent_calls INTEGER NOT NULL DEFAULT 5,
      total_calls INTEGER NOT NULL DEFAULT 20,
      ramp_up_seconds INTEGER DEFAULT 10,
      status TEXT DEFAULT 'pending',
      results JSONB,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX idx_load_tests_agent ON load_tests(agent_id);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS load_tests CASCADE;`);
}
