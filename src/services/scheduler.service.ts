import { ScheduledTestModel } from "../models/scheduledTest.model";
import { BatchedTestExecutor } from "./batched-test-executor.service";
import { pool } from "../db";

/**
 * Scheduler Service
 * Handles running scheduled tests via a polling mechanism
 */
export class SchedulerService {
  private static instance: SchedulerService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private checkIntervalMs: number = 60000; // Check every minute

  private constructor() {}

  static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService();
    }
    return SchedulerService.instance;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      console.log("[Scheduler] Already running");
      return;
    }

    console.log("[Scheduler] Starting scheduler service...");
    this.isRunning = true;

    // Run immediately on start
    this.checkAndRunDueTests();

    // Then run periodically
    this.intervalId = setInterval(() => {
      this.checkAndRunDueTests();
    }, this.checkIntervalMs);

    console.log(`[Scheduler] Scheduler started, checking every ${this.checkIntervalMs / 1000} seconds`);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[Scheduler] Scheduler stopped");
  }

  /**
   * Check for due tests and run them
   */
  private async checkAndRunDueTests(): Promise<void> {
    try {
      const dueTests = await ScheduledTestModel.findDueTests();

      if (dueTests.length === 0) {
        return;
      }

      console.log(`[Scheduler] Found ${dueTests.length} due test(s) to run`);

      for (const scheduledTest of dueTests) {
        await this.runScheduledTest(scheduledTest);
      }
    } catch (error) {
      console.error("[Scheduler] Error checking for due tests:", error);
    }
  }

  /**
   * Run a single scheduled test
   */
  private async runScheduledTest(scheduledTest: any): Promise<void> {
    console.log(`[Scheduler] Running scheduled test: ${scheduledTest.name} (${scheduledTest.id})`);

    try {
      // Get the agent details
      const agentQuery = `
        SELECT a.*, i.api_key 
        FROM agents a 
        LEFT JOIN integrations i ON a.integration_id = i.id
        WHERE a.id = $1
      `;
      const agentResult = await pool.query(agentQuery, [scheduledTest.agent_id]);

      if (!agentResult.rows[0]) {
        console.error(`[Scheduler] Agent not found for scheduled test: ${scheduledTest.id}`);
        await ScheduledTestModel.updateStatus(scheduledTest.id, "paused");
        return;
      }

      const agent = agentResult.rows[0];

      // Create a test run
      const testRunQuery = `
        INSERT INTO test_runs (
          user_id, name, status, agent_id, provider, config, progress
        ) VALUES ($1, $2, 'pending', $3, $4, $5, 0)
        RETURNING id
      `;

      const testRunResult = await pool.query(testRunQuery, [
        scheduledTest.user_id,
        `[Scheduled] ${scheduledTest.name}`,
        scheduledTest.agent_id,
        scheduledTest.provider,
        JSON.stringify({
          agentName: scheduledTest.agent_name,
          scheduledTestId: scheduledTest.id,
          enableBatching: scheduledTest.enable_batching,
          enableConcurrency: scheduledTest.enable_concurrency,
          concurrencyCount: scheduledTest.concurrency_count,
        }),
      ]);

      const testRunId = testRunResult.rows[0].id;

      // Start the batched test executor
      const executor = new BatchedTestExecutor(
        testRunId,
        scheduledTest.provider,
        scheduledTest.external_agent_id || scheduledTest.agent_id,
        scheduledTest.agent_id,
        agent.api_key,
        scheduledTest.batches,
        {
          enableBatching: scheduledTest.enable_batching,
          enableConcurrency: scheduledTest.enable_concurrency,
          concurrencyCount: scheduledTest.concurrency_count,
          agentConfig: agent.config,
          agentPrompt: agent.prompt,
          integrationId: scheduledTest.integration_id,
        }
      );

      // Run in background (don't await)
      executor.execute().catch((error) => {
        console.error(`[Scheduler] Error executing scheduled test ${scheduledTest.id}:`, error);
      });

      // Update the scheduled test after successful start
      await ScheduledTestModel.updateAfterRun(scheduledTest.id);

      console.log(`[Scheduler] Started test run ${testRunId} for scheduled test ${scheduledTest.id}`);
    } catch (error) {
      console.error(`[Scheduler] Error running scheduled test ${scheduledTest.id}:`, error);
    }
  }
}

// Export singleton instance
export const schedulerService = SchedulerService.getInstance();
