import app from './app';
import { config } from './config';
import { pool, connectWithRetry } from './db';
import { initializeDatabase } from './db/migrations/init';
import { addTestCaseColumns } from './db/migrations/003_add_test_case_columns';
import { addPromptVersionsTable } from './db/migrations/007_add_prompt_versions';
import { addConfigVersionsTable } from './db/migrations/008_add_config_versions';
import { addTestCaseCategoryPriority } from './db/migrations/009_add_test_case_category_priority';
import { addPromptSuggestionsColumn } from './db/migrations/010_add_prompt_suggestions';
import { createTestWorkflowsTable } from './db/migrations/011_create_test_workflows';
import { updateAlertEmailStructure } from './db/migrations/012_update_alert_email_structure';
import { ScheduledTestModel } from './models/scheduledTest.model';
import { schedulerService } from './services/scheduler.service';

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
    await addPromptVersionsTable();
    await addConfigVersionsTable();
    await addTestCaseCategoryPriority();
    await addPromptSuggestionsColumn();
    await createTestWorkflowsTable();
    await updateAlertEmailStructure();
    
    // Create scheduled tests table
    await ScheduledTestModel.createTable();

    // Start the scheduler service
    schedulerService.start();

    // Start server
    app.listen(config.port, () => {
      console.log(`🚀 Server running on port ${config.port}`);
      console.log(`📍 Environment: ${config.env}`);
      console.log(`🔗 API URL: http://localhost:${config.port}/api`);
      console.log(`⏰ Scheduler service started`);
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
  schedulerService.stop();
  await pool.end();
  process.exit(0);
});

startServer();
