/**
 * Migration: Create monitoring tables
 * 
 * Creates tables for real-time production call monitoring:
 * - production_calls: Stores calls received via webhooks
 * - monitoring_sessions: Tracks which agents are being monitored
 */

import pool from '../../db';

export async function createMonitoringTables(): Promise<void> {
  const client = await pool.connect();
  
  try {
    console.log('[Migration] Creating monitoring tables...');

    // Production Calls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        
        -- Provider info
        provider VARCHAR(50) NOT NULL,
        provider_call_id VARCHAR(255),
        
        -- Call details
        call_type VARCHAR(50) DEFAULT 'inbound',
        caller_phone VARCHAR(50),
        callee_phone VARCHAR(50),
        
        -- Status
        status VARCHAR(50) DEFAULT 'active',
        started_at TIMESTAMP WITH TIME ZONE,
        ended_at TIMESTAMP WITH TIME ZONE,
        duration_seconds INTEGER,
        
        -- Content
        transcript JSONB,
        transcript_text TEXT,
        recording_url TEXT,
        
        -- Analysis
        analysis JSONB,
        analysis_status VARCHAR(50) DEFAULT 'pending',
        overall_score DECIMAL(5,2),
        issues_found INTEGER DEFAULT 0,
        
        -- Suggestions
        prompt_suggestions JSONB,
        
        -- Raw webhook data
        webhook_payload JSONB,
        
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Indexes for production_calls
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_user_id ON production_calls(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_agent_id ON production_calls(agent_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_provider ON production_calls(provider)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_status ON production_calls(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_created_at ON production_calls(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_calls_provider_call_id ON production_calls(provider_call_id)`);

    // Monitoring sessions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        
        -- Webhook config
        webhook_url TEXT NOT NULL,
        webhook_secret VARCHAR(255),
        is_active BOOLEAN DEFAULT false,
        
        -- Stats
        total_calls INTEGER DEFAULT 0,
        last_call_at TIMESTAMP WITH TIME ZONE,
        
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        -- Unique constraint
        UNIQUE(user_id, agent_id)
      )
    `);

    // Indexes for monitoring_sessions
    await client.query(`CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_user_id ON monitoring_sessions(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_agent_id ON monitoring_sessions(agent_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_is_active ON monitoring_sessions(is_active)`);

    console.log('[Migration] Monitoring tables created successfully');
  } catch (error) {
    console.error('[Migration] Error creating monitoring tables:', error);
    throw error;
  } finally {
    client.release();
  }
}
