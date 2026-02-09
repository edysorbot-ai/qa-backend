/**
 * Migration: Create bookings table
 * 
 * Creates tables for demo booking system:
 * - bookings: Stores all demo booking records
 * - booking_availability: Admin-configurable availability windows
 */

import pool from '../../db';

export async function createBookingsTable(): Promise<void> {
  const client = await pool.connect();
  
  try {
    console.log('[Migration] Creating bookings tables...');

    // Booking availability configuration (admin can set working hours)
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_availability (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
        start_hour INTEGER NOT NULL CHECK (start_hour >= 0 AND start_hour <= 23),
        end_hour INTEGER NOT NULL CHECK (end_hour >= 0 AND end_hour <= 23),
        is_available BOOLEAN DEFAULT true,
        timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(day_of_week)
      );
    `);

    // Insert default availability: Mon-Fri 9AM-6PM, Sat 10AM-2PM
    await client.query(`
      INSERT INTO booking_availability (day_of_week, start_hour, end_hour, is_available)
      VALUES 
        (0, 10, 18, true),
        (1, 9, 18, true),
        (2, 9, 18, true),
        (3, 9, 18, true),
        (4, 9, 18, true),
        (5, 9, 18, true),
        (6, 10, 14, true)
      ON CONFLICT (day_of_week) DO NOTHING;
    `);

    // Bookings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        
        -- Guest info (public booking, no auth required)
        guest_name VARCHAR(255) NOT NULL,
        guest_email VARCHAR(255) NOT NULL,
        guest_company VARCHAR(255),
        guest_message TEXT,
        
        -- Booking details
        booking_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
        duration_minutes INTEGER DEFAULT 60,
        
        -- Google Calendar integration
        google_event_id VARCHAR(255),
        google_meet_link TEXT,
        calendar_event_created BOOLEAN DEFAULT false,
        
        -- Email tracking
        confirmation_email_sent BOOLEAN DEFAULT false,
        reminder_email_sent BOOLEAN DEFAULT false,
        
        -- Status
        status VARCHAR(50) DEFAULT 'confirmed',
        cancelled_at TIMESTAMP WITH TIME ZONE,
        cancellation_reason TEXT,
        
        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    // Indexes for fast lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(guest_email);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bookings_google_event ON bookings(google_event_id);
    `);

    console.log('[Migration] ✅ Bookings tables created successfully');
  } catch (error: any) {
    // Ignore "already exists" errors
    if (error.code !== '42P07' && !error.message?.includes('already exists')) {
      console.error('[Migration] Error creating bookings tables:', error.message);
    }
  } finally {
    client.release();
  }
}
