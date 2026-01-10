/**
 * Centralized Logging Service with Admin Panel Integration
 * 
 * Provides structured logging with:
 * - Console output for development
 * - File storage for persistence
 * - In-memory buffer for admin panel viewing
 * - Log levels: error, warn, info, debug
 * - Request correlation IDs
 * - Automatic log rotation
 */

import winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';

// Log storage configuration
const LOG_DIR = path.join(__dirname, '../../logs');
const MAX_LOG_BUFFER_SIZE = 1000; // Keep last 1000 logs in memory for admin panel
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB per log file
const MAX_LOG_FILES = 5; // Keep 5 rotated files

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Log entry interface
export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  category: string;
  correlationId?: string;
  userId?: string;
  metadata?: Record<string, any>;
  stack?: string;
}

// In-memory log buffer for admin panel
class LogBuffer {
  private logs: LogEntry[] = [];
  private maxSize: number;

  constructor(maxSize: number = MAX_LOG_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  add(entry: LogEntry): void {
    this.logs.unshift(entry); // Add to beginning for newest first
    if (this.logs.length > this.maxSize) {
      this.logs.pop(); // Remove oldest
    }
  }

  getAll(): LogEntry[] {
    return [...this.logs];
  }

  getByLevel(level: string): LogEntry[] {
    return this.logs.filter(log => log.level === level);
  }

  getByCategory(category: string): LogEntry[] {
    return this.logs.filter(log => log.category === category);
  }

  getByCorrelationId(correlationId: string): LogEntry[] {
    return this.logs.filter(log => log.correlationId === correlationId);
  }

  getByUserId(userId: string): LogEntry[] {
    return this.logs.filter(log => log.userId === userId);
  }

  search(query: string): LogEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.logs.filter(log => 
      log.message.toLowerCase().includes(lowerQuery) ||
      log.category.toLowerCase().includes(lowerQuery) ||
      JSON.stringify(log.metadata || {}).toLowerCase().includes(lowerQuery)
    );
  }

  getRecent(count: number = 100): LogEntry[] {
    return this.logs.slice(0, count);
  }

  getStats(): {
    total: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
    errorsLast24h: number;
  } {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    
    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let errorsLast24h = 0;

    this.logs.forEach(log => {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;
      byCategory[log.category] = (byCategory[log.category] || 0) + 1;
      
      if (log.level === 'error' && new Date(log.timestamp).getTime() > dayAgo) {
        errorsLast24h++;
      }
    });

    return {
      total: this.logs.length,
      byLevel,
      byCategory,
      errorsLast24h,
    };
  }

  clear(): void {
    this.logs = [];
  }
}

// Create log buffer instance
const internalLogBuffer = new LogBuffer();

// Custom Winston format for structured logging
const structuredFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const logEntry: any = {
    timestamp,
    level,
    message,
    ...metadata
  };
  return JSON.stringify(logEntry);
});

// Create Winston logger
const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    structuredFormat
  ),
  defaultMeta: { service: 'qa-backend' },
  transports: [
    // Error logs to separate file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: MAX_LOG_FILE_SIZE,
      maxFiles: MAX_LOG_FILES,
    }),
    // All logs to combined file
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: MAX_LOG_FILE_SIZE,
      maxFiles: MAX_LOG_FILES,
    }),
  ],
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
  winstonLogger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

