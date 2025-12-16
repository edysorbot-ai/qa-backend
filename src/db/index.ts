import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000, // Increased timeout for Neon cold starts
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

export const getClient = async () => {
  const client = await pool.connect();
  return client;
};

export default pool;
