import { Pool } from 'pg';

/**
 * t17 — additional escalation channels + master notification toggle.
 *
 * Adds to alert_settings:
 *   - teams_webhook_url     TEXT   (Microsoft Teams incoming webhook)
 *   - whatsapp_webhook_url  TEXT   (generic WhatsApp relay endpoint; receives a
 *                                   JSON { text } POST — works with Twilio/360dialog
 *                                   style relays or a custom bridge)
 *   - escalation_enabled    BOOLEAN DEFAULT true (master on/off switch so a user
 *                                   can silence all escalations without losing config)
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE alert_settings
      ADD COLUMN IF NOT EXISTS teams_webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS whatsapp_webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS escalation_enabled BOOLEAN NOT NULL DEFAULT true
  `);
  console.log('[Migration 046] alert_settings escalation channels ready');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE alert_settings
      DROP COLUMN IF EXISTS teams_webhook_url,
      DROP COLUMN IF EXISTS whatsapp_webhook_url,
      DROP COLUMN IF EXISTS escalation_enabled
  `);
}
