import { pool } from "../db";
import bcrypt from "bcryptjs";

// Types
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  is_active: boolean;
  last_login_at?: string;
  created_at: string;
}

export interface IntegrationSetting {
  id: string;
  provider: string;
  display_name: string;
  description?: string;
  is_enabled: boolean;
  icon_url?: string;
  sort_order: number;
}

export interface CreditPackage {
  id: string;
  name: string;
  description?: string;
  credits: number;
  price_usd: number;
  is_unlimited: boolean;
  is_active: boolean;
  is_default: boolean;
  validity_days: number;
  features: Record<string, any>;
  max_team_members: number;
  created_at: string;
}

export interface FeatureCreditCost {
  id: string;
  feature_key: string;
  feature_name: string;
  description?: string;
  credit_cost: number;
  category: string;
  is_active: boolean;
}

export interface CreditPricing {
  id: string;
  credits_per_dollar: number;
  min_purchase_credits: number;
  bulk_discount_tiers: any[];
  is_active: boolean;
}

export interface UserCredit {
  id: string;
  user_id: string;
  package_id?: string;
  current_credits: number;
  total_credits_purchased: number;
  total_credits_used: number;
  package_expires_at?: string;
}

export interface Coupon {
  id: string;
  code: string;
  description?: string;
  discount_type: "percentage" | "fixed" | "credits";
  discount_value: number;
  credits_bonus: number;
  max_uses?: number;
  current_uses: number;
  min_purchase_amount: number;
  applicable_packages?: string[];
  valid_from: string;
  valid_until?: string;
  is_active: boolean;
}

export interface ReferralLink {
  id: string;
  code: string;
  description?: string;
  referrer_credits: number;
  referee_credits: number;
  referrer_discount_percent: number;
  referee_discount_percent: number;
  max_referrals?: number;
  current_referrals: number;
  is_active: boolean;
  valid_until?: string;
}

export interface UserWithDetails {
  id: string;
  clerk_id: string;
  email: string;
  name?: string;
  created_at: string;
  current_credits: number;
  total_credits_used: number;
  package_name?: string;
  package_id?: string;
}

