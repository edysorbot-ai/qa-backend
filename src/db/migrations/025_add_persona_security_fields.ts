import { pool } from '../index';

export async function up(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add persona fields to test_cases
    await client.query(`
      ALTER TABLE test_cases 
      ADD COLUMN IF NOT EXISTS persona_type VARCHAR(50) DEFAULT 'neutral',
      ADD COLUMN IF NOT EXISTS persona_traits JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS voice_accent VARCHAR(50) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS behavior_modifiers JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS security_test_type VARCHAR(50) DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS sensitive_data_types JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS is_security_test BOOLEAN DEFAULT FALSE
    `);

    // Create index for security tests
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_test_cases_security 
      ON test_cases(agent_id, is_security_test) 
      WHERE is_security_test = TRUE
    `);

    // Create index for persona types
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_test_cases_persona 
      ON test_cases(agent_id, persona_type)
    `);

    await client.query('COMMIT');
    console.log('Migration 025: Added persona and security fields to test_cases');
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

    await client.query(`
      ALTER TABLE test_cases 
      DROP COLUMN IF EXISTS persona_type,
      DROP COLUMN IF EXISTS persona_traits,
      DROP COLUMN IF EXISTS voice_accent,
      DROP COLUMN IF EXISTS behavior_modifiers,
      DROP COLUMN IF EXISTS security_test_type,
      DROP COLUMN IF EXISTS sensitive_data_types,
      DROP COLUMN IF EXISTS is_security_test
    `);

    await client.query('DROP INDEX IF EXISTS idx_test_cases_security');
    await client.query('DROP INDEX IF EXISTS idx_test_cases_persona');

    await client.query('COMMIT');
    console.log('Migration 025: Rolled back persona and security fields');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
