import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_flows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
      edges JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX idx_flows_agent ON conversation_flows(agent_id);

    CREATE TABLE IF NOT EXISTS flow_compliance_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_result_id UUID,
      flow_id UUID REFERENCES conversation_flows(id) ON DELETE SET NULL,
      path_taken JSONB NOT NULL DEFAULT '[]'::jsonb,
      expected_path JSONB NOT NULL DEFAULT '[]'::jsonb,
      compliance_score NUMERIC(5,2) DEFAULT 0,
      deviations JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS flow_compliance_results CASCADE;
    DROP TABLE IF EXISTS conversation_flows CASCADE;
  `);
}
