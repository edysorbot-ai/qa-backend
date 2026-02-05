import { Pool } from 'pg';
import OpenAI from 'openai';

interface ConsistencyTestConfig {
  testCaseId: string;
  iterations: number;
  similarityThreshold: number;
}

interface ResponseCluster {
  clusterId: string;
  count: number;
  representativeResponse: string;
  avgSimilarity: number;
}

interface IterationResult {
  iteration: number;
  response: string;
  similarityToBaseline: number;
  isOutlier: boolean;
  latencyMs: number;
}

interface ConsistencyResult {
  id: string;
  testCaseId: string;
  agentId: string;
  iterations: number;
  consistencyScore: number;
  semanticVariance: number;
  outlierCount: number;
  responseClusters: ResponseCluster[];
  status: string;
  createdAt: string;
  completedAt: string | null;
  iterationResults?: IterationResult[];
}

export class ConsistencyTestService {
  private pool: Pool;
  private openai: OpenAI;

  constructor(pool: Pool) {
    this.pool = pool;
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  /**
   * Start a consistency test run
   */
  async startConsistencyTest(
    agentId: string,
    testCaseId: string,
    userId: string,
    iterations: number = 30,
    callAgentFn: (testCase: any) => Promise<{ text: string; latencyMs: number }>
  ): Promise<ConsistencyResult> {
    // Create the consistency run record
    const runResult = await this.pool.query(
      `INSERT INTO consistency_test_runs (agent_id, test_case_id, user_id, iterations, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING *`,
      [agentId, testCaseId, userId, iterations]
    );
    const run = runResult.rows[0];

    // Get the test case
    const tcResult = await this.pool.query(
      `SELECT * FROM test_cases WHERE id = $1`,
      [testCaseId]
    );
    
    if (tcResult.rows.length === 0) {
      await this.pool.query(
        `UPDATE consistency_test_runs SET status = 'failed' WHERE id = $1`,
        [run.id]
      );
      throw new Error('Test case not found');
    }

    const testCase = tcResult.rows[0];

    try {
      // Run iterations and collect responses
      const responses: Array<{ text: string; latencyMs: number }> = [];
      
      for (let i = 0; i < iterations; i++) {
        const result = await callAgentFn(testCase);
        responses.push(result);
      }

      // Get embeddings for all responses
      const embeddings = await this.getEmbeddings(responses.map(r => r.text));

      // Calculate consistency metrics
      const baselineEmbedding = embeddings[0];
      const similarities: number[] = [];
      const iterationData: IterationResult[] = [];

      for (let i = 0; i < responses.length; i++) {
        const similarity = this.cosineSimilarity(baselineEmbedding, embeddings[i]);
        similarities.push(similarity);
        
        const isOutlier = similarity < 0.85; // Default threshold
        
        iterationData.push({
          iteration: i + 1,
          response: responses[i].text,
          similarityToBaseline: similarity,
          isOutlier,
          latencyMs: responses[i].latencyMs,
        });

        // Store iteration result
        await this.pool.query(
          `INSERT INTO consistency_test_iterations 
           (consistency_run_id, iteration_number, response, embedding, similarity_to_baseline, is_outlier, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [run.id, i + 1, responses[i].text, JSON.stringify(embeddings[i]), similarity, isOutlier, responses[i].latencyMs]
        );
      }

      // Calculate consistency score (mean similarity)
      const consistencyScore = (similarities.reduce((a, b) => a + b, 0) / similarities.length) * 100;

      // Calculate semantic variance (standard deviation)
      const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
      const variance = similarities.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / similarities.length;
      const semanticVariance = Math.sqrt(variance);

      // Count outliers
      const outlierCount = iterationData.filter(r => r.isOutlier).length;

      // Cluster responses
      const clusters = this.clusterResponses(responses.map(r => r.text), embeddings, similarities);

      // Update run with results
      await this.pool.query(
        `UPDATE consistency_test_runs 
         SET consistency_score = $1, semantic_variance = $2, outlier_count = $3, 
             response_clusters = $4, status = 'completed', completed_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [consistencyScore, semanticVariance, outlierCount, JSON.stringify(clusters), run.id]
      );

      return {
        id: run.id,
        testCaseId,
        agentId,
        iterations,
        consistencyScore,
        semanticVariance,
        outlierCount,
        responseClusters: clusters,
        status: 'completed',
        createdAt: run.created_at,
        completedAt: new Date().toISOString(),
        iterationResults: iterationData,
      };

    } catch (error) {
      await this.pool.query(
        `UPDATE consistency_test_runs SET status = 'failed' WHERE id = $1`,
        [run.id]
      );
      throw error;
    }
  }

  /**
   * Get embeddings for texts using OpenAI
   */
  private async getEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });

    return response.data.map(d => d.embedding);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Simple clustering using similarity threshold
   */
  private clusterResponses(
    responses: string[],
    embeddings: number[][],
    similarities: number[]
  ): ResponseCluster[] {
    const clusters: Map<number, { responses: string[]; indices: number[]; similarities: number[] }> = new Map();
    const assigned: Set<number> = new Set();
    let clusterNum = 0;

    for (let i = 0; i < responses.length; i++) {
      if (assigned.has(i)) continue;

      // Start new cluster with this response
      const cluster = {
        responses: [responses[i]],
        indices: [i],
        similarities: [similarities[i]],
      };
      assigned.add(i);

      // Find similar responses
      for (let j = i + 1; j < responses.length; j++) {
        if (assigned.has(j)) continue;

        const similarity = this.cosineSimilarity(embeddings[i], embeddings[j]);
        if (similarity >= 0.90) { // High threshold for same cluster
          cluster.responses.push(responses[j]);
          cluster.indices.push(j);
          cluster.similarities.push(similarities[j]);
          assigned.add(j);
        }
      }

      clusters.set(clusterNum++, cluster);
    }

    // Convert to response clusters
    const result: ResponseCluster[] = [];
    let clusterId = 'A';
    
    // Sort clusters by size (largest first)
    const sortedClusters = Array.from(clusters.values()).sort((a, b) => b.responses.length - a.responses.length);

    for (const cluster of sortedClusters) {
      result.push({
        clusterId: `Cluster ${clusterId}`,
        count: cluster.responses.length,
        representativeResponse: cluster.responses[0].substring(0, 200) + (cluster.responses[0].length > 200 ? '...' : ''),
        avgSimilarity: cluster.similarities.reduce((a, b) => a + b, 0) / cluster.similarities.length,
      });
      clusterId = String.fromCharCode(clusterId.charCodeAt(0) + 1);
    }

    return result;
  }

