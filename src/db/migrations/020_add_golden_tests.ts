import { pool } from '../index';

export async function up(): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create golden_tests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS golden_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255),
        baseline_result_id UUID REFERENCES test_results(id) ON DELETE SET NULL,
        baseline_responses JSONB DEFAULT '[]',
        baseline_metrics JSONB DEFAULT '{}',
        baseline_captured_at TIMESTAMP,
        thresholds JSONB DEFAULT '{"minSemanticSimilarity": 0.90, "maxLatencyIncrease": 0.20, "maxCostIncrease": 0.15}',
        schedule_frequency VARCHAR(20) DEFAULT 'weekly',
        last_run_at TIMESTAMP,
        next_scheduled_run TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create golden_test_runs table for history
    await client.query(`
      CREATE TABLE IF NOT EXISTS golden_test_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        golden_test_id UUID REFERENCES golden_tests(id) ON DELETE CASCADE,
        current_result_id UUID REFERENCES test_results(id) ON DELETE SET NULL,
        passed BOOLEAN DEFAULT FALSE,
        semantic_similarity DECIMAL(5,4),
        latency_change DECIMAL(5,2),
        cost_change DECIMAL(5,2),
        drift_details JSONB DEFAULT '[]',
        alerts JSONB DEFAULT '[]',
        run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_golden_tests_agent 
      ON golden_tests(agent_id);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_golden_tests_user 
      ON golden_tests(user_id);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_golden_tests_next_run 
      ON golden_tests(next_scheduled_run) 
      WHERE status = 'active';
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_golden_test_runs_golden_test 
      ON golden_test_runs(golden_test_id);
    `);
    
    await client.query('COMMIT');
    console.log('Migration 020: Added golden_tests and golden_test_runs tables');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function down(): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    await client.query('DROP INDEX IF EXISTS idx_golden_test_runs_golden_test');
    await client.query('DROP INDEX IF EXISTS idx_golden_tests_next_run');
    await client.query('DROP INDEX IF EXISTS idx_golden_tests_user');
    await client.query('DROP INDEX IF EXISTS idx_golden_tests_agent');
    await client.query('DROP TABLE IF EXISTS golden_test_runs');
    await client.query('DROP TABLE IF EXISTS golden_tests');
    
    await client.query('COMMIT');
    console.log('Migration 020: Removed golden_tests tables');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
