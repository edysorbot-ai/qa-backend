import { pool } from '../db';
import { ContextGrowthMetrics, TurnTokenMetrics, ConversationTurn } from '../models/testResult.model';
import OpenAI from 'openai';

// Token counting utilities
const COST_PER_1K_INPUT_TOKENS = 0.0025; // GPT-4o pricing
const COST_PER_1K_OUTPUT_TOKENS = 0.01;
const BLOAT_THRESHOLD = 20; // % growth rate that indicates bloat
const CONTEXT_WARNING_SIZE = 4000; // Tokens

export class ContextGrowthService {
  private openai: OpenAI | null = null;

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
    return this.openai;
  }

  /**
   * Estimate token count for a string using GPT tokenizer approximation
   * For production, use tiktoken library for accurate counts
   */
  estimateTokenCount(text: string): number {
    if (!text) return 0;
    // Rough estimation: ~4 characters per token for English text
    // More accurate for production: use tiktoken
    return Math.ceil(text.length / 4);
  }

  /**
   * Calculate token metrics for each turn in a conversation
   */
  calculateTurnMetrics(conversationTurns: ConversationTurn[]): TurnTokenMetrics[] {
    const metrics: TurnTokenMetrics[] = [];
    let cumulativeContext = 0;
    let previousContextSize = 0;

    conversationTurns.forEach((turn, index) => {
      const turnTokens = this.estimateTokenCount(turn.text);
      
      // User turns add to prompt tokens, agent turns are completion tokens
      const promptTokens = turn.role === 'user' ? turnTokens : 0;
      const completionTokens = turn.role === 'agent' ? turnTokens : 0;
      
      // Cumulative context grows with each turn (simulating full history being passed)
      cumulativeContext += turnTokens;
      
      // Calculate growth rate
      const growthRate = previousContextSize > 0 
        ? ((cumulativeContext - previousContextSize) / previousContextSize) * 100 
        : 0;

      metrics.push({
        turnNumber: index + 1,
        promptTokens,
        completionTokens,
        totalContextTokens: cumulativeContext,
        contextGrowthRate: Math.round(growthRate * 100) / 100,
        timestamp: new Date(turn.timestamp || Date.now()),
      });

      previousContextSize = cumulativeContext;
    });

    return metrics;
  }

  /**
   * Analyze context growth and detect bloat patterns
   */
  analyzeContextGrowth(turnMetrics: TurnTokenMetrics[]): ContextGrowthMetrics {
    if (turnMetrics.length === 0) {
      return {
        testResultId: '',
        turns: [],
        totalTokensUsed: 0,
        averageContextGrowth: 0,
        maxContextSize: 0,
        contextEfficiencyScore: 100,
        bloatDetected: false,
      };
    }

    const totalTokens = turnMetrics.reduce(
      (sum, t) => sum + t.promptTokens + t.completionTokens, 
      0
    );

    const maxContext = Math.max(...turnMetrics.map(t => t.totalContextTokens));
    
    const growthRates = turnMetrics
      .filter(t => t.turnNumber > 1)
      .map(t => t.contextGrowthRate);
    
    const avgGrowth = growthRates.length > 0
      ? growthRates.reduce((a, b) => a + b, 0) / growthRates.length
      : 0;

    // Detect bloat: exponential or super-linear growth
    // Ideal: sublinear growth (using summarization)
    // Linear: each turn adds roughly same amount
    // Bloat: growth rate increases over time
    let bloatDetected = false;
    let bloatTurnNumber: number | undefined;

    for (const turn of turnMetrics) {
      if (turn.contextGrowthRate > BLOAT_THRESHOLD || 
          turn.totalContextTokens > CONTEXT_WARNING_SIZE) {
        bloatDetected = true;
        bloatTurnNumber = turn.turnNumber;
        break;
      }
    }

    // Efficiency score: 100 = perfect (constant context), higher = worse
    // Based on how much the final context exceeds expected linear growth
    const expectedLinearContext = turnMetrics[0]?.totalContextTokens * turnMetrics.length;
    const actualFinalContext = turnMetrics[turnMetrics.length - 1]?.totalContextTokens || 0;
    const efficiencyScore = expectedLinearContext > 0 
      ? Math.round((actualFinalContext / expectedLinearContext) * 100)
      : 100;

    // Estimate cost savings with better context management
    const potentialOptimizedTokens = totalTokens * 0.3; // Assume 30% reduction possible
    const estimatedSavings = (potentialOptimizedTokens / 1000) * 
      ((COST_PER_1K_INPUT_TOKENS + COST_PER_1K_OUTPUT_TOKENS) / 2);

    return {
      testResultId: '',
      turns: turnMetrics,
      totalTokensUsed: totalTokens,
      averageContextGrowth: Math.round(avgGrowth * 100) / 100,
      maxContextSize: maxContext,
      contextEfficiencyScore: efficiencyScore,
      bloatDetected,
      bloatTurnNumber,
      estimatedCostSavings: bloatDetected ? Math.round(estimatedSavings * 100) / 100 : 0,
    };
  }

  /**
   * Store turn token metrics in the database
   */
  async storeTurnMetrics(testResultId: string, turnMetrics: TurnTokenMetrics[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete existing metrics for this result
      await client.query(
        'DELETE FROM turn_token_metrics WHERE test_result_id = $1',
        [testResultId]
      );

      // Insert new metrics
      for (const turn of turnMetrics) {
        await client.query(
          `INSERT INTO turn_token_metrics 
           (test_result_id, turn_number, role, prompt_tokens, completion_tokens, 
            cumulative_context_tokens, growth_rate)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            testResultId,
            turn.turnNumber,
            turn.promptTokens > 0 ? 'user' : 'agent',
            turn.promptTokens,
            turn.completionTokens,
            turn.totalContextTokens,
            turn.contextGrowthRate,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update test result with context growth summary
   */
  async updateTestResultWithMetrics(
    testResultId: string, 
    metrics: ContextGrowthMetrics
  ): Promise<void> {
    await pool.query(
      `UPDATE test_results SET
        total_tokens_used = $1,
        max_context_size = $2,
        avg_context_growth = $3,
        context_efficiency_score = $4,
        bloat_detected = $5,
        bloat_turn_number = $6
       WHERE id = $7`,
      [
        metrics.totalTokensUsed,
        metrics.maxContextSize,
        metrics.averageContextGrowth,
        metrics.contextEfficiencyScore,
        metrics.bloatDetected,
        metrics.bloatTurnNumber || null,
        testResultId,
      ]
    );
  }

  /**
   * Get context growth metrics for a test result
   */
  async getContextMetrics(testResultId: string): Promise<ContextGrowthMetrics | null> {
    // First check if we have stored metrics
    const storedResult = await pool.query(
      `SELECT total_tokens_used, max_context_size, avg_context_growth, 
              context_efficiency_score, bloat_detected, bloat_turn_number
       FROM test_results WHERE id = $1`,
      [testResultId]
    );

    if (storedResult.rows.length === 0) {
      return null;
    }

    const storedData = storedResult.rows[0];

    // Get turn-level metrics
    const turnResult = await pool.query(
      `SELECT turn_number, role, prompt_tokens, completion_tokens, 
              cumulative_context_tokens, growth_rate, created_at
       FROM turn_token_metrics 
       WHERE test_result_id = $1 
       ORDER BY turn_number`,
      [testResultId]
    );

    // If we have stored turn metrics, use them
    if (turnResult.rows.length > 0) {
      const turns: TurnTokenMetrics[] = turnResult.rows.map(row => ({
        turnNumber: row.turn_number,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalContextTokens: row.cumulative_context_tokens,
        contextGrowthRate: parseFloat(row.growth_rate),
        timestamp: row.created_at,
      }));

      return {
        testResultId,
        turns,
        totalTokensUsed: storedData.total_tokens_used || 0,
        averageContextGrowth: parseFloat(storedData.avg_context_growth) || 0,
        maxContextSize: storedData.max_context_size || 0,
        contextEfficiencyScore: parseFloat(storedData.context_efficiency_score) || 100,
        bloatDetected: storedData.bloat_detected || false,
        bloatTurnNumber: storedData.bloat_turn_number,
      };
    }

    // If no stored turn metrics, calculate from conversation_turns
    const conversationResult = await pool.query(
      'SELECT conversation_turns FROM test_results WHERE id = $1',
      [testResultId]
    );

    if (conversationResult.rows.length === 0) {
      return null;
    }

    const conversationTurns = conversationResult.rows[0].conversation_turns || [];
    
    // Map to standard format if needed
    const normalizedTurns: ConversationTurn[] = conversationTurns.map((turn: any) => ({
      role: turn.role === 'test_caller' ? 'user' : turn.role === 'ai_agent' ? 'agent' : turn.role,
      text: turn.content || turn.text || '',
      timestamp: turn.timestamp || Date.now(),
    }));

    const turnMetrics = this.calculateTurnMetrics(normalizedTurns);
    const metrics = this.analyzeContextGrowth(turnMetrics);
    metrics.testResultId = testResultId;

    // Store for future queries
    await this.storeTurnMetrics(testResultId, turnMetrics);
    await this.updateTestResultWithMetrics(testResultId, metrics);

    return metrics;
  }

  /**
   * Get context growth summary for an agent (across all test results)
   */
  async getAgentContextSummary(agentId: string): Promise<{
    averageTokensPerTest: number;
    averageGrowthRate: number;
    testsWithBloat: number;
    totalTests: number;
    mostEfficientTest: { id: string; score: number } | null;
    leastEfficientTest: { id: string; score: number } | null;
  }> {
    const result = await pool.query(
      `SELECT 
         COUNT(*)::int as total_tests,
         AVG(total_tokens_used)::int as avg_tokens,
         AVG(avg_context_growth) as avg_growth,
         COUNT(*) FILTER (WHERE bloat_detected = true)::int as bloat_count
       FROM test_results tr
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1 AND tr.total_tokens_used IS NOT NULL`,
      [agentId]
    );

    const summary = result.rows[0];

    // Get most and least efficient tests
    const efficientResult = await pool.query(
      `SELECT tr.id, tr.context_efficiency_score
       FROM test_results tr
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1 AND tr.context_efficiency_score IS NOT NULL
       ORDER BY tr.context_efficiency_score ASC
       LIMIT 1`,
      [agentId]
    );

    const inefficientResult = await pool.query(
      `SELECT tr.id, tr.context_efficiency_score
       FROM test_results tr
       JOIN test_runs trun ON tr.test_run_id = trun.id
       WHERE trun.agent_id = $1 AND tr.context_efficiency_score IS NOT NULL
       ORDER BY tr.context_efficiency_score DESC
       LIMIT 1`,
      [agentId]
    );

    return {
      averageTokensPerTest: summary.avg_tokens || 0,
      averageGrowthRate: parseFloat(summary.avg_growth) || 0,
      testsWithBloat: summary.bloat_count || 0,
      totalTests: summary.total_tests || 0,
      mostEfficientTest: efficientResult.rows[0] 
        ? { id: efficientResult.rows[0].id, score: efficientResult.rows[0].context_efficiency_score }
        : null,
      leastEfficientTest: inefficientResult.rows[0]
        ? { id: inefficientResult.rows[0].id, score: inefficientResult.rows[0].context_efficiency_score }
        : null,
    };
  }
}

export const contextGrowthService = new ContextGrowthService();
