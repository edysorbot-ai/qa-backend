import { clerkMiddleware, getAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';

export const clerkAuth = clerkMiddleware();

export const requireAuthentication = (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  
  // Debug logging
  console.log('Auth object:', JSON.stringify(auth, null, 2));
  console.log('Authorization header:', req.headers.authorization?.substring(0, 50) + '...');
  
  if (!auth?.userId) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Authentication required'
    });
  }
  
  // Attach auth to request for use in controllers
  (req as any).auth = auth;
  next();
};
