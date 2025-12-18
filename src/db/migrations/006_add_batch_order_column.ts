import { query } from '../index';

export const addBatchOrderColumn = async () => {
  try {
    // Add batch_order column to test_results for preserving execution order
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS batch_order INTEGER
    `);

    console.log('✅ batch_order column added to test_results table');
  } catch (error) {
    console.error('❌ Error adding batch_order column:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  addBatchOrderColumn().then(() => process.exit(0)).catch(() => process.exit(1));
}
