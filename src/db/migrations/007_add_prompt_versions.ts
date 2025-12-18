import { query } from '../index';

export const addPromptVersionsTable = async () => {
  try {
    // Prompt Versions table - stores history of prompt changes
    await query(`
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        prompt_hash VARCHAR(64) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, version_number)
      )
    `);

    // Create index for faster lookups
    await query(`
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent_id 
      ON prompt_versions(agent_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_hash 
      ON prompt_versions(agent_id, prompt_hash)
    `);

    console.log('✓ Prompt versions table created successfully');
  } catch (error) {
    console.error('Error creating prompt versions table:', error);
    throw error;
  }
};
