import { Request, Response } from 'express';
import { bookingService } from '../services/booking.service';
import { BookingModel } from '../models/booking.model';

/**
 * Booking Controller
 * All endpoints are PUBLIC (no auth required) since anyone can book a demo.
 */
export class BookingController {

  /**
   * GET /api/booking/availability?date=2026-02-10
   * Get available time slots for a specific date
   */
  async getAvailableSlots(req: Request, res: Response) {
    try {
      const { date } = req.query;

      if (!date || typeof date !== 'string') {
        return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      }

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }

      // Don't allow past dates
      const dateObj = new Date(date + 'T00:00:00');
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (dateObj < today) {
        return res.status(400).json({ error: 'Cannot check availability for past dates' });
      }

      const slots = await bookingService.getAvailableSlots(date);
      res.json({ date, slots });
    } catch (error: any) {
      console.error('[BookingController] getAvailableSlots error:', error.message);
      res.status(500).json({ error: 'Failed to fetch available slots' });
    }
  }

  /**
   * GET /api/booking/weekly-availability
   * Get availability configuration for the whole week (which days/hours are open)
   */
  async getWeeklyAvailability(req: Request, res: Response) {
    try {
      const availability = await bookingService.getWeeklyAvailability();
      res.json({ availability });
    } catch (error: any) {
      console.error('[BookingController] getWeeklyAvailability error:', error.message);
      res.status(500).json({ error: 'Failed to fetch weekly availability' });
    }
  }

  /**
   * POST /api/booking
   * Create a new booking (with Google Calendar + email)
   */
  async createBooking(req: Request, res: Response) {
    try {
      const { name, email, company, message, date, time, timezone, duration } = req.body;

      // Validate required fields
      if (!name || !email || !date || !time) {
        return res.status(400).json({
          error: 'Missing required fields: name, email, date, time',
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Validate date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }

      // Validate time (HH:MM)
      if (!/^\d{2}:\d{2}$/.test(time)) {
        return res.status(400).json({ error: 'Invalid time format. Use HH:MM (24-hour)' });
      }

      const result = await bookingService.createBooking({
        guest_name: name,
        guest_email: email,
        guest_company: company,
        guest_message: message,
        booking_date: date,
        start_time: time,
        timezone: timezone || 'Asia/Kolkata',
        duration_minutes: duration || 60,
      });

      res.status(201).json({
        success: true,
        booking: {
          id: result.booking.id,
          date: result.booking.booking_date,
          start_time: result.booking.start_time,
          end_time: result.booking.end_time,
          duration: result.booking.duration_minutes,
          status: result.booking.status,
          google_meet_link: result.meetLink,
          email_sent: result.emailSent,
        },
        meetLink: result.meetLink,
        emailSent: result.emailSent,
        message: 'Demo booked successfully! Check your email for the meeting link.',
      });
    } catch (error: any) {
      console.error('[BookingController] createBooking error:', error.message);

      // Handle "slot already taken" gracefully
      if (error.message?.includes('no longer available')) {
        return res.status(409).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to create booking' });
    }
  }

  /**
   * GET /api/booking/:id
   * Get booking details by ID
   */
  async getBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const booking = await BookingModel.findById(id);

      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      res.json({ booking });
    } catch (error: any) {
      console.error('[BookingController] getBooking error:', error.message);
      res.status(500).json({ error: 'Failed to fetch booking' });
    }
  }

  /**
   * POST /api/booking/:id/cancel
   * Cancel a booking
   */
  async cancelBooking(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { reason } = req.body;

      const booking = await bookingService.cancelBooking(id, reason);
      if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
      }

      res.json({
        success: true,
        booking,
        message: 'Booking has been cancelled.',
      });
    } catch (error: any) {
      console.error('[BookingController] cancelBooking error:', error.message);
      res.status(500).json({ error: 'Failed to cancel booking' });
    }
  }
}

export const bookingController = new BookingController();
