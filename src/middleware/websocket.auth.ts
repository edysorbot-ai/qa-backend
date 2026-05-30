/**
 * WebSocket Authentication
 * 
 * Provides authentication for WebSocket connections
 * using Clerk tokens for user authentication with proper signature verification
 */

import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../services/logger.service';
import crypto from 'crypto';

// Types for authenticated WebSocket connections
export interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAuthenticated?: boolean;
  connectionId?: string;
  connectedAt?: Date;
}

export interface WebSocketAuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

/**
 * Extract token from WebSocket connection request
 * Supports token in:
 * - Query string: ?token=xxx
 * - Authorization header: Bearer xxx
 * - Sec-WebSocket-Protocol header
 */
const extractToken = (request: IncomingMessage): string | null => {
  // Try query string first
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }
  
  // Try Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  
  // Try Sec-WebSocket-Protocol header (for browsers that can't set custom headers)
  const protocol = request.headers['sec-websocket-protocol'];
  if (protocol) {
    // Protocol might be in format: "auth, token_xxx" or just "token_xxx"
    const tokens = typeof protocol === 'string' ? protocol.split(',') : protocol;
    for (const token of tokens) {
      const trimmed = token.trim();
      if (trimmed.startsWith('token_')) {
        return trimmed.slice(6); // Remove 'token_' prefix
      }
    }
  }
  
  return null;
};

/**
 * Verify Clerk session token with proper cryptographic signature validation.
 * Uses Clerk's JWKS endpoint to fetch public keys and verify RS256 signatures.
 */

// Cache for JWKS keys (refreshed every 1 hour)
let jwksCache: { keys: any[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchJWKS(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL) {
    return jwksCache.keys;
  }

  // Clerk JWKS endpoint derived from the publishable key
  const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';
  // Extract the instance identifier from pk_test_xxx or pk_live_xxx
  const instanceId = Buffer.from(CLERK_PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, ''), 'base64').toString().replace(/\$$/, '');
  const jwksUrl = `https://${instanceId}/.well-known/jwks.json`;

  try {
    const response = await fetch(jwksUrl);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${response.status}`);
    }
    const data: any = await response.json();
    jwksCache = { keys: data.keys, fetchedAt: Date.now() };
    return data.keys;
  } catch (error) {
    logger.security.error('Failed to fetch JWKS', { error: error instanceof Error ? error.message : 'Unknown' });
    // Return cached keys if available even if expired
    if (jwksCache) return jwksCache.keys;
    return [];
  }
}

function importRSAKey(jwk: any): crypto.KeyObject {
  // Convert JWK to PEM for verification
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObject;
}

const verifyClerkToken = async (token: string): Promise<WebSocketAuthResult> => {
  try {
    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_SECRET_KEY) {
      logger.security.error('CLERK_SECRET_KEY not configured');
      return { authenticated: false, error: 'Server configuration error' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { authenticated: false, error: 'Invalid token format' };
    }

    // Decode header to get key ID (kid)
    try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    // Verify expiration first (fast check)
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return { authenticated: false, error: 'Token expired' };
    }

    // Fetch JWKS and find matching key
    const keys = await fetchJWKS();
    const matchingKey = keys.find((k: any) => k.kid === header.kid);

    if (!matchingKey) {
      // Try refreshing cache in case keys were rotated
      jwksCache = null;
      const freshKeys = await fetchJWKS();
      const freshKey = freshKeys.find((k: any) => k.kid === header.kid);
      if (!freshKey) {
        return { authenticated: false, error: 'No matching signing key found' };
      }
      // Verify signature with fresh key
      const publicKey = importRSAKey(freshKey);
      const signatureValid = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], 'base64url')
      );
      if (!signatureValid) {
        return { authenticated: false, error: 'Invalid token signature' };
      }
    } else {
      // Verify signature with cached key
      const publicKey = importRSAKey(matchingKey);
      const signatureValid = crypto.verify(
        'RSA-SHA256',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], 'base64url')
      );
      if (!signatureValid) {
        return { authenticated: false, error: 'Invalid token signature' };
      }
    }

    // Extract user ID from verified payload
    const userId = payload.sub || payload.userId;
    if (!userId) {
      return { authenticated: false, error: 'No user ID in token' };
    }

    return { authenticated: true, userId };
    } catch (decodeError) {
      return { authenticated: false, error: 'Failed to decode token' };
    }
  } catch (error) {
    logger.security.error('Token verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { authenticated: false, error: 'Token verification failed' };
  }
};

/**
 * Authenticate WebSocket connection
 * Returns authenticated WebSocket with user info attached
 */
export const authenticateWebSocket = async (
  ws: WebSocket,
  request: IncomingMessage
): Promise<AuthenticatedWebSocket> => {
  const authenticatedWs = ws as AuthenticatedWebSocket;
  const connectionId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  authenticatedWs.connectionId = connectionId;
  authenticatedWs.connectedAt = new Date();
  
  const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress;
  
  logger.websocket.info('WebSocket connection attempt', {
    connectionId,
    ip: clientIp,
  });
  
  // Extract token
  const token = extractToken(request);
  
  if (!token) {
    logger.websocket.warn('WebSocket auth failed: No token', {
      connectionId,
      ip: clientIp,
    });
    authenticatedWs.isAuthenticated = false;
    return authenticatedWs;
  }
  
  // Verify token
  const authResult = await verifyClerkToken(token);
  
  if (!authResult.authenticated) {
    logger.security.warn('WebSocket auth failed: Invalid token', {
      connectionId,
      ip: clientIp,
      error: authResult.error,
    });
    authenticatedWs.isAuthenticated = false;
    return authenticatedWs;
  }
  
  // Attach user info to WebSocket
  authenticatedWs.userId = authResult.userId;
  authenticatedWs.isAuthenticated = true;
  
  logger.websocket.info('WebSocket authenticated', {
    connectionId,
    userId: authResult.userId,
    ip: clientIp,
  });
  
  return authenticatedWs;
};

/**
 * Require authentication for WebSocket operations
 * Closes connection if not authenticated
 */
export const requireWebSocketAuth = (ws: AuthenticatedWebSocket): boolean => {
  if (!ws.isAuthenticated || !ws.userId) {
    logger.security.warn('WebSocket operation rejected: Not authenticated', {
      connectionId: ws.connectionId,
    });
    
    ws.send(JSON.stringify({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    }));
    
    ws.close(4001, 'Unauthorized');
    return false;
  }
  return true;
};

/**
 * Verify user can access specific resource
 */
export const verifyWebSocketAccess = (
  ws: AuthenticatedWebSocket,
  resourceUserId: string
): boolean => {
  if (!ws.isAuthenticated || !ws.userId) {
    return false;
  }
  
  if (ws.userId !== resourceUserId) {
    logger.security.warn('WebSocket access denied: User mismatch', {
      connectionId: ws.connectionId,
      requestedResource: resourceUserId,
      actualUser: ws.userId,
    });
    return false;
  }
  
  return true;
};

export default {
  authenticate: authenticateWebSocket,
  requireAuth: requireWebSocketAuth,
  verifyAccess: verifyWebSocketAccess,
};
