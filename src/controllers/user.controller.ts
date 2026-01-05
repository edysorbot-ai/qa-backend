import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

export class UserController {
  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      if (!clerkUser?.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      res.json({ user });
    } catch (error) {
      next(error);
    }
  }

  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      if (!clerkUser?.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const updatedUser = await userService.update(user.id, req.body);
      res.json({ user: updatedUser });
    } catch (error) {
      next(error);
    }
  }

  async getDashboardStats(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      if (!clerkUser?.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);
      
      const stats = await userService.getDashboardStats(effectiveUserId);

      res.json({ stats });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
