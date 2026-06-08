/**
 * Item 18: low-cost monitoring controls.
 *
 * Adds:
 *   - monitored_agents.sampling_rate FLOAT DEFAULT 1.0  (fraction of inbound
 *     calls to send through full analysis; 1.0 = every call, 0.1 = 10%).
 *   - monitored_agents.signal_filters JSONB DEFAULT '{}'  (optional pre-LLM
 *     keyword/regex filters that decide whether a call qualifies for
 *     analysis — e.g. only analyse calls containing "refund").
 *
 * Together these reduce per-call inference cost by ~10x for high-volume
 * agents while still surfacing every escalation-worthy interaction.
 */

import { Pool } from 'pg';

export async function addMonitoringSamplingControls(pool: Pool) {
  await pool.query(`
    ALTER TABLE monitored_agents
      ADD COLUMN IF NOT EXISTS sampling_rate REAL DEFAULT 1.0 CHECK (sampling_rate >= 0 AND sampling_rate <= 1.0),
      ADD COLUMN IF NOT EXISTS signal_filters JSONB DEFAULT '{}'::jsonb
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_monitored_agents_sampling
      ON monitored_agents(sampling_rate)
  `);
  // Item 24: add PagerDuty routing key to alert_settings
  await pool.query(`
    ALTER TABLE alert_settings
      ADD COLUMN IF NOT EXISTS pagerduty_routing_key TEXT
  `);
}

export async function down(pool: Pool) {
  await pool.query(`
    ALTER TABLE monitored_agents
      DROP COLUMN IF EXISTS sampling_rate,
      DROP COLUMN IF EXISTS signal_filters
  `);
  await pool.query(`
    ALTER TABLE alert_settings
      DROP COLUMN IF EXISTS pagerduty_routing_key
  `);
}