export const AdminModel = {
  // Admin Authentication
  async authenticateAdmin(username: string, password: string): Promise<AdminUser | null> {
    const result = await pool.query(
      `SELECT * FROM admin_users WHERE username = $1 AND is_active = true`,
      [username]
    );

    if (!result.rows[0]) return null;

    const admin = result.rows[0];
    const isValid = await bcrypt.compare(password, admin.password_hash);

    if (!isValid) return null;

    // Update last login
    await pool.query(
      `UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`,
      [admin.id]
    );

    return {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      is_active: admin.is_active,
      last_login_at: admin.last_login_at,
      created_at: admin.created_at,
    };
  },

  // Integration Settings
  async getAllIntegrations(): Promise<IntegrationSetting[]> {
    const result = await pool.query(
      `SELECT * FROM integration_settings ORDER BY sort_order ASC`
    );
    return result.rows;
  },

  async updateIntegration(id: string, data: Partial<IntegrationSetting>): Promise<IntegrationSetting | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.display_name !== undefined) {
      updates.push(`display_name = $${paramCount++}`);
      values.push(data.display_name);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(data.description);
    }
    if (data.is_enabled !== undefined) {
      updates.push(`is_enabled = $${paramCount++}`);
      values.push(data.is_enabled);
    }
    if (data.icon_url !== undefined) {
      updates.push(`icon_url = $${paramCount++}`);
      values.push(data.icon_url);
    }
    if (data.sort_order !== undefined) {
      updates.push(`sort_order = $${paramCount++}`);
      values.push(data.sort_order);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE integration_settings SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  async getEnabledIntegrations(): Promise<IntegrationSetting[]> {
    const result = await pool.query(
      `SELECT * FROM integration_settings WHERE is_enabled = true ORDER BY sort_order ASC`
    );
    return result.rows;
  },

  // Credit Packages
  async getAllPackages(): Promise<CreditPackage[]> {
    const result = await pool.query(
      `SELECT * FROM credit_packages ORDER BY price_usd ASC`
    );
    return result.rows;
  },

  async getActivePackages(): Promise<CreditPackage[]> {
    const result = await pool.query(
      `SELECT * FROM credit_packages WHERE is_active = true ORDER BY price_usd ASC`
    );
    return result.rows;
  },

  async createPackage(data: Omit<CreditPackage, "id" | "created_at">): Promise<CreditPackage> {
    // If this package is being set as default, unset any existing default
    if (data.is_default) {
      await pool.query(`UPDATE credit_packages SET is_default = false WHERE is_default = true`);
    }
    
    const result = await pool.query(
      `INSERT INTO credit_packages (name, description, credits, price_usd, is_unlimited, is_active, is_default, validity_days, features, max_team_members)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [data.name, data.description, data.credits, data.price_usd, data.is_unlimited, data.is_active, data.is_default || false, data.validity_days, JSON.stringify(data.features), data.max_team_members]
    );
    return result.rows[0];
  },

  async updatePackage(id: string, data: Partial<CreditPackage>): Promise<CreditPackage | null> {
    // If this package is being set as default, unset any existing default
    if (data.is_default) {
      await pool.query(`UPDATE credit_packages SET is_default = false WHERE is_default = true AND id != $1`, [id]);
    }
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fields = ['name', 'description', 'credits', 'price_usd', 'is_unlimited', 'is_active', 'is_default', 'validity_days', 'max_team_members'];
    
    for (const field of fields) {
      if ((data as any)[field] !== undefined) {
        updates.push(`${field} = $${paramCount++}`);
        values.push((data as any)[field]);
      }
    }

    if (data.features !== undefined) {
      updates.push(`features = $${paramCount++}`);
      values.push(JSON.stringify(data.features));
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE credit_packages SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  async deletePackage(id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM credit_packages WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },
  
  // Get the default package for new users
  async getDefaultPackage(): Promise<CreditPackage | null> {
    const result = await pool.query(
      `SELECT * FROM credit_packages WHERE is_default = true AND is_active = true LIMIT 1`
    );
    return result.rows[0] || null;
  },

  // Feature Credit Costs
  async getAllFeatureCosts(): Promise<FeatureCreditCost[]> {
    const result = await pool.query(
      `SELECT * FROM feature_credit_costs ORDER BY category, feature_name`
    );
    return result.rows;
  },

  async updateFeatureCost(id: string, data: Partial<FeatureCreditCost>): Promise<FeatureCreditCost | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.feature_name !== undefined) {
      updates.push(`feature_name = $${paramCount++}`);
      values.push(data.feature_name);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(data.description);
    }
    if (data.credit_cost !== undefined) {
      updates.push(`credit_cost = $${paramCount++}`);
      values.push(data.credit_cost);
    }
    if (data.category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(data.category);
    }
    if (data.is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(data.is_active);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE feature_credit_costs SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  async createFeatureCost(data: Omit<FeatureCreditCost, "id">): Promise<FeatureCreditCost> {
    const result = await pool.query(
      `INSERT INTO feature_credit_costs (feature_key, feature_name, description, credit_cost, category, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.feature_key, data.feature_name, data.description, data.credit_cost, data.category, data.is_active ?? true]
    );
    return result.rows[0];
  },

  // Credit Pricing
  async getCreditPricing(): Promise<CreditPricing | null> {
    const result = await pool.query(`SELECT * FROM credit_pricing WHERE is_active = true LIMIT 1`);
    return result.rows[0] || null;
  },

  async updateCreditPricing(data: Partial<CreditPricing>): Promise<CreditPricing | null> {
    const current = await this.getCreditPricing();
    if (!current) return null;

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.credits_per_dollar !== undefined) {
      updates.push(`credits_per_dollar = $${paramCount++}`);
      values.push(data.credits_per_dollar);
    }
    if (data.min_purchase_credits !== undefined) {
      updates.push(`min_purchase_credits = $${paramCount++}`);
      values.push(data.min_purchase_credits);
    }
    if (data.bulk_discount_tiers !== undefined) {
      updates.push(`bulk_discount_tiers = $${paramCount++}`);
      values.push(JSON.stringify(data.bulk_discount_tiers));
    }

    if (updates.length === 0) return current;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(current.id);

    const result = await pool.query(
      `UPDATE credit_pricing SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  // User Credits Management
  async getUserCredits(userId: string): Promise<UserCredit | null> {
    const result = await pool.query(
      `SELECT * FROM user_credits WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  async initializeUserCredits(userId: string, packageId?: string, credits?: number): Promise<UserCredit> {
    const result = await pool.query(
      `INSERT INTO user_credits (user_id, package_id, current_credits, total_credits_purchased)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id) DO UPDATE SET 
         package_id = COALESCE($2, user_credits.package_id),
         current_credits = user_credits.current_credits + COALESCE($3, 0),
         total_credits_purchased = user_credits.total_credits_purchased + COALESCE($3, 0),
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, packageId || null, credits || 0]
    );
    return result.rows[0];
  },

  async addCreditsToUser(userId: string, credits: number, description: string): Promise<UserCredit | null> {
    // First ensure user_credits exists
    await this.initializeUserCredits(userId, undefined, 0);

    const result = await pool.query(
      `UPDATE user_credits 
       SET current_credits = current_credits + $2,
           total_credits_purchased = total_credits_purchased + $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
       RETURNING *`,
      [userId, credits]
    );

    if (result.rows[0]) {
      // Log transaction
      await pool.query(
        `INSERT INTO credit_transactions (user_id, transaction_type, credits_amount, balance_after, description)
         VALUES ($1, 'credit_added', $2, $3, $4)`,
        [userId, credits, result.rows[0].current_credits, description]
      );
    }

    return result.rows[0] || null;
  },

  async setUserPackage(userId: string, packageId: string): Promise<UserCredit | null> {
    // Get package details
    const pkgResult = await pool.query(`SELECT * FROM credit_packages WHERE id = $1`, [packageId]);
    const pkg = pkgResult.rows[0];
    if (!pkg) return null;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (pkg.validity_days || 30));

    // Initialize or update user credits
    await this.initializeUserCredits(userId, undefined, 0);

    const result = await pool.query(
      `UPDATE user_credits 
       SET package_id = $2,
           current_credits = current_credits + $3,
           total_credits_purchased = total_credits_purchased + $3,
           package_expires_at = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
       RETURNING *`,
      [userId, packageId, pkg.credits, expiresAt]
    );

    if (result.rows[0]) {
      // Log transaction
      await pool.query(
        `INSERT INTO credit_transactions (user_id, transaction_type, credits_amount, balance_after, description, metadata)
         VALUES ($1, 'package_assigned', $2, $3, $4, $5)`,
        [userId, pkg.credits, result.rows[0].current_credits, `Package assigned: ${pkg.name}`, JSON.stringify({ package_id: packageId, package_name: pkg.name })]
      );
    }

    return result.rows[0] || null;
  },

  // User Management
  async getAllUsers(): Promise<UserWithDetails[]> {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.clerk_id,
        u.email,
        COALESCE(u.first_name || ' ' || u.last_name, u.email) as name,
        u.created_at,
        COALESCE(uc.current_credits, 0) as current_credits,
        COALESCE(uc.total_credits_used, 0) as total_credits_used,
        cp.name as package_name,
        cp.id as package_id
      FROM users u
      LEFT JOIN user_credits uc ON u.id = uc.user_id
      LEFT JOIN credit_packages cp ON uc.package_id = cp.id
      ORDER BY u.created_at DESC
    `);
    return result.rows;
  },

  async getUserById(id: string): Promise<UserWithDetails | null> {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.clerk_id,
        u.email,
        COALESCE(u.first_name || ' ' || u.last_name, u.email) as name,
        u.created_at,
        COALESCE(uc.current_credits, 0) as current_credits,
        COALESCE(uc.total_credits_used, 0) as total_credits_used,
        COALESCE(uc.total_credits_purchased, 0) as total_credits_purchased,
        uc.package_expires_at,
        cp.name as package_name,
        cp.id as package_id,
        cp.is_unlimited
      FROM users u
      LEFT JOIN user_credits uc ON u.id = uc.user_id
      LEFT JOIN credit_packages cp ON uc.package_id = cp.id
      WHERE u.id = $1
    `, [id]);
    return result.rows[0] || null;
  },

  async updateUser(id: string, data: { name?: string; email?: string }): Promise<any> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      // Split name into first_name and last_name
      const nameParts = data.name.trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      updates.push(`first_name = $${paramCount++}`);
      values.push(firstName);
      updates.push(`last_name = $${paramCount++}`);
      values.push(lastName);
    }
    if (data.email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      values.push(data.email);
    }

    if (updates.length === 0) return null;

    values.push(id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING id, email, first_name || ' ' || last_name as name`,
      values
    );

    return result.rows[0] || null;
  },

  async deleteUser(id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  // Coupons
  async getAllCoupons(): Promise<Coupon[]> {
    const result = await pool.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
    return result.rows;
  },

  async createCoupon(data: Omit<Coupon, "id" | "current_uses">): Promise<Coupon> {
    const result = await pool.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, credits_bonus, max_uses, min_purchase_amount, applicable_packages, valid_from, valid_until, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [data.code.toUpperCase(), data.description, data.discount_type, data.discount_value, data.credits_bonus || 0, data.max_uses, data.min_purchase_amount || 0, data.applicable_packages, data.valid_from, data.valid_until, data.is_active ?? true]
    );
    return result.rows[0];
  },

  async updateCoupon(id: string, data: Partial<Coupon>): Promise<Coupon | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fields = ['code', 'description', 'discount_type', 'discount_value', 'credits_bonus', 'max_uses', 'min_purchase_amount', 'valid_from', 'valid_until', 'is_active'];
    
    for (const field of fields) {
      if ((data as any)[field] !== undefined) {
        updates.push(`${field} = $${paramCount++}`);
        values.push(field === 'code' ? (data as any)[field].toUpperCase() : (data as any)[field]);
      }
    }

    if (data.applicable_packages !== undefined) {
      updates.push(`applicable_packages = $${paramCount++}`);
      values.push(data.applicable_packages);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE coupons SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  async deleteCoupon(id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM coupons WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  // Referral Links
  async getAllReferralLinks(): Promise<ReferralLink[]> {
    const result = await pool.query(`SELECT * FROM referral_links ORDER BY created_at DESC`);
    return result.rows;
  },

  async createReferralLink(data: Omit<ReferralLink, "id" | "current_referrals">): Promise<ReferralLink> {
    // Convert empty strings to null for optional fields
    const validUntil = data.valid_until && data.valid_until !== "" ? data.valid_until : null;
    const maxReferrals = data.max_referrals || null;
    
    const result = await pool.query(
      `INSERT INTO referral_links (code, description, referrer_credits, referee_credits, referrer_discount_percent, referee_discount_percent, max_referrals, is_active, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [data.code.toUpperCase(), data.description || null, data.referrer_credits || 0, data.referee_credits || 0, data.referrer_discount_percent || 0, data.referee_discount_percent || 0, maxReferrals, data.is_active ?? true, validUntil]
    );
    return result.rows[0];
  },

  async updateReferralLink(id: string, data: Partial<ReferralLink>): Promise<ReferralLink | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fields = ['code', 'description', 'referrer_credits', 'referee_credits', 'referrer_discount_percent', 'referee_discount_percent', 'max_referrals', 'is_active', 'valid_until'];
    
    for (const field of fields) {
      if ((data as any)[field] !== undefined) {
        updates.push(`${field} = $${paramCount++}`);
        values.push(field === 'code' ? (data as any)[field].toUpperCase() : (data as any)[field]);
      }
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await pool.query(
      `UPDATE referral_links SET ${updates.join(", ")} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  },

  async deleteReferralLink(id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM referral_links WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  },

  // Stats
  async getDashboardStats() {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days') as new_users_30d,
        (SELECT COALESCE(SUM(current_credits), 0) FROM user_credits) as total_credits_in_system,
        (SELECT COALESCE(SUM(total_credits_used), 0) FROM user_credits) as total_credits_consumed,
        (SELECT COUNT(*) FROM test_runs) as total_test_runs,
        (SELECT COUNT(*) FROM test_cases) as total_test_cases,
        (SELECT COUNT(*) FROM agents) as total_agents,
        (SELECT COUNT(*) FROM scheduled_tests WHERE status = 'active') as active_schedules
    `);
    return stats.rows[0];
  },

  // Credit Transactions
  async getCreditTransactions(userId?: string, limit: number = 100): Promise<any[]> {
    const query = userId 
      ? `SELECT ct.*, u.email as user_email FROM credit_transactions ct JOIN users u ON ct.user_id = u.id WHERE ct.user_id = $1 ORDER BY ct.created_at DESC LIMIT $2`
      : `SELECT ct.*, u.email as user_email FROM credit_transactions ct JOIN users u ON ct.user_id = u.id ORDER BY ct.created_at DESC LIMIT $1`;
    
    const params = userId ? [userId, limit] : [limit];
    const result = await pool.query(query, params);
    return result.rows;
  },

  // User Features - Check if user has access to a feature based on their package
  async getUserFeatures(userId: string): Promise<Record<string, boolean>> {
    const result = await pool.query(`
      SELECT cp.features
      FROM user_credits uc
      JOIN credit_packages cp ON uc.package_id = cp.id
      WHERE uc.user_id = $1 AND uc.package_expires_at > NOW()
    `, [userId]);
    
    if (!result.rows[0]) return {};
    return result.rows[0].features || {};
  },

  async userHasFeature(userId: string, featureKey: string): Promise<boolean> {
    const features = await this.getUserFeatures(userId);
    return features[featureKey] === true;
  },
};
