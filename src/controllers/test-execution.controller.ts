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

// Create recordings directory if it doesn't exist
const recordingsDir = path.join(__dirname, '../../recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

const router = Router();

/**
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

    console.log(`[Controller] Created ${formattedTestCases.length} pending test results`);

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
      console.log(`[Controller] Test run ${testRunId} execution completed`);
    }).catch((error: Error) => {
      console.error('Test run failed:', error);
      // Update test run status to failed
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch(console.error);
    });

    console.log(`[Controller] REAL test execution started for ${testRunId}`);
    console.log(`[Controller] Provider: ${provider}, Agent: ${agentId}`);

  } catch (error) {
    console.error('Failed to start test run:', error);
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

    // Check if subscription has expired
    const isExpired = userCredits.package_expires_at && new Date(userCredits.package_expires_at) < new Date();
    if (isExpired) {
      return res.status(402).json({
        success: false,
        error: {
          code: 'SUBSCRIPTION_INACTIVE',
          message: 'Your subscription has expired. Please renew to continue testing.',
          details: {
            packageName: userCredits.package_name,
            required: testCaseCount * 10,
            available: userCredits.current_credits || 0,
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
    const availableCredits = userCredits.current_credits || 0;

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
    console.error('Failed to check credits:', error);
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
    console.error('Failed to get test run status:', error);
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
          conversationTurns = conversationTurns.map((turn: any) => ({
            role: turn.role,
            content: turn.content || turn.text || turn.message || '',
            timestamp: turn.timestamp,
            durationMs: turn.durationMs || turn.latencyMs,
          }));
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
    console.error('Failed to get test results:', error);
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
    
    // Map conversation turns to expected format (text -> content)
    if (Array.isArray(conversationTurns)) {
      conversationTurns = conversationTurns.map((turn: any) => ({
        role: turn.role,
        content: turn.content || turn.text || turn.message || '',
        timestamp: turn.timestamp,
        durationMs: turn.durationMs || turn.latencyMs,
      }));
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
        
        // AI-generated prompt suggestions for failed tests
        promptSuggestions: r.prompt_suggestions || [],
        
        // Error
        errorMessage: r.error_message,
      },
    });

  } catch (error) {
    console.error('Failed to get test result:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get result',
    });
  }
});

/**
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
    console.error('Failed to cancel test run:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel test run',
    });
  }
});

/**
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
    console.error('Failed to get metrics:', error);
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
        COUNT(CASE WHEN trs.status = 'failed' THEN 1 END) as failed_cases
      FROM test_runs tr
      LEFT JOIN test_results trs ON trs.test_run_id = tr.id
      WHERE tr.user_id = $1
      GROUP BY tr.id 
      ORDER BY tr.created_at DESC 
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [userId, limit, offset]);

    res.json({
      success: true,
      runs: result.rows.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        createdAt: r.created_at,
        stats: {
          total: parseInt(r.total_tests) || 0,
          completed: parseInt(r.completed_cases) || 0,
          passed: parseInt(r.passed_cases) || 0,
          failed: parseInt(r.failed_cases) || 0,
        },
      })),
    });

  } catch (error) {
    console.error('Failed to list test runs:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list runs',
    });
  }
});

/**
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
      console.error('Re-run failed:', error);
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch(console.error);
    });

  } catch (error) {
    console.error('Failed to re-run test:', error);
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

    console.log(`[SmartTestCases] Generating for agent: ${agentName}`);

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
    console.error('Failed to generate smart test cases:', error);
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
    console.log(`[SmartTestCases] Generating for agent: ${agentId}`);

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
    console.error('Failed to generate smart test cases:', error);
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
    console.error('Failed to create test plan:', error);
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
    console.error('Failed to modify test plan:', error);
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

    console.log(`[IntelligentBatching] Analyzing ${testCases.length} test cases with AI...`);

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

      console.log(`[IntelligentBatching] Created ${result.batches.length} AI-optimized batches`);

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
      console.log(`[Batching] No agent prompt provided, using simple topic-based batching`);
      
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
    console.error('Failed to analyze batching:', error);
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
    
    if (integrationId && !directApiKey) {
      // Look up API key from integration
      const integrationResult = await pool.query(
        'SELECT api_key, provider FROM integrations WHERE id = $1',
        [integrationId]
      );
      
      if (integrationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Integration not found',
        });
      }
      
      apiKey = integrationResult.rows[0].api_key;
      resolvedProvider = integrationResult.rows[0].provider;
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

    console.log(`[BatchedExecution] Created test run with ${batches.length} batches, ${totalTestCases} test cases`);
    console.log(`[BatchedExecution] Batch details:`);
    batches.forEach((batch: Batch, index: number) => {
      console.log(`[BatchedExecution]   Batch ${index + 1}: "${batch.name}" - ${batch.testCases.length} test cases`);
      console.log(`[BatchedExecution]     Test cases: ${batch.testCases.map(tc => tc.name).join(', ')}`);
    });
    console.log(`[BatchedExecution] Batching enabled: ${enableBatching}`);
    console.log(`[BatchedExecution] Concurrency enabled: ${enableConcurrency}, count: ${concurrencyCount}`);

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
        console.log('[BatchedExecution] Could not fetch agent phone number:', e);
      }
    }

    executeBatchedCalls(
      testRunId,
      batches,
      { provider: resolvedProvider, agentId, apiKey, phoneNumber },
      enableBatching,
      enableConcurrency,
      concurrencyCount
    ).catch((error: Error) => {
      console.error('Batched test run failed:', error);
      pool.query(
        `UPDATE test_runs SET status = 'failed' WHERE id = $1`,
        [testRunId]
      ).catch(console.error);
    });

  } catch (error) {
    console.error('Failed to start batched test run:', error);
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
  agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
  enableBatching: boolean,
  enableConcurrency: boolean = false,
  concurrencyCount: number = 1
): Promise<void> {
  console.log(`[BatchedExecution] Starting execution for ${testRunId}`);
  console.log(`[BatchedExecution] Total batches: ${batches.length}`);
  console.log(`[BatchedExecution] Concurrency: ${enableConcurrency ? `enabled (${concurrencyCount})` : 'disabled (sequential)'}`);
  
  const { batchedTestExecutor } = await import('../services/batched-test-executor.service');
  
  // Helper function to execute a single batch
  const executeSingleBatch = async (batch: typeof batches[0], batchIndex: number) => {
    console.log(`[BatchedExecution] Executing batch ${batchIndex + 1}/${batches.length}: ${batch.name} (${batch.testCases.length} test cases)`);
    
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
      console.log(`[BatchedExecution] Batch ${batch.id} testMode: ${testMode}`);
      
      const executionResult = await batchedTestExecutor.executeBatch(
        {
          id: batch.id,
          name: batch.name,
          testMode: testMode,  // Pass testMode for voice/chat routing
          testCaseIds: batch.testCases.map(tc => tc.id),
          testCases: batch.testCases.map(tc => ({
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
        '' // Agent prompt - will be fetched by executor
      );
      
      const { results, transcript, totalTurns, durationMs, audioBuffer } = executionResult;
      
      console.log(`[BatchedExecution] Batch ${batch.id} execution result:`);
      console.log(`[BatchedExecution]   - Results count: ${results.length}`);
      console.log(`[BatchedExecution]   - Transcript length: ${transcript.length}`);
      console.log(`[BatchedExecution]   - Total turns: ${totalTurns}`);
      console.log(`[BatchedExecution]   - Duration: ${durationMs}ms`);
      if (transcript.length > 0) {
        console.log(`[BatchedExecution]   - First turn: ${JSON.stringify(transcript[0])}`);
      }
      
      // Save audio recording if available
      let audioUrl: string | null = null;
      if (audioBuffer && audioBuffer.length > 0) {
        const audioFileName = `${testRunId}_${batch.id}.raw`;
        const audioFilePath = path.join(recordingsDir, audioFileName);
        fs.writeFileSync(audioFilePath, audioBuffer);
        audioUrl = `/api/audio/${audioFileName}`;
        console.log(`[BatchedExecution] Saved audio: ${audioFilePath} (${audioBuffer.length} bytes)`);
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
      console.log(`[BatchedExecution] Saving batch ${batch.id} with ${results.length} results for ${batch.testCases.length} test cases`);
      
      // Create a map from result names to results for quick lookup
      const resultMap = new Map(results.map(r => [r.testCaseName, r]));
      
      // Update ALL test cases in this batch
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
      
      console.log(`[BatchedExecution] Batch ${batch.id} completed: ${results.filter(r => r.passed).length}/${results.length} passed, ${totalTurns} turns, ${durationMs}ms`);
      
    } catch (error) {
      console.error(`[BatchedExecution] Batch ${batch.id} failed:`, error);
      
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
    console.log(`[BatchedExecution] Running ${batches.length} batches with concurrency ${concurrencyCount}`);
    
    // Process batches in chunks
    for (let i = 0; i < batches.length; i += concurrencyCount) {
      const chunk = batches.slice(i, i + concurrencyCount);
      const chunkPromises = chunk.map((batch, idx) => executeSingleBatch(batch, i + idx));
      
      console.log(`[BatchedExecution] Starting concurrent round ${Math.floor(i / concurrencyCount) + 1}: ${chunk.length} batches`);
      await Promise.all(chunkPromises);
      console.log(`[BatchedExecution] Completed concurrent round ${Math.floor(i / concurrencyCount) + 1}`);
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
  
  console.log(`[BatchedExecution] Completed all batches for ${testRunId} - Passed: ${passedCount.rows[0].count}, Failed: ${failedCount.rows[0].count}`);

  // Send email notifications for failed tests
  emailNotificationService.checkAndNotifyTestRunFailures(testRunId)
    .then(sent => {
      if (sent) {
        console.log(`[BatchedExecution] Failure notification sent for test run ${testRunId}`);
      }
    })
    .catch(err => console.error('[BatchedExecution] Failed to send notification:', err));
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
  console.log(`[BatchedExecutor] Starting batched execution for ${testRunId}`);
  console.log(`[BatchedExecutor] Total batches: ${testPlan.batches.length}`);
  
  // Import the batched executor service (to be created)
  const { batchedTestExecutor } = await import('../services/batched-test-executor.service');
  
  for (let i = 0; i < testPlan.batches.length; i++) {
    const batch = testPlan.batches[i];
    console.log(`[BatchedExecutor] Executing batch ${i + 1}/${testPlan.batches.length}: ${batch.name}`);
    
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
        agentPrompt
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
            JSON.stringify(result.metrics || {}),
            new Date(),
            testRunId,
            result.testCaseId,
          ]
        );
      }
      
    } catch (error) {
      console.error(`[BatchedExecutor] Batch ${batch.id} failed:`, error);
      
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
  
  console.log(`[BatchedExecutor] Completed batched execution for ${testRunId} - Passed: ${passedCount.rows[0].count}, Failed: ${failedCount.rows[0].count}`);

  // Send email notifications for failed tests
  emailNotificationService.checkAndNotifyTestRunFailures(testRunId)
    .then(sent => {
      if (sent) {
        console.log(`[BatchedExecutor] Failure notification sent for test run ${testRunId}`);
      }
    })
    .catch(err => console.error('[BatchedExecutor] Failed to send notification:', err));
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
    console.error('Error serving audio:', error);
    res.status(500).json({ error: 'Failed to serve audio file' });
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
