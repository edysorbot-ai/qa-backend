import { FailedTestAlertPayload } from '../models/alertSettings.model';

export class SlackNotificationService {
  /**
   * Send test failure alert to Slack
   */
  async sendFailureAlert(
    payload: FailedTestAlertPayload, 
    webhookUrl: string,
    channel?: string
  ): Promise<boolean> {
    if (!webhookUrl) {
      console.warn('[SlackNotificationService] No webhook URL provided');
      return false;
    }

    try {
      const message = this.buildSlackMessage(payload);
      
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(channel ? { ...message, channel } : message),
      });

      if (response.ok) {
        console.log('[SlackNotificationService] Alert sent successfully');
        return true;
      } else {
        const errorText = await response.text();
        console.error('[SlackNotificationService] Failed to send alert:', errorText);
        return false;
      }
    } catch (error) {
      console.error('[SlackNotificationService] Error sending alert:', error);
      return false;
    }
  }

  /**
   * Test Slack webhook connection
   */
  async testConnection(webhookUrl: string, channel?: string): Promise<{ success: boolean; message: string }> {
    if (!webhookUrl) {
      return { success: false, message: 'Webhook URL is required' };
    }

    // Validate URL format
    if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
      return { success: false, message: 'Invalid Slack webhook URL. It should start with https://hooks.slack.com/' };
    }

    try {
      const testMessage = {
        text: '✅ Voice Agent QA connected successfully!',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*✅ Voice Agent QA Connected*\n\nYou will receive test failure alerts in this channel.'
            }
          }
        ]
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(channel ? { ...testMessage, channel } : testMessage),
      });

      if (response.ok) {
        return { success: true, message: 'Connected successfully! Check your Slack channel for a test message.' };
      } else {
        const errorText = await response.text();
        return { success: false, message: `Failed to connect: ${errorText}` };
      }
    } catch (error) {
      return { success: false, message: `Connection error: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
  }

  /**
   * Build Slack Block Kit message for failure alert
   */
  private buildSlackMessage(payload: FailedTestAlertPayload): object {
    const failedCount = payload.summary.failed;
    const totalCount = payload.summary.total;
    const passRate = totalCount > 0 ? ((payload.summary.passed / totalCount) * 100).toFixed(0) : '0';

    const blocks: object[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚨 Test Failure Alert`,
          emoji: true
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Test Run:*\n${payload.testRunName}`
          },
          {
            type: 'mrkdwn',
            text: `*Agent:*\n${payload.agentName} (${payload.provider})`
          }
        ]
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Results:*\n❌ ${failedCount} failed / ${totalCount} total`
          },
          {
            type: 'mrkdwn',
            text: `*Pass Rate:*\n${passRate}%`
          }
        ]
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Failed Tests:*'
        }
      }
    ];

    // Add failed test details (limit to first 5 to avoid message size limits)
    const failedTests = payload.failedTests.slice(0, 5);
    failedTests.forEach((test, index) => {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${index + 1}. ${test.testCaseName}*\n` +
                `_Category:_ ${test.category}\n` +
                `_Expected:_ ${test.expectedOutcome}\n` +
                `_Error:_ ${test.errorMessage || test.actualResponse || 'Test failed'}`
        }
      });
    });

    if (payload.failedTests.length > 5) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_...and ${payload.failedTests.length - 5} more failed tests_`
          }
        ]
      });
    }

    // Add timestamp
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `📅 ${new Date(payload.timestamp).toLocaleString()}`
        }
      ]
    });

    return {
      text: `🚨 Test Failure: ${failedCount} tests failed in ${payload.testRunName}`,
      blocks
    };
  }
}

export const slackNotificationService = new SlackNotificationService();
