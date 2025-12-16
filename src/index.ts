import app from './app';
import { config } from './config';
import { pool, connectWithRetry } from './db';
import { initializeDatabase } from './db/migrations/init';
import { addTestCaseColumns } from './db/migrations/003_add_test_case_columns';

const startServer = async () => {
  try {
    // Test database connection with retries (for Neon cold starts)
    const connected = await connectWithRetry(3, 5000);
    if (!connected) {
      throw new Error('Failed to connect to database after multiple retries');
    }

    // Initialize database tables
    await initializeDatabase();
    
    // Run additional migrations
    await addTestCaseColumns();

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
