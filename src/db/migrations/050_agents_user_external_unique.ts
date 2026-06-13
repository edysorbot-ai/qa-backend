/**
 * Prevent the same provider agent from being connected more than once per user.
 * UNIQUE (user_id, provider, external_agent_id) — partial index where external_agent_id IS NOT NULL
 * (custom agents have no external_agent_id, so they're excluded from the constraint).
 */
import { query } from '../index';

export async function addAgentsUserExternalUnique(): Promise<void> {
  console.log('🔄 Deduping agents + adding unique (user_id, provider, external_agent_id)...');

  await query(`
    DELETE FROM agents a USING agents b
    WHERE a.id > b.id
      AND a.user_id = b.user_id
      AND a.provider = b.provider
      AND a.external_agent_id IS NOT NULL
      AND b.external_agent_id IS NOT NULL
      AND a.external_agent_id = b.external_agent_id
  `).catch((e) => console.warn('[mig 050] dedup skip:', e?.message));

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_user_provider_external_unique
    ON agents (user_id, provider, external_agent_id)
    WHERE external_agent_id IS NOT NULL
  `).catch((e) => console.warn('[mig 050] index create skip:', e?.message));

  console.log('✅ Migration 050 done');
}
