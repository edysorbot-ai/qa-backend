import { query } from '../index';

export const addBatchNameColumn = async () => {
  try {
    // Add batch_name column to test_results for displaying batch names in UI
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS batch_name VARCHAR(255)
    `);

    console.log('✅ batch_name column added to test_results table');
  } catch (error) {
    console.error('❌ Error adding batch_name column:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  addBatchNameColumn().then(() => process.exit(0)).catch(() => process.exit(1));
}
