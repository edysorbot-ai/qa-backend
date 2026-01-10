-- Production Calls table for real-time monitoring
-- Stores calls received via webhooks from voice agent providers

CREATE TABLE IF NOT EXISTS production_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  -- Provider info
  provider VARCHAR(50) NOT NULL,
  provider_call_id VARCHAR(255), -- Call ID from the provider
  
  -- Call details
  call_type VARCHAR(50) DEFAULT 'inbound', -- inbound, outbound
  caller_phone VARCHAR(50),
  callee_phone VARCHAR(50),
  
  -- Status
  status VARCHAR(50) DEFAULT 'active', -- active, completed, failed
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,
  
  -- Content
  transcript JSONB, -- Array of { role, content, timestamp }
  transcript_text TEXT, -- Plain text version for searching
  recording_url TEXT,
  
  -- Analysis
  analysis JSONB, -- AI analysis results
  analysis_status VARCHAR(50) DEFAULT 'pending', -- pending, analyzing, completed, failed
  overall_score DECIMAL(5,2),
  issues_found INTEGER DEFAULT 0,
  
  -- Suggestions
  prompt_suggestions JSONB, -- Array of improvement suggestions
  
  -- Raw webhook data
  webhook_payload JSONB,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_production_calls_user_id ON production_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_production_calls_agent_id ON production_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_production_calls_provider ON production_calls(provider);
CREATE INDEX IF NOT EXISTS idx_production_calls_status ON production_calls(status);
CREATE INDEX IF NOT EXISTS idx_production_calls_created_at ON production_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_calls_provider_call_id ON production_calls(provider_call_id);

-- Monitoring sessions table - tracks which agents are being monitored
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  -- Webhook config
  webhook_url TEXT NOT NULL,
  webhook_secret VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  
  -- Stats
  total_calls INTEGER DEFAULT 0,
  last_call_at TIMESTAMP WITH TIME ZONE,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique constraint - one session per agent per user
  UNIQUE(user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_user_id ON monitoring_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_agent_id ON monitoring_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_sessions_is_active ON monitoring_sessions(is_active);
