import { query } from '../index';

export const addTestResultColumns = async () => {
  try {
    // Add new columns to test_results if they don't exist
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS scenario TEXT,
      ADD COLUMN IF NOT EXISTS user_input TEXT,
      ADD COLUMN IF NOT EXISTS expected_response TEXT,
      ADD COLUMN IF NOT EXISTS actual_response TEXT,
      ADD COLUMN IF NOT EXISTS category VARCHAR(100)
    `);

    // Make test_case_id nullable
    await query(`
      ALTER TABLE test_results 
      ALTER COLUMN test_case_id DROP NOT NULL
    `).catch(() => {
      // Column might already be nullable
    });

    // Drop the foreign key constraint if it exists
    await query(`
      ALTER TABLE test_results 
      DROP CONSTRAINT IF EXISTS test_results_test_case_id_fkey
    `);

    console.log('✅ Test results table updated successfully');
  } catch (error) {
    console.error('❌ Error updating test_results table:', error);
    throw error;
  }
};

// Run migration only if executed directly
if (require.main === module) {
  addTestResultColumns().then(() => process.exit(0)).catch(() => process.exit(1));
}
