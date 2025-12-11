import { query } from '../index';

export const initializeDatabase = async () => {
  try {
    // Users table (synced with Clerk)
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        clerk_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        image_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // API Keys / Integrations table
    await query(`
      CREATE TABLE IF NOT EXISTS integrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        api_key TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, provider)
      )
    `);

    // Agents table
    await query(`
      CREATE TABLE IF NOT EXISTS agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
        external_agent_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        prompt TEXT,
        intents JSONB DEFAULT '[]',
        config JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Test Cases table
    await query(`
      CREATE TABLE IF NOT EXISTS test_cases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        user_input TEXT NOT NULL,
        expected_intent VARCHAR(255),
        expected_output TEXT,
        variations JSONB DEFAULT '[]',
        config_overrides JSONB DEFAULT '{}',
        is_auto_generated BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Test Runs table
    await query(`
      CREATE TABLE IF NOT EXISTS test_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        name VARCHAR(255),
        status VARCHAR(20) DEFAULT 'pending',
        total_tests INTEGER DEFAULT 0,
        passed_tests INTEGER DEFAULT 0,
        failed_tests INTEGER DEFAULT 0,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Test Results table
    await query(`
      CREATE TABLE IF NOT EXISTS test_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
        test_case_id UUID REFERENCES test_cases(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        user_audio_url TEXT,
        agent_audio_url TEXT,
        user_transcript TEXT,
        agent_transcript TEXT,
        detected_intent VARCHAR(255),
        intent_match BOOLEAN,
        output_match BOOLEAN,
        latency_ms INTEGER,
        conversation_turns JSONB DEFAULT '[]',
        metrics JSONB DEFAULT '{}',
        error_message TEXT,
        started_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Metrics table for aggregated analytics
    await query(`
      CREATE TABLE IF NOT EXISTS metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
        agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
        metric_type VARCHAR(50) NOT NULL,
        metric_name VARCHAR(100) NOT NULL,
        metric_value DECIMAL(10, 4),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await query(`CREATE INDEX IF NOT EXISTS idx_agents_user_id ON agents(user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_cases_agent_id ON test_cases(agent_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_runs_agent_id ON test_runs(agent_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_results_run_id ON test_results(test_run_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_metrics_run_id ON metrics(test_run_id)`);

    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  }
};
