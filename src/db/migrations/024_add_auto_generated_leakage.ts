import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    -- Add is_auto_generated column to leakage_test_scenarios
    ALTER TABLE leakage_test_scenarios 
    ADD COLUMN IF NOT EXISTS is_auto_generated BOOLEAN DEFAULT FALSE;

    -- Add index for auto-generated scenarios
    CREATE INDEX IF NOT EXISTS idx_leakage_scenarios_auto_gen 
    ON leakage_test_scenarios(is_auto_generated);

    -- Add detected_sensitive_data table to store analysis results
    CREATE TABLE IF NOT EXISTS detected_sensitive_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(100) NOT NULL,
      description TEXT,
      example_pattern TEXT,
      risk_level VARCHAR(20) DEFAULT 'medium',
      source VARCHAR(50) DEFAULT 'prompt',
      context TEXT,
      acknowledged BOOLEAN DEFAULT FALSE,
      acknowledged_by UUID REFERENCES users(id),
      acknowledged_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for detected_sensitive_data
    CREATE INDEX IF NOT EXISTS idx_detected_sensitive_agent ON detected_sensitive_data(agent_id);
    CREATE INDEX IF NOT EXISTS idx_detected_sensitive_risk ON detected_sensitive_data(risk_level);
  `);

  console.log('Migration 024: Added is_auto_generated column and detected_sensitive_data table');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS detected_sensitive_data;
    ALTER TABLE leakage_test_scenarios DROP COLUMN IF EXISTS is_auto_generated;
  `);

  console.log('Migration 024: Removed auto-generated leakage columns and tables');
}
