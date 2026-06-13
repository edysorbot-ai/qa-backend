/**
 * Adds:
 *  - outage_checks: per-provider periodic health check history (powers
 *    the status-page UI with 90-day uptime grid).
 *  - rlaif_runs: scheduled "review failing conversations" digest with
 *    categorised root causes + recommendations.
 *  - agent_consumption: per-day rollup of test+production token/cost/
 *    minute consumption per agent.
 */

import { Pool } from 'pg';

export async function up(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outage_checks (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      integration_id UUID,
      provider TEXT NOT NULL,
      check_type TEXT NOT NULL DEFAULT 'health',
      status TEXT NOT NULL,
      http_status INT,
      latency_ms INT,
      error TEXT,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outage_user_provider_time ON outage_checks(user_id, provider, checked_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rlaif_runs (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      agent_id UUID,
      scope TEXT NOT NULL DEFAULT 'all',
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      total_evaluated INT DEFAULT 0,
      total_failed INT DEFAULT 0,
      categories JSONB DEFAULT '[]'::jsonb,
      recommendations JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rlaif_user_time ON rlaif_runs(user_id, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_consumption (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      agent_id UUID,
      day DATE NOT NULL,
      llm_tokens_in BIGINT DEFAULT 0,
      llm_tokens_out BIGINT DEFAULT 0,
      llm_cost_cents BIGINT DEFAULT 0,
      minutes REAL DEFAULT 0,
      calls INT DEFAULT 0,
      credits_used INT DEFAULT 0,
      UNIQUE (user_id, agent_id, day)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_consumption_user_day ON agent_consumption(user_id, day DESC)`);
}

export async function down(pool: Pool) {
  await pool.query(`DROP TABLE IF EXISTS outage_checks`);
  await pool.query(`DROP TABLE IF EXISTS rlaif_runs`);
  await pool.query(`DROP TABLE IF EXISTS agent_consumption`);
}
