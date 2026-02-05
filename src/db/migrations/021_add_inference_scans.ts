import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    -- Inference scan results table
    CREATE TABLE IF NOT EXISTS inference_scans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_result_id UUID REFERENCES test_results(id) ON DELETE CASCADE,
      overall_risk_score DECIMAL(5,2),
      compliance_flags JSONB DEFAULT '[]'::jsonb,
      action_required BOOLEAN DEFAULT FALSE,
      scan_status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Individual detected inferences
    CREATE TABLE IF NOT EXISTS detected_inferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scan_id UUID REFERENCES inference_scans(id) ON DELETE CASCADE,
      source_statement TEXT NOT NULL,
      turn_number INTEGER,
      inferred_attribute VARCHAR(255) NOT NULL,
      category VARCHAR(50) NOT NULL,
      confidence DECIMAL(3,2),
      risk_level VARCHAR(20) NOT NULL,
      regulations JSONB DEFAULT '[]'::jsonb,
      recommendation TEXT,
      acknowledged BOOLEAN DEFAULT FALSE,
      acknowledged_by UUID REFERENCES users(id),
      acknowledged_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for efficient querying
    CREATE INDEX IF NOT EXISTS idx_inference_scans_test_result ON inference_scans(test_result_id);
    CREATE INDEX IF NOT EXISTS idx_inference_scans_risk_score ON inference_scans(overall_risk_score DESC);
    CREATE INDEX IF NOT EXISTS idx_inference_scans_action_required ON inference_scans(action_required) WHERE action_required = TRUE;
    CREATE INDEX IF NOT EXISTS idx_detected_inferences_scan ON detected_inferences(scan_id);
    CREATE INDEX IF NOT EXISTS idx_detected_inferences_category ON detected_inferences(category);
    CREATE INDEX IF NOT EXISTS idx_detected_inferences_risk ON detected_inferences(risk_level);
  `);

  console.log('Migration 021: Added inference_scans and detected_inferences tables');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS detected_inferences;
    DROP TABLE IF EXISTS inference_scans;
  `);

  console.log('Migration 021: Removed inference_scans and detected_inferences tables');
}
