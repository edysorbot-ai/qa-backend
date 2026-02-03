/**
 * Test Execution Queue Service
 * Uses BullMQ for managing parallel test execution jobs
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

// Types for job data
export interface TestJobData {
  testRunId: string;
  testCaseId: string;
  testCase: {
    id: string;
    scenario: string;
    userInput: string;
    expectedResponse: string;
    category: string;
  };
  agentConfig: {
    provider: 'elevenlabs' | 'retell' | 'vapi' | 'haptik';
    agentId: string;
    apiKey: string;
    agentName: string;
  };
  ttsConfig: {
    voice: string;
    model: string;
  };
  priority: number;
  batchNumber: number;
}

export interface TestJobResult {
  testRunId: string;
  testCaseId: string;
  success: boolean;
  metrics: {
    firstResponseLatencyMs?: number;
    totalDurationMs: number;
    userAudioDurationMs?: number;
    agentAudioDurationMs?: number;
  };
  transcript: {
    userInput: string;
    agentResponse: string;
  };
  analysis?: {
    intentMatch: boolean;
    responseQuality: number; // 1-5
    keywordsMatched: string[];
    keywordsMissed: string[];
    sentiment: 'positive' | 'neutral' | 'negative';
    confidenceScore: number;
  };
  error?: string;
  timestamp: Date;
}

// Queue names
const QUEUE_NAME = 'voice-test-execution';
const EVENTS_QUEUE_NAME = 'voice-test-events';

// Redis connection
let redisConnection: Redis | null = null;
let redisConnectionFailed = false;

export function getRedisConnection(): Redis | null {
  if (redisConnectionFailed) {
    return null;
  }
  
  if (!redisConnection) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      redisConnection = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times) => {
          if (times > 3) {
            console.warn('[Queue] Redis unavailable - Queue features disabled. Install and start Redis to enable job queuing.');
            redisConnectionFailed = true;
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000);
        },
        reconnectOnError: () => false,
      });
      
      redisConnection.on('error', (err: any) => {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          if (!redisConnectionFailed) {
            console.warn('[Queue] Redis connection failed - Queue features disabled');
            redisConnectionFailed = true;
          }
        }
      });
      
      redisConnection.on('connect', () => {
        console.log('[Queue] Redis connected successfully');
        redisConnectionFailed = false;
      });
    } catch (error) {
      console.warn('[Queue] Failed to initialize Redis:', error);
      redisConnectionFailed = true;
      return null;
    }
  }
  return redisConnection;
}

/**
 * Test Execution Queue Manager
 */
export class TestExecutionQueue {
  private queue: Queue<TestJobData, TestJobResult>;
  private queueEvents: QueueEvents;
  private worker: Worker<TestJobData, TestJobResult> | null = null;

