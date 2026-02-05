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
import { createMonitoringTables } from './db/migrations/013_create_monitoring_tables';
import { addProviderAgentIdColumn } from './db/migrations/014_add_provider_agent_id';
import { up as addScheduleEndOptions } from './db/migrations/016_add_schedule_end_options';
import { up as createAdminSystem } from './db/migrations/017_create_admin_system';
import { addMonitoringFeatureCosts } from './db/migrations/028_add_monitoring_feature_costs';
import { ScheduledTestModel } from './models/scheduledTest.model';
import { schedulerService } from './services/scheduler.service';
import { setWebSocketBroadcast } from './routes/webhook.routes';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

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
    await createMonitoringTables();
    await addProviderAgentIdColumn();
    await addScheduleEndOptions();
    await createAdminSystem();
    await addMonitoringFeatureCosts();
    
    // Create scheduled tests table
    await ScheduledTestModel.createTable();

    // Start the scheduler service
    schedulerService.start();

    // Create HTTP server
    const server = http.createServer(app);

    // WebSocket server for real-time monitoring
    const wss = new WebSocketServer({ server, path: '/ws' });
    
    // Store connections by user ID
    const userConnections = new Map<string, Set<WebSocket>>();

    wss.on('connection', (ws, req) => {
      console.log('[WebSocket] New connection');
      
      // Extract user ID from query string (sent by frontend)
      const url = new URL(req.url || '', `http://localhost`);
      const userId = url.searchParams.get('userId');
      
      if (userId) {
        if (!userConnections.has(userId)) {
          userConnections.set(userId, new Set());
        }
        userConnections.get(userId)!.add(ws);
        console.log(`[WebSocket] User ${userId} connected`);
      }

      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          // Handle ping/pong for keepalive
          if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (e) {
          // Ignore invalid messages
        }
      });

      ws.on('close', () => {
        if (userId) {
          userConnections.get(userId)?.delete(ws);
          if (userConnections.get(userId)?.size === 0) {
            userConnections.delete(userId);
          }
          console.log(`[WebSocket] User ${userId} disconnected`);
        }
      });

      ws.on('error', (error) => {
        console.error('[WebSocket] Error:', error);
      });
    });

    // Set broadcast function for webhooks to use
    setWebSocketBroadcast((userId: string, event: string, data: any) => {
      const connections = userConnections.get(userId);
      if (connections) {
        const message = JSON.stringify({ event, data, timestamp: Date.now() });
        connections.forEach((ws) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        });
        console.log(`[WebSocket] Broadcast to ${connections.size} connections for user ${userId}: ${event}`);
      }
    });

    // Start server
    server.listen(config.port, () => {
      console.log(`🚀 Server running on port ${config.port}`);
      console.log(`📍 Environment: ${config.env}`);
      console.log(`🔗 API URL: http://localhost:${config.port}/api`);
      console.log(`🔌 WebSocket URL: ws://localhost:${config.port}/ws`);
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
