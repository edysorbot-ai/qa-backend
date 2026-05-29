import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    INSERT INTO feature_credit_costs (feature_key, feature_name, description, credit_cost, category, is_active)
    VALUES 
      ('consistency_test_run', 'Consistency Test Run', 'Per iteration of consistency testing (each iteration makes multiple calls)', 3, 'testing', true),
      ('leakage_scenario_generate', 'Generate Leakage Scenarios', 'AI-powered generation of security test scenarios', 2, 'security', true),
      ('sensitive_data_analyze', 'Analyze Sensitive Data', 'AI analysis of agent prompts for sensitive data exposure', 2, 'security', true),
      ('inference_scan', 'Inference Scan', 'AI-powered scan of test results for implicit inferences', 2, 'compliance', true),
      ('prompt_analyze', 'Prompt Analysis', 'AI-powered analysis of agent prompt quality and issues', 2, 'testing', true),
      ('integration_analyze_agent', 'Analyze Agent Integration', 'AI analysis of agent configuration and auto test-case generation', 3, 'testing', true)
    ON CONFLICT (feature_key) DO NOTHING;
  `);

  // Add consecutive_failures column to scheduled_tests if not exists
  await pool.query(`
    ALTER TABLE scheduled_tests 
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_failure_reason TEXT;
  `);
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    DELETE FROM feature_credit_costs 
    WHERE feature_key IN (
      'consistency_test_run',
      'leakage_scenario_generate', 
      'sensitive_data_analyze',
      'inference_scan',
      'prompt_analyze',
      'integration_analyze_agent'
    );
  `);

  await pool.query(`
    ALTER TABLE scheduled_tests 
    DROP COLUMN IF EXISTS consecutive_failures,
    DROP COLUMN IF EXISTS last_failure_reason;
  `);
}
