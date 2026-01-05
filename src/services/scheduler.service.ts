import { ScheduledTestModel } from "../models/scheduledTest.model";
import { batchedTestExecutor } from "./batched-test-executor.service";
import { emailNotificationService } from "./emailNotification.service";
import { pool } from "../db";
import * as fs from "fs";
import * as path from "path";

// Recordings directory for audio files
const recordingsDir = path.join(__dirname, '../../recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

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

      // Update the scheduled test after successful start
      await ScheduledTestModel.updateAfterRun(scheduledTest.id);

      console.log(`[Scheduler] Started test run ${testRunId} for scheduled test ${scheduledTest.id}`);

      // Execute batches in background
      this.executeBatches(
        testRunId,
        scheduledTest,
        agent
      ).catch((error: Error) => {
        console.error(`[Scheduler] Error executing scheduled test ${scheduledTest.id}:`, error);
      });

    } catch (error) {
      console.error(`[Scheduler] Error running scheduled test ${scheduledTest.id}:`, error);
    }
  }

  /**
   * Execute all batches for a scheduled test
   */
  private async executeBatches(
    testRunId: string,
    scheduledTest: any,
    agent: any
  ): Promise<void> {
    const batches = scheduledTest.batches || [];
    const agentConfig = {
      provider: scheduledTest.provider,
      agentId: scheduledTest.external_agent_id || scheduledTest.agent_id,
      apiKey: agent.api_key,
      phoneNumber: agent.phone_number,
    };
    const enableConcurrency = scheduledTest.enable_concurrency || false;
    const concurrencyCount = scheduledTest.concurrency_count || 1;

    console.log(`[Scheduler] Executing ${batches.length} batches for test run ${testRunId}`);

    // Helper function to execute a single batch
    const executeSingleBatch = async (batch: any, batchIndex: number) => {
      console.log(`[Scheduler] Executing batch ${batchIndex + 1}/${batches.length}: ${batch.name}`);

      try {
        // Update test cases to 'running' status
        for (const tc of batch.testCases) {
          await pool.query(
            `UPDATE test_results SET status = 'running', started_at = $1 
             WHERE test_run_id = $2 AND user_input = $3`,
            [new Date(), testRunId, tc.name]
          );
        }

        // Execute the batch
        const testMode = batch.testMode || 'voice';
        const executionResult = await batchedTestExecutor.executeBatch(
          {
            id: batch.id,
            name: batch.name,
            testMode: testMode,
            testCaseIds: batch.testCases.map((tc: any) => tc.id),
            testCases: batch.testCases.map((tc: any) => ({
              id: tc.id,
              name: tc.name,
              scenario: tc.scenario,
              userInput: tc.name,
              expectedOutcome: tc.expectedOutcome,
              category: tc.category,
              keyTopicId: tc.category,
              keyTopicName: tc.category,
              priority: 'medium' as const,
              canBatchWith: [],
              requiresSeparateCall: false,
              estimatedTurns: 4,
              testType: 'happy_path' as const,
              isCallClosing: false,
              batchPosition: 'any' as const,
            })),
            estimatedDuration: batch.testCases.length * 25,
            primaryTopic: batch.name,
            description: `Testing ${batch.testCases.length} scenarios`,
          },
          agentConfig,
          agent.prompt || ''
        );

        const { results, transcript, totalTurns, durationMs, audioBuffer } = executionResult;

        // Save audio recording if available
        let audioUrl: string | null = null;
        if (audioBuffer && audioBuffer.length > 0) {
          const audioFileName = `${testRunId}_${batch.id}.raw`;
          const audioFilePath = path.join(recordingsDir, audioFileName);
          fs.writeFileSync(audioFilePath, audioBuffer);
          audioUrl = `/api/audio/${audioFileName}`;
          console.log(`[Scheduler] Saved audio: ${audioFilePath}`);
        }

        // Convert transcript to conversation_turns format
        const conversationTurns = transcript.map((t: any) => ({
          role: t.role === 'test_caller' ? 'user' : 'agent',
          content: t.content,
          timestamp: new Date(t.timestamp).toISOString(),
        }));

        // Build transcripts
        const userTranscript = transcript
          .filter((t: any) => t.role === 'test_caller')
          .map((t: any) => t.content)
          .join('\n');
        const agentTranscript = transcript
          .filter((t: any) => t.role === 'ai_agent')
          .map((t: any) => t.content)
          .join('\n');

        // Store results for each test case
        const resultMap = new Map(results.map((r: any) => [r.testCaseName, r]));

        for (const tc of batch.testCases) {
          const result = resultMap.get(tc.name);

          await pool.query(
            `UPDATE test_results 
             SET status = $1, actual_response = $2, 
                 metrics = $3, completed_at = $4,
                 duration_ms = $5,
                 conversation_turns = $6,
                 user_transcript = $7,
                 agent_transcript = $8,
                 batch_id = $9,
                 agent_audio_url = $10,
                 prompt_suggestions = $11
             WHERE test_run_id = $12 AND user_input = $13`,
            [
              result ? (result.passed ? 'passed' : 'failed') : 'failed',
              result?.actualResponse || 'No analysis result',
              JSON.stringify(result ? { ...result.metrics, score: result.score, turnsCovered: result.turnsCovered, hasRecording: !!audioUrl } : { hasRecording: !!audioUrl }),
              new Date(),
              Math.round(durationMs / batch.testCases.length),
              JSON.stringify(conversationTurns),
              userTranscript,
              agentTranscript,
              batch.id,
              audioUrl,
              JSON.stringify(result?.promptSuggestions || []),
              testRunId,
              tc.name,
            ]
          );
        }

        console.log(`[Scheduler] Batch ${batch.id} completed: ${results.filter((r: any) => r.passed).length}/${results.length} passed`);

      } catch (error) {
        console.error(`[Scheduler] Batch ${batch.id} failed:`, error);

        // Mark all test cases in batch as failed
        for (const tc of batch.testCases) {
          await pool.query(
            `UPDATE test_results SET status = 'failed', completed_at = $1,
             actual_response = $2
             WHERE test_run_id = $3 AND user_input = $4`,
            [new Date(), `Batch execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`, testRunId, tc.name]
          );
        }
      }
    };

    // Execute batches - either concurrently or sequentially
    if (enableConcurrency && concurrencyCount > 1) {
      for (let i = 0; i < batches.length; i += concurrencyCount) {
        const chunk = batches.slice(i, i + concurrencyCount);
        const chunkPromises = chunk.map((batch: any, idx: number) => executeSingleBatch(batch, i + idx));
        await Promise.all(chunkPromises);
      }
    } else {
      for (let i = 0; i < batches.length; i++) {
        await executeSingleBatch(batches[i], i);
      }
    }

    // Update test run status to completed
    await pool.query(
      `UPDATE test_runs SET status = 'completed', completed_at = $1 WHERE id = $2`,
      [new Date(), testRunId]
    );

    console.log(`[Scheduler] Completed all batches for ${testRunId}`);

    // Send email notifications for failed tests
    emailNotificationService.checkAndNotifyTestRunFailures(testRunId)
      .then((sent: boolean) => {
        if (sent) {
          console.log(`[Scheduler] Failure notification sent for test run ${testRunId}`);
        }
      })
      .catch((err: Error) => {
        console.error(`[Scheduler] Failed to send notification:`, err);
      });
  }
}

// Export singleton instance
export const schedulerService = SchedulerService.getInstance();
