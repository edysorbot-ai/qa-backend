/**
 * Migration: Add provider_agent_id column to agents table
 */

import pool from '../index';

export async function addProviderAgentIdColumn(): Promise<void> {
  console.log('[Migration] Adding provider_agent_id column to agents table...');
  
  await pool.query(`
    ALTER TABLE agents 
    ADD COLUMN IF NOT EXISTS provider_agent_id VARCHAR(255)
  `);
  
  console.log('[Migration] provider_agent_id column added successfully');
}
