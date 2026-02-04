import { query } from '../index';

export const addContextGrowthTracking = async () => {
  try {
    // Add token tracking columns to test_results table
    await query(`
      ALTER TABLE test_results 
      ADD COLUMN IF NOT EXISTS total_tokens_used INTEGER,
      ADD COLUMN IF NOT EXISTS max_context_size INTEGER,
      ADD COLUMN IF NOT EXISTS avg_context_growth DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS context_efficiency_score DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS bloat_detected BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS bloat_turn_number INTEGER
    `);

    // Create turn_token_metrics table for detailed per-turn tracking
    await query(`
      CREATE TABLE IF NOT EXISTS turn_token_metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_result_id UUID REFERENCES test_results(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        role VARCHAR(20) NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        cumulative_context_tokens INTEGER DEFAULT 0,
        growth_rate DECIMAL(5,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for efficient querying
    await query(`
      CREATE INDEX IF NOT EXISTS idx_turn_token_metrics_result_id 
      ON turn_token_metrics(test_result_id)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_turn_token_metrics_turn_number 
      ON turn_token_metrics(test_result_id, turn_number)
    `);

    console.log('✅ Context growth tracking tables created successfully');
  } catch (error) {
    console.error('❌ Error creating context growth tracking tables:', error);
    throw error;
  }
};

// Export for running directly
export default addContextGrowthTracking;
