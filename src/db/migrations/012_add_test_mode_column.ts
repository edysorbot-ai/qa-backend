import { pool } from '../index';

export async function addTestModeColumn() {
  try {
    // Add test_mode column to test_results for tracking voice vs chat testing
    await pool.query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS test_mode VARCHAR(10) DEFAULT 'voice'
    `);
    console.log('✅ test_mode column added to test_results table');
  } catch (error) {
    console.error('❌ Error adding test_mode column:', error);
    throw error;
  }
}
