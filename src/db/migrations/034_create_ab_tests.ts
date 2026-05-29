import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ab_tests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      prompt_a TEXT NOT NULL,
      prompt_b TEXT NOT NULL,
      prompt_a_label TEXT DEFAULT 'Prompt A',
      prompt_b_label TEXT DEFAULT 'Prompt B',
      test_case_ids TEXT[] NOT NULL,
      sample_size INTEGER DEFAULT 10,
      results_a JSONB DEFAULT '[]'::jsonb,
      results_b JSONB DEFAULT '[]'::jsonb,
      summary JSONB DEFAULT '{}'::jsonb,
      winner TEXT CHECK (winner IN ('a', 'b', 'tie', null)),
      confidence_level NUMERIC(5,4),
      created_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP,
      CONSTRAINT fk_agent FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX idx_ab_tests_user ON ab_tests(user_id);
    CREATE INDEX idx_ab_tests_agent ON ab_tests(agent_id);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ab_tests CASCADE;`);
}
