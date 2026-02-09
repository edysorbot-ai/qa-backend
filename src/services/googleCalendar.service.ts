/**
 * Google Calendar Service
 * 
 * Uses OAuth2 (Client ID + Client Secret + Refresh Token) to create
 * calendar events with Google Meet links on your personal/workspace calendar.
 * 
 * Required env vars:
 *   GOOGLE_CLIENT_ID        - OAuth2 Client ID (from Google Dev Console)
 *   GOOGLE_CLIENT_SECRET    - OAuth2 Client Secret (from Google Dev Console)
 *   GOOGLE_REFRESH_TOKEN    - OAuth2 Refresh Token (obtained via one-time consent flow at /api/google/auth)
 *   GOOGLE_CALENDAR_ID      - Calendar ID to create events in (default: "primary" = your main calendar)
 */

import { google, calendar_v3 } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

export class GoogleCalendarService {
  private calendar: calendar_v3.Calendar | null = null;
  private oauth2Client: InstanceType<typeof google.auth.OAuth2> | null = null;
  private calendarId: string;
  private initialized = false;

  constructor() {
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.initialize();
  }

  private initialize() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret) {
      console.warn('[GoogleCalendarService] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET - Calendar integration disabled');
      console.warn('[GoogleCalendarService] Set env vars to enable Google Calendar + Meet link generation');
      return;
    }

    if (!refreshToken) {
      console.warn('[GoogleCalendarService] Missing GOOGLE_REFRESH_TOKEN - visit /api/google/auth to authorize');
      console.warn('[GoogleCalendarService] After authorizing, set the GOOGLE_REFRESH_TOKEN env var and restart');
    }

    try {
      this.oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/google/callback'
      );

      if (refreshToken) {
        this.oauth2Client.setCredentials({ refresh_token: refreshToken });
        this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
        this.initialized = true;
        console.log('[GoogleCalendarService] ✅ Initialized with OAuth2 (Client ID + Refresh Token)');
      } else {
        console.log('[GoogleCalendarService] ⚠️ OAuth2 client created but no refresh token — auth flow needed');
      }
    } catch (error) {
      console.error('[GoogleCalendarService] Failed to initialize:', error);
    }
  }

  /**
   * Generate the Google OAuth2 consent URL (one-time setup)
   */
  getAuthUrl(): string | null {
    if (!this.oauth2Client) return null;
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
  }

  /**
   * Exchange authorization code for tokens (one-time setup)
   */
  async exchangeCode(code: string): Promise<string | null> {
    if (!this.oauth2Client) return null;
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      if (tokens.refresh_token) {
        // Set credentials so calendar works immediately
        this.oauth2Client.setCredentials(tokens);
        this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
        this.initialized = true;
        console.log('[GoogleCalendarService] ✅ OAuth2 tokens obtained — Calendar ready!');
        return tokens.refresh_token;
      }
      console.warn('[GoogleCalendarService] No refresh_token in response — try revoking app access and re-authorizing');
      return null;
    } catch (error: any) {
      console.error('[GoogleCalendarService] Token exchange failed:', error.message);
      return null;
    }
  }

  /**
   * Check if the service is properly configured
   */
  isConfigured(): boolean {
    return this.initialized && this.calendar !== null;
  }

  /**
   * Create a calendar event with Google Meet link
   */
  async createMeetingEvent(params: {
    summary: string;
    description: string;
    startDateTime: string;   // ISO 8601 e.g. "2026-02-10T09:00:00+05:30"
    endDateTime: string;     // ISO 8601
    attendeeEmail: string;
    attendeeName: string;
    timezone?: string;
  }): Promise<{
    eventId: string;
    meetLink: string;
    htmlLink: string;
  } | null> {
    if (!this.calendar) {
      console.warn('[GoogleCalendarService] Cannot create event - not configured');
      return null;
    }

    try {
      const event: calendar_v3.Schema$Event = {
        summary: params.summary,
        description: params.description,
        start: {
          dateTime: params.startDateTime,
          timeZone: params.timezone || 'Asia/Kolkata',
        },
        end: {
          dateTime: params.endDateTime,
          timeZone: params.timezone || 'Asia/Kolkata',
        },
        attendees: [
          { email: params.attendeeEmail, displayName: params.attendeeName },
        ],
        conferenceData: {
          createRequest: {
            requestId: `stablr-booking-${Date.now()}`,
            conferenceSolutionKey: {
              type: 'hangoutsMeet',
            },
          },
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 15 },
          ],
        },
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
      };

      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: event,
        conferenceDataVersion: 1,
        sendUpdates: 'none', // We send our own branded email via SMTP
      });

      const createdEvent = response.data;
      const meetLink = createdEvent.conferenceData?.entryPoints?.find(
        (ep) => ep.entryPointType === 'video'
      )?.uri || '';

      console.log('[GoogleCalendarService] ✅ Event created:', {
        eventId: createdEvent.id,
        meetLink,
        summary: createdEvent.summary,
      });

      return {
        eventId: createdEvent.id || '',
        meetLink: meetLink,
        htmlLink: createdEvent.htmlLink || '',
      };
    } catch (error: any) {
      console.error('[GoogleCalendarService] Failed to create event:', error.message);
      if (error.response?.data) {
        console.error('[GoogleCalendarService] API Error Details:', JSON.stringify(error.response.data));
      }
      return null;
    }
  }

  /**
   * Delete/cancel a calendar event
   */
  async cancelEvent(eventId: string): Promise<boolean> {
    if (!this.calendar) {
      console.warn('[GoogleCalendarService] Cannot cancel event - not configured');
      return false;
    }

    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId,
        sendUpdates: 'none',
      });
      console.log('[GoogleCalendarService] ✅ Event cancelled:', eventId);
      return true;
    } catch (error: any) {
      console.error('[GoogleCalendarService] Failed to cancel event:', error.message);
      return false;
    }
  }
}

// Singleton export
export const googleCalendarService = new GoogleCalendarService();
