import pool from '../db';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface Booking {
  id: string;
  guest_name: string;
  guest_email: string;
  guest_company?: string;
  guest_message?: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  timezone: string;
  duration_minutes: number;
  google_event_id?: string;
  google_meet_link?: string;
  calendar_event_created: boolean;
  confirmation_email_sent: boolean;
  reminder_email_sent: boolean;
  status: 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  cancelled_at?: Date;
  cancellation_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateBookingDTO {
  guest_name: string;
  guest_email: string;
  guest_company?: string;
  guest_message?: string;
  booking_date: string;  // YYYY-MM-DD
  start_time: string;    // HH:MM
  timezone?: string;
  duration_minutes?: number;
}

export interface BookingAvailability {
  id: string;
  day_of_week: number; // 0=Sunday, 6=Saturday
  start_hour: number;
  end_hour: number;
  is_available: boolean;
  timezone: string;
}

export interface TimeSlot {
  time: string;       // HH:MM format
  display: string;    // "09:00 AM" format
  available: boolean;
}

// ─── Model ────────────────────────────────────────────────────────────────────

export class BookingModel {

  /**
   * Create a new booking
   */
  static async create(data: CreateBookingDTO): Promise<Booking> {
    const duration = data.duration_minutes || 60;
    const [hours, minutes] = data.start_time.split(':').map(Number);
    const endHour = hours + Math.floor(duration / 60);
    const endMinute = minutes + (duration % 60);
    const endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`;

    const result = await pool.query(
      `INSERT INTO bookings (guest_name, guest_email, guest_company, guest_message, booking_date, start_time, end_time, timezone, duration_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed')
       RETURNING *`,
      [
        data.guest_name,
        data.guest_email,
        data.guest_company || null,
        data.guest_message || null,
        data.booking_date,
        data.start_time,
        endTime,
        data.timezone || 'Asia/Kolkata',
        duration,
      ]
    );
    return result.rows[0];
  }

  /**
   * Get a booking by ID
   */
  static async findById(id: string): Promise<Booking | null> {
    const result = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  /**
   * Get all bookings for a specific date
   */
  static async findByDate(date: string): Promise<Booking[]> {
    const result = await pool.query(
      `SELECT * FROM bookings WHERE booking_date = $1 AND status != 'cancelled' ORDER BY start_time ASC`,
      [date]
    );
    return result.rows;
  }

  /**
   * Get bookings by email
   */
  static async findByEmail(email: string): Promise<Booking[]> {
    const result = await pool.query(
      `SELECT * FROM bookings WHERE guest_email = $1 ORDER BY booking_date DESC, start_time DESC`,
      [email]
    );
    return result.rows;
  }

  /**
   * Update Google Calendar event details on a booking
   */
  static async updateCalendarEvent(
    bookingId: string,
    googleEventId: string,
    meetLink: string
  ): Promise<Booking | null> {
    const result = await pool.query(
      `UPDATE bookings 
       SET google_event_id = $1, google_meet_link = $2, calendar_event_created = true, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [googleEventId, meetLink, bookingId]
    );
    return result.rows[0] || null;
  }

  /**
   * Mark confirmation email as sent
   */
  static async markEmailSent(bookingId: string): Promise<void> {
    await pool.query(
      `UPDATE bookings SET confirmation_email_sent = true, updated_at = NOW() WHERE id = $1`,
      [bookingId]
    );
  }

  /**
   * Cancel a booking
   */
  static async cancel(bookingId: string, reason?: string): Promise<Booking | null> {
    const result = await pool.query(
      `UPDATE bookings 
       SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reason || null, bookingId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get availability config for all days
   */
  static async getAvailability(): Promise<BookingAvailability[]> {
    const result = await pool.query(
      `SELECT * FROM booking_availability ORDER BY day_of_week ASC`
    );
    return result.rows;
  }

  /**
   * Check if a specific time slot is already booked for a date
   */
  static async isSlotBooked(date: string, startTime: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM bookings 
       WHERE booking_date = $1 AND start_time = $2 AND status != 'cancelled'`,
      [date, startTime]
    );
    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Get available time slots for a specific date
   */
  static async getAvailableSlots(date: string): Promise<TimeSlot[]> {
    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); // 0=Sun, 6=Sat

    // Get availability config for this day
    const availResult = await pool.query(
      `SELECT * FROM booking_availability WHERE day_of_week = $1 AND is_available = true`,
      [dayOfWeek]
    );

    if (availResult.rows.length === 0) {
      return []; // No availability for this day
    }

    const avail = availResult.rows[0];

    // Get existing bookings for this date
    const bookedResult = await pool.query(
      `SELECT start_time FROM bookings WHERE booking_date = $1 AND status != 'cancelled'`,
      [date]
    );
    const bookedTimes = new Set(
      bookedResult.rows.map((r: any) => r.start_time.substring(0, 5)) // "HH:MM"
    );

    // Generate time slots within availability window
    const slots: TimeSlot[] = [];
    for (let hour = avail.start_hour; hour < avail.end_hour; hour++) {
      const timeStr = `${String(hour).padStart(2, '0')}:00`;
      const period = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const display = `${String(displayHour).padStart(2, '0')}:00 ${period}`;

      // Check if this slot is in the past (for today's date)
      const now = new Date();
      const isToday = dateObj.toDateString() === now.toDateString();
      const isPast = isToday && hour <= now.getHours();

      slots.push({
        time: timeStr,
        display,
        available: !bookedTimes.has(timeStr) && !isPast,
      });
    }

    return slots;
  }

  /**
   * Get all bookings (admin)
   */
  static async findAll(limit = 50, offset = 0): Promise<{ bookings: Booking[]; total: number }> {
    const countResult = await pool.query('SELECT COUNT(*) FROM bookings');
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT * FROM bookings ORDER BY booking_date DESC, start_time DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { bookings: result.rows, total };
  }
}