// Generate unique log ID
function generateLogId(): string {
  return `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Logger categories
export type LogCategory = 
  | 'auth'
  | 'api'
  | 'database'
  | 'test-execution'
  | 'scheduler'
  | 'webhook'
  | 'websocket'
  | 'credits'
  | 'integration'
  | 'admin'
  | 'security'
  | 'system';

// Main Logger class
class Logger {
  private category: LogCategory;
  private correlationId?: string;
  private userId?: string;

  constructor(category: LogCategory = 'system') {
    this.category = category;
  }

  // Create a child logger with correlation ID
  child(options: { correlationId?: string; userId?: string; category?: LogCategory }): Logger {
    const childLogger = new Logger(options.category || this.category);
    childLogger.correlationId = options.correlationId || this.correlationId;
    childLogger.userId = options.userId || this.userId;
    return childLogger;
  }

  private log(
    level: 'error' | 'warn' | 'info' | 'debug',
    message: string,
    metadata?: Record<string, any>,
    error?: Error
  ): void {
    const entry: LogEntry = {
      id: generateLogId(),
      timestamp: new Date().toISOString(),
      level,
      message,
      category: this.category,
      correlationId: this.correlationId,
      userId: this.userId,
      metadata,
      stack: error?.stack,
    };

    // Add to in-memory buffer for admin panel
    internalLogBuffer.add(entry);

    // Log to Winston
    winstonLogger.log({
      level,
      message,
      category: this.category,
      correlationId: this.correlationId,
      userId: this.userId,
      ...metadata,
      ...(error && { error: error.message, stack: error.stack }),
    });
  }

  error(message: string, error?: Error | any, metadata?: Record<string, any>): void {
    const err = error instanceof Error ? error : undefined;
    const meta = error instanceof Error ? metadata : { ...error, ...metadata };
    this.log('error', message, meta, err);
  }

  warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata);
  }

  info(message: string, metadata?: Record<string, any>): void {
    this.log('info', message, metadata);
  }

  debug(message: string, metadata?: Record<string, any>): void {
    this.log('debug', message, metadata);
  }

  // Security-specific logging methods
  securityEvent(event: string, details: Record<string, any>): void {
    const securityLogger = new Logger('security');
    securityLogger.correlationId = this.correlationId;
    securityLogger.userId = this.userId;
    securityLogger.warn(`[SECURITY] ${event}`, details);
  }

  // API request logging
  apiRequest(method: string, path: string, statusCode: number, durationMs: number, metadata?: Record<string, any>): void {
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    this.log(level, `${method} ${path} ${statusCode} ${durationMs}ms`, {
      method,
      path,
      statusCode,
      durationMs,
      ...metadata,
    });
  }
}

// Export singleton loggers for each category
export const logger = {
  auth: new Logger('auth'),
  api: new Logger('api'),
  database: new Logger('database'),
  testExecution: new Logger('test-execution'),
  scheduler: new Logger('scheduler'),
  webhook: new Logger('webhook'),
  websocket: new Logger('websocket'),
  credits: new Logger('credits'),
  integration: new Logger('integration'),
  admin: new Logger('admin'),
  security: new Logger('security'),
  system: new Logger('system'),
  
  // Create a logger with correlation ID for request tracing
  forRequest(correlationId: string, userId?: string): {
    auth: Logger;
    api: Logger;
    credits: Logger;
    testExecution: Logger;
  } {
    return {
      auth: new Logger('auth').child({ correlationId, userId }),
      api: new Logger('api').child({ correlationId, userId }),
      credits: new Logger('credits').child({ correlationId, userId }),
      testExecution: new Logger('test-execution').child({ correlationId, userId }),
    };
  },
};

// Export log buffer for admin panel API
export const logBuffer = {
  getLogs: (count?: number) => adminLogBuffer.getRecent(count),
  getByLevel: (level: string) => adminLogBuffer.getByLevel(level),
  getByCategory: (category: string) => adminLogBuffer.getByCategory(category),
  getByCorrelationId: (correlationId: string) => adminLogBuffer.getByCorrelationId(correlationId),
  getByUserId: (userId: string) => adminLogBuffer.getByUserId(userId),
  search: (query: string) => adminLogBuffer.search(query),
  getRecent: (count?: number) => adminLogBuffer.getRecent(count),
  getStats: () => adminLogBuffer.getStats(),
  clear: () => adminLogBuffer.clear(),
};

// Alias for adminLogBuffer
const adminLogBuffer = {
  getAll: () => internalLogBuffer.getAll(),
  getByLevel: (level: string) => internalLogBuffer.getByLevel(level),
  getByCategory: (category: string) => internalLogBuffer.getByCategory(category),
  getByCorrelationId: (correlationId: string) => internalLogBuffer.getByCorrelationId(correlationId),
  getByUserId: (userId: string) => internalLogBuffer.getByUserId(userId),
  search: (query: string) => internalLogBuffer.search(query),
  getRecent: (count?: number) => internalLogBuffer.getRecent(count),
  getStats: () => internalLogBuffer.getStats(),
  clear: () => internalLogBuffer.clear(),
};

// Helper functions for external use
export function getLogStats() {
  return internalLogBuffer.getStats();
}

export function searchLogs(options: {
  query?: string;
  level?: string;
  category?: LogCategory;
  userId?: string;
  correlationId?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}): LogEntry[] {
  let results = internalLogBuffer.getAll();
  
  if (options.query) {
    const lowerQuery = options.query.toLowerCase();
    results = results.filter(log => 
      log.message.toLowerCase().includes(lowerQuery) ||
      JSON.stringify(log.metadata || {}).toLowerCase().includes(lowerQuery)
    );
  }
  
  if (options.level) {
    results = results.filter(log => log.level === options.level);
  }
  
  if (options.category) {
    results = results.filter(log => log.category === options.category);
  }
  
  if (options.userId) {
    results = results.filter(log => log.userId === options.userId);
  }
  
  if (options.correlationId) {
    results = results.filter(log => log.correlationId === options.correlationId);
  }
  
  if (options.startTime) {
    results = results.filter(log => new Date(log.timestamp) >= options.startTime!);
  }
  
  if (options.endTime) {
    results = results.filter(log => new Date(log.timestamp) <= options.endTime!);
  }
  
  return results.slice(0, options.limit || 100);
}

// Correlation ID context for async tracking
let currentCorrelationId: string | undefined;

export function setCorrelationId(correlationId: string): void {
  currentCorrelationId = correlationId;
}

export function getCorrelationId(): string | undefined {
  return currentCorrelationId;
}

export default logger;
