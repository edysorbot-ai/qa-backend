/**
 * Workflow Test Executor Service
 * 
 * Executes tests based on the workflow design.
 * Handles sequential execution of call groups and concurrent calls within groups.
 */

import { 
  WorkflowExecutionPlan, 
  ExecutionGroup, 
  CallExecution,
  TestCaseInWorkflow,
} from '../models/workflow.model';
import { BatchedTestExecutorService } from './batched-test-executor.service';
import { CallBatch, SmartTestCase } from './smart-testcase-generator.service';
import { query } from '../db';
import { v4 as uuidv4 } from 'uuid';

interface WorkflowExecutionResult {
  testRunId: string;
  status: 'completed' | 'failed' | 'partial';
  totalCalls: number;
  completedCalls: number;
  totalTestCases: number;
  passedTestCases: number;
  failedTestCases: number;
  results: CallExecutionResult[];
  durationMs: number;
}

interface CallExecutionResult {
  callNodeId: string;
  callLabel: string;
  status: 'completed' | 'failed' | 'skipped';
  testResults: TestResult[];
  transcript: ConversationTurn[];
  durationMs: number;
  error?: string;
}

interface TestResult {
  testCaseId: string;
  testCaseName: string;
  passed: boolean;
  score: number;
  actualResponse: string;
  metrics: Record<string, any>;
}

interface ConversationTurn {
  role: 'test_caller' | 'ai_agent';
  content: string;
  timestamp: number;
  testCaseId?: string;
}

export class WorkflowTestExecutorService {
  private batchedExecutor: BatchedTestExecutorService;

  constructor() {
    this.batchedExecutor = new BatchedTestExecutorService();
  }

