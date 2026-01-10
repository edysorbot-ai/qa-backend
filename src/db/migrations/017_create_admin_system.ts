import { pool } from "../index";

export async function up(): Promise<void> {
  console.log("Running migration: 017_create_admin_system");

  // 1. Integration settings table - control which integrations are enabled
  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider VARCHAR(50) UNIQUE NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      description TEXT,
      is_enabled BOOLEAN DEFAULT true,
      icon_url VARCHAR(500),
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Credit packages table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_packages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      credits INTEGER NOT NULL DEFAULT 0,
      price_usd DECIMAL(10, 2) NOT NULL DEFAULT 0,
      is_unlimited BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      is_default BOOLEAN DEFAULT false,
      validity_days INTEGER DEFAULT 30,
      features JSONB DEFAULT '{}',
      max_team_members INTEGER DEFAULT 1,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Feature credit costs table - defines credit cost for each operation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_credit_costs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feature_key VARCHAR(100) UNIQUE NOT NULL,
      feature_name VARCHAR(200) NOT NULL,
      description TEXT,
      credit_cost INTEGER NOT NULL DEFAULT 1,
      category VARCHAR(50) NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Credit pricing settings
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_pricing (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      credits_per_dollar DECIMAL(10, 4) NOT NULL DEFAULT 10,
      min_purchase_credits INTEGER DEFAULT 100,
      bulk_discount_tiers JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. User credits table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_credits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id UUID REFERENCES credit_packages(id) ON DELETE SET NULL,
      current_credits INTEGER DEFAULT 0,
      total_credits_purchased INTEGER DEFAULT 0,
      total_credits_used INTEGER DEFAULT 0,
      package_expires_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    )
  `);

  // 6. Credit transactions log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      transaction_type VARCHAR(50) NOT NULL,
      feature_key VARCHAR(100),
      credits_amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 7. Coupons table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(50) UNIQUE NOT NULL,
      description TEXT,
      discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed', 'credits')),
      discount_value DECIMAL(10, 2) NOT NULL,
      credits_bonus INTEGER DEFAULT 0,
      max_uses INTEGER,
      current_uses INTEGER DEFAULT 0,
      min_purchase_amount DECIMAL(10, 2) DEFAULT 0,
      applicable_packages UUID[],
      valid_from TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      valid_until TIMESTAMP WITH TIME ZONE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 8. Coupon usage tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupon_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      discount_applied DECIMAL(10, 2),
      credits_added INTEGER DEFAULT 0,
      UNIQUE(coupon_id, user_id)
    )
  `);

  // 9. Referral links table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code VARCHAR(50) UNIQUE NOT NULL,
      description TEXT,
      referrer_credits INTEGER DEFAULT 0,
      referee_credits INTEGER DEFAULT 0,
      referrer_discount_percent DECIMAL(5, 2) DEFAULT 0,
      referee_discount_percent DECIMAL(5, 2) DEFAULT 0,
      max_referrals INTEGER,
      current_referrals INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      valid_until TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 10. Referral tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referral_link_id UUID NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
      referrer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      referee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referrer_credits_awarded INTEGER DEFAULT 0,
      referee_credits_awarded INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(referral_link_id, referee_user_id)
    )
  `);

  // 11. Admin users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'admin',
      is_active BOOLEAN DEFAULT true,
      last_login_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 12. Package features mapping
  await pool.query(`
    CREATE TABLE IF NOT EXISTS package_features (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      package_id UUID NOT NULL REFERENCES credit_packages(id) ON DELETE CASCADE,
      feature_key VARCHAR(100) NOT NULL,
      is_enabled BOOLEAN DEFAULT true,
      custom_credit_cost INTEGER,
      usage_limit INTEGER,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(package_id, feature_key)
    )
  `);

  // Create indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_created_at ON credit_transactions(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coupon_usage_user_id ON coupon_usage(user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referral_usage_referrer ON referral_usage(referrer_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_credits_user_id ON user_credits(user_id)`);

  // Insert default admin user (password: admin@edysor - will be hashed)
  const bcrypt = await import('bcryptjs');
  const passwordHash = await bcrypt.hash('admin@edysor', 10);
  
  await pool.query(`
    INSERT INTO admin_users (username, password_hash, role)
    VALUES ('admin', $1, 'superadmin')
    ON CONFLICT (username) DO NOTHING
  `, [passwordHash]);

  // Insert default integration settings
  const integrations = [
    { provider: 'vapi', display_name: 'VAPI', description: 'Voice AI Platform Integration', sort_order: 1 },
    { provider: 'retell', display_name: 'Retell AI', description: 'Retell AI Voice Agent Integration', sort_order: 2 },
    { provider: 'bland', display_name: 'Bland AI', description: 'Bland AI Voice Integration', sort_order: 3 },
    { provider: 'elevenlabs', display_name: 'ElevenLabs', description: 'ElevenLabs Voice Integration', sort_order: 4 },
    { provider: 'openai-realtime', display_name: 'OpenAI Realtime', description: 'OpenAI Realtime Voice API', sort_order: 5 },
    { provider: 'livekit', display_name: 'LiveKit', description: 'LiveKit Voice Integration', sort_order: 6 },
    { provider: 'bolna', display_name: 'Bolna', description: 'Bolna Voice AI Integration', sort_order: 7 },
    { provider: 'haptik', display_name: 'Haptik', description: 'Haptik Conversational AI', sort_order: 8 },
    { provider: 'custom', display_name: 'Custom Agent', description: 'Custom Voice Agent Integration', sort_order: 9 },
  ];

  for (const integration of integrations) {
    await pool.query(`
      INSERT INTO integration_settings (provider, display_name, description, sort_order)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (provider) DO NOTHING
    `, [integration.provider, integration.display_name, integration.description, integration.sort_order]);
  }

  // Insert default feature credit costs
  const features = [
    // Test Case Operations
    { feature_key: 'test_case_create', feature_name: 'Create Test Case', credit_cost: 1, category: 'test_cases' },
    { feature_key: 'test_case_update', feature_name: 'Update Test Case', credit_cost: 0, category: 'test_cases' },
    { feature_key: 'test_case_delete', feature_name: 'Delete Test Case', credit_cost: 0, category: 'test_cases' },
    { feature_key: 'test_case_bulk_create', feature_name: 'Bulk Create Test Cases', credit_cost: 5, category: 'test_cases' },
    
    // Test Run Operations
    { feature_key: 'test_run_voice', feature_name: 'Voice Test Run', credit_cost: 10, category: 'test_runs' },
    { feature_key: 'test_run_chat', feature_name: 'Chat Test Run', credit_cost: 5, category: 'test_runs' },
    { feature_key: 'test_run_batch', feature_name: 'Batch Test Run (per batch)', credit_cost: 15, category: 'test_runs' },
    { feature_key: 'test_run_concurrent', feature_name: 'Concurrent Test Run (per concurrent)', credit_cost: 5, category: 'test_runs' },
    
    // Scheduling
    { feature_key: 'schedule_create', feature_name: 'Create Schedule', credit_cost: 2, category: 'scheduling' },
    { feature_key: 'schedule_run', feature_name: 'Scheduled Run Execution', credit_cost: 10, category: 'scheduling' },
    
    // Agent Operations
    { feature_key: 'agent_create', feature_name: 'Create Agent', credit_cost: 5, category: 'agents' },
    { feature_key: 'custom_agent_create', feature_name: 'Create Custom Agent', credit_cost: 20, category: 'agents' },
    { feature_key: 'agent_simulation_voice', feature_name: 'Voice Simulation', credit_cost: 15, category: 'agents' },
    { feature_key: 'agent_simulation_chat', feature_name: 'Chat Simulation', credit_cost: 8, category: 'agents' },
    
    // Comparison & Analysis
    { feature_key: 'compare_prompts', feature_name: 'Compare Prompts', credit_cost: 5, category: 'analysis' },
    { feature_key: 'compare_test_runs', feature_name: 'Compare Test Runs', credit_cost: 5, category: 'analysis' },
    { feature_key: 'prompt_suggestion', feature_name: 'AI Prompt Suggestion', credit_cost: 10, category: 'analysis' },
    
    // Team & Collaboration
    { feature_key: 'team_member_add', feature_name: 'Add Team Member', credit_cost: 50, category: 'team' },
    { feature_key: 'team_member_monthly', feature_name: 'Team Member (monthly)', credit_cost: 100, category: 'team' },
    
    // Integrations
    { feature_key: 'integration_connect', feature_name: 'Connect Integration', credit_cost: 0, category: 'integrations' },
    { feature_key: 'integration_sync', feature_name: 'Sync Integration Data', credit_cost: 2, category: 'integrations' },
    
    // Workflows
    { feature_key: 'workflow_create', feature_name: 'Create Workflow', credit_cost: 5, category: 'workflows' },
    { feature_key: 'workflow_run', feature_name: 'Run Workflow', credit_cost: 10, category: 'workflows' },
    
    // Reports & Export
    { feature_key: 'report_generate', feature_name: 'Generate Report', credit_cost: 3, category: 'reports' },
    { feature_key: 'export_data', feature_name: 'Export Data', credit_cost: 2, category: 'reports' },
  ];

  for (const feature of features) {
    await pool.query(`
      INSERT INTO feature_credit_costs (feature_key, feature_name, credit_cost, category)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (feature_key) DO NOTHING
    `, [feature.feature_key, feature.feature_name, feature.credit_cost, feature.category]);
  }

  // Insert default credit pricing
  await pool.query(`
    INSERT INTO credit_pricing (credits_per_dollar, min_purchase_credits, bulk_discount_tiers)
    VALUES (10, 100, '[{"min_credits": 500, "discount_percent": 5}, {"min_credits": 1000, "discount_percent": 10}, {"min_credits": 5000, "discount_percent": 20}]')
    ON CONFLICT DO NOTHING
  `);

  // Insert default packages
  const packages = [
    {
      name: 'Free Trial',
      description: 'Get started with limited features',
      credits: 100,
      price_usd: 0,
      is_unlimited: false,
      validity_days: 14,
      max_team_members: 1,
      features: { test_runs: true, test_cases: true, agents: true, max_agents: 2 }
    },
    {
      name: 'Starter',
      description: 'Perfect for small teams',
      credits: 500,
      price_usd: 29,
      is_unlimited: false,
      validity_days: 30,
      max_team_members: 3,
      features: { test_runs: true, test_cases: true, agents: true, scheduling: true, max_agents: 5 }
    },
    {
      name: 'Professional',
      description: 'For growing businesses',
      credits: 2000,
      price_usd: 99,
      is_unlimited: false,
      validity_days: 30,
      max_team_members: 10,
      features: { test_runs: true, test_cases: true, agents: true, scheduling: true, workflows: true, max_agents: 20 }
    },
    {
      name: 'Enterprise',
      description: 'Unlimited access for large teams',
      credits: 0,
      price_usd: 499,
      is_unlimited: true,
      validity_days: 30,
      max_team_members: 100,
      features: { test_runs: true, test_cases: true, agents: true, scheduling: true, workflows: true, unlimited: true }
    }
  ];

  for (const pkg of packages) {
    await pool.query(`
      INSERT INTO credit_packages (name, description, credits, price_usd, is_unlimited, validity_days, max_team_members, features)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (name) DO NOTHING
    `, [pkg.name, pkg.description, pkg.credits, pkg.price_usd, pkg.is_unlimited, pkg.validity_days, pkg.max_team_members, JSON.stringify(pkg.features)]);
  }

  // Add is_default column if it doesn't exist (for existing databases)
  await pool.query(`
    ALTER TABLE credit_packages 
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false
  `);

  // Set Free Trial as default package if no default is set
  await pool.query(`
    UPDATE credit_packages 
    SET is_default = true 
    WHERE name = 'Free Trial' 
    AND NOT EXISTS (SELECT 1 FROM credit_packages WHERE is_default = true)
  `);

  console.log("Migration 017_create_admin_system completed");
}

export async function down(): Promise<void> {
  console.log("Rolling back migration: 017_create_admin_system");
  
  await pool.query(`DROP TABLE IF EXISTS referral_usage CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS referral_links CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS coupon_usage CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS coupons CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS credit_transactions CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS user_credits CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS package_features CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS credit_pricing CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS feature_credit_costs CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS credit_packages CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS admin_users CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS integration_settings CASCADE`);

  console.log("Rollback 017_create_admin_system completed");
}
