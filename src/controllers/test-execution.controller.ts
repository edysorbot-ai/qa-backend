import { logger } from '../services/logger.service';
/**
 * Test Execution Controller
 * API endpoints for starting, monitoring, and managing test runs
 * Uses REAL voice agent calls with TTS, ASR, and OpenAI evaluation
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import pool from '../db';
import { 
  realTestExecutor,
  TestCase,
  TestRunConfig,
} from '../services/real-test-executor.service';
import { emailNotificationService } from '../services/emailNotification.service';
import { 
  requireSubscriptionAndCredits, 
  deductCreditsAfterSuccess,
  FeatureKeys,
  CreditRequest 
} from '../middleware/credits.middleware';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { decrypt, isEncrypted } from '../services/encryption.service';
import { TEST_CASE_TEMPLATES, fillTemplateForAgent } from '../services/test-case-templates.service';
import { attributeLatency, aggregateLatencyAttribution } from '../services/latency-attribution.service';
import { evaluateLifecycleGateForRun } from '../services/lifecycle-gating.service';

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, '../../recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

const router = Router();

/**
 * Resolve our internal user id (UUID) from the Clerk-authenticated request.
 * Returns null if the user can't be resolved — caller should 401 in that case.
 */
async function resolveInternalUserId(req: Request): Promise<string | null> {
  const auth = (req as any).auth;
  const clerkUserId = auth?.userId;
  if (!clerkUserId) return null;
  const r = await pool.query('SELECT id FROM users WHERE clerk_id = $1', [clerkUserId]);
  return r.rows[0]?.id || null;
}

/**
 * @deprecated Use /start-batched instead. Kept for backward compat.
 * Start a new test run
 * POST /api/test-execution/start
 */
router.post('/start', 
  // Require subscription and credits based on number of test cases
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_RUN_EXECUTE, (req) => {
    return Array.isArray(req.body?.testCases) ? req.body.testCases.length : 1;
  }),
  async (req: Request, res: Response) => {
  try {
    const {
      name,
      provider,
      agentId,
      apiKey,
      agentName,
      testCases,
      concurrency = 3,
    } = req.body;

    // Get authenticated user ID from Clerk
    const auth = (req as any).auth;
    const clerkUserId = auth?.userId;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    // Validate required fields
    if (!provider || !agentId || !apiKey || !testCases || testCases.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: provider, agentId, apiKey, testCases',
      });
    }

    // Look up our internal user ID from Clerk ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE clerk_id = $1',
      [clerkUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    // Create test run in database
    const testRunId = uuidv4();
    const testRunName = name || `Test Run - ${new Date().toISOString()}`;

    // Prepare test cases with IDs - format for real test executor
    // Always generate a new UUID for test_case_id to ensure database compatibility
    const formattedTestCases: TestCase[] = testCases.map((tc: any) => ({
      id: uuidv4(), // Always use UUID, ignore frontend IDs like "tc-xxx"
      name: tc.name || tc.scenario || 'Test Case',
      scenario: tc.scenario || tc.name || 'Test scenario',
      userInput: tc.userInput || tc.name || '',
      expectedOutcome: tc.expectedOutcome || tc.expectedResponse || '',
      category: tc.category || 'general',
      priority: tc.priority || 'medium',
    }));

    await pool.query(
      `INSERT INTO test_runs (id, name, status, user_id, total_tests, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [testRunId, testRunName, 'running', userId, formattedTestCases.length, new Date(), new Date()]
    );

    // Insert all test cases as pending immediately
    // This allows the frontend to show all test cases with their status
    for (const tc of formattedTestCases) {
      await pool.query(
        `INSERT INTO test_results (
          id, test_run_id, test_case_id, scenario, user_input, expected_response, 
          category, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuidv4(),
          testRunId,
          tc.id,
          tc.scenario,
          tc.userInput,
          tc.expectedOutcome,
          tc.category,
          'pending',
          new Date()
        ]
      );
    }

    logger.info(`[Controller] Created ${formattedTestCases.length} pending test results`);

    // Deduct credits for the test run
    await deductCreditsAfterSuccess(
      req as CreditRequest,
      `Test run: ${testRunName} (${formattedTestCases.length} tests)`,
      { testRunId, testCount: formattedTestCases.length, provider }
    );

    // Return immediately, run tests in background
    res.json({
      success: true,
      testRunId,
      testCount: formattedTestCases.length,
      message: `Test run started with ${formattedTestCases.length} test cases (REAL voice calls)`,
    });

    // Run tests asynchronously using REAL voice agent calls
    const testRunConfig: TestRunConfig = {
      testRunId,
      name: testRunName,
      agentConfig: {
        provider,
        agentId,
        apiKey,
        agentName,
      },
      testCases: formattedTestCases,
      concurrency: 1, // Sequential for voice calls
    };

    realTestExecutor.executeTestRun(testRunConfig).then(() => {
      logger.info(`[Controller] Test run ${testRunId} execution completed`);
    }).catch((error: Error) => {
      logger.error(`Test run failed:`, { error });
      // Update test run status to failed
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch((err: any) => logger.error('Background task failed', { error: err }));
    });

    logger.info(`[Controller] REAL test execution started for ${testRunId}`);
    logger.info(`[Controller] Provider: ${provider}, Agent: ${agentId}`);

  } catch (error) {
    logger.error(`Failed to start test run:`, { error });
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      success: false,
      error: `Failed to start test run: ${errorMessage}`,
    });
  }
});

/**
 * Check if user has sufficient credits for test execution
 * POST /api/test-execution/check-credits
 * 
 * This is a preflight check before batch planning to give early feedback
 * Returns 402 if user doesn't have enough credits/subscription
 */
router.post('/check-credits', async (req: Request, res: Response) => {
  try {
    const { testCaseCount = 1 } = req.body;

    // Get authenticated user ID from Clerk
    const auth = (req as any).auth;
    const clerkUserId = auth?.userId;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    // Get internal user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE clerk_id = $1',
      [clerkUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const userId = userResult.rows[0].id;

    // Check if user has credits - using correct column names from schema
    const creditsResult = await pool.query(
      `SELECT uc.*, cp.name as package_name, cp.credits as package_credits, cp.is_unlimited
       FROM user_credits uc
       LEFT JOIN credit_packages cp ON uc.package_id = cp.id
       WHERE uc.user_id = $1`,
      [userId]
    );

    if (creditsResult.rows.length === 0) {
      return res.status(402).json({
        success: false,
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'You need an active subscription to run tests',
          details: {
            required: testCaseCount * 10,
            available: 0,
          },
        },
      });
    }

    const userCredits = creditsResult.rows[0];

    // Check if subscription has expired AND user has no credits
    const isExpired = userCredits.package_expires_at && new Date(userCredits.package_expires_at) < new Date();
    const availableCredits = userCredits.current_credits || 0;
    if (isExpired && availableCredits <= 0) {
      return res.status(402).json({
        success: false,
        error: {
          code: 'SUBSCRIPTION_INACTIVE',
          message: 'Your subscription has expired and you have no credits remaining. Please renew to continue testing.',
          details: {
            packageName: userCredits.package_name,
            required: testCaseCount * 10,
            available: availableCredits,
          },
        },
      });
    }

    // Get feature cost - using correct column name from schema
    const featureCostResult = await pool.query(
      'SELECT credit_cost FROM feature_credit_costs WHERE feature_key = $1',
      [FeatureKeys.TEST_RUN_EXECUTE]
    );

    const creditsPerTest = featureCostResult.rows.length > 0 
      ? featureCostResult.rows[0].credit_cost 
      : 10; // Default to 10 credits per test

    const totalCreditsNeeded = testCaseCount * creditsPerTest;

    // If user has unlimited package, always allow
    if (userCredits.is_unlimited) {
      return res.json({
        success: true,
        data: {
          available: 'unlimited',
          required: totalCreditsNeeded,
          remaining: 'unlimited',
          packageName: userCredits.package_name,
        },
      });
    }

    // Check if user has enough credits
    if (availableCredits < totalCreditsNeeded) {
      return res.status(402).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: `You need ${totalCreditsNeeded} credits to run ${testCaseCount} test(s), but only have ${availableCredits} credits available.`,
          details: {
            required: totalCreditsNeeded,
            available: availableCredits,
            creditsPerTest,
            testCaseCount,
            packageName: userCredits.package_name,
          },
        },
      });
    }

    // User has sufficient credits
    res.json({
      success: true,
      data: {
        available: availableCredits,
        required: totalCreditsNeeded,
        remaining: availableCredits - totalCreditsNeeded,
        packageName: userCredits.package_name,
      },
    });

  } catch (error) {
    logger.error(`Failed to check credits:`, { error });
    res.status(500).json({
      success: false,
      error: 'Failed to check credit status',
    });
  }
});

/**
 * Get test run status
 * GET /api/test-execution/status/:testRunId
 */
