import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { logger } from "../services/logger.service";

// SECURITY: JWT secret must be provided via environment variable
// No fallback to hardcoded value for production security
const getAdminJwtSecret = (): string => {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    logger.security.error('ADMIN_JWT_SECRET environment variable is not set');
    throw new Error('ADMIN_JWT_SECRET must be configured');
  }
  if (secret.length < 32) {
    logger.security.warn('ADMIN_JWT_SECRET should be at least 32 characters for security');
  }
  return secret;
};

export interface AdminTokenPayload {
  adminId: string;
  username: string;
  role: string;
}

export interface AdminRequest extends Request {
  admin?: AdminTokenPayload;
}

export const adminAuth = (req: AdminRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.security.warn('Admin auth failed: No token provided', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, getAdminJwtSecret()) as AdminTokenPayload;
    req.admin = decoded;
    
    logger.security.debug('Admin authenticated', {
      adminId: decoded.adminId,
      username: decoded.username,
      role: decoded.role,
      path: req.path,
    });
    
    next();
  } catch (error) {
    logger.security.warn('Admin auth failed: Invalid token', {
      ip: req.ip,
      path: req.path,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

export const generateAdminToken = (admin: { id: string; username: string; role: string }): string => {
  logger.security.info('Admin token generated', {
    adminId: admin.id,
    username: admin.username,
    role: admin.role,
  });
  
  return jwt.sign(
    {
      adminId: admin.id,
      username: admin.username,
      role: admin.role,
    },
    getAdminJwtSecret(),
    { expiresIn: "24h" }
  );
};
