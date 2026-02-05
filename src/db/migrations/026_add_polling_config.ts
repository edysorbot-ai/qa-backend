/**
 * Migration: Add polling configuration to monitoring_sessions
 * 
 * Adds columns to support API polling as an alternative to webhooks:
 * - polling_enabled: Whether automatic polling is enabled
 * - polling_interval_seconds: How often to poll (default 30s)
 * - last_polled_at: When the last poll occurred
 * - sync_method: 'webhook' or 'polling'
 */

import pool from '../../db';

export async function addPollingConfigToMonitoring(): Promise<void> {
  const client = await pool.connect();
  
  try {
    console.log('[Migration] Adding polling configuration to monitoring_sessions...');

    // Add polling columns
    await client.query(`
      ALTER TABLE monitoring_sessions 
      ADD COLUMN IF NOT EXISTS polling_enabled BOOLEAN DEFAULT false
    `);

    await client.query(`
      ALTER TABLE monitoring_sessions 
      ADD COLUMN IF NOT EXISTS polling_interval_seconds INTEGER DEFAULT 30
    `);

    await client.query(`
      ALTER TABLE monitoring_sessions 
      ADD COLUMN IF NOT EXISTS last_polled_at TIMESTAMP WITH TIME ZONE
    `);

    await client.query(`
      ALTER TABLE monitoring_sessions 
      ADD COLUMN IF NOT EXISTS sync_method VARCHAR(20) DEFAULT 'polling'
    `);

    // Add more detailed analysis columns to production_calls
    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS provider_analysis JSONB
    `);

    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS latency_metrics JSONB
    `);

    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS tool_calls JSONB
    `);

    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS sentiment VARCHAR(50)
    `);

    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS disconnection_reason VARCHAR(100)
    `);

    await client.query(`
      ALTER TABLE production_calls 
      ADD COLUMN IF NOT EXISTS compliance_flags JSONB
    `);

    // Index for polling queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_polling 
      ON monitoring_sessions(polling_enabled, is_active) 
      WHERE polling_enabled = true
    `);

    console.log('[Migration] Polling configuration added successfully');
  } catch (error) {
    console.error('[Migration] Error adding polling configuration:', error);
    throw error;
  } finally {
    client.release();
  }
}
