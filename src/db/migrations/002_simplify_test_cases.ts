import { query } from '../index';

/**
 * Migration: Simplify test_cases table to only name and scenario
 */
export const migrateTestCases = async () => {
  try {
    console.log('Running test_cases migration...');

    // Add scenario column if it doesn't exist
    await query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS scenario TEXT
    `);

    // Copy user_input to scenario for existing records
    await query(`
      UPDATE test_cases 
      SET scenario = COALESCE(user_input, description, '')
      WHERE scenario IS NULL
    `);

    // Make scenario NOT NULL after populating it
    await query(`
      ALTER TABLE test_cases 
      ALTER COLUMN scenario SET NOT NULL
    `).catch(() => {
      // Column might already be NOT NULL
    });

    // Drop old columns (optional - keep for now for backward compatibility)
    // Uncomment these if you want to fully remove old columns:
    /*
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS description`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS user_input`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS expected_intent`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS expected_output`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS variations`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS config_overrides`);
    await query(`ALTER TABLE test_cases DROP COLUMN IF EXISTS is_auto_generated`);
    */

    console.log('✅ test_cases migration completed');
  } catch (error) {
    console.error('❌ test_cases migration failed:', error);
    throw error;
  }
};

// Run migration if called directly
if (require.main === module) {
  migrateTestCases()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
