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
   */
  async findByOwnerId(ownerUserId: string): Promise<TeamMember[]> {
    const result = await query(
      'SELECT * FROM team_members WHERE owner_user_id = $1 ORDER BY created_at DESC',
      [ownerUserId]
    );
    return result.rows;
  }

  /**
   * Check if a user is a team member (not an owner)
   */
  async isTeamMember(userId: string): Promise<boolean> {
    // First get the user's email
    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) return false;
    
    const email = userResult.rows[0].email;
    
    // Check if this email is in team_members
    const teamResult = await query(
      'SELECT id FROM team_members WHERE email = $1',
      [email]
    );
    
    return teamResult.rows.length > 0;
  }

  /**
   * Get the owner user ID for a team member
   * Returns the owner's user_id if the given user is a team member, otherwise returns the same user_id
   */
  async getOwnerUserId(userId: string): Promise<string> {
    // First get the user's email
    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) return userId;
    
    const email = userResult.rows[0].email;
    
    // Check if this email is in team_members
    const teamResult = await query(
      'SELECT owner_user_id FROM team_members WHERE email = $1',
      [email]
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
   * Delete a team member
   */
  async delete(id: string, ownerUserId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM team_members WHERE id = $1 AND owner_user_id = $2',
      [id, ownerUserId]
    );
    return result.rowCount ? result.rowCount > 0 : false;
  }

  /**
   * Check if email already exists as user or team member
   */
  async emailExists(email: string): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();
    
    // Check in users table
    const userResult = await query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    if (userResult.rows.length > 0) return true;
    
    // Check in team_members table
    const teamResult = await query(
      'SELECT id FROM team_members WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    
    return teamResult.rows.length > 0;
  }
}

export const teamMemberService = new TeamMemberService();
