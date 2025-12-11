import app from './app';
import { config } from './config';
import { pool } from './db';
import { initializeDatabase } from './db/migrations/init';

const startServer = async () => {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connection successful');

    // Initialize database tables
    await initializeDatabase();

    // Start server
    app.listen(config.port, () => {
      console.log(`🚀 Server running on port ${config.port}`);
      console.log(`📍 Environment: ${config.env}`);
      console.log(`🔗 API URL: http://localhost:${config.port}/api`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();
