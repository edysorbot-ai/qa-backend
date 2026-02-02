require('dotenv').config();
const { Client } = require('pg');

async function fixEmailTypes() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Get divya@edysor.ai user's alert settings
    const result = await client.query(`
      SELECT a.id, a.user_id, a.email_configs, u.email
      FROM alert_settings a
      JOIN users u ON a.user_id = u.id
      WHERE u.email = 'divya@edysor.ai'
    `);

    if (result.rows.length === 0) {
      console.log('No alert settings found for divya@edysor.ai');
      return;
    }

    const settings = result.rows[0];
    console.log('\nCurrent email_configs:');
    console.log(JSON.stringify(settings.email_configs, null, 2));

    // Process email_configs: remove type from emails that are not the first account email
    const emailConfigs = settings.email_configs || [];
    const accountEmail = settings.email.toLowerCase();
    
    const updatedConfigs = emailConfigs.map((config, index) => {
      // Keep type for account email and team_member emails
      if (config.type === 'team_member' || config.email.toLowerCase() === accountEmail) {
        return config;
      }
      
      // Remove type from custom emails
      const { type, name, ...rest } = config;
      return rest;
    });

    console.log('\nUpdated email_configs:');
    console.log(JSON.stringify(updatedConfigs, null, 2));

    // Update the database
    await client.query(
      'UPDATE alert_settings SET email_configs = $1 WHERE id = $2',
      [JSON.stringify(updatedConfigs), settings.id]
    );

    console.log('\n✅ Successfully updated email configs');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

fixEmailTypes();