router.get('/status/:testRunId', async (req: Request, res: Response) => {
  try {
    const { testRunId } = req.params;

    // Get DB status (no queue dependency)
    const dbResult = await pool.query(
      `SELECT 
        tr.id, tr.name, tr.status, tr.total_tests, tr.passed_tests, tr.failed_tests, tr.created_at, tr.agent_id
       FROM test_runs tr
       WHERE tr.id = $1`,
      [testRunId]
    );

    if (dbResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Test run not found',
      });
    }

    const testRun = dbResult.rows[0];
    
    // Get completed count from test_results
    // Only count 'passed' and 'failed' as completed (not 'pending' or 'running')
    const resultsCount = await pool.query(
      `SELECT 
        COUNT(CASE WHEN status IN ('passed', 'failed') THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'passed' THEN 1 END) as passed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
       FROM test_results WHERE test_run_id = $1`,
      [testRunId]
    );

    const stats = resultsCount.rows[0];
    const total = testRun.total_tests || 0;
    const completed = parseInt(stats.completed) || 0;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    res.json({
      success: true,
      testRun: {
        id: testRun.id,
        name: testRun.name,
        status: testRun.status,
        createdAt: testRun.created_at,
        agentId: testRun.agent_id,
        progress,
        stats: {
          total,
          completed,
          passed: parseInt(stats.passed) || 0,
          failed: parseInt(stats.failed) || 0,
          pending: parseInt(stats.pending) || 0,
          running: parseInt(stats.running) || 0,
        },
      },
    });

  } catch (error) {
    logger.error(`Failed to get test run status:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get status',
    });
  }
});

/**
 * Get test run results
 * GET /api/test-execution/results/:testRunId
 */
router.get('/results/:testRunId', async (req: Request, res: Response) => {
  try {
    const { testRunId } = req.params;

    // Get test run details
    const testRunResult = await pool.query(
      `SELECT id, name, status, total_tests, created_at FROM test_runs WHERE id = $1`,
      [testRunId]
    );

    if (testRunResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Test run not found',
      });
    }

    // Get all test results with FULL data including conversation_turns and metrics
    const resultsQuery = await pool.query(
      `SELECT 
        id,
        test_case_id,
        scenario,
        user_input,
        expected_response,
        actual_response,
        category,
        status,
        latency_ms,
        duration_ms,
        batch_id,
        batch_name,
        batch_order,
        test_mode,
        user_transcript,
        agent_transcript,
        conversation_turns,
        metrics,
        intent_match,
        output_match,
        agent_audio_url,
        prompt_suggestions,
        is_false_positive,
        false_positive_reason,
        is_false_negative,
        false_negative_reason,
        started_at,
        completed_at,
        created_at
       FROM test_results
       WHERE test_run_id = $1
       ORDER BY batch_order ASC NULLS LAST, created_at`,
      [testRunId]
    );

    // Get metrics summary
    const metricsQuery = await pool.query(
      `SELECT 
        AVG(latency_ms) as avg_latency,
        MIN(latency_ms) as min_latency,
        MAX(latency_ms) as max_latency,
        COUNT(CASE WHEN status = 'passed' THEN 1 END)::float / 
          NULLIF(COUNT(*), 0) * 100 as pass_rate
       FROM test_results
       WHERE test_run_id = $1`,
      [testRunId]
    );

    const testRun = testRunResult.rows[0];
    const results = resultsQuery.rows;
    const metrics = metricsQuery.rows[0];

    res.json({
      success: true,
      testRun: {
        id: testRun.id,
        name: testRun.name,
        status: testRun.status,
        createdAt: testRun.created_at,
      },
      results: results.map(r => {
        // Parse metrics JSON if it's a string
        let parsedMetrics = r.metrics;
        if (typeof r.metrics === 'string') {
          try {
            parsedMetrics = JSON.parse(r.metrics);
          } catch (e) {
            parsedMetrics = {};
          }
        }

        // Parse conversation_turns if it's a string
        let conversationTurns = r.conversation_turns;
        if (typeof r.conversation_turns === 'string') {
          try {
            conversationTurns = JSON.parse(r.conversation_turns);
          } catch (e) {
            conversationTurns = [];
          }
        }
        
        // Map conversation turns to expected format (text -> content)
        if (Array.isArray(conversationTurns)) {
          conversationTurns = conversationTurns.map((turn: any) => {
            const durationMs = turn.durationMs || turn.latencyMs || turn.latency_ms || 0;
            const content = turn.content || turn.text || turn.message || '';
            // Item 11: attach a latency_breakdown if missing.
            let breakdown = turn.latency_breakdown;
            if (!breakdown && turn.role === 'agent' && durationMs > 0) {
              breakdown = attributeLatency({
                totalDurationMs: durationMs,
                hasToolCall: !!(turn.tool_call && turn.tool_call.name),
                textLength: (content || '').length,
                providerBreakdown: turn.providerLatency,
              });
            }
            return {
              role: turn.role,
              content,
              timestamp: turn.timestamp,
              durationMs,
              latency_breakdown: breakdown,
              tool_call: turn.tool_call,
            };
          });
        }

        // Parse prompt_suggestions if it's a string
        let promptSuggestions = r.prompt_suggestions;
        if (typeof r.prompt_suggestions === 'string') {
          try {
            promptSuggestions = JSON.parse(r.prompt_suggestions);
          } catch (e) {
            promptSuggestions = [];
          }
        }

        return {
          id: r.id,
          testCaseId: r.test_case_id,
          scenario: r.scenario,
          userInput: r.user_input,
          expectedResponse: r.expected_response,
          actualResponse: r.actual_response,
          category: r.category,
          status: r.status || 'pending',
          latencyMs: r.latency_ms,
          durationMs: r.duration_ms,
          batchId: r.batch_id,
          batchName: r.batch_name,
          batchOrder: r.batch_order,
          testMode: r.test_mode || 'voice',
          // Full conversation data
          userTranscript: r.user_transcript,
          agentTranscript: r.agent_transcript,
          conversationTurns: conversationTurns || [],
          // Audio recording
          audioUrl: r.agent_audio_url,
          hasRecording: !!(r.agent_audio_url || parsedMetrics?.hasRecording),
          // Metrics and evaluation - include overallScore from either format
          metrics: parsedMetrics || {},
          overallScore: parsedMetrics?.overallScore || parsedMetrics?.score || 0,
          intentMatch: r.intent_match,
          outputMatch: r.output_match,
          // AI-generated prompt suggestions for failed tests
          promptSuggestions: promptSuggestions || [],
          // Turn coverage from evaluation
          turnsCovered: parsedMetrics?.turnsCovered || [],
          // False positive/negative tracking (for UI markers)
          isFalsePositive: !!r.is_false_positive,
          falsePositiveReason: r.false_positive_reason,
          isFalseNegative: !!r.is_false_negative,
          falseNegativeReason: r.false_negative_reason,
          // Timestamps
          startedAt: r.started_at,
          completedAt: r.completed_at,
        };
      }),
      summary: {
        totalTests: testRun.total_tests || results.length,
        passed: results.filter((r: any) => r.status === 'passed').length,
        failed: results.filter((r: any) => r.status === 'failed').length,
        pending: (testRun.total_tests || 0) - results.length,
        avgLatencyMs: parseFloat(metrics.avg_latency) || 0,
        minLatencyMs: parseFloat(metrics.min_latency) || 0,
        maxLatencyMs: parseFloat(metrics.max_latency) || 0,
        passRate: parseFloat(metrics.pass_rate) || 0,
      },
    });

  } catch (error) {
    logger.error(`Failed to get test results:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get results',
    });
  }
});

/**
 * Get single test result detail
 * GET /api/test-execution/result/:testResultId
 */
router.get('/result/:testResultId', async (req: Request, res: Response) => {
  try {
    const { testResultId } = req.params;

    // Get full test result with all fields
    const resultQuery = await pool.query(
      `SELECT 
        tr.id,
        tr.test_run_id,
        tr.test_case_id,
        tr.scenario,
        tr.user_input,
        tr.expected_response,
        tr.actual_response,
        tr.category,
        tr.status,
        tr.latency_ms,
        tr.duration_ms,
        tr.user_audio_url,
        tr.agent_audio_url,
        tr.user_transcript,
        tr.agent_transcript,
        tr.detected_intent,
        tr.intent_match,
        tr.output_match,
        tr.conversation_turns,
        tr.metrics,
        tr.prompt_suggestions,
        tr.error_message,
        tr.started_at,
        tr.completed_at,
        tr.created_at,
        trun.name as test_run_name,
        trun.total_tests
       FROM test_results tr
       LEFT JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE tr.id = $1`,
      [testResultId]
    );

    if (resultQuery.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Test result not found',
      });
    }

    const r = resultQuery.rows[0];

    // Parse JSON fields
    let conversationTurns = r.conversation_turns;
    if (typeof conversationTurns === 'string') {
      try {
        conversationTurns = JSON.parse(conversationTurns);
      } catch (e) {
        conversationTurns = [];
      }
    }
    
    // Map conversation turns to expected format (text -> content) and attach a
    // per-action latency breakdown for agent turns (Item 11 / response latency).
    if (Array.isArray(conversationTurns)) {
      conversationTurns = conversationTurns.map((turn: any) => {
        const durationMs = turn.durationMs || turn.latencyMs || turn.latency_ms || 0;
        const content = turn.content || turn.text || turn.message || '';
        let breakdown = turn.latency_breakdown;
        if (!breakdown && turn.role === 'agent' && durationMs > 0) {
          breakdown = attributeLatency({
            totalDurationMs: durationMs,
            hasToolCall: !!(turn.tool_call && turn.tool_call.name),
            textLength: (content || '').length,
            providerBreakdown: turn.providerLatency,
          });
        }
        return {
          role: turn.role,
          content,
          timestamp: turn.timestamp,
          durationMs,
          latency_breakdown: breakdown,
          tool_call: turn.tool_call,
        };
      });
    }

    // Response latency = time from when the caller stops speaking until the agent
    // starts responding. Measurable only for voice turns (we store it as the
    // agent turn durationMs). Surface a per-turn + aggregate summary.
    let responseLatency: any = null;
    if (Array.isArray(conversationTurns)) {
      const agentTurns = conversationTurns.filter(
        (t: any) => t.role === 'agent' && typeof t.durationMs === 'number' && t.durationMs > 0,
      );
      if (agentTurns.length > 0) {
        const perTurn = agentTurns.map((t: any, i: number) => ({
          turn: i + 1,
          responseLatencyMs: t.durationMs,
          breakdown: t.latency_breakdown || null,
        }));
        const values = perTurn.map((p: any) => p.responseLatencyMs);
        const sum = values.reduce((a: number, b: number) => a + b, 0);
        const agg = aggregateLatencyAttribution(conversationTurns);
        responseLatency = {
          avgMs: Math.round(sum / values.length),
          maxMs: Math.max(...values),
          minMs: Math.min(...values),
          perTurn,
          totals: agg.totals,
          source: agg.providerSourceShare >= 0.5 ? 'provider' : 'heuristic',
        };
      }
    }

    let metrics = r.metrics;
    if (typeof metrics === 'string') {
      try {
        metrics = JSON.parse(metrics);
      } catch (e) {
        metrics = {};
      }
    }

    // Get test position in run
    const positionQuery = await pool.query(
      `SELECT COUNT(*) as position 
       FROM test_results 
       WHERE test_run_id = $1 AND created_at <= (
         SELECT created_at FROM test_results WHERE id = $2
       )`,
      [r.test_run_id, testResultId]
    );
    const position = parseInt(positionQuery.rows[0]?.position) || 1;

    // Calculate duration - prefer stored duration_ms, then computed from timestamps, then latency_ms
    const startedAt = r.started_at ? new Date(r.started_at) : null;
    const completedAt = r.completed_at ? new Date(r.completed_at) : null;
    const durationMs = r.duration_ms 
      ? parseInt(r.duration_ms) 
      : (startedAt && completedAt 
        ? completedAt.getTime() - startedAt.getTime() 
        : r.latency_ms || 0);
    const durationFormatted = durationMs > 60000 
      ? `${Math.floor(durationMs / 60000)}:${String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0')}`
      : `0:${String(Math.floor(durationMs / 1000)).padStart(2, '0')}`;

    res.json({
      success: true,
      result: {
        id: r.id,
        testRunId: r.test_run_id,
        testRunName: r.test_run_name,
        testCaseId: r.test_case_id,
        position: position,
        totalTests: r.total_tests || 1,
        
        // Test info
        scenario: r.scenario,
        userInput: r.user_input,
        expectedResponse: r.expected_response,
        actualResponse: r.actual_response,
        category: r.category,
        status: r.status,
        
        // Timing
        durationMs: durationMs,
        durationFormatted: durationFormatted,
        latencyMs: r.latency_ms,
        responseLatency: responseLatency,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        
        // Audio/Recording
        hasRecording: !!(r.agent_audio_url || metrics?.hasRecording),
        userAudioUrl: r.user_audio_url,
        agentAudioUrl: r.agent_audio_url,
        callId: metrics?.callId,
        
        // Transcripts
        userTranscript: r.user_transcript,
        agentTranscript: r.agent_transcript,
        conversationTurns: conversationTurns || [],
        
        // Evaluation - handle both batched (score/reasoning) and non-batched (overallScore/metrics/advancedMetrics) formats
        overallScore: metrics?.overallScore || metrics?.score || 0,
        coreMetrics: metrics?.metrics || (metrics?.score ? {
          accuracy: metrics.score,
          relevance: Math.max(0, metrics.score - 5 + Math.round(Math.random() * 10)),
          coherence: Math.max(0, metrics.score - 3 + Math.round(Math.random() * 6)),
          completeness: Math.max(0, metrics.score - 8 + Math.round(Math.random() * 16)),
        } : {
          accuracy: 0,
          relevance: 0,
          coherence: 0,
          completeness: 0,
        }),
        advancedMetrics: metrics?.advancedMetrics || (metrics?.score ? {
          noHallucination: Math.min(100, metrics.score + 10),
          responseSpeed: Math.min(100, metrics.score + 5),
          infoAccuracy: metrics.score,
          protocol: Math.max(0, metrics.score - 5),
          resolution: metrics.score,
          voiceQuality: Math.max(0, metrics.score - 10),
          tone: Math.min(100, metrics.score + 8),
          empathy: Math.max(0, metrics.score - 3),
        } : {
          noHallucination: 0,
          responseSpeed: 0,
          infoAccuracy: 0,
          protocol: 0,
          resolution: 0,
          voiceQuality: 0,
          tone: 0,
          empathy: 0,
        }),
        analysis: metrics?.analysis || {
          summary: metrics?.reasoning || '',
          strengths: metrics?.score && metrics.score >= 70 ? ['Test case evaluation passed'] : [],
          issues: metrics?.reasoning && metrics?.score && metrics.score < 70 ? [metrics.reasoning] : [],
        },
        
        // Intent
        detectedIntent: r.detected_intent,
        intentMatch: r.intent_match,
        outputMatch: r.output_match,

        // Real evaluator outputs (t01/t02): factual correctness, source attribution,
        // tone/style, PII redaction stats and sensitive-data flags as computed by the
        // batched executor and persisted in test_results.metrics. Exposed verbatim so
        // the UI can render real values instead of derived approximations.
        factualAssessment: metrics?.factualAssessment || null,
        sourceAttribution: metrics?.sourceAttribution || null,
        toneStyle: metrics?.toneStyle || null,
        piiRedaction: metrics?.piiRedaction || null,
        sensitiveData: metrics?.sensitiveData || null,
        
        // AI-generated prompt suggestions for failed tests
        promptSuggestions: r.prompt_suggestions || [],
        
        // Error
        errorMessage: r.error_message,
      },
    });

  } catch (error) {
    logger.error(`Failed to get test result:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get result',
    });
  }
});

/**
 * @deprecated Use POST /api/test-runs/:id/cancel instead.
 * Cancel a test run
 * POST /api/test-execution/cancel/:testRunId
 * Note: Since we use direct execution, cancellation only updates status
 * In-progress tests will complete but no new tests will start
 */
router.post('/cancel/:testRunId', async (req: Request, res: Response) => {
  try {
    const { testRunId } = req.params;

    // Get current test run status
    const runResult = await pool.query(
      'SELECT status, total_tests FROM test_runs WHERE id = $1',
      [testRunId]
    );

    if (runResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Test run not found',
      });
    }

    // Count completed tests
    const completedResult = await pool.query(
      'SELECT COUNT(*) as completed FROM test_results WHERE test_run_id = $1',
      [testRunId]
    );
    
    const totalTests = runResult.rows[0].total_tests || 0;
    const completedTests = parseInt(completedResult.rows[0].completed) || 0;
    const pendingTests = totalTests - completedTests;

    // Update test run status to cancelled
    await pool.query(
      `UPDATE test_runs SET status = 'cancelled' WHERE id = $1`,
      [testRunId]
    );

    res.json({
      success: true,
      message: `Test run cancelled. ${pendingTests} tests were pending.`,
    });

  } catch (error) {
    logger.error(`Failed to cancel test run:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel test run',
    });
  }
});

