import nodemailer from 'nodemailer';
import { google } from 'googleapis';
import { config } from '../config';
import { FailedTestAlertPayload } from '../models/alertSettings.model';
import { alertSettingsService } from './alertSettings.service';
import { slackNotificationService } from './slackNotification.service';
import { googleCalendarService } from './googleCalendar.service';
import pool from '../db';

export class EmailNotificationService {
  private transporter: nodemailer.Transporter | null = null;
  private useGmailApi = false;

  constructor() {
    this.initializeTransporter();
  }

  private initializeTransporter() {
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
        tls: { rejectUnauthorized: false },
      });
      console.log(`[EmailNotificationService] SMTP transporter initialized (${smtpHost}:${smtpPort})`);
    } else if (googleCalendarService.isConfigured()) {
      this.useGmailApi = true;
      console.log('[EmailNotificationService] Email via Gmail API (no SMTP configured)');
    } else {
      console.warn('[EmailNotificationService] Email disabled - no SMTP or Google credentials');
    }
  }

  /**
   * Send email via Gmail API over HTTPS (works when SMTP ports are blocked)
   */
  private async sendViaGmailApi(to: string, from: string, subject: string, html: string): Promise<boolean> {
    const oauth2Client = googleCalendarService.getOAuth2Client();
    if (!oauth2Client) return false;

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
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
    const encodedMessage = Buffer.from(messageParts.join('\r\n')).toString('base64url');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage },
    });
    return true;
  }

  /**
   * Send email: SMTP first, fallback to Gmail API
   */
  private async sendEmailInternal(to: string, subject: string, html: string): Promise<boolean> {
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@stablr.ai';

    if (this.transporter) {
      try {
        await this.transporter.sendMail({ from: fromEmail, to, subject, html });
        console.log(`[EmailNotificationService] ✅ Email sent via SMTP to: ${to}`);
        return true;
      } catch (smtpErr: any) {
        console.warn('[EmailNotificationService] SMTP failed:', smtpErr.code || smtpErr.message);
      }
    }

    try {
      const sent = await this.sendViaGmailApi(to, fromEmail, subject, html);
      if (sent) {
        console.log(`[EmailNotificationService] ✅ Email sent via Gmail API to: ${to}`);
        return true;
      }
    } catch (gmailErr: any) {
      console.error('[EmailNotificationService] Gmail API also failed:', gmailErr.message);
    }

    return false;
  }

  /**
   * Send test failure alert email
   */
  async sendFailureAlert(payload: FailedTestAlertPayload, emails: string[]): Promise<boolean> {
    if (!this.transporter && !this.useGmailApi) {
      console.warn('[EmailNotificationService] Cannot send email - no transport configured');
      return false;
    }

    if (emails.length === 0) {
      console.warn('[EmailNotificationService] No email addresses to send to');
      return false;
    }

    try {
      const subject = `🚨 Test Failure Alert: ${payload.testRunName}`;
      const html = this.generateFailureAlertHtml(payload);

      const sent = await this.sendEmailInternal(emails.join(', '), subject, html);
      if (sent) {
        console.log(`[EmailNotificationService] Failure alert sent to: ${emails.join(', ')}`);
      }
      return sent;
    } catch (error) {
      console.error('[EmailNotificationService] Failed to send email:', error);
      return false;
    }
  }

  /**
   * Generate HTML email content for failure alert
   */
  private generateFailureAlertHtml(payload: FailedTestAlertPayload): string {
    const failedTestsHtml = payload.failedTests.map(test => `
      <tr style="background-color: #fef2f2;">
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          <strong>${test.testCaseName}</strong><br>
          <span style="color: #6b7280; font-size: 12px;">${test.category}</span>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          ${test.scenario}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          ${test.expectedOutcome}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #dc2626;">
          ${test.errorMessage || test.actualResponse || 'Test failed'}
        </td>
      </tr>
    `).join('');

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Test Failure Alert</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%); padding: 30px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">🚨 Test Failure Alert</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">
            ${payload.isScheduledRun ? 'Scheduled Test Run' : 'Test Run'} has failed tests
          </p>
        </div>

        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="margin: 0 0 15px 0; font-size: 18px; color: #111827;">Test Run Details</h2>
            <table style="width: 100%;">
              <tr>
                <td style="padding: 5px 0; color: #6b7280;">Test Run Name:</td>
                <td style="padding: 5px 0; font-weight: 600;">${payload.testRunName}</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #6b7280;">Agent:</td>
                <td style="padding: 5px 0; font-weight: 600;">${payload.agentName}</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #6b7280;">Provider:</td>
                <td style="padding: 5px 0; font-weight: 600;">${payload.provider}</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #6b7280;">Run Type:</td>
                <td style="padding: 5px 0; font-weight: 600;">${payload.isScheduledRun ? '📅 Scheduled' : '▶️ Manual'}</td>
              </tr>
              <tr>
                <td style="padding: 5px 0; color: #6b7280;">Time:</td>
                <td style="padding: 5px 0; font-weight: 600;">${new Date(payload.timestamp).toLocaleString()}</td>
              </tr>
            </table>
          </div>

          <div style="display: flex; gap: 15px; margin-bottom: 20px;">
            <div style="flex: 1; background: #f0fdf4; padding: 15px; border-radius: 8px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #16a34a;">${payload.summary.passed}</div>
              <div style="color: #6b7280; font-size: 14px;">Passed</div>
            </div>
            <div style="flex: 1; background: #fef2f2; padding: 15px; border-radius: 8px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #dc2626;">${payload.summary.failed}</div>
              <div style="color: #6b7280; font-size: 14px;">Failed</div>
            </div>
            <div style="flex: 1; background: #f3f4f6; padding: 15px; border-radius: 8px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #374151;">${payload.summary.total}</div>
              <div style="color: #6b7280; font-size: 14px;">Total</div>
            </div>
          </div>

          <h2 style="margin: 30px 0 15px 0; font-size: 18px; color: #111827;">Failed Tests</h2>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr style="background-color: #f3f4f6;">
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Test Case</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Scenario</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Expected</th>
                <th style="padding: 12px; text-align: left; border-bottom: 2px solid #e5e7eb;">Issue</th>
              </tr>
            </thead>
            <tbody>
              ${failedTestsHtml}
            </tbody>
          </table>

          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
            <p>This is an automated notification from STABLR Platform.</p>
            <p>Test Run ID: ${payload.testRunId}</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Check if a user should receive failure alerts and send if needed
   */
  async notifyUserOfTestFailure(userId: string, payload: FailedTestAlertPayload): Promise<boolean> {
    console.log(`[EmailNotificationService] ========== NOTIFYING USER ==========`);
    console.log(`[EmailNotificationService] User ID: ${userId}`);
    console.log(`[EmailNotificationService] Is Scheduled Run: ${payload.isScheduledRun}`);
    console.log(`[EmailNotificationService] Failed Tests Count: ${payload.failedTests.length}`);
    
    try {
      const alertSettings = await alertSettingsService.getEnabledAlertSettingsForUser(userId);
      
      console.log(`[EmailNotificationService] Alert Settings:`, alertSettings ? {
        enabled: alertSettings.enabled,
        notify_on_test_failure: alertSettings.notify_on_test_failure,
        notify_on_scheduled_failure: alertSettings.notify_on_scheduled_failure,
        email_configs: alertSettings.email_configs,
        email_addresses: alertSettings.email_addresses
      } : 'NOT FOUND OR DISABLED');
      
      if (!alertSettings) {
        console.log(`[EmailNotificationService] No alert settings or alerts disabled for user ${userId}`);
        return false;
      }

      // Check if we should notify based on run type
      if (payload.isScheduledRun && !alertSettings.notify_on_scheduled_failure) {
        console.log(`[EmailNotificationService] Scheduled failure notifications disabled for user ${userId}`);
        return false;
      }

      if (!payload.isScheduledRun && !alertSettings.notify_on_test_failure) {
        console.log(`[EmailNotificationService] Test failure notifications disabled for user ${userId}`);
        return false;
      }

      // Get enabled email addresses from email_configs
      // email_configs contains objects like { email, enabled, type, name }
      const emailConfigs = alertSettings.email_configs || [];
      const emails = emailConfigs
        .filter((config: any) => config.enabled)
        .map((config: any) => config.email);
      
      // Also check legacy email_addresses field as fallback
      if (emails.length === 0 && alertSettings.email_addresses?.length > 0) {
        emails.push(...alertSettings.email_addresses);
      }
      
      let emailSent = false;
      let slackSent = false;

      // Send email notifications
      if (emails.length > 0) {
        console.log(`[EmailNotificationService] Sending failure alert to emails: ${emails.join(', ')}`);
        emailSent = await this.sendFailureAlert(payload, emails);
      } else {
        console.log(`[EmailNotificationService] No email addresses configured for user ${userId}`);
      }

      // Send Slack notification if enabled
      if (alertSettings.slack_enabled && alertSettings.slack_webhook_url) {
        console.log(`[EmailNotificationService] Sending Slack notification for user ${userId}`);
        slackSent = await slackNotificationService.sendFailureAlert(
          payload, 
          alertSettings.slack_webhook_url,
          alertSettings.slack_channel || undefined
        );
      }

      return emailSent || slackSent;
    } catch (error) {
      console.error('[EmailNotificationService] Error notifying user of failure:', error);
      return false;
    }
  }

  /**
   * Check a completed test run and send failure alerts if needed
   * This is the main entry point called when test runs complete
   */
  async checkAndNotifyTestRunFailures(testRunId: string): Promise<boolean> {
    console.log(`[EmailNotificationService] ========== CHECKING TEST RUN FAILURES ==========`);
    console.log(`[EmailNotificationService] Test Run ID: ${testRunId}`);
    
    try {
      // Get test run details
      const testRunResult = await pool.query(
        `SELECT tr.*, a.name as agent_name, a.provider
         FROM test_runs tr
         LEFT JOIN agents a ON tr.agent_id = a.id
         WHERE tr.id = $1`,
        [testRunId]
      );

      if (testRunResult.rows.length === 0) {
        console.log(`[EmailNotificationService] Test run ${testRunId} not found`);
        return false;
      }

      const testRun = testRunResult.rows[0];
      console.log(`[EmailNotificationService] Test Run Found:`, {
        id: testRun.id,
        name: testRun.name,
        user_id: testRun.user_id,
        failed_tests: testRun.failed_tests,
        total_tests: testRun.total_tests
      });
      
      const failedTests = testRun.failed_tests || 0;

      // No failures, no notification needed
      if (failedTests === 0) {
        console.log(`[EmailNotificationService] No failed tests in run ${testRunId}, skipping notification`);
        return false;
      }

      // Get failed test results
      const failedResultsQuery = await pool.query(
        `SELECT tr.*, tc.name as test_case_name, tc.scenario, tc.category, tc.expected_output
         FROM test_results tr
         LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
         WHERE tr.test_run_id = $1 AND tr.status = 'failed'
         ORDER BY tr.created_at`,
        [testRunId]
      );

      if (failedResultsQuery.rows.length === 0) {
        console.log(`[EmailNotificationService] No failed results found for run ${testRunId}`);
        return false;
      }

      // Determine if this is a scheduled run
      const isScheduledRun = testRun.name?.includes('[Scheduled]') || 
                             testRun.config?.scheduledTestId != null;

      // Build the payload
      const payload: FailedTestAlertPayload = {
        testRunId: testRun.id,
        testRunName: testRun.name || 'Test Run',
        agentId: testRun.agent_id || '',
        agentName: testRun.agent_name || 'Unknown Agent',
        provider: testRun.provider || testRun.config?.provider || 'Unknown',
        isScheduledRun,
        failedTests: failedResultsQuery.rows.map(result => ({
          testCaseId: result.test_case_id,
          testCaseName: result.test_case_name || result.scenario || 'Unknown Test',
          scenario: result.scenario || '',
          category: result.category || 'General',
          expectedOutcome: result.expected_output || result.expected_response || '',
          actualResponse: result.agent_transcript || result.actual_response || '',
          errorMessage: result.error_message || '',
          status: result.status,
        })),
        summary: {
          total: testRun.total_tests || 0,
          passed: testRun.passed_tests || 0,
          failed: failedTests,
        },
        timestamp: new Date(),
      };

      // Notify the user
      return await this.notifyUserOfTestFailure(testRun.user_id, payload);
    } catch (error) {
      console.error('[EmailNotificationService] Error checking test run failures:', error);
      return false;
    }
  }

  /**
   * Send welcome email to new team member with login credentials
   */
  async sendTeamMemberWelcomeEmail(data: {
    toEmail: string;
    name: string;
    password: string;
    ownerName: string;
    loginUrl: string;
  }): Promise<boolean> {
    if (!this.transporter) {
      console.warn('[EmailNotificationService] Cannot send email - SMTP not configured');
      // Log credentials for development
      console.log('='.repeat(60));
      console.log('[DEV] Team Member Credentials:');
      console.log(`Email: ${data.toEmail}`);
      console.log(`Password: ${data.password}`);
      console.log(`Login URL: ${data.loginUrl}`);
      console.log('='.repeat(60));
      return false;
    }

    try {
      const subject = `🎉 Welcome to STABLR - Your Account is Ready!`;
      const html = this.generateTeamMemberWelcomeHtml(data);

      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@stablr.ai',
        to: data.toEmail,
        subject,
        html,
      });

      console.log(`[EmailNotificationService] Welcome email sent to: ${data.toEmail}`);
      return true;
    } catch (error) {
      console.error('[EmailNotificationService] Failed to send welcome email:', error);
      // Log credentials as fallback
      console.log('='.repeat(60));
      console.log('[FALLBACK] Team Member Credentials:');
      console.log(`Email: ${data.toEmail}`);
      console.log(`Password: ${data.password}`);
      console.log(`Login URL: ${data.loginUrl}`);
      console.log('='.repeat(60));
      return false;
    }
  }

  /**
   * Generate HTML for team member welcome email
   */
  private generateTeamMemberWelcomeHtml(data: {
    toEmail: string;
    name: string;
    password: string;
    ownerName: string;
    loginUrl: string;
  }): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Welcome to STABLR</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding: 40px 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Welcome to STABLR!</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 15px 0 0 0; font-size: 16px;">
            Your team account is ready
          </p>
        </div>

        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="font-size: 16px; margin-bottom: 20px;">
            Hi <strong>${data.name}</strong>,
          </p>
          
          <p style="margin-bottom: 20px;">
            <strong>${data.ownerName}</strong> has added you as a team member to their STABLR account. 
            You now have full access to test and monitor voice agents.
          </p>

          <div style="background: #f3f4f6; padding: 25px; border-radius: 8px; margin: 25px 0;">
            <h2 style="margin: 0 0 20px 0; font-size: 18px; color: #111827;">Your Login Credentials</h2>
            <table style="width: 100%;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; width: 100px;">Email:</td>
                <td style="padding: 8px 0; font-weight: 600;">${data.toEmail}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Password:</td>
                <td style="padding: 8px 0; font-family: monospace; font-weight: 600; background: #fef3c7; padding: 8px 12px; border-radius: 4px; display: inline-block;">${data.password}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${data.loginUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
              Login to Your Account
            </a>
          </div>

          <div style="background: #fef2f2; padding: 15px; border-radius: 8px; margin-top: 25px;">
            <p style="margin: 0; font-size: 14px; color: #991b1b;">
              <strong>⚠️ Security Note:</strong> We recommend changing your password after your first login for security purposes.
            </p>
          </div>

          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
            <p>This is an automated message from STABLR Platform.</p>
            <p>If you didn't expect this email, please contact your team administrator.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

export const emailNotificationService = new EmailNotificationService();
