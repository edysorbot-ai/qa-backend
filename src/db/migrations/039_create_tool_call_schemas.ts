import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_call_schemas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      description TEXT,
      parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      expected_response_schema JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tool_call_validations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_result_id UUID,
      agent_id UUID NOT NULL,
      tool_name TEXT NOT NULL,
      parameters_sent JSONB,
      is_valid BOOLEAN DEFAULT false,
      validation_errors JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tool_schemas_agent ON tool_call_schemas(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tool_validations_result ON tool_call_validations(test_result_id);
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS tool_call_validations CASCADE;
    DROP TABLE IF EXISTS tool_call_schemas CASCADE;
  `);
}
