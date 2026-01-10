import { pool } from "../index";

export async function up(): Promise<void> {
  console.log("Running migration: 016_add_schedule_end_options");
  
  // Add columns for schedule end options
  const queries = [
    // Add ends_type column with default 'never'
    `ALTER TABLE scheduled_tests 
     ADD COLUMN IF NOT EXISTS ends_type VARCHAR(20) DEFAULT 'never' 
     CHECK (ends_type IN ('never', 'on', 'after'))`,
    
    // Add ends_on_date column for "on" type (end on specific date)
    `ALTER TABLE scheduled_tests 
     ADD COLUMN IF NOT EXISTS ends_on_date DATE`,
    
    // Add ends_after_occurrences column for "after" type (end after X runs)
    `ALTER TABLE scheduled_tests 
     ADD COLUMN IF NOT EXISTS ends_after_occurrences INTEGER`,
    
    // Add completed_occurrences column to track completed runs
    `ALTER TABLE scheduled_tests 
     ADD COLUMN IF NOT EXISTS completed_occurrences INTEGER DEFAULT 0`,
  ];

  for (const query of queries) {
    try {
      await pool.query(query);
      console.log("Successfully executed:", query.substring(0, 50) + "...");
    } catch (error: any) {
      // Ignore error if column already exists
      if (error.code !== "42701") {
        throw error;
      }
      console.log("Column already exists, skipping...");
    }
  }

  console.log("Migration 016_add_schedule_end_options completed");
}

export async function down(): Promise<void> {
  console.log("Rolling back migration: 016_add_schedule_end_options");
  
  const queries = [
    `ALTER TABLE scheduled_tests DROP COLUMN IF EXISTS ends_type`,
    `ALTER TABLE scheduled_tests DROP COLUMN IF EXISTS ends_on_date`,
    `ALTER TABLE scheduled_tests DROP COLUMN IF EXISTS ends_after_occurrences`,
    `ALTER TABLE scheduled_tests DROP COLUMN IF EXISTS completed_occurrences`,
  ];

  for (const query of queries) {
    await pool.query(query);
  }

  console.log("Rollback 016_add_schedule_end_options completed");
}
