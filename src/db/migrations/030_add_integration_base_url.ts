/**
 * Migration: Add base_url column to integrations table
 * 
 * Allows users to specify a custom base URL for providers like ElevenLabs
 * that have region-specific domains (e.g., elevenlabs.in for India).
 */

import pool from '../../db';

export async function addIntegrationBaseUrl(): Promise<void> {
  const client = await pool.connect();
  
  try {
    console.log('[Migration] Adding base_url column to integrations...');

    // Add base_url column - nullable, NULL means use default provider URL
    await client.query(`
      ALTER TABLE integrations 
      ADD COLUMN IF NOT EXISTS base_url TEXT DEFAULT NULL
    `);

    console.log('[Migration] ✅ base_url column added to integrations');
  } catch (error: any) {
    if (error.code === '42701') {
      // Column already exists
      console.log('[Migration] base_url column already exists, skipping');
    } else {
      console.error('[Migration] Error adding base_url column:', error.message);
    }
  } finally {
    client.release();
  }
}