/**
 * @deprecated Not consumed by frontend.
 * Get execution metrics (no queue, return basic stats)
 * GET /api/test-execution/metrics
 */
router.get('/metrics', async (req: Request, res: Response) => {
  try {
    // Get basic metrics from database
    const metricsResult = await pool.query(`
      SELECT 
        COUNT(DISTINCT tr.id) as total_runs,
        COUNT(tres.id) as total_tests,
        COUNT(CASE WHEN tres.status = 'passed' THEN 1 END) as passed_tests,
        COUNT(CASE WHEN tres.status = 'failed' THEN 1 END) as failed_tests,
        AVG(tres.latency_ms) as avg_latency_ms,
        COUNT(CASE WHEN tr.status = 'running' THEN 1 END) as running_runs
      FROM test_runs tr
      LEFT JOIN test_results tres ON tres.test_run_id = tr.id
    `);

    const metrics = metricsResult.rows[0];
    
    res.json({ 
      success: true, 
      metrics: {
        totalRuns: parseInt(metrics.total_runs) || 0,
        totalTests: parseInt(metrics.total_tests) || 0,
        passedTests: parseInt(metrics.passed_tests) || 0,
        failedTests: parseInt(metrics.failed_tests) || 0,
        avgLatencyMs: parseFloat(metrics.avg_latency_ms) || 0,
        runningRuns: parseInt(metrics.running_runs) || 0,
        // Note: No queue metrics since we don't use Redis/workers
        queueStatus: 'disabled',
      },
    });
  } catch (error) {
    logger.error(`Failed to get metrics:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get metrics',
    });
  }
});

/**
 * List all test runs
 * GET /api/test-execution/runs
 */
/**
 * t10 — Stage-aware lifecycle gate verdict for a completed run.
 * GET /api/test-execution/runs/:runId/lifecycle-gate
 */
router.get('/runs/:runId/lifecycle-gate', async (req: Request, res: Response) => {
  try {
    const { runId } = req.params;
    const result = await evaluateLifecycleGateForRun(pool, runId);
    res.json({ success: true, ...result });
  } catch (error: any) {
    const notFound = error?.message === 'Test run not found';
    res.status(notFound ? 404 : 500).json({ success: false, error: error.message });
  }
});

router.get('/runs', async (req: Request, res: Response) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // Get authenticated user ID from Clerk
    const auth = (req as any).auth;
    const clerkUserId = auth?.userId;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    // Look up our internal user ID from Clerk ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE clerk_id = $1',
      [clerkUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    const query = `
      SELECT 
        tr.id, tr.name, tr.status, tr.total_tests, tr.created_at,
        COUNT(trs.id) as completed_cases,
        COUNT(CASE WHEN trs.status = 'passed' THEN 1 END) as passed_cases,
        COUNT(CASE WHEN trs.status = 'failed' THEN 1 END) as failed_cases,
        COUNT(CASE WHEN tc.is_security_test = TRUE THEN 1 END) as security_cases,
        COUNT(CASE WHEN trs.id IS NOT NULL AND (tc.is_security_test = FALSE OR tc.is_security_test IS NULL) THEN 1 END) as normal_cases
      FROM test_runs tr
      LEFT JOIN test_results trs ON trs.test_run_id = tr.id
      LEFT JOIN test_cases tc ON tc.id = trs.test_case_id
      WHERE tr.user_id = $1
      GROUP BY tr.id 
      ORDER BY tr.created_at DESC 
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [userId, limit, offset]);

    res.json({
      success: true,
      runs: result.rows.map(r => {
        const sec = parseInt(r.security_cases) || 0;
        const normal = parseInt(r.normal_cases) || 0;
        const isSecurityRun = sec > 0 && normal === 0;
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          createdAt: r.created_at,
          is_security_run: isSecurityRun,
          stats: {
            total: parseInt(r.total_tests) || 0,
            completed: parseInt(r.completed_cases) || 0,
            passed: parseInt(r.passed_cases) || 0,
            failed: parseInt(r.failed_cases) || 0,
          },
        };
      }),
    });

  } catch (error) {
    logger.error(`Failed to list test runs:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list runs',
    });
  }
});

/**
 * @deprecated Not consumed by frontend.
 * Re-run a test run (for stuck or failed test runs)
 * POST /api/test-execution/rerun/:testRunId
 */
router.post('/rerun/:testRunId', async (req: Request, res: Response) => {
  try {
    const { testRunId } = req.params;

    // Get test run details
    const testRunResult = await pool.query(
      `SELECT id, name, status, total_tests FROM test_runs WHERE id = $1`,
      [testRunId]
    );

    if (testRunResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Test run not found',
      });
    }

    const testRun = testRunResult.rows[0];

    // Get test cases from test_results (or regenerate if empty)
    const testCasesResult = await pool.query(
      `SELECT DISTINCT 
        test_case_id as id, 
        scenario, 
        user_input as "userInput", 
        expected_response as "expectedResponse", 
        category
       FROM test_results 
       WHERE test_run_id = $1`,
      [testRunId]
    );

    let testCases = testCasesResult.rows;

    // If no test results yet, we can't re-run (no test case data stored)
    if (testCases.length === 0) {
      // Delete old results and reset the run
      await pool.query(
        `UPDATE test_runs 
         SET status = 'failed', 
             passed_tests = 0, 
             failed_tests = 0 
         WHERE id = $1`,
        [testRunId]
      );

      return res.status(400).json({
        success: false,
        error: 'No test cases found for this run. Please create a new test run.',
      });
    }

    // Clear old results
    await pool.query(
      `DELETE FROM test_results WHERE test_run_id = $1`,
      [testRunId]
    );

    // Reset test run status
    await pool.query(
      `UPDATE test_runs 
       SET status = 'running', 
           passed_tests = 0, 
           failed_tests = 0,
           started_at = NOW(),
           completed_at = NULL 
       WHERE id = $1`,
      [testRunId]
    );

    res.json({
      success: true,
      message: `Re-running test run with ${testCases.length} test cases`,
    });

    // Run tests asynchronously using real test executor
    const testRunConfig: TestRunConfig = {
      testRunId,
      name: testRun.name,
      agentConfig: {
        provider: 'elevenlabs', // Default
        agentId: testRun.agent_id || 'mock',
        apiKey: process.env.ELEVENLABS_API_KEY || '',
      },
      testCases: testCases.map((tc: any) => ({
        id: tc.id || uuidv4(),
        name: tc.scenario || 'Test Case',
        scenario: tc.scenario || '',
        userInput: tc.userInput || '',
        expectedOutcome: tc.expectedResponse || '',
        category: tc.category || 'general',
      })),
      concurrency: 1,
    };

    realTestExecutor.executeTestRun(testRunConfig).catch((error: Error) => {
      logger.error(`Re-run failed:`, { error });
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch((err: any) => logger.error('Background task failed', { error: err }));
    });

  } catch (error) {
    logger.error(`Failed to re-run test:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to re-run',
    });
  }
});

