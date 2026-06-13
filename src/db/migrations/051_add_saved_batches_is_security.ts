import { query } from '../index';

/**
 * Adds an `is_security` boolean to saved_batches so security and regular
 * batches can be distinguished and toggled in the UI.
 */
export async function addSavedBatchesIsSecurity(): Promise<void> {
  await query(`
    ALTER TABLE saved_batches
      ADD COLUMN IF NOT EXISTS is_security BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_saved_batches_is_security
      ON saved_batches(is_security)
  `);
  // Backfill: any batch whose name explicitly mentions "Security" should be
  // flagged. Safe to re-run because we only flip false → true.
  await query(`
    UPDATE saved_batches
      SET is_security = TRUE
      WHERE is_security = FALSE
        AND name ILIKE '%security%'
  `);
}
