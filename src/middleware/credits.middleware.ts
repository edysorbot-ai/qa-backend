/**
 * Credits & Subscription Middleware
 * 
 * Enforces package subscription requirements and credit checks
 * before allowing users to perform credit-consuming actions.
 */

import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

export interface UserSubscription {
  userId: string;
  hasSubscription: boolean;
  packageId: string | null;
  packageName: string | null;
  currentCredits: number;
  isUnlimited: boolean;
  packageExpired: boolean;
  features: Record<string, boolean>;
}

export interface CreditRequest extends Request {
  subscription?: UserSubscription;
  effectiveUserId?: string;
}

/**
 * Feature keys for credit costs
 */
export const FeatureKeys = {
  TEST_CASE_CREATE: 'test_case_create',
  TEST_RUN_EXECUTE: 'test_run_execute',
  CUSTOM_AGENT_CREATE: 'custom_agent_create',
  CUSTOM_AGENT_SIMULATE: 'custom_agent_simulate',
  AGENT_CREATE: 'agent_create',
  SCHEDULED_TEST_CREATE: 'scheduled_test_create',
  TEAM_MEMBER_ADD: 'team_member_add',
} as const;

/**
 * Get user subscription info
 */
async function getUserSubscription(userId: string): Promise<UserSubscription> {
  const result = await pool.query(`
    SELECT 
      u.id as user_id,
      uc.package_id,
      uc.current_credits,
      uc.package_expires_at,
      cp.name as package_name,
      cp.is_unlimited,
      cp.features
    FROM users u
    LEFT JOIN user_credits uc ON u.id = uc.user_id
    LEFT JOIN credit_packages cp ON uc.package_id = cp.id
    WHERE u.id = $1
  `, [userId]);

  const row = result.rows[0];
  
  if (!row || !row.package_id) {
    return {
      userId,
      hasSubscription: false,
      packageId: null,
      packageName: null,
      currentCredits: 0,
      isUnlimited: false,
      packageExpired: false,
      features: {},
    };
  }

  const packageExpired = row.package_expires_at 
    ? new Date(row.package_expires_at) < new Date() 
    : false;

  return {
    userId,
    hasSubscription: !packageExpired,
    packageId: row.package_id,
    packageName: row.package_name,
    currentCredits: row.current_credits || 0,
    isUnlimited: row.is_unlimited || false,
    packageExpired,
    features: row.features || {},
  };
}

/**
 * Get credit cost for a feature
 */
async function getFeatureCreditCost(featureKey: string): Promise<number> {
  const result = await pool.query(`
    SELECT credit_cost FROM feature_credit_costs 
    WHERE feature_key = $1 AND is_active = true
  `, [featureKey]);

  return result.rows[0]?.credit_cost ?? 1;
}

/**
 * Deduct credits from user account
 */
export async function deductCredits(
  userId: string, 
  amount: number, 
  description: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First, lock the user_credits row
    const lockResult = await client.query(`
      SELECT uc.current_credits, uc.package_id
      FROM user_credits uc
      WHERE uc.user_id = $1
      FOR UPDATE
    `, [userId]);

    if (!lockResult.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }

    const userCredits = lockResult.rows[0];

    // Then check if package is unlimited (separate query, no FOR UPDATE needed)
    const packageResult = await client.query(`
      SELECT is_unlimited FROM credit_packages WHERE id = $1
    `, [userCredits.package_id]);

    const isUnlimited = packageResult.rows[0]?.is_unlimited || false;

    // Skip deduction for unlimited packages
    if (isUnlimited) {
      await client.query('COMMIT');
      return true;
    }

    if (userCredits.current_credits < amount) {
      await client.query('ROLLBACK');
      return false;
    }

    // Deduct credits
    const updateResult = await client.query(`
      UPDATE user_credits 
      SET current_credits = current_credits - $2,
          total_credits_used = total_credits_used + $2,
          updated_at = NOW()
      WHERE user_id = $1
      RETURNING current_credits
    `, [userId, amount]);

    // Log transaction
    await client.query(`
      INSERT INTO credit_transactions 
        (user_id, transaction_type, credits_amount, balance_after, description, metadata)
      VALUES ($1, 'credit_used', $2, $3, $4, $5)
    `, [userId, -amount, updateResult.rows[0].current_credits, description, metadata ? JSON.stringify(metadata) : null]);

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deducting credits:', error);
    return false;
  } finally {
    client.release();
  }
}

/**
 * Middleware to require an active subscription/package
 * Returns 402 Payment Required if user has no subscription
 */
