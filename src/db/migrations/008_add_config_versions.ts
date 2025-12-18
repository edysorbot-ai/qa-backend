import { query } from '../index';

export const addConfigVersionsTable = async () => {
  try {
    // Config Versions table - stores history of configuration changes
    await query(`
      CREATE TABLE IF NOT EXISTS config_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        config JSONB NOT NULL,
        config_hash VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, version_number)
      )
    `);

    // Create index for faster lookups
    await query(`
      CREATE INDEX IF NOT EXISTS idx_config_versions_agent_id 
      ON config_versions(agent_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_config_versions_hash 
      ON config_versions(agent_id, config_hash)
    `);

    console.log('✓ Config versions table created successfully');
  } catch (error) {
    console.error('Error creating config versions table:', error);
    throw error;
  }
};
