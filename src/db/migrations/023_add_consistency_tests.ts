import { Pool } from 'pg';
import { pool } from '../index';

async function migrate() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check if pgvector extension exists
    const extensionCheck = await client.query(`
      SELECT 1 FROM pg_extension WHERE extname = 'vector'
    `);
    
    if (extensionCheck.rows.length === 0) {
      console.log('Note: pgvector extension not installed. Using TEXT for embeddings instead.');
    }

    // Create consistency_test_runs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS consistency_test_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        iterations INTEGER NOT NULL DEFAULT 30,
        consistency_score DECIMAL(5,2),
        semantic_variance DECIMAL(5,4),
        outlier_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        response_clusters JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Create consistency_test_iterations table
    // Using TEXT for embedding storage to avoid pgvector dependency
    // Can be migrated to VECTOR type later if pgvector is available
    await client.query(`
      CREATE TABLE IF NOT EXISTS consistency_test_iterations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        consistency_run_id UUID REFERENCES consistency_test_runs(id) ON DELETE CASCADE,
        iteration_number INTEGER NOT NULL,
        response TEXT,
        embedding TEXT,
        similarity_to_baseline DECIMAL(5,4),
        is_outlier BOOLEAN DEFAULT FALSE,
        latency_ms INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consistency_runs_agent_id ON consistency_test_runs(agent_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consistency_runs_test_case_id ON consistency_test_runs(test_case_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consistency_runs_user_id ON consistency_test_runs(user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consistency_runs_status ON consistency_test_runs(status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_consistency_iterations_run_id ON consistency_test_iterations(consistency_run_id)
    `);

    await client.query('COMMIT');
    console.log('Migration 023_add_consistency_tests completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 023_add_consistency_tests failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
