/**
 * Migration: Add production monitoring feature costs
 * 
 * Adds credit costs for production monitoring features
 */

import { pool } from '../../db';

export async function addMonitoringFeatureCosts(): Promise<void> {
  const client = await pool.connect();
  
  try {
    console.log('[Migration] Adding production monitoring feature costs...');

    // Add production monitoring enable feature cost
    await client.query(`
      INSERT INTO feature_credit_costs (feature_key, feature_name, description, credit_cost, category, is_active)
      VALUES 
        ('production_monitoring_enable', 'Enable Production Monitoring', 'Enable production monitoring for an agent to track and analyze real calls', 50, 'monitoring', true),
        ('production_call_analyze', 'Analyze Production Call', 'AI-powered analysis of a production call for quality, compliance, and issues', 5, 'monitoring', true)
      ON CONFLICT (feature_key) DO UPDATE SET
        feature_name = EXCLUDED.feature_name,
        description = EXCLUDED.description,
        credit_cost = EXCLUDED.credit_cost,
        category = EXCLUDED.category
    `);

    console.log('[Migration] Production monitoring feature costs added successfully');
  } finally {
    client.release();
  }
}

export async function down(): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query(`
      DELETE FROM feature_credit_costs 
      WHERE feature_key IN ('production_monitoring_enable', 'production_call_analyze')
    `);
  } finally {
    client.release();
  }
}