  constructor() {
    const connection = getRedisConnection();
    
    if (!connection) {
      console.warn('[Queue] Queue service disabled - Redis not available');
      // Create stub objects to prevent errors
      this.queue = null as any;
      this.queueEvents = null as any;
      return;
    }
    
    this.queue = new Queue<TestJobData, TestJobResult>(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
        },
      },
    });

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  }

  /**
   * Add a batch of test cases to the queue
   */
  async addTestBatch(
    testRunId: string,
    testCases: TestJobData['testCase'][],
    agentConfig: TestJobData['agentConfig'],
    ttsConfig: TestJobData['ttsConfig'],
    concurrency: number = 1
  ): Promise<string[]> {
    if (!this.queue) {
      console.warn('[Queue] Cannot add test batch - Redis not available');
      return [];
    }
    
    const jobIds: string[] = [];
    const batchSize = Math.ceil(testCases.length / concurrency);
    
    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const batchNumber = Math.floor(i / batchSize);
      
      const jobData: TestJobData = {
        testRunId,
        testCaseId: testCase.id,
        testCase,
        agentConfig,
        ttsConfig,
        priority: i, // Earlier test cases have higher priority
        batchNumber,
      };

      const job = await this.queue.add(`test-${testCase.id}`, jobData, {
        priority: i,
        jobId: `${testRunId}-${testCase.id}`,
      });

      jobIds.push(job.id!);
    }

    return jobIds;
  }

  /**
   * Start a worker to process test jobs
   */
  startWorker(
    processor: (job: Job<TestJobData, TestJobResult>) => Promise<TestJobResult>,
    concurrency: number = 1
  ): Worker<TestJobData, TestJobResult> | null {
    const connection = getRedisConnection();
    
    if (!connection) {
      console.warn('[Queue] Cannot start worker - Redis not available');
      return null;
    }
    
    this.worker = new Worker<TestJobData, TestJobResult>(
      QUEUE_NAME,
      processor,
      {
        connection,
        concurrency,
        limiter: {
          max: concurrency,
          duration: 1000,
        },
      }
    );

    this.worker.on('completed', (job, result) => {
      console.log(`Job ${job.id} completed:`, result.success ? 'SUCCESS' : 'FAILED');
    });

    this.worker.on('failed', (job, error) => {
      console.error(`Job ${job?.id} failed:`, error.message);
    });

    this.worker.on('progress', (job, progress) => {
      console.log(`Job ${job.id} progress:`, progress);
    });

    return this.worker;
  }

  /**
   * Get status of a test run
   */
  async getTestRunStatus(testRunId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    progress: number;
  }> {
    if (!this.queue) {
      return { total: 0, completed: 0, failed: 0, pending: 0, progress: 0 };
    }
    
    const jobs = await this.queue.getJobs(['completed', 'failed', 'waiting', 'active']);
    const runJobs = jobs.filter(j => j.data.testRunId === testRunId);
    
    const completed = runJobs.filter(j => j.finishedOn).length;
    const failed = runJobs.filter(j => j.failedReason).length;
    const pending = runJobs.length - completed - failed;
    
    return {
      total: runJobs.length,
      completed: completed - failed,
      failed,
      pending,
      progress: runJobs.length > 0 ? Math.round((completed / runJobs.length) * 100) : 0,
    };
  }

  /**
   * Get results of a test run
   */
  async getTestRunResults(testRunId: string): Promise<TestJobResult[]> {
    const jobs = await this.queue.getJobs(['completed']);
    const runJobs = jobs.filter(j => j.data.testRunId === testRunId);
    
    const results: TestJobResult[] = [];
    for (const job of runJobs) {
      if (job.returnvalue) {
        results.push(job.returnvalue);
      }
    }
    
    return results;
  }

  /**
   * Cancel all jobs for a test run
   */
  async cancelTestRun(testRunId: string): Promise<number> {
    if (!this.queue) {
      return 0;
    }
    
    const jobs = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    const runJobs = jobs.filter(j => j.data.testRunId === testRunId);
    
    let cancelled = 0;
    for (const job of runJobs) {
      try {
        await job.remove();
        cancelled++;
      } catch (e) {
        // Job may have already completed
      }
    }
    
    return cancelled;
  }

  /**
   * Pause the queue
   */
  async pause(): Promise<void> {
    if (!this.queue) return;
    await this.queue.pause();
  }

  /**
   * Resume the queue
   */
  async resume(): Promise<void> {
    if (!this.queue) return;
    await this.queue.resume();
  }

  /**
   * Get queue metrics
   */
  async getMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    if (!this.queue) {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
    
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Listen for job events
   */
  onJobCompleted(callback: (jobId: string, result: TestJobResult) => void) {
    if (!this.queueEvents) return;
    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      callback(jobId, JSON.parse(returnvalue));
    });
  }

  onJobFailed(callback: (jobId: string, error: string) => void) {
    if (!this.queueEvents) return;
    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      callback(jobId, failedReason);
    });
  }

  onJobProgress(callback: (jobId: string, progress: number) => void) {
    if (!this.queueEvents) return;
    this.queueEvents.on('progress', ({ jobId, data }) => {
      callback(jobId, Number(data));
    });
  }

  /**
   * Get job data by test case ID
   */
  async getJobData(testCaseId: string): Promise<TestJobData | null> {
    if (!this.queue) {
      return null;
    }
    
    try {
      // Try to find job with this test case ID
      const jobs = await this.queue.getJobs(['active', 'waiting', 'completed']);
      for (const job of jobs) {
        if (job.data.testCaseId === testCaseId) {
          return job.data;
        }
      }
      return null;
    } catch (error) {
      console.error('Error getting job data:', error);
      return null;
    }
  }

  /**
   * Cleanup and close connections
   */
  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.queue) {
      await this.queue.close();
    }
    if (this.queueEvents) {
      await this.queueEvents.close();
    }
  }
}

// Export singleton instance
export const testExecutionQueue = new TestExecutionQueue();
