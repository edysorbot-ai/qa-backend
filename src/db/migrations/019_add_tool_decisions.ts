import { pool } from '../index';

export async function up(): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create tool_decisions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_result_id UUID REFERENCES test_results(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        available_tools JSONB DEFAULT '[]',
        selected_tool VARCHAR(100),
        selection_reason TEXT,
        alternatives_considered JSONB DEFAULT '[]',
        decision_factors JSONB DEFAULT '[]',
        input_context TEXT,
        confidence DECIMAL(3,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create index for efficient querying
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_decisions_result 
      ON tool_decisions(test_result_id);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tool_decisions_turn 
      ON tool_decisions(test_result_id, turn_number);
    `);
    
    await client.query('COMMIT');
    console.log('Migration 019: Added tool_decisions table');
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
    
    await client.query('DROP INDEX IF EXISTS idx_tool_decisions_turn');
    await client.query('DROP INDEX IF EXISTS idx_tool_decisions_result');
    await client.query('DROP TABLE IF EXISTS tool_decisions');
    
    await client.query('COMMIT');
    console.log('Migration 019: Removed tool_decisions table');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
