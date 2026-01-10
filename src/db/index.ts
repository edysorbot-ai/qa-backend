import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 10000, // Reduced for Neon - close idle connections faster
  connectionTimeoutMillis: 30000, // Increased timeout for Neon cold starts
  keepAlive: true, // Enable TCP keepalive to prevent connection drops
  keepAliveInitialDelayMillis: 10000, // Start keepalive after 10 seconds
});

pool.on('connect', () => {
  console.log('✅ Connected to Neon PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  // Don't exit on error - try to reconnect
});

// Retry connection helper for Neon cold starts
export const connectWithRetry = async (maxRetries = 3, delayMs = 5000): Promise<boolean> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Database connection attempt ${attempt}/${maxRetries}...`);
      const client = await pool.connect();
      client.release();
      console.log('✅ Database connection successful');
      return true;
    } catch (error) {
      console.log(`⏳ Attempt ${attempt} failed. ${attempt < maxRetries ? `Retrying in ${delayMs/1000}s...` : 'No more retries.'}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  return false;
};

export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
  return res;
};

/**
 * Query with retry logic for handling Neon PostgreSQL cold starts and transient failures
 */
export const queryWithRetry = async (text: string, params?: any[], maxRetries = 3, delayMs = 2000) => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const start = Date.now();
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
      return res;
    } catch (error: any) {
      lastError = error;
      const isRetryable = ['ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'ECONNRESET', '57P01'].some(
        code => error.code === code || error.message?.includes(code)
      );
      
      if (isRetryable && attempt < maxRetries) {
        console.log(`[DB] Query attempt ${attempt} failed (${error.code}), retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
  }
  
  throw lastError;
};

export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export default pool;
