import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';

export class UserController {
  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      if (!clerkUser?.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      let user = await userService.findByClerkId(clerkUser.userId);
      
      if (!user) {
        // Create user if doesn't exist
        user = await userService.create({
          clerk_id: clerkUser.userId,
          email: clerkUser.sessionClaims?.email || '',
          first_name: clerkUser.sessionClaims?.first_name,
          last_name: clerkUser.sessionClaims?.last_name,
        });
      }

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

      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updatedUser = await userService.update(user.id, req.body);
      res.json({ user: updatedUser });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