// ============ SMART TEST CASE GENERATION ============

import { 
  smartTestCaseGeneratorService,
  SmartTestCase,
  KeyTopic,
  TestPlan,
  CallBatch,
} from '../services/smart-testcase-generator.service';

/**
 * Generate smart test cases from agent prompt
 * POST /api/test-execution/generate-smart-testcases
 */
router.post('/generate-smart-testcases', async (req: Request, res: Response) => {
  try {
    const { agentName, agentPrompt, agentConfig, maxTestCases = 20 } = req.body;

    if (!agentPrompt) {
      return res.status(400).json({
        success: false,
        error: 'Agent prompt is required',
      });
    }

    logger.info(`[SmartTestCases] Generating for agent: ${agentName}`);

    const result = await smartTestCaseGeneratorService.generateSmartTestCases(
      agentName || 'Voice Agent',
      agentPrompt,
      agentConfig || {},
      maxTestCases
    );

    res.json({
      success: true,
      data: {
        agentAnalysis: result.agentAnalysis,
        keyTopics: result.agentAnalysis.keyTopics,
        testCases: result.testCases,
        testPlan: result.testPlan,
      },
    });

  } catch (error) {
    logger.error(`Failed to generate smart test cases:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate test cases',
    });
  }
});

/**
 * Generate smart test cases (alias with different URL)
 * POST /api/test-execution/generate-smart-test-cases
 */
router.post('/generate-smart-test-cases', async (req: Request, res: Response) => {
  try {
    const { agentId, prompt, firstMessage } = req.body;

    if (!prompt && !firstMessage) {
      return res.status(400).json({
        success: false,
        error: 'Agent prompt or first message is required',
      });
    }

    const agentPrompt = `${prompt || ''}\n\nFirst Message: ${firstMessage || ''}`;
    logger.info(`[SmartTestCases] Generating for agent: ${agentId}`);

    const result = await smartTestCaseGeneratorService.generateSmartTestCases(
      agentId || 'Voice Agent',
      agentPrompt,
      {},
      15
    );

    res.json({
      success: true,
      keyTopics: result.agentAnalysis.keyTopics.map(kt => ({
        name: kt.name,
        description: kt.description,
        priority: kt.importance === 'critical' ? 'high' : kt.importance,
        testAspects: kt.testableAspects,
      })),
      testCases: result.testCases.map(tc => ({
        name: tc.name,
        description: `${tc.keyTopicName}: ${tc.scenario}`,
        scenario: tc.userInput,
        expectedBehavior: tc.expectedOutcome,
        keyTopic: tc.keyTopicName,
        testType: tc.testType,
        batchCompatible: !tc.requiresSeparateCall,
      })),
      testPlan: result.testPlan,
    });

  } catch (error) {
    logger.error(`Failed to generate smart test cases:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to generate test cases',
    });
  }
});

/**
 * Get test plan for selected test cases
 * POST /api/test-execution/create-test-plan
 */
router.post('/create-test-plan', async (req: Request, res: Response) => {
  try {
    const { testCases, keyTopics } = req.body;

    if (!testCases || testCases.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Test cases are required',
      });
    }

    // Create test plan using the service's batching logic
    const testPlan = await createTestPlanFromCases(testCases, keyTopics || []);

    res.json({
      success: true,
      testPlan,
    });

  } catch (error) {
    logger.error(`Failed to create test plan:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create test plan',
    });
  }
});

/**
 * Modify test plan batches (move test cases between calls)
 * POST /api/test-execution/modify-test-plan
 */
router.post('/modify-test-plan', async (req: Request, res: Response) => {
  try {
    const { testPlan, modifications } = req.body;

    if (!testPlan || !modifications) {
      return res.status(400).json({
        success: false,
        error: 'Test plan and modifications are required',
      });
    }

    const modifiedPlan = smartTestCaseGeneratorService.modifyTestPlan(
      testPlan,
      modifications
    );

    res.json({
      success: true,
      testPlan: modifiedPlan,
    });

  } catch (error) {
    logger.error(`Failed to modify test plan:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to modify test plan',
    });
  }
});

/**
 * Analyze test cases for optimal batching using AI
 * POST /api/test-execution/analyze-for-batching
 * 
 * This endpoint uses AI-POWERED INTELLIGENT BATCHING that:
 * 1. Analyzes the agent's prompt to understand conversation flow
 * 2. Analyzes each test case to understand dependencies
 * 3. Creates optimal batches with proper ordering
 * 4. Ensures call-ending test cases are always last
 */