  /**
   * Get consistency test run by ID
   */
  async getConsistencyRun(runId: string): Promise<ConsistencyResult | null> {
    const result = await this.pool.query(
      `SELECT * FROM consistency_test_runs WHERE id = $1`,
      [runId]
    );

    if (result.rows.length === 0) return null;

    const run = result.rows[0];

    // Get iterations if completed
    let iterationResults: IterationResult[] | undefined;
    if (run.status === 'completed') {
      const iterResult = await this.pool.query(
        `SELECT iteration_number, response, similarity_to_baseline, is_outlier, latency_ms
         FROM consistency_test_iterations
         WHERE consistency_run_id = $1
         ORDER BY iteration_number`,
        [runId]
      );

      iterationResults = iterResult.rows.map(r => ({
        iteration: r.iteration_number,
        response: r.response,
        similarityToBaseline: parseFloat(r.similarity_to_baseline),
        isOutlier: r.is_outlier,
        latencyMs: r.latency_ms,
      }));
    }

    return {
      id: run.id,
      testCaseId: run.test_case_id,
      agentId: run.agent_id,
      iterations: run.iterations,
      consistencyScore: run.consistency_score ? parseFloat(run.consistency_score) : 0,
      semanticVariance: run.semantic_variance ? parseFloat(run.semantic_variance) : 0,
      outlierCount: run.outlier_count || 0,
      responseClusters: run.response_clusters || [],
      status: run.status,
      createdAt: run.created_at,
      completedAt: run.completed_at,
      iterationResults,
    };
  }

  /**
   * Get all consistency runs for an agent
   */
  async getConsistencyRunsForAgent(agentId: string): Promise<ConsistencyResult[]> {
    const result = await this.pool.query(
      `SELECT cr.*, tc.name as test_case_name
       FROM consistency_test_runs cr
       LEFT JOIN test_cases tc ON cr.test_case_id = tc.id
       WHERE cr.agent_id = $1
       ORDER BY cr.created_at DESC`,
      [agentId]
    );

    return result.rows.map(run => ({
      id: run.id,
      testCaseId: run.test_case_id,
      testCaseName: run.test_case_name,
      agentId: run.agent_id,
      iterations: run.iterations,
      consistencyScore: run.consistency_score ? parseFloat(run.consistency_score) : 0,
      semanticVariance: run.semantic_variance ? parseFloat(run.semantic_variance) : 0,
      outlierCount: run.outlier_count || 0,
      responseClusters: run.response_clusters || [],
      status: run.status,
      createdAt: run.created_at,
      completedAt: run.completed_at,
    }));
  }

  /**
   * Get consistency summary for agent
   */
  async getConsistencySummary(agentId: string): Promise<{
    avgConsistencyScore: number;
    totalRuns: number;
    completedRuns: number;
    testCasesWithLowConsistency: Array<{ testCaseId: string; testCaseName: string; score: number }>;
    trend: Array<{ date: string; avgScore: number }>;
  }> {
    // Get overall stats
    const statsResult = await this.pool.query(
      `SELECT 
         AVG(consistency_score) as avg_score,
         COUNT(*) as total_runs,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_runs
       FROM consistency_test_runs
       WHERE agent_id = $1`,
      [agentId]
    );

    const stats = statsResult.rows[0];

    // Get test cases with low consistency (<85%)
    const lowScoreResult = await this.pool.query(
      `SELECT cr.test_case_id, tc.name as test_case_name, cr.consistency_score
       FROM consistency_test_runs cr
       LEFT JOIN test_cases tc ON cr.test_case_id = tc.id
       WHERE cr.agent_id = $1 AND cr.status = 'completed' AND cr.consistency_score < 85
       ORDER BY cr.consistency_score ASC
       LIMIT 10`,
      [agentId]
    );

    // Get trend data (last 30 days)
    const trendResult = await this.pool.query(
      `SELECT 
         DATE(created_at) as date,
         AVG(consistency_score) as avg_score
       FROM consistency_test_runs
       WHERE agent_id = $1 AND status = 'completed' AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [agentId]
    );

    return {
      avgConsistencyScore: parseFloat(stats.avg_score) || 0,
      totalRuns: parseInt(stats.total_runs) || 0,
      completedRuns: parseInt(stats.completed_runs) || 0,
      testCasesWithLowConsistency: lowScoreResult.rows.map(r => ({
        testCaseId: r.test_case_id,
        testCaseName: r.test_case_name,
        score: parseFloat(r.consistency_score),
      })),
      trend: trendResult.rows.map(r => ({
        date: r.date,
        avgScore: parseFloat(r.avg_score),
      })),
    };
  }
}

export function getConsistencyTestService(pool: Pool): ConsistencyTestService {
  return new ConsistencyTestService(pool);
}
