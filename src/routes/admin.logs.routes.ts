/**
 * Admin Logs Routes
 * 
 * Provides API endpoints for viewing application logs
 * from the admin panel
 */

import { Router, Response } from 'express';
import { adminAuth, AdminRequest } from '../middleware/admin.middleware';
import { adminRateLimiter } from '../middleware/rateLimit.middleware';
import { 
  logBuffer, 
  getLogStats, 
  searchLogs, 
  LogCategory,
  LogEntry 
} from '../services/logger.service';

const router = Router();

/**
 * GET /api/admin/logs
 * Get recent logs with optional filtering
 */
router.get(
  '/',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      const {
        limit = '100',
        level,
        category,
        userId,
        search,
        startTime,
        endTime,
      } = req.query;

      let logs: LogEntry[] = logBuffer.getLogs(parseInt(limit as string, 10) || 100);

      // Apply filters
      if (level) {
        logs = logs.filter((log: LogEntry) => log.level === level);
      }

      if (category) {
        logs = logs.filter((log: LogEntry) => log.category === category);
      }

      if (userId) {
        logs = logs.filter((log: LogEntry) => log.metadata?.userId === userId);
      }

      if (startTime) {
        const start = new Date(startTime as string);
        logs = logs.filter((log: LogEntry) => new Date(log.timestamp) >= start);
      }

      if (endTime) {
        const end = new Date(endTime as string);
        logs = logs.filter((log: LogEntry) => new Date(log.timestamp) <= end);
      }

      if (search) {
        const searchStr = (search as string).toLowerCase();
        logs = logs.filter((log: LogEntry) => 
          log.message.toLowerCase().includes(searchStr) ||
          JSON.stringify(log.metadata || {}).toLowerCase().includes(searchStr)
        );
      }

      res.json({
        success: true,
        data: {
          logs,
          total: logs.length,
          filters: {
            limit: parseInt(limit as string, 10) || 100,
            level: level || null,
            category: category || null,
            userId: userId || null,
            search: search || null,
          },
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve logs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * GET /api/admin/logs/stats
 * Get log statistics
 */
router.get(
  '/stats',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      const stats = getLogStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve log stats',
      });
    }
  }
);

/**
 * GET /api/admin/logs/search
 * Search logs with advanced query
 */
router.get(
  '/search',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      const {
        query,
        level,
        category,
        userId,
        correlationId,
        startTime,
        endTime,
        limit = '100',
      } = req.query;

      const results = searchLogs({
        query: query as string,
        level: level as string,
        category: category as LogCategory,
        userId: userId as string,
        correlationId: correlationId as string,
        startTime: startTime ? new Date(startTime as string) : undefined,
        endTime: endTime ? new Date(endTime as string) : undefined,
        limit: parseInt(limit as string, 10) || 100,
      });

      res.json({
        success: true,
        data: {
          logs: results,
          total: results.length,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Search failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

/**
 * GET /api/admin/logs/categories
 * Get available log categories
 */
router.get(
  '/categories',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      const categories: LogCategory[] = [
        'auth',
        'api',
        'database',
        'test-execution',
        'scheduler',
        'webhook',
        'websocket',
        'credits',
        'integration',
        'admin',
        'security',
        'system',
      ];

      res.json({
        success: true,
        data: { categories },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve categories',
      });
    }
  }
);

/**
 * GET /api/admin/logs/levels
 * Get available log levels
 */
router.get(
  '/levels',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      const levels = ['error', 'warn', 'info', 'debug'];

      res.json({
        success: true,
        data: { levels },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve levels',
      });
    }
  }
);

/**
 * POST /api/admin/logs/clear
 * Clear log buffer (admin only)
 */
router.post(
  '/clear',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      // Only super admins can clear logs
      if (req.admin?.role !== 'super_admin') {
        return res.status(403).json({
          success: false,
          error: 'Only super admins can clear logs',
        });
      }

      logBuffer.clear();

      res.json({
        success: true,
        message: 'Log buffer cleared',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to clear logs',
      });
    }
  }
);

/**
 * GET /api/admin/logs/stream
 * Server-Sent Events endpoint for real-time log streaming
 */
router.get(
  '/stream',
  adminRateLimiter,
  adminAuth,
  async (req: AdminRequest, res: Response) => {
    try {
      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Log stream connected' })}\n\n`);

      // Send logs every 2 seconds
      let lastLogCount = logBuffer.getLogs(1).length;
      const interval = setInterval(() => {
        const currentLogs = logBuffer.getLogs(100);
        const newLogs = currentLogs.slice(0, currentLogs.length - lastLogCount);
        
        if (newLogs.length > 0) {
          for (const log of newLogs) {
            res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
          }
          lastLogCount = currentLogs.length;
        }
      }, 2000);

      // Cleanup on client disconnect
      req.on('close', () => {
        clearInterval(interval);
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to establish log stream',
      });
    }
  }
);

export default router;
