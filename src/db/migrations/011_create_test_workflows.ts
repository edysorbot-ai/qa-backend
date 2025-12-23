/**
 * Migration: Create test_workflows table
 */

import { query } from '../index';

export async function createTestWorkflowsTable() {
  try {
    console.log('Creating test_workflows table...');
    
    // Create test_workflows table
    await query(`
      CREATE TABLE IF NOT EXISTS test_workflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        nodes JSONB NOT NULL DEFAULT '[]',
        edges JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_workflows_agent_id ON test_workflows(agent_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_workflows_user_id ON test_workflows(user_id)
    `);
    
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_workflows_is_active ON test_workflows(is_active)
    `);

    // Add execution columns to test_runs if not exists
    await query(`
      ALTER TABLE test_runs 
      ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(50) DEFAULT 'standard'
    `);
    
    await query(`
      ALTER TABLE test_runs 
      ADD COLUMN IF NOT EXISTS execution_plan JSONB
    `);
    
    await query(`
      ALTER TABLE test_runs 
      ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES test_workflows(id) ON DELETE SET NULL
    `);

    console.log('✅ test_workflows table created successfully');
  } catch (error) {
    console.error('Error creating test_workflows table:', error);
    throw error;
  }
}
