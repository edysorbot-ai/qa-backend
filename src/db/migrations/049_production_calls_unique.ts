/**
 * Add a unique constraint on (provider_call_id, agent_id) for production_calls.
 * Required for ON CONFLICT upsert in call-polling.service.ts (race-safe).
 */
import { query } from '../index';

export async function addProductionCallsUnique(): Promise<void> {
  console.log('🔄 Adding unique constraint on production_calls(provider_call_id, agent_id)...');
  // First, drop duplicates keeping earliest row
  await query(`
    DELETE FROM production_calls a USING production_calls b
    WHERE a.id > b.id
      AND a.provider_call_id = b.provider_call_id
      AND a.agent_id = b.agent_id;
  `).catch((e) => console.warn('[mig 049] dedup skip:', e?.message));

  await query(`
    ALTER TABLE production_calls
    ADD CONSTRAINT production_calls_provider_call_id_agent_id_key
    UNIQUE (provider_call_id, agent_id)
  `).catch((e) => console.warn('[mig 049] add unique skip (already exists?):', e?.message));

  console.log('✅ Migration 049 done');
}
