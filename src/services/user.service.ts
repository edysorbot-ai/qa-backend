import { query } from '../db';
import { User, CreateUserDTO, UpdateUserDTO } from '../models/user.model';
import { clerkClient } from '@clerk/express';

export class UserService {
  async findByClerkId(clerkId: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE clerk_id = $1',
      [clerkId]
    );
    return result.rows[0] || null;
  }

  async findById(id: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  async create(data: CreateUserDTO): Promise<User> {
    const result = await query(
      `INSERT INTO users (clerk_id, email, first_name, last_name, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.clerk_id, data.email, data.first_name, data.last_name, data.image_url]
    );
    return result.rows[0];
  }

  async update(id: string, data: UpdateUserDTO): Promise<User | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.email !== undefined) {
      fields.push(`email = $${paramCount++}`);
      values.push(data.email);
    }
    if (data.first_name !== undefined) {
      fields.push(`first_name = $${paramCount++}`);
      values.push(data.first_name);
    }
    if (data.last_name !== undefined) {
      fields.push(`last_name = $${paramCount++}`);
      values.push(data.last_name);
    }
    if (data.image_url !== undefined) {
      fields.push(`image_url = $${paramCount++}`);
      values.push(data.image_url);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async upsertFromClerk(clerkUser: any): Promise<User> {
    const existing = await this.findByClerkId(clerkUser.id);
    
    if (existing) {
      return this.update(existing.id, {
        email: clerkUser.emailAddresses?.[0]?.emailAddress,
        first_name: clerkUser.firstName,
        last_name: clerkUser.lastName,
        image_url: clerkUser.imageUrl,
      }) as Promise<User>;
    }

    return this.create({
      clerk_id: clerkUser.id,
      email: clerkUser.emailAddresses?.[0]?.emailAddress,
      first_name: clerkUser.firstName,
      last_name: clerkUser.lastName,
      image_url: clerkUser.imageUrl,
    });
  }

  // Find user by clerk ID or create a minimal user record
  // Also syncs user data from Clerk if user exists but has placeholder data
  async findOrCreateByClerkId(clerkId: string): Promise<User> {
    const existing = await this.findByClerkId(clerkId);
    
    if (existing) {
      // Check if user has placeholder/incorrect data (clerk_id in email field or placeholder email)
      const needsSync = !existing.email || 
                        existing.email.includes('@placeholder.com') ||
                        existing.email.startsWith('user_') ||
                        existing.email === clerkId;
      
      if (needsSync) {
        // Try to fetch correct data from Clerk and update
        try {
          const clerkUser = await clerkClient.users.getUser(clerkId);
          const actualEmail = clerkUser.emailAddresses?.[0]?.emailAddress;
          
          if (actualEmail && actualEmail !== existing.email) {
            console.log(`[UserService] Syncing user ${clerkId}: updating email from "${existing.email}" to "${actualEmail}"`);
            const updated = await this.update(existing.id, {
              email: actualEmail,
              first_name: clerkUser.firstName || existing.first_name,
              last_name: clerkUser.lastName || existing.last_name,
              image_url: clerkUser.imageUrl || existing.image_url,
            });
            return updated || existing;
          }
        } catch (error) {
          console.error('[UserService] Failed to sync user from Clerk:', error);
        }
      }
      
      return existing;
    }

    // Fetch user details from Clerk to get correct email
    let email = `${clerkId}@placeholder.com`;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let imageUrl: string | undefined;

    try {
      const clerkUser = await clerkClient.users.getUser(clerkId);
      email = clerkUser.emailAddresses?.[0]?.emailAddress || email;
      firstName = clerkUser.firstName || undefined;
      lastName = clerkUser.lastName || undefined;
      imageUrl = clerkUser.imageUrl || undefined;
    } catch (error) {
      console.error('[UserService] Failed to fetch user from Clerk:', error);
    }

    // Create user record with correct email
    return this.create({
      clerk_id: clerkId,
      email,
      first_name: firstName,
      last_name: lastName,
      image_url: imageUrl,
    });
  }

  // Sync all users with Clerk data (admin utility function)
  async syncAllUsersFromClerk(): Promise<{ synced: number; failed: number; skipped: number }> {
    let synced = 0;
    let failed = 0;
    let skipped = 0;

    const result = await query('SELECT * FROM users WHERE clerk_id IS NOT NULL');
    
    for (const user of result.rows) {
      // Skip users that already have valid email (not placeholder or clerk_id format)
      if (user.email && 
          !user.email.includes('@placeholder.com') && 
          !user.email.startsWith('user_')) {
        skipped++;
        continue;
      }

      try {
        const clerkUser = await clerkClient.users.getUser(user.clerk_id);
        const actualEmail = clerkUser.emailAddresses?.[0]?.emailAddress;

        if (actualEmail) {
          await this.update(user.id, {
            email: actualEmail,
            first_name: clerkUser.firstName || user.first_name,
            last_name: clerkUser.lastName || user.last_name,
            image_url: clerkUser.imageUrl || user.image_url,
          });
          console.log(`[UserService] Synced user ${user.clerk_id}: ${actualEmail}`);
          synced++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`[UserService] Failed to sync user ${user.clerk_id}:`, error);
        failed++;
      }
    }

    return { synced, failed, skipped };
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getDashboardStats(userId: string): Promise<{
    totalAgents: number;
    totalTestCases: number;
    totalTestRuns: number;
    passRate: number;
    recentTestRuns: any[];
    topAgents: any[];
  }> {
    // Get total agents
    const agentsResult = await query(
      'SELECT COUNT(*)::int as count FROM agents WHERE user_id = $1',
      [userId]
    );
    const totalAgents = agentsResult.rows[0]?.count || 0;

    // Get total test cases
    const testCasesResult = await query(
      'SELECT COUNT(*)::int as count FROM test_cases WHERE user_id = $1',
      [userId]
    );
    const totalTestCases = testCasesResult.rows[0]?.count || 0;

    // Get test run stats
    const testRunsResult = await query(
      `SELECT 
        COUNT(*)::int as total_runs,
        COALESCE(SUM(passed_tests), 0)::int as total_passed,
        COALESCE(SUM(failed_tests), 0)::int as total_failed,
        COALESCE(SUM(total_tests), 0)::int as total_tests
       FROM test_runs 
       WHERE user_id = $1 AND status = 'completed'`,
      [userId]
    );
    const stats = testRunsResult.rows[0];
    const totalTestRuns = stats?.total_runs || 0;
    const passRate = stats?.total_tests > 0 
      ? Math.round((stats.total_passed / stats.total_tests) * 100) 
      : 0;

    // Get recent test runs (last 5)
    const recentRunsResult = await query(
      `SELECT tr.id, tr.name, tr.status, tr.total_tests, tr.passed_tests, tr.failed_tests, 
              tr.created_at, tr.completed_at, a.name as agent_name
       FROM test_runs tr
       LEFT JOIN agents a ON tr.agent_id = a.id
       WHERE tr.user_id = $1
       ORDER BY tr.created_at DESC
       LIMIT 5`,
      [userId]
    );
    const recentTestRuns = recentRunsResult.rows;

    // Get top agents by test runs
    const topAgentsResult = await query(
      `SELECT a.id, a.name, a.provider, 
              COUNT(tr.id)::int as test_run_count,
              COALESCE(SUM(tr.passed_tests), 0)::int as total_passed,
              COALESCE(SUM(tr.total_tests), 0)::int as total_tests
       FROM agents a
       LEFT JOIN test_runs tr ON a.id = tr.agent_id AND tr.status = 'completed'
       WHERE a.user_id = $1
       GROUP BY a.id, a.name, a.provider
       ORDER BY test_run_count DESC
       LIMIT 5`,
      [userId]
    );
    const topAgents = topAgentsResult.rows;

    return {
      totalAgents,
      totalTestCases,
      totalTestRuns,
      passRate,
      recentTestRuns,
      topAgents,
    };
  }

  // ==================== Referral System ====================

  // Validate a referral code and return its details
  async validateReferralCode(code: string): Promise<{
    valid: boolean;
    referralId?: string;
    refereeCredits?: number;
    message?: string;
  }> {
    const result = await query(
      `SELECT * FROM referral_links 
       WHERE code = $1 
       AND is_active = true 
       AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)
       AND (max_referrals IS NULL OR current_referrals < max_referrals)`,
      [code.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return { valid: false, message: 'Invalid or expired referral code' };
    }

    const referral = result.rows[0];
    return {
      valid: true,
      referralId: referral.id,
      refereeCredits: referral.referee_credits,
    };
  }

  // Apply referral code for a new user signup
  async applyReferralCode(userId: string, referralCode: string, referrerUserId?: string): Promise<{
    success: boolean;
    creditsAwarded?: number;
    message?: string;
  }> {
    // Validate the referral code
    const validation = await this.validateReferralCode(referralCode);
    if (!validation.valid) {
      return { success: false, message: validation.message };
    }

    // Check if user has already used any referral code
    const existingUsage = await query(
      `SELECT * FROM referral_usage WHERE referee_user_id = $1`,
      [userId]
    );

    if (existingUsage.rows.length > 0) {
      return { success: false, message: 'You have already used a referral code' };
    }

    // Get the referral details
    const referralResult = await query(
      `SELECT * FROM referral_links WHERE id = $1`,
      [validation.referralId]
    );
    const referral = referralResult.rows[0];

    try {
      // Start transaction
      await query('BEGIN');

      // Award credits to the referee (new user)
      if (referral.referee_credits > 0) {
        // First ensure user has a credit record
        await query(
          `INSERT INTO user_credits (user_id, current_credits, total_credits_purchased, total_credits_used)
           VALUES ($1, 0, 0, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId]
        );

        // Add credits
        await query(
          `UPDATE user_credits 
           SET current_credits = current_credits + $1,
               total_credits_purchased = total_credits_purchased + $1
           WHERE user_id = $2`,
          [referral.referee_credits, userId]
        );

        // Log the transaction (using correct column names)
        await query(
          `INSERT INTO credit_transactions (user_id, credits_amount, transaction_type, description, balance_after)
           VALUES ($1, $2, 'referral_bonus', $3, 
                   (SELECT current_credits FROM user_credits WHERE user_id = $1))`,
          [userId, referral.referee_credits, `Referral bonus for using code ${referralCode}`]
        );
      }

      // Award credits to the referrer if specified
      if (referrerUserId && referral.referrer_credits > 0) {
        // Ensure referrer has a credit record
        await query(
          `INSERT INTO user_credits (user_id, current_credits, total_credits_purchased, total_credits_used)
           VALUES ($1, 0, 0, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [referrerUserId]
        );

        // Add credits to referrer
        await query(
          `UPDATE user_credits 
           SET current_credits = current_credits + $1,
               total_credits_purchased = total_credits_purchased + $1
           WHERE user_id = $2`,
          [referral.referrer_credits, referrerUserId]
        );

        // Log the transaction for referrer (using correct column names)
        await query(
          `INSERT INTO credit_transactions (user_id, credits_amount, transaction_type, description, balance_after)
           VALUES ($1, $2, 'referral_bonus', $3,
                   (SELECT current_credits FROM user_credits WHERE user_id = $1))`,
          [referrerUserId, referral.referrer_credits, `Referral bonus for referring a new user`]
        );
      }

      // Record the referral usage
      await query(
        `INSERT INTO referral_usage (referral_link_id, referrer_user_id, referee_user_id, referrer_credits_awarded, referee_credits_awarded)
         VALUES ($1, $2, $3, $4, $5)`,
        [referral.id, referrerUserId || null, userId, referrerUserId ? referral.referrer_credits : 0, referral.referee_credits]
      );

      // Update the referral link counter
      await query(
        `UPDATE referral_links SET current_referrals = current_referrals + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [referral.id]
      );

      await query('COMMIT');

      return {
        success: true,
        creditsAwarded: referral.referee_credits,
        message: `Successfully applied referral code! You received ${referral.referee_credits} credits.`,
      };
    } catch (error) {
      await query('ROLLBACK');
      console.error('[UserService] Error applying referral code:', error);
      return { success: false, message: 'Failed to apply referral code' };
    }
  }
}

export const userService = new UserService();
