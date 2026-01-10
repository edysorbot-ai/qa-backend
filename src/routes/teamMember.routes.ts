import { Router, Request, Response } from 'express';
import { teamMemberService } from '../services/teamMember.service';
import { userService } from '../services/user.service';
import { emailNotificationService } from '../services/emailNotification.service';
import { alertSettingsService } from '../services/alertSettings.service';
import { clerkClient } from '@clerk/express';
import { pool } from '../db';
import { 
  requireSubscription,
  FeatureKeys 
} from '../middleware/credits.middleware';

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
 * Check team member limit for user's package
 */
async function checkTeamMemberLimit(userId: string): Promise<{ allowed: boolean; current: number; max: number }> {
  const result = await pool.query(`
    SELECT 
      cp.max_team_members,
      (SELECT COUNT(*) FROM team_members WHERE owner_user_id = $1) as current_count
    FROM user_credits uc
    JOIN credit_packages cp ON uc.package_id = cp.id
    WHERE uc.user_id = $1 AND (uc.package_expires_at IS NULL OR uc.package_expires_at > NOW())
  `, [userId]);

  if (!result.rows[0]) {
    return { allowed: false, current: 0, max: 0 };
  }

  const maxMembers = result.rows[0].max_team_members;
  const currentCount = parseInt(result.rows[0].current_count);

  // -1 means unlimited
  if (maxMembers === -1) {
    return { allowed: true, current: currentCount, max: -1 };
  }

  return { 
    allowed: currentCount < maxMembers, 
    current: currentCount, 
    max: maxMembers 
  };
}

/**
 * Assign owner's package and credits to a team member
 * Team members share the same package as their owner
 */
