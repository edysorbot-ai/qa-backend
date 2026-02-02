import { Router, Request, Response } from 'express';
import { alertSettingsService } from '../services/alertSettings.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { slackNotificationService } from '../services/slackNotification.service';

const router = Router();

/**
 * Helper function to get internal user ID from Clerk auth
 */
async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const clerkUser = (req as any).auth;
  if (!clerkUser?.userId) {
    return null;
  }
  
  const user = await userService.findOrCreateByClerkId(clerkUser.userId);
  return user?.id || null;
}

/**
 * Helper function to get effective user ID (owner's ID if team member)
 */
async function getEffectiveUserId(userId: string): Promise<string> {
  return await teamMemberService.getOwnerUserId(userId);
}

/**
 * @swagger
 * /api/alert-settings:
 *   get:
 *     summary: Get alert settings for current user
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Alert settings retrieved successfully
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Get effective user ID (owner's ID if this is a team member)
    const effectiveUserId = await getEffectiveUserId(userId);
    let settings = await alertSettingsService.findByUserId(effectiveUserId);
    
    // If no settings exist, return default settings
    if (!settings) {
      settings = {
        id: '',
        user_id: effectiveUserId,
        enabled: false,
        email_addresses: [],
        email_configs: [],
        notify_on_test_failure: true,
        notify_on_scheduled_failure: true,
        slack_enabled: false,
        slack_webhook_url: null,
        slack_channel: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    }

    res.json({ settings });
  } catch (error) {
    console.error('Error fetching alert settings:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/alert-settings:
 *   put:
 *     summary: Update alert settings for current user
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               email_addresses:
 *                 type: array
 *                 items:
 *                   type: string
 *               notify_on_test_failure:
 *                 type: boolean
 *               notify_on_scheduled_failure:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Alert settings updated successfully
 */
router.put('/', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Get effective user ID (owner's ID if this is a team member)
    const effectiveUserId = await getEffectiveUserId(userId);

    const { enabled, email_addresses, email_configs, notify_on_test_failure, notify_on_scheduled_failure } = req.body;

    // Validate email addresses if provided
    if (email_addresses) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalidEmails = email_addresses.filter((email: string) => !emailRegex.test(email));
      if (invalidEmails.length > 0) {
        return res.status(400).json({ 
          message: 'Invalid email addresses', 
          invalidEmails 
        });
      }
    }

    // Validate email_configs if provided
    if (email_configs) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const invalidConfigs = email_configs.filter((config: any) => !emailRegex.test(config.email));
      if (invalidConfigs.length > 0) {
        return res.status(400).json({ 
          message: 'Invalid email addresses in configs', 
          invalidEmails: invalidConfigs.map((c: any) => c.email)
        });
      }
    }

    const settings = await alertSettingsService.upsert(effectiveUserId, {
      enabled,
      email_addresses,
      email_configs,
      notify_on_test_failure,
      notify_on_scheduled_failure,
    });

    res.json({ settings, message: 'Alert settings updated successfully' });
  } catch (error) {
    console.error('Error updating alert settings:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/alert-settings/add-email:
 *   post:
 *     summary: Add an email address to alert settings
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email added successfully
 */
router.post('/add-email', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Get effective user ID (owner's ID if this is a team member)
    const effectiveUserId = await getEffectiveUserId(userId);

    const { email } = req.body;

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    let settings = await alertSettingsService.findByUserId(effectiveUserId);
    
    if (!settings) {
      // Create new settings with the email
      settings = await alertSettingsService.create({
        user_id: effectiveUserId,
        email_addresses: [email],
      });
    } else {
      // Add email if not already present
      const existingEmails = settings.email_addresses || [];
      if (!existingEmails.includes(email)) {
        settings = await alertSettingsService.update(effectiveUserId, {
          email_addresses: [...existingEmails, email],
        });
      }
    }

    res.json({ settings, message: 'Email added successfully' });
  } catch (error) {
    console.error('Error adding email:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/alert-settings/remove-email:
 *   post:
 *     summary: Remove an email address from alert settings
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email removed successfully
 */
router.post('/remove-email', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Get effective user ID (owner's ID if this is a team member)
    const effectiveUserId = await getEffectiveUserId(userId);

    const { email } = req.body;

    const settings = await alertSettingsService.findByUserId(effectiveUserId);
    
    if (!settings) {
      return res.status(404).json({ message: 'Alert settings not found' });
    }

    const existingEmails = settings.email_addresses || [];
    const updatedEmails = existingEmails.filter((e: string) => e !== email);

    const updatedSettings = await alertSettingsService.update(effectiveUserId, {
      email_addresses: updatedEmails,
    });

    res.json({ settings: updatedSettings, message: 'Email removed successfully' });
  } catch (error) {
    console.error('Error removing email:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/alert-settings/slack/test:
 *   post:
 *     summary: Test Slack webhook connection
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               webhook_url:
 *                 type: string
 *               channel:
 *                 type: string
 *     responses:
 *       200:
 *         description: Test result
 */
router.post('/slack/test', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const { webhook_url, channel } = req.body;

    if (!webhook_url) {
      return res.status(400).json({ message: 'Webhook URL is required' });
    }

    const result = await slackNotificationService.testConnection(webhook_url, channel);
    
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (error) {
    console.error('Error testing Slack connection:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/alert-settings/slack:
 *   put:
 *     summary: Update Slack settings
 *     tags: [Alert Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               slack_enabled:
 *                 type: boolean
 *               slack_webhook_url:
 *                 type: string
 *               slack_channel:
 *                 type: string
 *     responses:
 *       200:
 *         description: Slack settings updated successfully
 */
router.put('/slack', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const effectiveUserId = await getEffectiveUserId(userId);
    const { slack_enabled, slack_webhook_url, slack_channel } = req.body;

    // Validate webhook URL format if provided
    if (slack_webhook_url && slack_webhook_url.trim() !== '') {
      if (!slack_webhook_url.startsWith('https://hooks.slack.com/')) {
        return res.status(400).json({ message: 'Invalid Slack webhook URL. Must start with https://hooks.slack.com/' });
      }
    }

    // Require webhook URL if enabling Slack
    if (slack_enabled && (!slack_webhook_url || slack_webhook_url.trim() === '')) {
      return res.status(400).json({ message: 'Webhook URL is required when enabling Slack notifications' });
    }

    const settings = await alertSettingsService.upsert(effectiveUserId, {
      slack_enabled,
      slack_webhook_url,
      slack_channel,
    });

    res.json({ settings, message: 'Slack settings updated successfully' });
  } catch (error) {
    console.error('Error updating Slack settings:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
