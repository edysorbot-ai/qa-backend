import { query } from '../index';

export const addTestCaseColumns = async () => {
  try {
    console.log('Adding new columns to test_cases table...');

    // Add scenario column if user_input doesn't exist, or rename user_input to scenario
    await query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'test_cases' AND column_name = 'user_input') THEN
          -- Rename user_input to scenario if needed
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'test_cases' AND column_name = 'scenario') THEN
            ALTER TABLE test_cases RENAME COLUMN user_input TO scenario;
          END IF;
        ELSE
          -- Add scenario column if it doesn't exist
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'test_cases' AND column_name = 'scenario') THEN
            ALTER TABLE test_cases ADD COLUMN scenario TEXT;
          END IF;
        END IF;
      END $$;
    `);

    // Add expected_behavior column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS expected_behavior TEXT
    `);

    // Add key_topic column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS key_topic VARCHAR(100)
    `);

    // Add test_type column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS test_type VARCHAR(50)
    `);

    // Add batch_compatible column
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS batch_compatible BOOLEAN DEFAULT true
    `);

    console.log('✅ Test case columns added successfully');
  } catch (error) {
    console.error('Failed to add test case columns:', error);
    // Don't throw - columns might already exist
  }
};
