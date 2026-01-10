import { pool } from '../index';

export const addSlackIntegration = async () => {
  console.log('🔄 Running add Slack integration migration...');
  
  try {
    // Add Slack fields to alert_settings table
    await pool.query(`
      ALTER TABLE alert_settings 
      ADD COLUMN IF NOT EXISTS slack_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS slack_channel TEXT
    `);

    console.log('✅ Slack integration columns added successfully');
  } catch (error) {
    console.error('❌ Slack integration migration failed:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  addSlackIntegration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
