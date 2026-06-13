import { query } from '../index';

export async function updateAlertEmailStructure() {
  console.log('Updating alert_settings email structure...');

  try {
    // Add new column for email configs (array of objects with email and enabled status)
    await query(`
      ALTER TABLE alert_settings 
      ADD COLUMN IF NOT EXISTS email_configs JSONB DEFAULT '[]'::jsonb
    `);

    // Migrate existing email_addresses to email_configs format
    await query(`
      UPDATE alert_settings 
      SET email_configs = (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'email', email,
              'enabled', true,
              'type', 'account'
            )
          ),
          '[]'::jsonb
        )
        FROM unnest(email_addresses) AS email
      )
      WHERE email_configs = '[]'::jsonb 
        AND email_addresses IS NOT NULL 
        AND array_length(email_addresses, 1) > 0
    `);

    console.log('✅ Alert settings email structure updated successfully');
  } catch (error) {
    console.error('Error updating alert settings email structure:', error);
  }
}
