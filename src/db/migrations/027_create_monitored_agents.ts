import pool from '../index';

export async function up() {
  await pool.query(`
    -- Create monitored_agents table
    CREATE TABLE IF NOT EXISTS monitored_agents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      polling_enabled BOOLEAN DEFAULT false,
      polling_interval_seconds INTEGER DEFAULT 30,
      last_polled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, agent_id)
    );

    -- Create index for faster lookups
    CREATE INDEX IF NOT EXISTS idx_monitored_agents_user_id ON monitored_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_monitored_agents_agent_id ON monitored_agents(agent_id);
  `);
  
  console.log('✅ Created monitored_agents table');
}

export async function down() {
  await pool.query(`
    DROP TABLE IF EXISTS monitored_agents CASCADE;
  `);
  
  console.log('✅ Dropped monitored_agents table');
}
