import { pool } from '../index';

export const createAlertSettingsTable = async () => {
  console.log('🔄 Running create alert_settings table migration...');
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alert_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT false,
        email_addresses TEXT[] DEFAULT '{}',
        notify_on_test_failure BOOLEAN DEFAULT true,
        notify_on_scheduled_failure BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      );
    `);

    // Create index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_settings_user_id ON alert_settings(user_id);
    `);

    console.log('✅ alert_settings table created successfully');
  } catch (error) {
    console.error('❌ alert_settings migration failed:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  createAlertSettingsTable()
    .then(() => {
      console.log('Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
