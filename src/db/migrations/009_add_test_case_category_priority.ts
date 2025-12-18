import { query } from '../index';

/**
 * Migration: Add category and priority columns to test_cases table
 */
export const addTestCaseCategoryPriority = async () => {
  try {
    console.log('Adding category and priority columns to test_cases table...');

    // Add category column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'General'
    `);

    // Add priority column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium'
    `);

    // Create index on category for filtering
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_cases_category 
      ON test_cases(category)
    `);

    // Create index on agent_id and category for common queries
    await query(`
      CREATE INDEX IF NOT EXISTS idx_test_cases_agent_category 
      ON test_cases(agent_id, category)
    `);

    console.log('✅ Category and priority columns added to test_cases table');
  } catch (error) {
    console.error('❌ Failed to add category/priority columns:', error);
    throw error;
  }
};
