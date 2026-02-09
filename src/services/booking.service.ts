/**
 * Booking Service
 * 
 * Orchestrates the entire booking flow:
 *  1. Check availability
 *  2. Create booking record
 *  3. Create Google Calendar event with Meet link
 *  4. Send confirmation email with Meet link via SMTP
 */

import { BookingModel, CreateBookingDTO, Booking, TimeSlot } from '../models/booking.model';
import { googleCalendarService } from './googleCalendar.service';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

class BookingService {
  private transporter: nodemailer.Transporter | null = null;
  private useGmailApi = false;

  constructor() {
    this.initializeSmtp();
  }

  private initializeSmtp() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT || '465');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (smtpHost && smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: {
          rejectUnauthorized: false,
        },
      });
      console.log(`[BookingService] SMTP transporter initialized (${smtpHost}:${smtpPort})`);
    } else if (googleCalendarService.isConfigured()) {
      // Fallback: use Gmail API over HTTPS (no SMTP ports needed)
      this.useGmailApi = true;
      console.log('[BookingService] Email via Gmail API (no SMTP configured)');
    } else {
      console.warn('[BookingService] Email disabled - no SMTP or Google credentials configured');
    }
  }

  // ─── Availability ─────────────────────────────────────────────────────────

  /**
   * Get available time slots for a given date
   */
  async getAvailableSlots(date: string): Promise<TimeSlot[]> {
    return BookingModel.getAvailableSlots(date);
  }

  /**
   * Get availability config for the whole week
   */
  async getWeeklyAvailability() {
    return BookingModel.getAvailability();
  }

  // ─── Booking Flow ─────────────────────────────────────────────────────────

  /**
   * Complete booking flow:
   *  1. Validate slot is available
   *  2. Create booking record in DB
   *  3. Create Google Calendar event with Meet link
   *  4. Send confirmation email
   */
  async createBooking(data: CreateBookingDTO): Promise<{
    booking: Booking;
    meetLink: string | null;
    emailSent: boolean;
  }> {
    // 1. Check if slot is still available
    const isBooked = await BookingModel.isSlotBooked(data.booking_date, data.start_time);
    if (isBooked) {
      throw new Error('This time slot is no longer available. Please select a different time.');
    }

    // 2. Create booking record
    const booking = await BookingModel.create(data);
    console.log('[BookingService] ✅ Booking created:', booking.id);

    let meetLink: string | null = null;
    let emailSent = false;

    // 3. Create Google Calendar event with Meet link
    if (googleCalendarService.isConfigured()) {
      try {
        const startDateTime = this.buildISODateTime(
          data.booking_date,
          data.start_time,
          data.timezone || 'Asia/Kolkata'
        );
        const duration = data.duration_minutes || 60;
        const endDateTime = this.addMinutesToISO(startDateTime, duration);

        console.log('[BookingService] Calendar event times:', { startDateTime, endDateTime, duration });

        const calendarResult = await googleCalendarService.createMeetingEvent({
          summary: `STABLR Platform Demo - ${data.guest_name}`,
          description: this.buildEventDescription(data),
          startDateTime,
          endDateTime,
          attendeeEmail: data.guest_email,
          attendeeName: data.guest_name,
          timezone: data.timezone || 'Asia/Kolkata',
        });

        if (calendarResult) {
          meetLink = calendarResult.meetLink;
          await BookingModel.updateCalendarEvent(
            booking.id,
            calendarResult.eventId,
            calendarResult.meetLink
          );
          console.log('[BookingService] ✅ Calendar event created with Meet link:', meetLink);
        }
      } catch (error) {
        console.error('[BookingService] Calendar event creation failed (booking still valid):', error);
      }
    } else {
      console.warn('[BookingService] Google Calendar not configured - skipping Meet link generation');
    }

    // 4. Send confirmation email
    try {
      emailSent = await this.sendConfirmationEmail(booking, meetLink);
      if (emailSent) {
        await BookingModel.markEmailSent(booking.id);
      }
    } catch (error) {
      console.error('[BookingService] Confirmation email failed (booking still valid):', error);
    }

    // Return updated booking
    const updatedBooking = await BookingModel.findById(booking.id);

    return {
      booking: updatedBooking || booking,
      meetLink,
      emailSent,
    };
  }

  // ─── Cancel ───────────────────────────────────────────────────────────────

  async cancelBooking(bookingId: string, reason?: string): Promise<Booking | null> {
    const booking = await BookingModel.findById(bookingId);
    if (!booking) return null;

    // Cancel Google Calendar event if it exists
    if (booking.google_event_id && googleCalendarService.isConfigured()) {
      await googleCalendarService.cancelEvent(booking.google_event_id);
    }

    return BookingModel.cancel(bookingId, reason);
  }

  // ─── Email ────────────────────────────────────────────────────────────────

  private async sendConfirmationEmail(booking: Booking, meetLink: string | null): Promise<boolean> {
    if (!this.transporter && !this.useGmailApi) {
      console.warn('[BookingService] Cannot send email - no email transport configured');
      return false;
    }

    const dateFormatted = new Date(booking.booking_date).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const startHour = parseInt(booking.start_time.split(':')[0]);
    const period = startHour >= 12 ? 'PM' : 'AM';
    const displayHour = startHour === 0 ? 12 : startHour > 12 ? startHour - 12 : startHour;
    const timeFormatted = `${displayHour}:00 ${period}`;

    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@stablr.ai';
    const subject = `STABLR - Demo Booking Confirmed | ${dateFormatted} at ${timeFormatted}`;
    const html = this.generateConfirmationHtml({
      guestName: booking.guest_name,
      date: dateFormatted,
      time: timeFormatted,
      duration: booking.duration_minutes,
      meetLink,
      bookingId: booking.id,
    });

    // Try SMTP first
    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: fromEmail,
          to: booking.guest_email,
          subject,
          html,
        });
        console.log('[BookingService] ✅ Email sent via SMTP to:', booking.guest_email);
        return true;
      } catch (smtpError: any) {
        console.warn('[BookingService] SMTP failed:', smtpError.code || smtpError.message);
        // Fall through to Gmail API
      }
    }

    // Fallback: Gmail API over HTTPS (works even when SMTP ports are blocked)
    try {
      return await this.sendViaGmailApi(booking.guest_email, fromEmail, subject, html);
    } catch (gmailError: any) {
      console.error('[BookingService] Gmail API also failed:', gmailError.message);
      return false;
    }
  }

  /**
   * Send email via Gmail API (HTTPS, port 443 — never blocked by cloud providers)
   */
  private async sendViaGmailApi(to: string, from: string, subject: string, html: string): Promise<boolean> {
    const oauth2Client = googleCalendarService.getOAuth2Client();
    if (!oauth2Client) {
      console.warn('[BookingService] Gmail API unavailable - no OAuth2 client');
      return false;
    }

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build RFC 2822 MIME message with RFC 2047 encoded subject for non-ASCII safety
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: STABLR <${from}>`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ];
    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64url');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });

    console.log('[BookingService] ✅ Email sent via Gmail API to:', to);
    return true;
  }

  private generateConfirmationHtml(params: {
    guestName: string;
    date: string;
    time: string;
    duration: number;
    meetLink: string | null;
    bookingId: string;
  }): string {
    const meetSection = params.meetLink
      ? `
        <tr>
          <td style="padding: 0 40px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8f9fc; border: 1px solid #e2e4ea; border-radius: 8px;">
              <tr>
                <td style="padding: 24px; text-align: center;">
                  <p style="margin: 0 0 16px; font-size: 13px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Meeting Link</p>
                  <a href="${params.meetLink}" 
                     style="display: inline-block; background: #111827; color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 6px; font-weight: 600; font-size: 14px; letter-spacing: 0.02em;">
                    Join Google Meet
                  </a>
                  <p style="margin: 14px 0 0; font-size: 12px; color: #9ca3af;">
                    <a href="${params.meetLink}" style="color: #6b7280; text-decoration: underline;">${params.meetLink}</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `
      : `
        <tr>
          <td style="padding: 0 40px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background: #fffbf5; border: 1px solid #e8dcc8; border-radius: 8px;">
              <tr>
                <td style="padding: 20px; text-align: center;">
                  <p style="margin: 0; font-size: 14px; color: #78716c;">A meeting link will be shared with you before the demo.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Booking Confirmation</title>
      </head>
      <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 48px 16px;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">

                <!-- Logo Header -->
                <tr>
                  <td style="background: #111827; padding: 32px 40px; border-radius: 12px 12px 0 0; text-align: center;">
                    <span style="font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: 0.15em;">STABLR</span>
                  </td>
                </tr>

                <!-- Main Content -->
                <tr>
                  <td style="background: #ffffff; padding: 0;">
                    <table width="100%" cellpadding="0" cellspacing="0">

                      <!-- Confirmation Banner -->
                      <tr>
                        <td style="padding: 40px 40px 8px; text-align: center;">
                          <p style="display: inline-block; background: #ecfdf5; color: #065f46; font-size: 13px; font-weight: 600; padding: 6px 16px; border-radius: 20px; margin: 0; letter-spacing: 0.02em;">BOOKING CONFIRMED</p>
                        </td>
                      </tr>

                      <!-- Greeting -->
                      <tr>
                        <td style="padding: 24px 40px 8px;">
                          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">Hi ${params.guestName},</p>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 0 40px 28px;">
                          <p style="margin: 0; font-size: 15px; color: #374151; line-height: 1.6;">Your STABLR platform demo has been successfully scheduled. Here are the details:</p>
                        </td>
                      </tr>

                      <!-- Details Table -->
                      <tr>
                        <td style="padding: 0 40px 28px;">
                          <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                            <tr style="background: #f9fafb;">
                              <td style="padding: 14px 20px; font-size: 13px; color: #6b7280; font-weight: 500; border-bottom: 1px solid #e5e7eb; width: 120px;">Date</td>
                              <td style="padding: 14px 20px; font-size: 14px; color: #111827; font-weight: 600; border-bottom: 1px solid #e5e7eb;">${params.date}</td>
                            </tr>
                            <tr>
                              <td style="padding: 14px 20px; font-size: 13px; color: #6b7280; font-weight: 500; border-bottom: 1px solid #e5e7eb;">Time</td>
                              <td style="padding: 14px 20px; font-size: 14px; color: #111827; font-weight: 600; border-bottom: 1px solid #e5e7eb;">${params.time} (IST)</td>
                            </tr>
                            <tr style="background: #f9fafb;">
                              <td style="padding: 14px 20px; font-size: 13px; color: #6b7280; font-weight: 500; border-bottom: 1px solid #e5e7eb;">Duration</td>
                              <td style="padding: 14px 20px; font-size: 14px; color: #111827; font-weight: 600; border-bottom: 1px solid #e5e7eb;">${params.duration} minutes</td>
                            </tr>
                            <tr>
                              <td style="padding: 14px 20px; font-size: 13px; color: #6b7280; font-weight: 500;">Platform</td>
                              <td style="padding: 14px 20px; font-size: 14px; color: #111827; font-weight: 600;">Google Meet</td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      ${meetSection}

                      <!-- What to Expect -->
                      <tr>
                        <td style="padding: 0 40px 32px;">
                          <p style="margin: 0 0 14px; font-size: 15px; color: #111827; font-weight: 600;">What to Expect</p>
                          <table cellpadding="0" cellspacing="0" style="width: 100%;">
                            <tr><td style="padding: 6px 0; font-size: 14px; color: #4b5563; line-height: 1.5;"><span style="color: #9ca3af; margin-right: 8px;">—</span> Personalized walkthrough of the STABLR platform</td></tr>
                            <tr><td style="padding: 6px 0; font-size: 14px; color: #4b5563; line-height: 1.5;"><span style="color: #9ca3af; margin-right: 8px;">—</span> Live demo of AI voice agent testing</td></tr>
                            <tr><td style="padding: 6px 0; font-size: 14px; color: #4b5563; line-height: 1.5;"><span style="color: #9ca3af; margin-right: 8px;">—</span> Q&A session tailored to your use case</td></tr>
                            <tr><td style="padding: 6px 0; font-size: 14px; color: #4b5563; line-height: 1.5;"><span style="color: #9ca3af; margin-right: 8px;">—</span> Custom pricing discussion</td></tr>
                          </table>
                        </td>
                      </tr>

                    </table>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="background: #111827; padding: 28px 40px; border-radius: 0 0 12px 12px; text-align: center;">
                    <p style="margin: 0 0 6px; font-size: 12px; color: #9ca3af;">Booking ID: ${params.bookingId}</p>
                    <p style="margin: 0; font-size: 12px; color: #6b7280;">Need to reschedule? Reply to this email.</p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildISODateTime(date: string, time: string, timezone: string): string {
    // Build ISO string with timezone offset
    const offsetMap: Record<string, string> = {
      'Asia/Kolkata': '+05:30',
      'America/New_York': '-05:00',
      'America/Los_Angeles': '-08:00',
      'Europe/London': '+00:00',
      'UTC': '+00:00',
    };
    const offset = offsetMap[timezone] || '+05:30';
    return `${date}T${time}:00${offset}`;
  }

  private addMinutesToISO(isoString: string, minutes: number): string {
    const date = new Date(isoString);
    date.setMinutes(date.getMinutes() + minutes);

    // Preserve the original offset portion
    const offset = isoString.slice(-6);

    // Convert UTC time back to the target timezone's local time
    // by applying the offset before formatting with getUTC* methods
    const sign = offset[0] === '+' ? 1 : -1;
    const offsetHours = parseInt(offset.slice(1, 3));
    const offsetMinutes = parseInt(offset.slice(4, 6));
    const totalOffsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60 * 1000;
    const localDate = new Date(date.getTime() + totalOffsetMs);

    const pad = (n: number) => String(n).padStart(2, '0');
    return `${localDate.getUTCFullYear()}-${pad(localDate.getUTCMonth() + 1)}-${pad(localDate.getUTCDate())}T${pad(localDate.getUTCHours())}:${pad(localDate.getUTCMinutes())}:00${offset}`;
  }

  private buildEventDescription(data: CreateBookingDTO): string {
    let desc = `STABLR Platform Demo\n\n`;
    desc += `Guest: ${data.guest_name}\n`;
    desc += `Email: ${data.guest_email}\n`;
    if (data.guest_company) desc += `Company: ${data.guest_company}\n`;
    if (data.guest_message) desc += `\nNotes: ${data.guest_message}\n`;
    desc += `\nBooked via STABLR booking system.`;
    return desc;
  }
}

export const bookingService = new BookingService();
