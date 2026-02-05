import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    -- Leakage test scenarios
    CREATE TABLE IF NOT EXISTS leakage_test_scenarios (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      is_builtin BOOLEAN DEFAULT FALSE,
      sensitive_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      conversation_flow JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Leakage test runs
    CREATE TABLE IF NOT EXISTS leakage_test_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_id UUID REFERENCES leakage_test_scenarios(id) ON DELETE CASCADE,
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      passed BOOLEAN,
      data_minimization_score DECIMAL(5,2),
      leakages JSONB DEFAULT '[]'::jsonb,
      full_conversation JSONB DEFAULT '[]'::jsonb,
      error_message TEXT,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_leakage_scenarios_agent ON leakage_test_scenarios(agent_id);
    CREATE INDEX IF NOT EXISTS idx_leakage_scenarios_user ON leakage_test_scenarios(user_id);
    CREATE INDEX IF NOT EXISTS idx_leakage_runs_scenario ON leakage_test_runs(scenario_id);
    CREATE INDEX IF NOT EXISTS idx_leakage_runs_agent ON leakage_test_runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_leakage_runs_status ON leakage_test_runs(status);
  `);

  console.log('Migration 022: Added leakage_test_scenarios and leakage_test_runs tables');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS leakage_test_runs;
    DROP TABLE IF EXISTS leakage_test_scenarios;
  `);

  console.log('Migration 022: Removed leakage test tables');
}
