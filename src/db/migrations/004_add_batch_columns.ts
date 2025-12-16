import { query } from '../index';

export const addBatchColumns = async () => {
  try {
    // Add batch_id and duration_ms columns to test_results
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS batch_id VARCHAR(100),
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER
    `);

    // Create index for batch_id for faster grouping queries
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_results_batch_id ON test_results(batch_id)
    `);

    console.log('✅ Batch columns added to test_results table');
  } catch (error) {
    console.error('❌ Error adding batch columns:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  addBatchColumns().then(() => process.exit(0)).catch(() => process.exit(1));
}
