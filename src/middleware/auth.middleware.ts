import { clerkMiddleware, requireAuth } from '@clerk/express';

export const clerkAuth = clerkMiddleware();
export const requireAuthentication = requireAuth();