export const requireSubscription = async (
  req: CreditRequest, 
  res: Response, 
  next: NextFunction
) => {
  try {
    const clerkUser = (req as any).auth;
    if (!clerkUser?.userId) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Authentication required' 
      });
    }

    const user = await userService.findOrCreateByClerkId(clerkUser.userId);
    
    // Get effective user ID (for team members, use owner's subscription)
    const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);
    req.effectiveUserId = effectiveUserId;

    const subscription = await getUserSubscription(effectiveUserId);
    req.subscription = subscription;

    if (!subscription.hasSubscription) {
      return res.status(402).json({
        error: 'subscription_required',
        message: 'An active subscription is required to perform this action',
        details: {
          action: 'Please purchase a package to continue',
          upgradeRequired: true,
        }
      });
    }

    if (subscription.packageExpired) {
      return res.status(402).json({
        error: 'subscription_expired',
        message: 'Your subscription has expired',
        details: {
          action: 'Please renew your subscription to continue',
          upgradeRequired: true,
        }
      });
    }

    next();
  } catch (error) {
    console.error('Error in requireSubscription middleware:', error);
    next(error);
  }
};

/**
 * Middleware to require a specific feature to be enabled in user's package
 */
export const requireFeature = (featureKey: string) => {
  return async (req: CreditRequest, res: Response, next: NextFunction) => {
    try {
      // Ensure subscription is loaded
      if (!req.subscription) {
        const clerkUser = (req as any).auth;
        if (!clerkUser?.userId) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const user = await userService.findOrCreateByClerkId(clerkUser.userId);
        const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);
        req.effectiveUserId = effectiveUserId;
        req.subscription = await getUserSubscription(effectiveUserId);
      }

      if (!req.subscription.hasSubscription) {
        return res.status(402).json({
          error: 'subscription_required',
          message: 'An active subscription is required',
          details: { upgradeRequired: true }
        });
      }

      // Check if feature is enabled in package
      if (!req.subscription.features[featureKey]) {
        return res.status(402).json({
          error: 'feature_not_available',
          message: `This feature is not available in your current package`,
          details: {
            feature: featureKey,
            currentPackage: req.subscription.packageName,
            upgradeRequired: true,
            action: 'Please upgrade your package to access this feature'
          }
        });
      }

      next();
    } catch (error) {
      console.error('Error in requireFeature middleware:', error);
      next(error);
    }
  };
};

/**
 * Middleware to check if user has sufficient credits for an action
 * Uses feature credit costs from the database
 */
export const requireCredits = (featureKey: string, multiplierFn?: (req: Request) => number) => {
  return async (req: CreditRequest, res: Response, next: NextFunction) => {
    try {
      // Ensure subscription is loaded
      if (!req.subscription) {
        const clerkUser = (req as any).auth;
        if (!clerkUser?.userId) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const user = await userService.findOrCreateByClerkId(clerkUser.userId);
        const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);
        req.effectiveUserId = effectiveUserId;
        req.subscription = await getUserSubscription(effectiveUserId);
      }

      if (!req.subscription.hasSubscription) {
        return res.status(402).json({
          error: 'subscription_required',
          message: 'An active subscription is required',
          details: { upgradeRequired: true }
        });
      }

      // Unlimited packages skip credit checks
      if (req.subscription.isUnlimited) {
        return next();
      }

      // Get credit cost for this feature
      const baseCost = await getFeatureCreditCost(featureKey);
      const multiplier = multiplierFn ? multiplierFn(req) : 1;
      const totalCost = baseCost * multiplier;

      if (req.subscription.currentCredits < totalCost) {
        return res.status(402).json({
          error: 'insufficient_credits',
          message: 'You do not have enough credits for this action',
          details: {
            required: totalCost,
            available: req.subscription.currentCredits,
            feature: featureKey,
            upgradeRequired: true,
            action: 'Please purchase more credits or upgrade your package'
          }
        });
      }

      // Store cost info for later deduction
      (req as any).creditCost = totalCost;
      (req as any).creditFeatureKey = featureKey;

      next();
    } catch (error) {
      console.error('Error in requireCredits middleware:', error);
      next(error);
    }
  };
};

/**
 * Combined middleware that requires subscription and checks credits
 */
export const requireSubscriptionAndCredits = (
  featureKey: string, 
  multiplierFn?: (req: Request) => number
) => {
  return [
    requireSubscription,
    requireCredits(featureKey, multiplierFn)
  ];
};

/**
 * Helper to deduct credits after successful operation
 * Call this in controller after operation succeeds
 */
export const deductCreditsAfterSuccess = async (
  req: CreditRequest,
  description: string,
  metadata?: Record<string, any>
): Promise<boolean> => {
  const cost = (req as any).creditCost;
  const userId = req.effectiveUserId;

  if (!userId || !cost) {
    return true; // No credits to deduct
  }

  // Check if unlimited
  if (req.subscription?.isUnlimited) {
    return true;
  }

  return await deductCredits(userId, cost, description, metadata);
};
