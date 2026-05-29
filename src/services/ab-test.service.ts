/**
 * A/B Prompt Testing Service
 * 
 * Runs the same test suite against two different prompts and 
 * provides statistical comparison with confidence intervals.
 */

import pool from '../db';
import { logger } from './logger.service';
import OpenAI from 'openai';

interface ABTestResult {
  testCaseId: string;
  testCaseName: string;
  passed: boolean;
  score: number;
  actualResponse: string;
}

interface ABTestSummary {
  promptA: {
    label: string;
    passRate: number;
    avgScore: number;
    scores: number[];
  };
  promptB: {
    label: string;
    passRate: number;
    avgScore: number;
    scores: number[];
  };
  winner: 'a' | 'b' | 'tie';
  confidenceLevel: number;
  pValue: number;
  significantMetrics: Array<{
    metric: string;
    promptAValue: number;
    promptBValue: number;
    improvement: number;
    significant: boolean;
  }>;
  sampleSizeRecommendation?: string;
}

class ABTestService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  /**
   * Create a new A/B test
   */
  async createABTest(params: {
    userId: string;
    agentId: string;
    name: string;
    promptA: string;
    promptB: string;
    promptALabel?: string;
    promptBLabel?: string;
    testCaseIds: string[];
    sampleSize?: number;
  }): Promise<string> {
    const result = await pool.query(
      `INSERT INTO ab_tests (user_id, agent_id, name, prompt_a, prompt_b, prompt_a_label, prompt_b_label, test_case_ids, sample_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        params.userId,
        params.agentId,
        params.name,
        params.promptA,
        params.promptB,
        params.promptALabel || 'Prompt A',
        params.promptBLabel || 'Prompt B',
        params.testCaseIds,
        params.sampleSize || 10,
      ]
    );

    return result.rows[0].id;
  }

  /**
   * Run the A/B test - evaluates both prompts against the same test cases
   */
  async runABTest(abTestId: string): Promise<void> {
    // Mark as running
    await pool.query(`UPDATE ab_tests SET status = 'running' WHERE id = $1`, [abTestId]);

    try {
      const testQuery = await pool.query(`SELECT * FROM ab_tests WHERE id = $1`, [abTestId]);
      const abTest = testQuery.rows[0];
      if (!abTest) throw new Error('A/B test not found');

      // Fetch test cases
      const tcQuery = await pool.query(
        `SELECT id, name, scenario, user_input, expected_response, category
         FROM test_cases WHERE id = ANY($1)`,
        [abTest.test_case_ids]
      );
      const testCases = tcQuery.rows;

      // Run evaluations for both prompts
      const resultsA = await this.evaluatePromptAgainstTestCases(abTest.prompt_a, testCases);
      const resultsB = await this.evaluatePromptAgainstTestCases(abTest.prompt_b, testCases);

      // Calculate statistical summary
      const summary = this.calculateStatistics(resultsA, resultsB, abTest.prompt_a_label, abTest.prompt_b_label);

      // Store results
      await pool.query(
        `UPDATE ab_tests SET 
          status = 'completed',
          results_a = $1,
          results_b = $2,
          summary = $3,
          winner = $4,
          confidence_level = $5,
          completed_at = NOW()
         WHERE id = $6`,
        [
          JSON.stringify(resultsA),
          JSON.stringify(resultsB),
          JSON.stringify(summary),
          summary.winner,
          summary.confidenceLevel,
          abTestId,
        ]
      );

      logger.info(`[ABTest] Completed A/B test ${abTestId} - Winner: ${summary.winner} (confidence: ${(summary.confidenceLevel * 100).toFixed(1)}%)`);
    } catch (error: any) {
      logger.error(`[ABTest] Failed: ${error.message}`);
      await pool.query(`UPDATE ab_tests SET status = 'failed' WHERE id = $1`, [abTestId]);
      throw error;
    }
  }

  /**
   * Evaluate a prompt against test cases using GPT-4o
   */
  private async evaluatePromptAgainstTestCases(
    agentPrompt: string,
    testCases: Array<{ id: string; name: string; scenario: string; user_input: string; expected_response: string; category: string }>
  ): Promise<ABTestResult[]> {
    const results: ABTestResult[] = [];

    for (const tc of testCases) {
      try {
        // Simulate agent response based on the prompt
        const agentResponse = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: agentPrompt },
            { role: 'user', content: tc.user_input || tc.scenario },
          ],
          temperature: 0.3,
          max_tokens: 500,
        });

        const actualResponse = agentResponse.choices[0]?.message?.content || '';

        // Evaluate the response
        const evaluation = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are a QA evaluator. Score the agent's response against the expected behavior.
Return JSON: { "passed": true/false, "score": 0-100, "reasoning": "brief explanation" }`
            },
            {
              role: 'user',
              content: `Test: ${tc.scenario}\nExpected: ${tc.expected_response}\nActual: ${actualResponse}`
            },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        const evalResult = JSON.parse(evaluation.choices[0]?.message?.content || '{"passed":false,"score":0}');

        results.push({
          testCaseId: tc.id,
          testCaseName: tc.name,
          passed: evalResult.passed,
          score: evalResult.score || 0,
          actualResponse: actualResponse.substring(0, 500),
        });
      } catch (error) {
        results.push({
          testCaseId: tc.id,
          testCaseName: tc.name,
          passed: false,
          score: 0,
          actualResponse: 'Evaluation failed',
        });
      }
    }

    return results;
  }

  /**
   * Calculate statistical significance using Welch's t-test
   */
  private calculateStatistics(
    resultsA: ABTestResult[],
    resultsB: ABTestResult[],
    labelA: string,
    labelB: string
  ): ABTestSummary {
    const scoresA = resultsA.map(r => r.score);
    const scoresB = resultsB.map(r => r.score);
    const passRateA = resultsA.filter(r => r.passed).length / resultsA.length;
    const passRateB = resultsB.filter(r => r.passed).length / resultsB.length;
    const avgA = scoresA.reduce((a, b) => a + b, 0) / scoresA.length;
    const avgB = scoresB.reduce((a, b) => a + b, 0) / scoresB.length;

    // Welch's t-test
    const varA = this.variance(scoresA);
    const varB = this.variance(scoresB);
    const n = scoresA.length;
    const tStat = Math.abs(avgA - avgB) / Math.sqrt(varA / n + varB / n);
    
    // Approximate p-value using t-distribution (simplified)
    const df = n - 1;
    const pValue = this.tDistributionPValue(tStat, df);
    const confidenceLevel = 1 - pValue;

    let winner: 'a' | 'b' | 'tie' = 'tie';
    if (pValue < 0.05) {
      winner = avgA > avgB ? 'a' : 'b';
    }

    const improvement = avgA !== 0 ? ((avgB - avgA) / avgA) * 100 : 0;

    return {
      promptA: { label: labelA, passRate: passRateA * 100, avgScore: avgA, scores: scoresA },
      promptB: { label: labelB, passRate: passRateB * 100, avgScore: avgB, scores: scoresB },
      winner,
      confidenceLevel,
      pValue,
      significantMetrics: [
        {
          metric: 'Average Score',
          promptAValue: avgA,
          promptBValue: avgB,
          improvement,
          significant: pValue < 0.05,
        },
        {
          metric: 'Pass Rate',
          promptAValue: passRateA * 100,
          promptBValue: passRateB * 100,
          improvement: passRateA !== 0 ? ((passRateB - passRateA) / passRateA) * 100 : 0,
          significant: Math.abs(passRateA - passRateB) > 0.1,
        },
      ],
      sampleSizeRecommendation: pValue > 0.05 && pValue < 0.2
        ? `Run ${Math.ceil(n * 2)} more test cases for 95% confidence`
        : undefined,
    };
  }

  private variance(arr: number[]): number {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length - 1);
  }

  /**
   * Simplified t-distribution p-value approximation
   */
  private tDistributionPValue(t: number, df: number): number {
    // Using approximation for two-tailed test
    const x = df / (df + t * t);
    const a = df / 2;
    const b = 0.5;
    // Incomplete beta function approximation
    const p = this.incompleteBeta(x, a, b);
    return Math.min(1, Math.max(0, p));
  }

  private incompleteBeta(x: number, a: number, b: number): number {
    // Simple approximation using continued fraction
    if (x === 0 || x === 1) return x;
    const bt = Math.exp(
      this.logGamma(a + b) - this.logGamma(a) - this.logGamma(b) +
      a * Math.log(x) + b * Math.log(1 - x)
    );
    if (x < (a + 1) / (a + b + 2)) {
      return bt * this.betaCF(x, a, b) / a;
    }
    return 1 - bt * this.betaCF(1 - x, b, a) / b;
  }

  private betaCF(x: number, a: number, b: number): number {
    const maxIterations = 100;
    const epsilon = 1e-7;
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < epsilon) d = epsilon;
    d = 1 / d;
    let result = d;
    for (let i = 1; i <= maxIterations; i++) {
      const m = i;
      let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
      d = 1 + numerator * d;
      if (Math.abs(d) < epsilon) d = epsilon;
      c = 1 + numerator / c;
      if (Math.abs(c) < epsilon) c = epsilon;
      d = 1 / d;
      result *= d * c;
      numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
      d = 1 + numerator * d;
      if (Math.abs(d) < epsilon) d = epsilon;
      c = 1 + numerator / c;
      if (Math.abs(c) < epsilon) c = epsilon;
      d = 1 / d;
      const delta = d * c;
      result *= delta;
      if (Math.abs(delta - 1) < epsilon) break;
    }
    return result;
  }

  private logGamma(x: number): number {
    const coefficients = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const c of coefficients) { ser += c / ++y; }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  /**
   * Get all A/B tests for a user
   */
  async getABTests(userId: string, agentId?: string): Promise<any[]> {
    let query = `SELECT * FROM ab_tests WHERE user_id = $1`;
    const params: any[] = [userId];
    
    if (agentId) {
      query += ` AND agent_id = $2`;
      params.push(agentId);
    }
    
    query += ` ORDER BY created_at DESC`;
    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Get a single A/B test
   */
  async getABTest(id: string): Promise<any> {
    const result = await pool.query(`SELECT * FROM ab_tests WHERE id = $1`, [id]);
    return result.rows[0];
  }
}

export const abTestService = new ABTestService();