  /**
   * Execute a workflow-based test run
   */
  async executeWorkflow(
    testRunId: string,
    executionPlan: WorkflowExecutionPlan,
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    agentPrompt: string,
    onProgress?: (progress: WorkflowProgress) => void
  ): Promise<WorkflowExecutionResult> {
    console.log(`[WorkflowExecutor] Starting workflow execution for test run: ${testRunId}`);
    console.log(`[WorkflowExecutor] Execution plan: ${executionPlan.executionGroups.length} groups, ${executionPlan.totalCalls} calls, ${executionPlan.totalTestCases} test cases`);

    const startTime = Date.now();
    const results: CallExecutionResult[] = [];
    let completedCalls = 0;
    let passedTestCases = 0;
    let failedTestCases = 0;

    try {
      // Process each execution group sequentially
      for (const group of executionPlan.executionGroups) {
        console.log(`[WorkflowExecutor] Processing group ${group.order + 1}, concurrent: ${group.concurrent}, calls: ${group.calls.length}`);

        // Update progress
        onProgress?.({
          testRunId,
          currentGroup: group.order + 1,
          totalGroups: executionPlan.executionGroups.length,
          completedCalls,
          totalCalls: executionPlan.totalCalls,
          status: 'running',
        });

        if (group.concurrent && group.calls.length > 1) {
          // Execute calls concurrently
          const callResults = await this.executeConcurrentCalls(
            group.calls,
            agentConfig,
            agentPrompt,
            testRunId
          );
          
          results.push(...callResults);
          completedCalls += callResults.length;
          
          // Count passed/failed
          for (const result of callResults) {
            for (const testResult of result.testResults) {
              if (testResult.passed) passedTestCases++;
              else failedTestCases++;
            }
          }
        } else {
          // Execute calls sequentially
          for (const call of group.calls) {
            const callResult = await this.executeCall(
              call,
              agentConfig,
              agentPrompt,
              testRunId
            );
            
            results.push(callResult);
            completedCalls++;
            
            // Count passed/failed
            for (const testResult of callResult.testResults) {
              if (testResult.passed) passedTestCases++;
              else failedTestCases++;
            }

            // Update progress after each call
            onProgress?.({
              testRunId,
              currentGroup: group.order + 1,
              totalGroups: executionPlan.executionGroups.length,
              completedCalls,
              totalCalls: executionPlan.totalCalls,
              status: 'running',
            });
          }
        }
      }

      const durationMs = Date.now() - startTime;

      const finalResult: WorkflowExecutionResult = {
        testRunId,
        status: failedTestCases === 0 ? 'completed' : 
                passedTestCases === 0 ? 'failed' : 'partial',
        totalCalls: executionPlan.totalCalls,
        completedCalls,
        totalTestCases: executionPlan.totalTestCases,
        passedTestCases,
        failedTestCases,
        results,
        durationMs,
      };

      // Update progress - completed
      onProgress?.({
        testRunId,
        currentGroup: executionPlan.executionGroups.length,
        totalGroups: executionPlan.executionGroups.length,
        completedCalls,
        totalCalls: executionPlan.totalCalls,
        status: 'completed',
      });

      return finalResult;
    } catch (error) {
      console.error('[WorkflowExecutor] Error executing workflow:', error);
      
      return {
        testRunId,
        status: 'failed',
        totalCalls: executionPlan.totalCalls,
        completedCalls,
        totalTestCases: executionPlan.totalTestCases,
        passedTestCases,
        failedTestCases,
        results,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute a single call with its test cases
   */
  private async executeCall(
    call: CallExecution,
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    agentPrompt: string,
    testRunId: string
  ): Promise<CallExecutionResult> {
    console.log(`[WorkflowExecutor] Executing call: ${call.callLabel} with ${call.testCases.length} test cases`);
    
    const startTime = Date.now();

    if (call.testCases.length === 0) {
      return {
        callNodeId: call.callNodeId,
        callLabel: call.callLabel,
        status: 'skipped',
        testResults: [],
        transcript: [],
        durationMs: 0,
      };
    }

    try {
      // Convert workflow test cases to batch format
      const batch: CallBatch = {
        id: `workflow_${call.callNodeId}`,
        name: call.callLabel,
        testCaseIds: call.testCases.map(tc => tc.id),
        testCases: call.testCases.map(tc => ({
          id: tc.id,
          name: tc.name,
          scenario: tc.scenario,
          userInput: tc.scenario, // Use scenario as user input
          expectedOutcome: tc.expectedOutcome,
          category: tc.category,
          keyTopicId: tc.category,
          keyTopicName: tc.category,
          priority: tc.priority,
          canBatchWith: [],
          requiresSeparateCall: false,
          estimatedTurns: 2,
          testType: 'happy_path' as const,
          isCallClosing: false,
          batchPosition: 'any' as const,
        })),
        estimatedDuration: 180, // 3 minutes in seconds
        primaryTopic: call.callLabel,
        description: `Workflow call: ${call.callLabel}`,
      };

      // Use batched executor to run the tests
      const batchResult = await this.batchedExecutor.executeBatch(
        batch,
        agentConfig,
        agentPrompt
      );

      // Save individual test results to database
      for (const result of batchResult.results) {
        await this.saveTestResult(testRunId, result, call.callNodeId);
      }

      return {
        callNodeId: call.callNodeId,
        callLabel: call.callLabel,
        status: 'completed',
        testResults: batchResult.results.map(r => ({
          testCaseId: r.testCaseId,
          testCaseName: r.testCaseName,
          passed: r.passed,
          score: r.score,
          actualResponse: r.actualResponse,
          metrics: r.metrics,
        })),
        transcript: batchResult.transcript,
        durationMs: batchResult.durationMs,
      };
    } catch (error: any) {
      console.error(`[WorkflowExecutor] Error executing call ${call.callLabel}:`, error);
      
      return {
        callNodeId: call.callNodeId,
        callLabel: call.callLabel,
        status: 'failed',
        testResults: [],
        transcript: [],
        durationMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute multiple calls concurrently
   */
  private async executeConcurrentCalls(
    calls: CallExecution[],
    agentConfig: { provider: string; agentId: string; apiKey: string; phoneNumber?: string },
    agentPrompt: string,
    testRunId: string
  ): Promise<CallExecutionResult[]> {
    console.log(`[WorkflowExecutor] Executing ${calls.length} calls concurrently`);
    
    // Limit concurrency to prevent overwhelming the voice API
    const maxConcurrency = Math.min(calls.length, 3);
    const results: CallExecutionResult[] = [];
    
    // Process in batches if needed
    for (let i = 0; i < calls.length; i += maxConcurrency) {
      const batch = calls.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(call =>
        this.executeCall(call, agentConfig, agentPrompt, testRunId)
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    
    return results;
  }

  /**
   * Save test result to database
   */
  private async saveTestResult(
    testRunId: string,
    result: any,
    callNodeId: string
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO test_results (id, test_run_id, test_case_id, status, score, actual_response, metrics, workflow_call_node_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uuidv4(),
          testRunId,
          result.testCaseId,
          result.passed ? 'passed' : 'failed',
          result.score,
          result.actualResponse,
          JSON.stringify(result.metrics),
          callNodeId,
        ]
      );
    } catch (error) {
      console.error('[WorkflowExecutor] Error saving test result:', error);
    }
  }
}

export interface WorkflowProgress {
  testRunId: string;
  currentGroup: number;
  totalGroups: number;
  completedCalls: number;
  totalCalls: number;
  status: 'running' | 'completed' | 'failed';
}

export const workflowTestExecutorService = new WorkflowTestExecutorService();
