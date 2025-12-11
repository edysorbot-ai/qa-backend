import dotenv from 'dotenv';

dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  
  database: {
    url: process.env.DATABASE_URL || '',
  },
  
  clerk: {
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
    secretKey: process.env.CLERK_SECRET_KEY || '',
  },
  
  cors: {
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  },
};
