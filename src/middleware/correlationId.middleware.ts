/**
 * Correlation ID Middleware
 * 
 * Generates unique correlation IDs for request tracing
 * across services and logs
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger, setCorrelationId } from '../services/logger.service';

// Header name for correlation ID
const CORRELATION_ID_HEADER = 'X-Correlation-ID';
const REQUEST_ID_HEADER = 'X-Request-ID';

// Extend Request type to include correlationId
declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      requestStartTime?: number;
    }
  }
}

/**
 * Correlation ID middleware
 * - Extracts existing correlation ID from headers or generates a new one
 * - Attaches to request object for use in handlers
 * - Adds to response headers for client tracking
 * - Sets up logging context
 */
export const correlationIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Get existing correlation ID from header or generate new one
  const correlationId = 
    (req.headers[CORRELATION_ID_HEADER.toLowerCase()] as string) ||
    (req.headers[REQUEST_ID_HEADER.toLowerCase()] as string) ||
    uuidv4();
  
  // Store start time for request duration logging
  req.requestStartTime = Date.now();
  
  // Attach correlation ID to request object
  req.correlationId = correlationId;
  
  // Set correlation ID in logging context
  setCorrelationId(correlationId);
  
  // Add correlation ID to response headers
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  res.setHeader(REQUEST_ID_HEADER, correlationId);
  
  // Log incoming request
  const userId = (req as any).auth?.userId;
  logger.api.info(`Incoming request: ${req.method} ${req.path}`, {
    correlationId,
    method: req.method,
    path: req.path,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    userId,
  });
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - (req.requestStartTime || Date.now());
    const logLevel = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger.api[logLevel](`Response: ${req.method} ${req.path} ${res.statusCode}`, {
      correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userId,
    });
  });
  
  next();
};

/**
 * Get correlation ID from request
 */
export const getCorrelationId = (req: Request): string => {
  return req.correlationId || 'unknown';
};

/**
 * Create child correlation ID for sub-operations
 * Useful for tracking nested async operations
 */
export const createChildCorrelationId = (parentId: string): string => {
  const childSuffix = uuidv4().slice(0, 8);
  return `${parentId}:${childSuffix}`;
};

export default correlationIdMiddleware;