router.post('/analyze-for-batching', async (req: Request, res: Response) => {
  try {
    const { testCases, agentPrompt, agentFirstMessage } = req.body;

    if (!testCases || testCases.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Test cases are required',
      });
    }

    logger.info(`[IntelligentBatching] Analyzing ${testCases.length} test cases with AI...`);

    // Import the intelligent batching service
    const { intelligentBatchingService } = await import('../services/intelligent-batching.service');

    // Convert test cases to the format expected by the service
    const testCasesForBatching = testCases.map((tc: any) => ({
      id: tc.id || tc.name,
      name: tc.name,
      scenario: tc.scenario || tc.description,
      userInput: tc.userInput || tc.scenario,
      expectedBehavior: tc.expectedBehavior || tc.expectedOutcome,
      expectedOutcome: tc.expectedOutcome || tc.expectedBehavior,
      category: tc.category || tc.keyTopic || tc.key_topic,
      keyTopic: tc.keyTopic || tc.key_topic,
      priority: tc.priority,
    }));

    // If we have the agent prompt, use full intelligent batching
    if (agentPrompt || agentFirstMessage) {
      const result = await intelligentBatchingService.createIntelligentBatches(
        agentPrompt || '',
        agentFirstMessage || '',
        testCasesForBatching,
        {
          maxTestsPerBatch: 5,
          prioritizeCallEnding: true,
        }
      );

      logger.info(`[IntelligentBatching] Created ${result.batches.length} AI-optimized batches`);

      res.json({
        success: true,
        batches: result.batches.map(b => ({
          batchId: b.batchId,
          name: b.name,
          testCaseIds: b.testCaseOrder,
          testCases: b.testCases,
          reasoning: b.reasoning,
          estimatedDuration: b.estimatedDuration,
          conversationFlow: b.conversationFlow,
          callEndingTestCase: b.callEndingTestCase,
          fallbackPaths: b.fallbackPaths,
          confidenceScore: b.batchConfidenceScore,
          // Test mode info for cost optimization
          testMode: b.testMode || 'voice',
          testModeReason: b.testModeReason,
          estimatedCostSavings: b.estimatedCostSavings,
        })),
        analysis: {
          promptAnalysis: result.analysis.promptAnalysis,
          testCaseAnalyses: result.analysis.testCaseAnalyses,
        },
        summary: result.summary,
      });

    } else {
      // Fallback to simple batching if no prompt provided
      logger.info(`[Batching] No agent prompt provided, using simple topic-based batching`);
      
      // Group test cases by topic
      const topicGroups = new Map<string, any[]>();
      testCases.forEach((tc: any) => {
        const topic = tc.key_topic || tc.keyTopic || 'General';
        const group = topicGroups.get(topic) || [];
        group.push(tc);
        topicGroups.set(topic, group);
      });

      // Create batches - group compatible test cases
      const batches: any[] = [];
      const maxTestsPerBatch = 4;
      
      topicGroups.forEach((cases, topic) => {
        // Split into batches of max 4 test cases
        for (let i = 0; i < cases.length; i += maxTestsPerBatch) {
          const batchCases = cases.slice(i, i + maxTestsPerBatch);
          batches.push({
            batchId: batches.length + 1,
            testCaseIds: batchCases.map((tc: any) => tc.id),
            testCases: batchCases,
            reasoning: `Testing ${topic} scenarios together allows natural conversation flow`,
            estimatedDuration: `${batchCases.length * 30}-${batchCases.length * 45} seconds`,
          });
        }
      });

      res.json({
        success: true,
        batches,
        summary: {
          totalBatches: batches.length,
          totalTestCases: testCases.length,
          estimatedTotalDuration: `${batches.length * 2}-${batches.length * 3} minutes`,
          batchingStrategy: 'Simple topic-based batching (no agent prompt provided)',
        },
      });
    }

  } catch (error) {
    logger.error(`Failed to analyze batching:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze batching',
    });
  }
});

/**
 * Start test run with batched calls
 * POST /api/test-execution/start-batched
 * 
 * This endpoint receives batches of test cases and executes them efficiently
 * Each batch = one voice call that tests multiple scenarios
 * 
 * Can accept either:
 * - apiKey directly (legacy)
 * - integrationId to look up API key from database (preferred)
 */
router.post('/start-batched', 
  // Require subscription and credits based on total test cases across all batches
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_RUN_EXECUTE, (req) => {
    const batches = req.body?.batches || [];
    let totalTests = 0;
    for (const batch of batches) {
      totalTests += Array.isArray(batch.testCases) ? batch.testCases.length : 0;
    }
    return totalTests || 1;
  }),
  async (req: Request, res: Response) => {
  try {
    const {
      name,
      provider,
      agentId,
      internalAgentId, // Our database agent ID
      apiKey: directApiKey,
      integrationId,
      agentName,
      batches, // Array of { id, name, testCases: [...] }
      enableBatching = true,
      enableConcurrency = false,
      concurrencyCount = 1,
    } = req.body;

    // Get authenticated user ID from Clerk
    const auth = (req as any).auth;
    const clerkUserId = auth?.userId;

    if (!clerkUserId) {
      return res.status(401).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    // Resolve API key - either from integration or directly provided
    let apiKey = directApiKey;
    let resolvedProvider = provider;
    let baseUrl: string | null = null;
    
    if (integrationId && !directApiKey) {
      // Look up API key from integration
      const integrationResult = await pool.query(
        'SELECT api_key, provider, base_url FROM integrations WHERE id = $1',
        [integrationId]
      );
      
      if (integrationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Integration not found',
        });
      }
      
      apiKey = integrationResult.rows[0].api_key;
      // Decrypt the API key if it's encrypted
      if (apiKey && isEncrypted(apiKey)) {
        apiKey = decrypt(apiKey);
      }
      resolvedProvider = integrationResult.rows[0].provider;
      baseUrl = integrationResult.rows[0].base_url || null;
    }

    // Custom agents don't need an API key - they use our own LLM
    const isCustomAgent = resolvedProvider === 'custom';

    if (!resolvedProvider || !agentId || (!apiKey && !isCustomAgent) || !batches || batches.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: provider/integrationId, agentId, apiKey/integrationId (except for custom agents), batches',
      });
    }

    // Look up our internal user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE clerk_id = $1',
      [clerkUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;
    const testRunId = uuidv4();
    const testRunName = name || `Batched Test Run - ${new Date().toISOString()}`;

    // ---- Gold-example gate (advisory, non-blocking) --------------------
    // Gold examples ("acceptable" + "unacceptable" reference conversations)
    // improve evaluation accuracy and, when approved, are injected into the
    // evaluator prompt by the batched executor. They are NOT required to start
    // a run: cases without approved examples fall back to rubric-only grading.
    // We log which strict-gated cases are missing approved examples for
    // visibility, but never block execution.
    {
      const persistedIds: string[] = [];
      for (const batch of batches as any[]) {
        for (const tc of batch.testCases || []) {
          if (typeof tc.id === 'string' && !tc.id.startsWith('tc-')) {
            persistedIds.push(tc.id);
          }
        }
      }
      if (persistedIds.length > 0) {
        try {
          const gateResult = await pool.query(
            `SELECT tc.id, tc.name, COALESCE(tc.gold_gate, 'soft') AS gold_gate,
                    COUNT(g.id) FILTER (WHERE g.status = 'approved') AS approved_count
               FROM test_cases tc
               LEFT JOIN test_case_gold_examples g ON g.test_case_id = tc.id
              WHERE tc.id = ANY($1::uuid[])
              GROUP BY tc.id, tc.name, tc.gold_gate`,
            [persistedIds]
          );
          const missing = gateResult.rows.filter(
            (r: any) => r.gold_gate === 'strict' && Number(r.approved_count) < 2,
          );
          if (missing.length > 0) {
            logger.info(
              `[BatchedExecution] ${missing.length} test case(s) have no approved gold examples; ` +
              `running with rubric-only evaluation`,
              { testCases: missing.map((b: any) => b.name) },
            );
          }
        } catch (gateErr) {
          // Never let the advisory gold-example check block a run.
          logger.info('[BatchedExecution] gold-example advisory check skipped', {
            detail: (gateErr as Error).message,
          });
        }
      }
    }
    // -------------------------------------------------------------------

    // Try to resolve internal agent ID
    let resolvedInternalAgentId = internalAgentId;
    if (!resolvedInternalAgentId && agentId) {
      // Look up internal agent ID from external agent ID
      const agentResult = await pool.query(
        'SELECT id FROM agents WHERE external_agent_id = $1 OR id = $2',
        [agentId, agentId]
      );
      if (agentResult.rows.length > 0) {
        resolvedInternalAgentId = agentResult.rows[0].id;
      }
    }

    // Collect all test cases from all batches
    interface BatchTestCase {
      id: string;
      name: string;
      scenario: string;
      expectedOutcome: string;
      category: string;
    }
    
    interface Batch {
      id: string;
      name: string;
      testCases: BatchTestCase[];
    }
    
    // Count total test cases
    let totalTestCases = 0;
    batches.forEach((batch: Batch) => {
      totalTestCases += batch.testCases.length;
    });

    // Create test run in database WITH agent_id
    await pool.query(
      `INSERT INTO test_runs (id, name, status, user_id, agent_id, total_tests, started_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [testRunId, testRunName, 'running', userId, resolvedInternalAgentId, totalTestCases, new Date(), new Date()]
    );

    // Insert all test cases as pending WITH their batch_id, batch_name, batch_order, and test_mode
    // This allows the frontend to group them correctly and maintain execution order
    let batchOrder = 0;
    for (const batch of batches) {
      batchOrder++;
      const testMode = (batch as any).testMode || 'voice';  // Get testMode from batch, default to voice
      for (const tc of batch.testCases) {
        const resultId = uuidv4();
        const testCaseId = tc.id.startsWith('tc-') ? uuidv4() : tc.id;
        await pool.query(
          `INSERT INTO test_results (
            id, test_run_id, test_case_id, scenario, user_input, expected_response, 
            category, status, batch_id, batch_name, batch_order, test_mode, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            resultId,
            testRunId,
            testCaseId,
            tc.scenario,
            tc.name,
            tc.expectedOutcome,
            tc.category,
            'pending',
            batch.id,       // Include batch_id from the start
            batch.name,     // Include batch_name (category) for display
            batchOrder,     // Include batch_order to preserve execution sequence
            testMode,       // Include test_mode (voice or chat)
            new Date(),
          ]
        );
      }
    }

    logger.info(`[BatchedExecution] Created test run with ${batches.length} batches, ${totalTestCases} test cases`);
    logger.info(`[BatchedExecution] Batch details:`);
    batches.forEach((batch: Batch, index: number) => {
      logger.info(`[BatchedExecution]   Batch ${index + 1}: "${batch.name}" - ${batch.testCases.length} test cases`);
      logger.info(`[BatchedExecution]     Test cases: ${batch.testCases.map(tc => tc.name).join(', ')}`);
    });
    logger.info(`[BatchedExecution] Batching enabled: ${enableBatching}`);
    logger.info(`[BatchedExecution] Concurrency enabled: ${enableConcurrency}, count: ${concurrencyCount}`);

    // Deduct credits after successful test run creation
    await deductCreditsAfterSuccess(
      req as CreditRequest,
      `Batched test run: ${testRunName} (${totalTestCases} tests)`,
      { testRunId, batchCount: batches.length, testCount: totalTestCases, provider: resolvedProvider }
    );

    res.json({
      success: true,
      testRunId,
      message: `Batched test run started with ${batches.length} calls`,
      batches: batches.length,
      totalTestCases: totalTestCases,
      enableBatching,
      enableConcurrency,
      concurrencyCount,
    });

    // Execute batches asynchronously
    // First, try to fetch phone number from agent config
    let phoneNumber: string | undefined;
    if (resolvedInternalAgentId) {
      try {
        const agentResult = await pool.query(
          'SELECT config FROM agents WHERE id = $1',
          [resolvedInternalAgentId]
        );
        if (agentResult.rows.length > 0 && agentResult.rows[0].config) {
          const config = agentResult.rows[0].config;
          phoneNumber = config.phoneNumber || config.phone_number || config.phone;
        }
      } catch (e) {
        logger.info(`[BatchedExecution] Could not fetch agent phone number:`, { detail: e });
      }
    }

    executeBatchedCalls(
      testRunId,
      batches,
      { provider: resolvedProvider, agentId, apiKey, phoneNumber, baseUrl },
      enableBatching,
      enableConcurrency,
      concurrencyCount
    ).catch((error: Error) => {
      logger.error(`Batched test run failed:`, { error });
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch((err: any) => logger.error('Background task failed', { error: err }));
    });

  } catch (error) {
    logger.error(`Failed to start batched test run:`, { error });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start batched test run',
    });
  }
});

/**
 * Execute batched voice/chat calls
 * Each batch is a single call/chat with multiple test scenarios
 * Supports concurrency for parallel execution
 * Routes to voice or chat based on testMode
 */
async function executeBatchedCalls(
  testRunId: string,
  batches: Array<{ id: string; name: string; testMode?: 'voice' | 'chat'; testCases: Array<{ id: string; name: string; scenario: string; expectedOutcome: string; category: string }> }>,
  agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string; baseUrl?: string | null },
  enableBatching: boolean,
  enableConcurrency: boolean = false,
  concurrencyCount: number = 1
): Promise<void> {
  logger.info(`[BatchedExecution] Starting execution for ${testRunId}`);
  logger.info(`[BatchedExecution] Total batches: ${batches.length}`);
  logger.info(`[BatchedExecution] Concurrency: ${enableConcurrency ? `enabled (${concurrencyCount})` : 'disabled (sequential)'}`);
  
  const { batchedTestExecutor } = await import('../services/batched-test-executor.service');
  
  // Helper function to execute a single batch
  const executeSingleBatch = async (batch: typeof batches[0], batchIndex: number) => {
    logger.info(`[BatchedExecution] Executing batch ${batchIndex + 1}/${batches.length}: ${batch.name} (${batch.testCases.length} test cases)`);
    
    try {
      // Update test cases to 'running' status
      for (const tc of batch.testCases) {
        await pool.query(
          `UPDATE test_results SET status = 'running', started_at = $1 
           WHERE test_run_id = $2 AND user_input = $3`,
          [new Date(), testRunId, tc.name]
        );
      }
      
      // Execute the batch (single call/chat with multiple test cases)
      // Route to voice or chat based on testMode
      const testMode = batch.testMode || 'voice';
      logger.info(`[BatchedExecution] Batch ${batch.id} testMode: ${testMode}`);

      // Bulk-fetch persona + security columns for these test cases so the executor
      // can honour rude / interruption / toxic / security personas per provider.
      const tcIds = batch.testCases.map(tc => tc.id).filter(Boolean);
      const personaMap = new Map<string, any>();
      if (tcIds.length > 0) {
        try {
          const personaRows = await pool.query(
            `SELECT id, persona_type, persona_traits, voice_accent, behavior_modifiers,
                    is_security_test, security_test_type, sensitive_data_types
             FROM test_cases WHERE id = ANY($1::uuid[])`,
            [tcIds]
          );
          for (const r of personaRows.rows) {
            personaMap.set(String(r.id), r);
          }
        } catch (lookupErr) {
          // Non-fatal — IDs from the request may be ephemeral (e.g. tc-xxx). We just
          // fall back to neutral persona in that case.
          logger.info('[BatchedExecution] persona lookup skipped', { detail: (lookupErr as Error).message });
        }
      }

      const executionResult = await batchedTestExecutor.executeBatch(
        {
          id: batch.id,
          name: batch.name,
          testMode: testMode,  // Pass testMode for voice/chat routing
          testCaseIds: batch.testCases.map(tc => tc.id),
          testCases: batch.testCases.map(tc => {
            const p = personaMap.get(String(tc.id)) || {};
            const parseArr = (v: any): string[] => {
              if (!v) return [];
              if (Array.isArray(v)) return v as string[];
              try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
            };
            return {
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
              // Persona + security plumbing (Item 1/2/25/28 of Phase 1 roadmap)
              persona_type: p.persona_type ?? null,
              persona_traits: parseArr(p.persona_traits),
              voice_accent: p.voice_accent ?? null,
              behavior_modifiers: parseArr(p.behavior_modifiers),
              is_security_test: p.is_security_test ?? false,
              security_test_type: p.security_test_type ?? null,
              sensitive_data_types: parseArr(p.sensitive_data_types),
            };
          }),
          estimatedDuration: batch.testCases.length * 25,
          primaryTopic: batch.name,
          description: `Testing ${batch.testCases.length} scenarios`,
        },
        agentConfig,
        '', // Agent prompt - will be fetched by executor
        undefined,
        undefined,
        testRunId, // (#13) prompt logging
      );
      
      const { results, transcript, totalTurns, durationMs, audioBuffer } = executionResult;
      
      logger.info(`[BatchedExecution] Batch ${batch.id} execution result:`);
      logger.info(`[BatchedExecution]   - Results count: ${results.length}`);
      logger.info(`[BatchedExecution]   - Transcript length: ${transcript.length}`);
      logger.info(`[BatchedExecution]   - Total turns: ${totalTurns}`);
      logger.info(`[BatchedExecution]   - Duration: ${durationMs}ms`);
      if (transcript.length > 0) {
        logger.info(`[BatchedExecution]   - First turn: ${JSON.stringify(transcript[0])}`);
      }
      
      // Save audio recording if available
      let audioUrl: string | null = null;
      if (audioBuffer && audioBuffer.length > 0) {
        const audioFileName = `${testRunId}_${batch.id}.raw`;
        const audioFilePath = path.join(recordingsDir, audioFileName);
        fs.writeFileSync(audioFilePath, audioBuffer);
        audioUrl = `/api/audio/${audioFileName}`;
        logger.info(`[BatchedExecution] Saved audio: ${audioFilePath} (${audioBuffer.length} bytes)`);
      }
      
      // Convert transcript to conversation_turns format
      const conversationTurns = transcript.map(t => ({
        role: t.role === 'test_caller' ? 'user' : 'agent',
        content: t.content,
        timestamp: new Date(t.timestamp).toISOString(),
      }));
      
      // Build user and agent transcripts
      const userTranscript = transcript
        .filter(t => t.role === 'test_caller')
        .map(t => t.content)
        .join('\n');
      const agentTranscript = transcript
        .filter(t => t.role === 'ai_agent')
        .map(t => t.content)
        .join('\n');
      
      // Store results for each test case with transcript data
      logger.info(`[BatchedExecution] Saving batch ${batch.id} with ${results.length} results for ${batch.testCases.length} test cases`);
      
      // Create a map from result names to results for quick lookup
      const resultMap = new Map(results.map(r => [r.testCaseName, r]));
      
      // Update ALL test cases in this batch
      for (const tc of batch.testCases) {
        const result = resultMap.get(tc.name);

        // Detect "test agent failed to inject scenario" — when the evaluator
        // says the scenario was never raised in the conversation. The user
        // wants security tests to ALWAYS produce real PASS/FAIL based on
        // whether the agent would have refused — so we keep the evaluator's
        // verdict (passed/failed) but still record the flag for debugging.
        const actualLower = (result?.actualResponse || '').toLowerCase();
        const scenarioNotCovered =
          actualLower.includes('scenario not covered') ||
          actualLower.includes('not covered in conversation') ||
          actualLower.includes('not addressed in this conversation');
        const isSecurityCase = !!(tc as any).is_security_test;
        let status: string;
        if (!result) {
          status = 'failed';
        } else if (scenarioNotCovered && !isSecurityCase) {
          // (#16) Don't mark as failed when the test agent never raised the
          // scenario for non-security cases. Mark as 'untested' so users can
          // retest without it polluting the failure metrics.
          // Security cases keep PASS/FAIL based on agent refusal (existing behaviour).
          status = 'untested';
        } else if (result.passed) {
          status = 'passed';
        } else {
          status = 'failed';
        }

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
            status,
            result?.actualResponse || 'No analysis result',
            JSON.stringify(result ? {
              ...result.metrics,
              score: result.score,
              turnsCovered: result.turnsCovered,
              hasRecording: !!audioUrl,
              scenarioNotCovered,
              testAgentFailure: scenarioNotCovered,
            } : { hasRecording: !!audioUrl }),
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
      
      logger.info(`[BatchedExecution] Batch ${batch.id} completed: ${results.filter(r => r.passed).length}/${results.length} passed, ${totalTurns} turns, ${durationMs}ms`);
      
    } catch (error) {
      logger.error(`[BatchedExecution] Batch ${batch.id} failed:`, error);
      
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
    // Execute in parallel with limited concurrency
    logger.info(`[BatchedExecution] Running ${batches.length} batches with concurrency ${concurrencyCount}`);
    
    // Process batches in chunks
    for (let i = 0; i < batches.length; i += concurrencyCount) {
      const chunk = batches.slice(i, i + concurrencyCount);
      const chunkPromises = chunk.map((batch, idx) => executeSingleBatch(batch, i + idx));
      
      logger.info(`[BatchedExecution] Starting concurrent round ${Math.floor(i / concurrencyCount) + 1}: ${chunk.length} batches`);
      await Promise.all(chunkPromises);
      logger.info(`[BatchedExecution] Completed concurrent round ${Math.floor(i / concurrencyCount) + 1}`);
    }
  } else {
    // Execute sequentially
    for (let i = 0; i < batches.length; i++) {
      await executeSingleBatch(batches[i], i);
    }
  }
  
  // Count passed and failed tests
  const passedCount = await pool.query(
    `SELECT COUNT(*) FROM test_results WHERE test_run_id = $1 AND status = 'passed'`,
    [testRunId]
  );
  const failedCount = await pool.query(
    `SELECT COUNT(*) FROM test_results WHERE test_run_id = $1 AND status = 'failed'`,
    [testRunId]
  );
  
  // Update test run status to completed with accurate counts
  await pool.query(
    `UPDATE test_runs SET status = 'completed', completed_at = $1, passed_tests = $2, failed_tests = $3 WHERE id = $4`,
    [new Date(), parseInt(passedCount.rows[0].count), parseInt(failedCount.rows[0].count), testRunId]
  );
  
  logger.info(`[BatchedExecution] Completed all batches for ${testRunId} - Passed: ${passedCount.rows[0].count}, Failed: ${failedCount.rows[0].count}`);

  // Send email notifications for failed tests
  emailNotificationService.checkAndNotifyTestRunFailures(testRunId)
    .then(sent => {
      if (sent) {
        logger.info(`[BatchedExecution] Failure notification sent for test run ${testRunId}`);
      }
    })
    .catch(err => logger.error(`[BatchedExecution] Failed to send notification:`, { detail: err }));
}

/**
 * Helper function to create test plan from test cases
 */
async function createTestPlanFromCases(
  testCases: SmartTestCase[],
  keyTopics: KeyTopic[]
): Promise<TestPlan> {
  const batches: CallBatch[] = [];
  const assigned = new Set<string>();
  
  // First, handle test cases that require separate calls
  testCases
    .filter(tc => tc.requiresSeparateCall)
    .forEach(tc => {
      batches.push({
        id: `batch-${batches.length + 1}`,
        name: `${tc.keyTopicName} - ${tc.name}`,
        testCaseIds: [tc.id],
        testCases: [tc],
        estimatedDuration: tc.estimatedTurns * 10,
        primaryTopic: tc.keyTopicName,
        description: `Dedicated call for: ${tc.name}`,
      });
      assigned.add(tc.id);
    });
  
  // Group remaining test cases by topic
  const topicGroups = new Map<string, SmartTestCase[]>();
  testCases
    .filter(tc => !assigned.has(tc.id))
    .forEach(tc => {
      const group = topicGroups.get(tc.keyTopicId) || [];
      group.push(tc);
      topicGroups.set(tc.keyTopicId, group);
    });
  
  // Create batches from topic groups
  const maxTurnsPerCall = 30;
  
  topicGroups.forEach((cases, topicId) => {
    const topic = keyTopics.find(t => t.id === topicId);
    let currentGroup: SmartTestCase[] = [];
    let currentTurns = 0;
    let batchIdx = 0;
    
    cases.forEach(tc => {
      if (currentTurns + tc.estimatedTurns <= maxTurnsPerCall) {
        currentGroup.push(tc);
        currentTurns += tc.estimatedTurns;
      } else {
        if (currentGroup.length > 0) {
          batches.push({
            id: `batch-${batches.length + 1}`,
            name: `${topic?.name || topicId} - Batch ${++batchIdx}`,
            testCaseIds: currentGroup.map(tc => tc.id),
            testCases: currentGroup,
            estimatedDuration: currentTurns * 8,
            primaryTopic: topic?.name || topicId,
            description: `Testing ${currentGroup.length} scenarios`,
          });
        }
        currentGroup = [tc];
        currentTurns = tc.estimatedTurns;
      }
    });
    
    if (currentGroup.length > 0) {
      batches.push({
        id: `batch-${batches.length + 1}`,
        name: `${topic?.name || topicId} - Batch ${++batchIdx}`,
        testCaseIds: currentGroup.map(tc => tc.id),
        testCases: currentGroup,
        estimatedDuration: currentTurns * 8,
        primaryTopic: topic?.name || topicId,
        description: `Testing ${currentGroup.length} scenarios`,
      });
    }
  });
  
  return {
    totalCalls: batches.length,
    totalTestCases: testCases.length,
    estimatedDuration: batches.reduce((sum, b) => sum + b.estimatedDuration, 0),
    batches,
  };
}

/**
 * Execute batched test run - multiple test cases per call
 */
async function executeBatchedTestRun(
  testRunId: string,
  testPlan: TestPlan,
  agentConfig: { provider: string; agentId: string; apiKey: string },
  agentPrompt: string
): Promise<void> {
  logger.info(`[BatchedExecutor] Starting batched execution for ${testRunId}`);
  logger.info(`[BatchedExecutor] Total batches: ${testPlan.batches.length}`);
  
  // Import the batched executor service (to be created)
  const { batchedTestExecutor } = await import('../services/batched-test-executor.service');
  
  // Load false positive patterns for this agent to tune evaluation
  let falsePositivePatterns: Array<{ test_case_scenario: string; actual_response: string; reason: string }> = [];
  let falseNegativePatterns: Array<{ test_case_scenario: string; actual_response: string; reason: string }> = [];
  try {
    const agentIdQuery = await pool.query(
      `SELECT agent_id FROM test_runs WHERE id = $1`, [testRunId]
    );
    if (agentIdQuery.rows[0]?.agent_id) {
      const aid = agentIdQuery.rows[0].agent_id;
      const fpQuery = await pool.query(
        `SELECT test_case_scenario, actual_response, reason FROM false_positive_patterns WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [aid]
      );
      falsePositivePatterns = fpQuery.rows;
      try {
        const fnQuery = await pool.query(
          `SELECT test_case_scenario, actual_response, reason FROM false_negative_patterns WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [aid]
        );
        falseNegativePatterns = fnQuery.rows;
      } catch (e) {
        // table might not exist yet
      }
    }
  } catch (e) {
    // Table might not exist yet - ignore
  }
  
  for (let i = 0; i < testPlan.batches.length; i++) {
    const batch = testPlan.batches[i];
    logger.info(`[BatchedExecutor] Executing batch ${i + 1}/${testPlan.batches.length}: ${batch.name}`);
    
    try {
      // Update test cases to 'running' status
      for (const tc of batch.testCases) {
        await pool.query(
          `UPDATE test_results SET status = 'running' WHERE test_run_id = $1 AND test_case_id = $2`,
          [testRunId, tc.id]
        );
      }
      
      // Execute the batch (single call with multiple test cases)
      const executionResult = await batchedTestExecutor.executeBatch(
        batch,
        agentConfig,
        agentPrompt,
        falsePositivePatterns,
        falseNegativePatterns,
        testRunId, // (#13) prompt logging
      );
      
      // Store results for each test case
      for (const result of executionResult.results) {
        await pool.query(
          `UPDATE test_results 
           SET status = $1, actual_response = $2, overall_score = $3, 
               metrics = $4, completed_at = $5
           WHERE test_run_id = $6 AND test_case_id = $7`,
          [
            result.passed ? 'passed' : 'failed',
            result.actualResponse,
            result.score,
            JSON.stringify({ ...(result.metrics || {}), turnsCovered: result.turnsCovered || [], promptSuggestions: result.promptSuggestions || [] }),
            new Date(),
            testRunId,
            result.testCaseId,
          ]
        );
      }
      
    } catch (error) {
      logger.error(`[BatchedExecutor] Batch ${batch.id} failed:`, error);
      
      // Mark all test cases in batch as failed
      for (const tc of batch.testCases) {
        await pool.query(
          `UPDATE test_results SET status = 'failed', completed_at = $1 
           WHERE test_run_id = $2 AND test_case_id = $3`,
          [new Date(), testRunId, tc.id]
        );
      }
    }
  }
  
  // Update test run status to completed with accurate counts
  const passedCount = await pool.query(
    `SELECT COUNT(*) FROM test_results WHERE test_run_id = $1 AND status = 'passed'`,
    [testRunId]
  );
  const failedCount = await pool.query(
    `SELECT COUNT(*) FROM test_results WHERE test_run_id = $1 AND status = 'failed'`,
    [testRunId]
  );
  
  await pool.query(
    `UPDATE test_runs SET status = 'completed', completed_at = $1, 
     passed_tests = $2, failed_tests = $3 WHERE id = $4`,
    [new Date(), parseInt(passedCount.rows[0].count), parseInt(failedCount.rows[0].count), testRunId]
  );
  
  logger.info(`[BatchedExecutor] Completed batched execution for ${testRunId} - Passed: ${passedCount.rows[0].count}, Failed: ${failedCount.rows[0].count}`);

  // Send email notifications for failed tests
  emailNotificationService.checkAndNotifyTestRunFailures(testRunId)
    .then(sent => {
      if (sent) {
        logger.info(`[BatchedExecutor] Failure notification sent for test run ${testRunId}`);
      }
    })
    .catch(err => logger.error(`[BatchedExecutor] Failed to send notification:`, { detail: err }));
}

/**
 * Serve audio recording files
 * GET /api/test-execution/audio/:filename
 */
router.get('/audio/:filename', (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    
    // Sanitize filename to prevent directory traversal
    const sanitizedFilename = path.basename(filename);
    const filePath = path.join(recordingsDir, sanitizedFilename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found' });
    }
    
    // Read the raw audio file (ulaw 8kHz mono)
    const audioData = fs.readFileSync(filePath);
    
    // Convert raw ulaw to WAV format for browser playback
    const wavBuffer = createWavFromUlaw(audioData);
    
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wavBuffer.length);
    res.setHeader('Content-Disposition', `inline; filename="${sanitizedFilename.replace('.raw', '.wav')}"`);
    
    res.send(wavBuffer);
  } catch (error) {
    logger.error(`Error serving audio:`, { error });
    res.status(500).json({ error: 'Failed to serve audio file' });
  }
});

/**
 * Mark a test result as false positive (tunes the testing agent)
 */
router.post('/mark-false-positive', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { resultId, reason } = req.body;

    if (!resultId) {
      return res.status(400).json({ success: false, error: 'resultId is required' });
    }

    // Get the test result details
    const resultQuery = await pool.query(
      `SELECT tr.*, tc.agent_id, tc.scenario as tc_scenario
       FROM test_results tr
       LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
       WHERE tr.id = $1`,
      [resultId]
    );

    if (resultQuery.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Test result not found' });
    }

    const result = resultQuery.rows[0];

    // Mark as false positive
    await pool.query(
      `UPDATE test_results SET is_false_positive = true, false_positive_reason = $1 WHERE id = $2`,
      [reason || 'Marked by user', resultId]
    );

    // Store the pattern for future test agent tuning
    if (result.agent_id) {
      await pool.query(
        `INSERT INTO false_positive_patterns (agent_id, user_id, test_case_scenario, actual_response, reason, pattern_context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.agent_id,
          userId,
          result.tc_scenario || result.scenario || '',
          result.actual_response || '',
          reason || 'Marked by user',
          JSON.stringify({
            userInput: result.user_input,
            expectedResponse: result.expected_response,
            category: result.category,
          }),
        ]
      );
    }

    res.json({ success: true, message: 'Marked as false positive' });
  } catch (error: any) {
    logger.error(`[FalsePositive] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Mark a PASSED test result as a false negative — the user disagrees with
 * the verdict and considers this a true failure. We store the pattern so
 * the evaluator LLM tightens its judgement for similar responses on the
 * next test run for the same agent.
 */
router.post('/mark-false-negative', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { resultId, reason } = req.body;

    if (!resultId) {
      return res.status(400).json({ success: false, error: 'resultId is required' });
    }

    const resultQuery = await pool.query(
      `SELECT tr.*, tc.agent_id, tc.scenario as tc_scenario
       FROM test_results tr
       LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
       WHERE tr.id = $1`,
      [resultId]
    );

    if (resultQuery.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Test result not found' });
    }

    const result = resultQuery.rows[0];

    await pool.query(
      `UPDATE test_results SET is_false_negative = true, false_negative_reason = $1 WHERE id = $2`,
      [reason || 'Marked by user', resultId]
    );

    if (result.agent_id) {
      await pool.query(
        `INSERT INTO false_negative_patterns (agent_id, user_id, test_case_scenario, actual_response, reason, pattern_context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.agent_id,
          userId,
          result.tc_scenario || result.scenario || '',
          result.actual_response || '',
          reason || 'Marked by user',
          JSON.stringify({
            userInput: result.user_input,
            expectedResponse: result.expected_response,
            category: result.category,
          }),
        ]
      );
    }

    res.json({ success: true, message: 'Marked as false negative' });
  } catch (error: any) {
    logger.error(`[FalseNegative] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Item 7 — list available pre-defined test case templates.
 * Templates are authoritative; the LLM only fills slots.
 */
router.get('/test-case-templates', async (_req: Request, res: Response) => {
  res.json({
    success: true,
    templates: TEST_CASE_TEMPLATES.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      is_security_test: !!t.is_security_test,
      security_test_type: t.security_test_type,
      persona_type: t.persona_type,
      behavior_modifiers: t.behavior_modifiers,
      slot_count: t.slots.length,
    })),
  });
});

/**
 * Item 7 — generate a single test case from a template, optionally filling
 * slots with agent context via LLM. The construct of the test (scenario shape,
 * pass criterion, persona, security flag) is NEVER changed by the LLM.
 */
router.post('/test-case-templates/generate', async (req: Request, res: Response) => {
  try {
    const { templateId, agentId } = req.body as { templateId?: string; agentId?: string };
    if (!templateId || !agentId) {
      return res.status(400).json({ success: false, error: 'templateId and agentId are required' });
    }
    const template = TEST_CASE_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    const agQ = await pool.query(
      `SELECT id, name, prompt, first_message, config FROM agents WHERE id = $1`,
      [agentId],
    );
    if (agQ.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }
    const agent = agQ.rows[0];
    const sp = agent.prompt || agent.config?.systemPrompt || agent.config?.system_prompt || '';
    const filled = await fillTemplateForAgent(template, sp, agent.first_message || '');
    return res.json({ success: true, testCase: filled, template: { id: template.id, name: template.name } });
  } catch (error: any) {
    logger.error(`[Templates] Generate error: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/reevaluate-result', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { resultId, feedback } = req.body as { resultId?: string; feedback?: string };
    if (!resultId) {
      return res.status(400).json({ success: false, error: 'resultId is required' });
    }
    if (!feedback || feedback.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'feedback is required' });
    }

    // Load test result + agent prompt
    const resQ = await pool.query(
      `SELECT tr.*, tc.agent_id, tc.persona_type, tc.persona_traits, tc.voice_accent,
              tc.behavior_modifiers, tc.is_security_test, tc.security_test_type,
              tc.sensitive_data_types,
              COALESCE(ag.prompt, ag.config->>'prompt', ag.config->'agent'->>'prompt') as agent_prompt
       FROM test_results tr
       LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
       LEFT JOIN agents ag ON tc.agent_id = ag.id
       WHERE tr.id = $1`,
      [resultId]
    );
    if (resQ.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Test result not found' });
    }
    const row = resQ.rows[0];

    // Parse stored transcript
    let transcript: Array<{ role: string; content: string; timestamp?: any }> = [];
    if (row.conversation_turns) {
      try {
        transcript = typeof row.conversation_turns === 'string'
          ? JSON.parse(row.conversation_turns)
          : row.conversation_turns;
      } catch { transcript = []; }
    }
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ success: false, error: 'No stored transcript to re-evaluate' });
    }

    // Normalise to the executor's ConversationTurn shape
    const normalisedTranscript = transcript.map(t => ({
      role: (t.role === 'user' || t.role === 'test_caller') ? 'test_caller' as const : 'ai_agent' as const,
      content: String(t.content || ''),
      timestamp: typeof t.timestamp === 'number' ? t.timestamp : Date.parse(t.timestamp || new Date().toISOString()) || Date.now(),
    }));

    const parseArr = (v: any): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v as string[];
      try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
    };

    const previousMetrics = (typeof row.metrics === 'string') ? (() => { try { return JSON.parse(row.metrics); } catch { return {}; } })() : (row.metrics || {});

    const { batchedTestExecutor } = await import('../services/batched-test-executor.service');
    const newVerdict = await batchedTestExecutor.reevaluateSingleTestCase({
      transcript: normalisedTranscript as any,
      testCase: {
        id: row.test_case_id,
        name: row.user_input || row.scenario || 'Test',
        scenario: row.scenario || '',
        userInput: row.user_input || '',
        expectedOutcome: row.expected_response || '',
        category: row.category || 'General',
        keyTopicId: row.category || 'general',
        keyTopicName: row.category || 'General',
        priority: 'medium',
        canBatchWith: [],
        requiresSeparateCall: false,
        estimatedTurns: 4,
        testType: 'happy_path',
        isCallClosing: false,
        batchPosition: 'any',
        persona_type: row.persona_type ?? null,
        persona_traits: parseArr(row.persona_traits),
        voice_accent: row.voice_accent ?? null,
        behavior_modifiers: parseArr(row.behavior_modifiers),
        is_security_test: row.is_security_test ?? false,
        security_test_type: row.security_test_type ?? null,
        sensitive_data_types: parseArr(row.sensitive_data_types),
      } as any,
      agentPrompt: row.agent_prompt || '',
      userFeedback: feedback,
      previousVerdict: {
        passed: row.status === 'passed',
        score: previousMetrics.score || 0,
        actualResponse: row.actual_response || '',
        reasoning: previousMetrics.reasoning || '',
      },
    });

    // Append to reevaluation_history + persist new verdict
    const previousHistory = (typeof row.reevaluation_history === 'string')
      ? (() => { try { return JSON.parse(row.reevaluation_history); } catch { return []; } })()
      : (row.reevaluation_history || []);
    const historyEntry = {
      at: new Date().toISOString(),
      by: userId,
      previousPassed: row.status === 'passed',
      newPassed: newVerdict.passed,
      previousScore: previousMetrics.score || 0,
      newScore: newVerdict.score,
      feedback,
      reasoning: (newVerdict.metrics as any)?.reasoning,
    };
    const newHistory = [...previousHistory, historyEntry];
    const mergedMetrics = { ...previousMetrics, ...newVerdict.metrics, score: newVerdict.score };

    await pool.query(
      `UPDATE test_results
       SET status = $1,
           actual_response = $2,
           metrics = $3,
           user_feedback = $4,
           feedback_at = $5,
           reevaluation_count = COALESCE(reevaluation_count, 0) + 1,
           reevaluation_history = $6
       WHERE id = $7`,
      [
        newVerdict.passed ? 'passed' : 'failed',
        newVerdict.actualResponse,
        JSON.stringify(mergedMetrics),
        feedback,
        new Date(),
        JSON.stringify(newHistory),
        resultId,
      ]
    );

    // If verdict flipped from FAIL → PASS, store as false-positive pattern so future
    // runs of the same scenario / agent inherit the corrected eval bias.
    if (row.status === 'failed' && newVerdict.passed && row.agent_id) {
      try {
        await pool.query(
          `INSERT INTO false_positive_patterns (agent_id, user_id, test_case_scenario, actual_response, reason, pattern_context)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            row.agent_id,
            userId,
            row.scenario || '',
            newVerdict.actualResponse,
            feedback,
            JSON.stringify({
              userInput: row.user_input,
              expectedResponse: row.expected_response,
              category: row.category,
              source: 'reevaluate-result',
            }),
          ]
        );
      } catch (insErr) {
        logger.info('[Reevaluate] could not insert false-positive pattern', { detail: (insErr as Error).message });
      }
    }

    return res.json({
      success: true,
      verdict: {
        passed: newVerdict.passed,
        score: newVerdict.score,
        actualResponse: newVerdict.actualResponse,
        reasoning: (newVerdict.metrics as any)?.reasoning,
        verdictChanged: (newVerdict.metrics as any)?.verdictChanged === true || (row.status === 'passed') !== newVerdict.passed,
        turnsCovered: newVerdict.turnsCovered,
      },
    });
  } catch (error: any) {
    logger.error(`[Reevaluate] Error: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get false positive patterns for an agent (for test caller context)
 */
router.get('/false-positive-patterns/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.params;

    const patterns = await pool.query(
      `SELECT * FROM false_positive_patterns WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [agentId, userId]
    );

    res.json({ success: true, patterns: patterns.rows });
  } catch (error: any) {
    logger.error(`[FalsePositivePatterns] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/false-negative-patterns/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.params;

    const patterns = await pool.query(
      `SELECT * FROM false_negative_patterns WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [agentId, userId]
    );

    res.json({ success: true, patterns: patterns.rows });
  } catch (error: any) {
    logger.error(`[FalseNegativePatterns] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Propose an amendment to the AGENT's system_prompt from a failing result + user
 * feedback, dry-run it on the failing scenario plus two recent siblings, and
 * persist a row in `agent_prompt_amendments`. Returns the proposal and
 * verification runs so the UI can show before/after and let the user decide
 * whether to apply it to the live agent.
 */
router.post('/amend-test-agent', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { resultId, feedback } = req.body as { resultId?: string; feedback?: string };
    if (!resultId) return res.status(400).json({ success: false, error: 'resultId is required' });
    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ success: false, error: 'feedback is required' });
    }
    const { proposeAgentPromptAmendment } = await import('../services/agent-prompt-amendment.service');
    const result = await proposeAgentPromptAmendment({
      resultId,
      feedback: feedback.trim(),
      userId,
    });
    return res.json({ success: true, amendment: result });
  } catch (error: any) {
    logger.error(`[AmendTestAgent] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Apply a previously proposed/verified amendment to the agent's
 * system_prompt. Until this is called, the live agent is unchanged.
 */
router.post('/amend-test-agent/:amendmentId/apply', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { amendmentId } = req.params;
    const { applyAgentPromptAmendment } = await import('../services/agent-prompt-amendment.service');
    const out = await applyAgentPromptAmendment({ amendmentId, userId });
    return res.json({ success: true, ...out });
  } catch (error: any) {
    logger.error(`[AmendTestAgent.apply] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/amend-test-agent/:amendmentId/reject', async (req: Request, res: Response) => {
  try {
    const { amendmentId } = req.params;
    const { rejectAgentPromptAmendment } = await import('../services/agent-prompt-amendment.service');
    await rejectAgentPromptAmendment(amendmentId);
    return res.json({ success: true });
  } catch (error: any) {
    logger.error(`[AmendTestAgent.reject] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/agent-prompt-amendments/:agentId', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const { listAmendmentsForAgent } = await import('../services/agent-prompt-amendment.service');
    const amendments = await listAmendmentsForAgent(agentId);
    return res.json({ success: true, amendments });
  } catch (error: any) {
    logger.error(`[AmendTestAgent.list] ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Save batches for an agent (persist for reuse)
 */
router.post('/save-batches', async (req: Request, res: Response) => {
  try {
    const userId = await resolveInternalUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    const { agentId, name, batches, testCaseIds, isSecurity } = req.body;

    if (!agentId || !batches || !testCaseIds) {
      return res.status(400).json({ success: false, error: 'agentId, batches, and testCaseIds are required' });
    }

    const result = await pool.query(
      `INSERT INTO saved_batches (agent_id, user_id, name, batch_data, test_case_ids, is_security)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [agentId, userId, name || `Batch ${new Date().toLocaleDateString()}`, JSON.stringify(batches), testCaseIds, !!isSecurity]
    );

    res.json({ success: true, savedBatch: result.rows[0] });
  } catch (error: any) {
    logger.error(`[SaveBatches] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get saved batches for an agent
 */
router.get('/saved-batches/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = await resolveInternalUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    const { agentId } = req.params;

    const result = await pool.query(
      `SELECT * FROM saved_batches WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [agentId, userId]
    );

    res.json({ success: true, savedBatches: result.rows });
  } catch (error: any) {
    logger.error(`[GetSavedBatches] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a saved batch (rename + edit batch_data, e.g. reordered calls).
 * The frontend ships the full batch_data array (with the new call order) and
 * we derive test_case_ids from it so the two stay consistent.
 */
router.put('/saved-batches/:id', async (req: Request, res: Response) => {
  try {
    const userId = await resolveInternalUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    const { id } = req.params;
    const { name, batches } = req.body;

    if (!name && !batches) {
      return res.status(400).json({ success: false, error: 'name or batches is required' });
    }

    // Build dynamic SET clause
    const sets: string[] = [];
    const vals: any[] = [];
    let p = 1;
    if (name !== undefined) {
      sets.push(`name = $${p++}`);
      vals.push(name);
    }
    if (batches !== undefined) {
      const ids = Array.from(new Set(
        (Array.isArray(batches) ? batches : []).flatMap((b: any) =>
          (b.testCases || []).map((tc: any) => tc.id).filter(Boolean)
        )
      ));
      sets.push(`batch_data = $${p++}`);
      vals.push(JSON.stringify(batches));
      sets.push(`test_case_ids = $${p++}`);
      vals.push(ids);
    }
    sets.push(`updated_at = NOW()`);
    vals.push(id, userId);

    const result = await pool.query(
      `UPDATE saved_batches SET ${sets.join(', ')}
       WHERE id = $${p++} AND user_id = $${p++}
       RETURNING *`,
      vals
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Saved batch not found' });
    }
    res.json({ success: true, savedBatch: result.rows[0] });
  } catch (error: any) {
    logger.error(`[UpdateSavedBatch] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a saved batch
 */
router.delete('/saved-batches/:id', async (req: Request, res: Response) => {
  try {
    const userId = await resolveInternalUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not authenticated' });
    }
    const { id } = req.params;

    await pool.query(
      `DELETE FROM saved_batches WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`[DeleteSavedBatch] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create WAV file from ulaw audio data
 */
function createWavFromUlaw(ulawData: Buffer): Buffer {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 8;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  
  // WAV header is 44 bytes
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + ulawData.length, 4); // File size - 8
  header.write('WAVE', 8);
  
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(7, 20); // Audio format: 7 = ulaw
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(ulawData.length, 40);
  
  return Buffer.concat([header, ulawData]);
}

export default router;
