/**
 * Rate Limiting Middleware
 * 
 * Provides configurable rate limiting for API endpoints
 * with different limits for different endpoint categories
 */

import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { logger } from '../services/logger.service';

// Rate limit configuration
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_GENERAL = 500; // General API: 500 requests per 15 min
const RATE_LIMIT_AUTH = 20; // Auth endpoints: 20 requests per 15 min
const RATE_LIMIT_TEST_EXECUTION = 200; // Test execution: 200 requests per 15 min (polling + status checks)
const RATE_LIMIT_ADMIN = 500; // Admin panel: 500 requests per 15 min

// Helper to safely get IP address
const getClientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const forwardedFor = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
};

// Custom handler for rate limit exceeded
const rateLimitHandler = (req: Request, res: Response) => {
  const userId = (req as any).auth?.userId;
  logger.security.warn('Rate limit exceeded', {
    ip: getClientIp(req),
    userId,
    path: req.path,
    method: req.method,
  });
  
  res.status(429).json({
    error: 'Too many requests',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
  });
};

// Skip rate limiting for certain conditions
const shouldSkip = (req: Request): boolean => {
  // Skip for health checks
  if (req.path === '/api/health') return true;
  
  // Skip for WebSocket upgrade requests
  if (req.headers.upgrade === 'websocket') return true;
  
  return false;
};

/**
 * General API rate limiter
 * 100 requests per 15 minutes per user/IP
 */
export const generalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_GENERAL,
  // Use default keyGenerator to avoid IPv6 issues
  handler: rateLimitHandler,
  skip: shouldSkip,
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please try again later.',
  },
  validate: { xForwardedForHeader: false },
});

/**
 * Stricter rate limiter for authentication endpoints
 * 20 requests per 15 minutes per IP (to prevent brute force)
 */
export const authRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_AUTH,
  handler: (req: Request, res: Response) => {
    logger.security.warn('Auth rate limit exceeded (potential brute force)', {
      ip: getClientIp(req),
      path: req.path,
      method: req.method,
    });
    
    res.status(429).json({
      error: 'Too many authentication attempts',
      message: 'Please wait before trying again.',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

/**
 * Rate limiter for test execution endpoints
 * 30 requests per 15 minutes per user
 */
export const testExecutionRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_TEST_EXECUTION,
  handler: (req: Request, res: Response) => {
    logger.testExecution.warn('Test execution rate limit exceeded', {
      ip: getClientIp(req),
      userId: (req as any).auth?.userId,
      path: req.path,
    });
    
    res.status(429).json({
      error: 'Too many test executions',
      message: 'You have reached the maximum number of test runs. Please wait before starting more tests.',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

/**
 * Rate limiter for admin panel
 * 200 requests per 15 minutes
 */
export const adminRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_ADMIN,
  handler: rateLimitHandler,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

/**
 * Very strict rate limiter for sensitive operations
 * 5 requests per 15 minutes
 */
export const sensitiveOperationRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 5,
  handler: (req: Request, res: Response) => {
    logger.security.warn('Sensitive operation rate limit exceeded', {
      ip: getClientIp(req),
      userId: (req as any).auth?.userId,
      path: req.path,
    });
    
    res.status(429).json({
      error: 'Too many requests',
      message: 'This operation is rate limited. Please try again later.',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
});

export default {
  general: generalRateLimiter,
  auth: authRateLimiter,
  testExecution: testExecutionRateLimiter,
  admin: adminRateLimiter,
  sensitiveOperation: sensitiveOperationRateLimiter,
};
