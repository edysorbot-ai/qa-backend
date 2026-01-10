import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { AdminModel } from '../models/admin.model';

const router = Router();

// GET /api/users/me - Get current user
router.get('/me', userController.getMe.bind(userController));

// PUT /api/users/me - Update current user
router.put('/me', userController.updateMe.bind(userController));

// GET /api/users/dashboard - Get dashboard stats
router.get('/dashboard', userController.getDashboardStats.bind(userController));

// GET /api/users/features - Get current user's package features
router.get('/features', async (req: any, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Get internal user ID from clerk_id
    const { pool } = await import('../db');
    const userResult = await pool.query('SELECT id FROM users WHERE clerk_id = $1', [userId]);
    if (!userResult.rows[0]) {
      return res.json({});
    }
    const features = await AdminModel.getUserFeatures(userResult.rows[0].id);
    res.json(features);
  } catch (error) {
    console.error('Get user features error:', error);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

// GET /api/users/subscription - Get current user's subscription/package info
router.get('/subscription', async (req: any, res) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { pool } = await import('../db');
    
    // Get user's subscription info with package details
    const result = await pool.query(`
      SELECT 
        uc.current_credits,
        uc.total_credits_purchased,
        uc.total_credits_used,
        uc.package_expires_at,
        uc.created_at as subscription_started,
        cp.id as package_id,
        cp.name as package_name,
        cp.description as package_description,
        cp.credits as package_credits,
        cp.price_usd,
        cp.validity_days,
        cp.max_team_members,
        cp.is_unlimited,
        cp.features
      FROM users u
      LEFT JOIN user_credits uc ON u.id = uc.user_id
      LEFT JOIN credit_packages cp ON uc.package_id = cp.id
      WHERE u.clerk_id = $1
    `, [userId]);

    if (!result.rows[0] || !result.rows[0].package_id) {
      return res.json({
        has_subscription: false,
        current_credits: 0,
        total_credits_used: 0,
        package: null,
        features: {}
      });
    }

    const row = result.rows[0];
    res.json({
      has_subscription: true,
      current_credits: row.current_credits || 0,
      total_credits_purchased: row.total_credits_purchased || 0,
      total_credits_used: row.total_credits_used || 0,
      subscription_started: row.subscription_started,
      package_expires_at: row.package_expires_at,
      package: {
        id: row.package_id,
        name: row.package_name,
        description: row.package_description,
        credits: row.package_credits,
        price_usd: row.price_usd,
        validity_days: row.validity_days,
        max_team_members: row.max_team_members,
        is_unlimited: row.is_unlimited
      },
      features: row.features || {}
    });
  } catch (error) {
    console.error('Get user subscription error:', error);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ==================== Referral Endpoints ====================

// GET /api/users/referral/validate/:code - Validate a referral code (public endpoint)
router.get('/referral/validate/:code', async (req: any, res) => {
  try {
    const { code } = req.params;
    if (!code) {
      return res.status(400).json({ error: 'Referral code is required' });
    }
    
    const { userService } = await import('../services/user.service');
    const result = await userService.validateReferralCode(code);
    
    res.json(result);
  } catch (error) {
    console.error('Validate referral code error:', error);
    res.status(500).json({ error: 'Failed to validate referral code' });
  }
});

// POST /api/users/referral/apply - Apply a referral code for current user
router.post('/referral/apply', async (req: any, res) => {
  try {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Referral code is required' });
    }
    
    const { pool } = await import('../db');
    const { userService } = await import('../services/user.service');
    
    // Get internal user ID
    const userResult = await pool.query('SELECT id FROM users WHERE clerk_id = $1', [clerkUserId]);
    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const result = await userService.applyReferralCode(userResult.rows[0].id, code);
    
    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Apply referral code error:', error);
    res.status(500).json({ error: 'Failed to apply referral code' });
  }
});

export default router;
