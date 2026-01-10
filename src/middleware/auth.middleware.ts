import { clerkMiddleware } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../services/logger.service';

export const clerkAuth = clerkMiddleware();

export const requireAuthentication = (req: Request, res: Response, next: NextFunction) => {
  // clerkMiddleware already attaches auth data to req.auth as an object
  const auth = (req as any).auth;
  
  // Log authentication attempts (without sensitive data)
  logger.auth.debug('Authentication check', {
    path: req.path,
    method: req.method,
    hasAuth: !!auth,
    hasUserId: !!auth?.userId,
  });
  
  if (!auth?.userId) {
    logger.auth.warn('Authentication failed: No user ID', {
      path: req.path,
      method: req.method,
      ip: req.ip,
    });
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }
  
  logger.auth.debug('User authenticated', {
    userId: auth.userId,
    path: req.path,
  });
  
  next();
};