async function assignOwnerPackageToTeamMember(ownerUserId: string, teamMemberEmail: string): Promise<void> {
  try {
    // Get owner's package and credits info
    const ownerCredits = await pool.query(`
      SELECT uc.*, cp.name as package_name
      FROM user_credits uc
      JOIN credit_packages cp ON uc.package_id = cp.id
      WHERE uc.user_id = $1
    `, [ownerUserId]);

    if (!ownerCredits.rows[0]) {
      console.log('[TeamMember] Owner has no package assigned, skipping team member package assignment');
      return;
    }

    const ownerPackage = ownerCredits.rows[0];

    // Get team member's user ID (they were just created in Clerk and our system)
    const teamMemberResult = await pool.query(`
      SELECT u.id FROM users u
      WHERE u.email = $1
    `, [teamMemberEmail]);

    if (!teamMemberResult.rows[0]) {
      console.log('[TeamMember] Team member user not found, will be assigned package on first login');
      return;
    }

    const teamMemberUserId = teamMemberResult.rows[0].id;

    // Check if team member already has credits record
    const existingCredits = await pool.query(
      `SELECT id FROM user_credits WHERE user_id = $1`,
      [teamMemberUserId]
    );

    if (existingCredits.rows.length === 0) {
      // Create user_credits record with owner's package (sharing same credits/limits)
      await pool.query(`
        INSERT INTO user_credits (user_id, package_id, current_credits, total_credits_purchased, package_expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        teamMemberUserId,
        ownerPackage.package_id,
        ownerPackage.current_credits,  // Share same credits
        ownerPackage.total_credits_purchased,
        ownerPackage.package_expires_at
      ]);
      console.log(`[TeamMember] Assigned owner's package "${ownerPackage.package_name}" to team member ${teamMemberEmail}`);
    }
  } catch (error) {
    console.error('[TeamMember] Failed to assign owner package to team member:', error);
    // Don't fail team member creation if package assignment fails
  }
}

/**
 * GET /api/team-members
 * Get all team members for the current user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Check if user is a team member (they shouldn't see this)
    const isTeamMember = await teamMemberService.isTeamMember(userId);
    if (isTeamMember) {
      return res.json({ teamMembers: [], isTeamMember: true });
    }

    const teamMembers = await teamMemberService.findByOwnerId(userId);
    res.json({ teamMembers, isTeamMember: false });
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /api/team-members/check-role
 * Check if current user is an owner or team member
 */
router.get('/check-role', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const isTeamMember = await teamMemberService.isTeamMember(userId);
    res.json({ isTeamMember, isOwner: !isTeamMember });
  } catch (error) {
    console.error('Error checking role:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /api/team-members
 * Create a new team member (requires subscription with team member quota)
 */
router.post('/', 
  requireSubscription,
  async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Check if user is a team member (they can't add members)
    const isTeamMember = await teamMemberService.isTeamMember(userId);
    if (isTeamMember) {
      return res.status(403).json({ message: 'Team members cannot add other team members' });
    }

    // Check team member limit
    const limitCheck = await checkTeamMemberLimit(userId);
    if (!limitCheck.allowed) {
      return res.status(402).json({ 
        error: 'team_member_limit_reached',
        message: 'You have reached the maximum number of team members for your plan',
        details: {
          current: limitCheck.current,
          max: limitCheck.max,
          upgradeRequired: true,
          action: 'Please upgrade your package to add more team members'
        }
      });
    }

    const { email, name, password } = req.body;

    // Validate inputs
    if (!email || !name || !password) {
      return res.status(400).json({ message: 'Email, name, and password are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    // Check if email already exists
    const emailExists = await teamMemberService.emailExists(email);
    if (emailExists) {
      return res.status(400).json({ message: 'This email is already registered' });
    }

    // Create user in Clerk
    let clerkUser;
    try {
      clerkUser = await clerkClient.users.createUser({
        emailAddress: [email],
        password: password,
        firstName: name.split(' ')[0],
        lastName: name.split(' ').slice(1).join(' ') || undefined,
      });
    } catch (clerkError: any) {
      console.error('Clerk user creation error:', clerkError);
      if (clerkError.errors) {
        const errorMessage = clerkError.errors.map((e: any) => e.message).join(', ');
        return res.status(400).json({ message: errorMessage });
      }
      return res.status(400).json({ message: 'Failed to create user account' });
    }

    // Create team member record
    const teamMember = await teamMemberService.create({
      owner_user_id: userId,
      email: email.toLowerCase(),
      name,
      password, // Not stored, just passed through for email
    });

    // Update with clerk_id
    await teamMemberService.updateClerkId(email, clerkUser.id);
    
    // Assign owner's package and credits to team member
    await assignOwnerPackageToTeamMember(userId, email.toLowerCase());

    // Add team member email to owner's alert settings
    await alertSettingsService.addTeamMemberEmail(userId, email, name);

    // Get owner info for email
    const owner = await userService.findById(userId);

    // Send welcome email with credentials
    await emailNotificationService.sendTeamMemberWelcomeEmail({
      toEmail: email,
      name,
      password,
      ownerName: owner ? `${owner.first_name || ''} ${owner.last_name || ''}`.trim() || 'Your team admin' : 'Your team admin',
      loginUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    res.json({ 
      teamMember: { ...teamMember, clerk_id: clerkUser.id, status: 'active' },
      message: 'Team member created successfully. Login credentials sent to their email.' 
    });
  } catch (error) {
    console.error('Error creating team member:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * DELETE /api/team-members/:id
 * Delete a team member
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    const { id } = req.params;

    // Get the team member first to get their clerk_id
    const teamMember = await teamMemberService.findById(id);
    if (!teamMember) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    // Delete from Clerk if they have a clerk_id
    if (teamMember.clerk_id) {
      try {
        await clerkClient.users.deleteUser(teamMember.clerk_id);
      } catch (clerkError) {
        console.error('Error deleting Clerk user:', clerkError);
        // Continue anyway - they might have been deleted already
      }
    }

    // Remove team member email from owner's alert settings
    await alertSettingsService.removeTeamMemberEmail(userId, teamMember.email);

    const deleted = await teamMemberService.delete(id, userId);
    if (!deleted) {
      return res.status(404).json({ message: 'Team member not found or not authorized' });
    }

    res.json({ message: 'Team member removed successfully' });
  } catch (error) {
    console.error('Error deleting team member:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
