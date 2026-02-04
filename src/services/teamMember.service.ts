import { query } from '../db';
import { TeamMember, CreateTeamMemberDTO } from '../models/teamMember.model';

export class TeamMemberService {
  /**
   * Find team member by ID
   */
  async findById(id: string): Promise<TeamMember | null> {
    const result = await query(
      'SELECT * FROM team_members WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find team member by email
   */
  async findByEmail(email: string): Promise<TeamMember | null> {
    const result = await query(
      'SELECT * FROM team_members WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Find team member by Clerk ID
   */
  async findByClerkId(clerkId: string): Promise<TeamMember | null> {
    const result = await query(
      'SELECT * FROM team_members WHERE clerk_id = $1',
      [clerkId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all team members for a user (owner)
   * Returns all team members (including deactivated) in chronological order (newest first)
   * Active members are shown first, followed by deactivated ones
   */
  async findByOwnerId(ownerUserId: string): Promise<TeamMember[]> {
    const result = await query(
      `SELECT * FROM team_members 
       WHERE owner_user_id = $1
       ORDER BY 
         CASE WHEN status = 'deactivated' THEN 1 ELSE 0 END,
         created_at DESC`,
      [ownerUserId]
    );
    return result.rows;
  }

  /**
   * Check if a user is a team member (not an owner)
   * Checks both by email and by clerk_id for robustness
   */
  async isTeamMember(userId: string): Promise<boolean> {
    // First get the user's email and clerk_id
    const userResult = await query(
      'SELECT email, clerk_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) return false;
    
    const email = userResult.rows[0].email;
    const clerkId = userResult.rows[0].clerk_id;
    
    // Check if this email OR clerk_id is in team_members (and not deactivated)
    const teamResult = await query(
      `SELECT id FROM team_members 
       WHERE (email = $1 OR clerk_id = $2) AND status != 'deactivated'`,
      [email, clerkId]
    );
    
    return teamResult.rows.length > 0;
  }

  /**
   * Get the owner user ID for a team member
   * Returns the owner's user_id if the given user is a team member, otherwise returns the same user_id
   * Checks both by email and by clerk_id for robustness
   */
  async getOwnerUserId(userId: string): Promise<string> {
    // First get the user's email and clerk_id
    const userResult = await query(
      'SELECT email, clerk_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) return userId;
    
    const email = userResult.rows[0].email;
    const clerkId = userResult.rows[0].clerk_id;
    
    // Check if this email OR clerk_id is in team_members (and not deactivated)
    const teamResult = await query(
      `SELECT owner_user_id FROM team_members 
       WHERE (email = $1 OR clerk_id = $2) AND status != 'deactivated'`,
      [email, clerkId]
    );
    
    if (teamResult.rows.length > 0) {
      return teamResult.rows[0].owner_user_id;
    }
    
    return userId;
  }

  /**
   * Create a new team member
   */
  async create(data: CreateTeamMemberDTO): Promise<TeamMember> {
    const result = await query(
      `INSERT INTO team_members (owner_user_id, email, name, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [data.owner_user_id, data.email.toLowerCase(), data.name]
    );
    return result.rows[0];
  }

  /**
   * Update team member's Clerk ID when they first login
   */
  async updateClerkId(email: string, clerkId: string): Promise<TeamMember | null> {
    const result = await query(
      `UPDATE team_members 
       SET clerk_id = $1, status = 'active', updated_at = CURRENT_TIMESTAMP 
       WHERE email = $2 
       RETURNING *`,
      [clerkId, email.toLowerCase()]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete a team member (soft delete - mark as deactivated)
   */
  async delete(id: string, ownerUserId: string): Promise<boolean> {
    // Soft delete - mark as deactivated instead of hard delete
    const result = await query(
      `UPDATE team_members 
       SET status = 'deactivated', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND owner_user_id = $2
       RETURNING id`,
      [id, ownerUserId]
    );
    return result.rowCount ? result.rowCount > 0 : false;
  }

  /**
   * Check if email already exists as user or team member
   * Excludes deactivated team members to allow reusing email addresses
   */
  async emailExists(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();
    
    // First check if this email belongs to a deactivated team member
    const deactivatedTeamMember = await query(
      "SELECT id FROM team_members WHERE LOWER(email) = $1 AND status = 'deactivated'",
      [normalizedEmail]
    );
    
    // If it's a deactivated team member, it's available for reuse
    if (deactivatedTeamMember.rows.length > 0) {
      return false;
    }
    
    // Check in users table
    const userResult = await query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    if (userResult.rows.length > 0) return true;
    
    // Check in team_members table - exclude deactivated members
    const teamResult = await query(
      "SELECT id FROM team_members WHERE LOWER(email) = $1 AND status != 'deactivated'",
      [normalizedEmail]
    );
    
    return teamResult.rows.length > 0;
  }

  /**
   * Update all team members' package when owner upgrades
   * This ensures team members share the same package as their owner
   */
  async cascadePackageUpgrade(ownerUserId: string, newPackageId: string, newExpiresAt: Date | null): Promise<void> {
    try {
      // Get all active team members for this owner
      const teamMembers = await this.findByOwnerId(ownerUserId);
      
      if (teamMembers.length === 0) {
        console.log(`[TeamMember] No team members found for owner ${ownerUserId}`);
        return;
      }

      console.log(`[TeamMember] Cascading package upgrade to ${teamMembers.length} team members`);

      // Get each team member's user ID and update their package
      for (const member of teamMembers) {
        try {
          // Find the user record for this team member
          const userResult = await query(
            'SELECT id FROM users WHERE email = $1 OR clerk_id = $2',
            [member.email, member.clerk_id]
          );

          if (userResult.rows.length === 0) {
            console.log(`[TeamMember] User not found for team member ${member.email}`);
            continue;
          }

          const memberUserId = userResult.rows[0].id;

          // Update the team member's package
          await query(
            `UPDATE user_credits 
             SET package_id = $1, 
                 package_expires_at = $2,
                 updated_at = NOW()
             WHERE user_id = $3`,
            [newPackageId, newExpiresAt, memberUserId]
          );

          console.log(`[TeamMember] Updated package for team member ${member.email}`);
        } catch (memberError) {
          console.error(`[TeamMember] Failed to update package for ${member.email}:`, memberError);
          // Continue with other members even if one fails
        }
      }

      console.log(`[TeamMember] Package cascade completed for owner ${ownerUserId}`);
    } catch (error) {
      console.error('[TeamMember] Failed to cascade package upgrade:', error);
      throw error;
    }
  }
}

export const teamMemberService = new TeamMemberService();
