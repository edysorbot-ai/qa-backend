import { Pool } from 'pg';

/**
 * Item 17 of Phase 1 roadmap — Agent lifecycle stages.
 *
 * agent.status today is 'active' | 'inactive' (deployment/disabled state).
 * We add a *lifecycle_stage* column so the platform can run evals appropriately
 * for each maturity tier:
 *   - development: light eval, no failure escalation
 *   - qa: full eval, failures alert team
 *   - uat: regression + adversarial, failures BLOCK promotion
 *   - production: continuous monitoring, failures = incident
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS lifecycle_stage VARCHAR(20) NOT NULL DEFAULT 'development';
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_lifecycle_stage_chk') THEN
        ALTER TABLE agents
          ADD CONSTRAINT agents_lifecycle_stage_chk
          CHECK (lifecycle_stage IN ('development','qa','uat','production'));
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_agents_lifecycle_stage ON agents(lifecycle_stage);
  `);
  console.log('[Migration 041] agents.lifecycle_stage column ready');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_lifecycle_stage_chk;`);
  await pool.query(`DROP INDEX IF EXISTS idx_agents_lifecycle_stage;`);
  await pool.query(`ALTER TABLE agents DROP COLUMN IF EXISTS lifecycle_stage;`);
}
