import { query } from '../db';
import { TestResult, CreateTestResultDTO, UpdateTestResultDTO } from '../models/testResult.model';

export class TestResultService {
  async findById(id: string): Promise<TestResult | null> {
    const result = await query(
      'SELECT * FROM test_results WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByTestRunId(testRunId: string): Promise<TestResult[]> {
    const result = await query(
      'SELECT * FROM test_results WHERE test_run_id = $1 ORDER BY created_at',
      [testRunId]
    );
    return result.rows;
  }

  async findByTestCaseId(testCaseId: string): Promise<TestResult[]> {
    const result = await query(
      'SELECT * FROM test_results WHERE test_case_id = $1 ORDER BY created_at DESC',
      [testCaseId]
    );
    return result.rows;
  }

  async create(data: CreateTestResultDTO): Promise<TestResult> {
    const result = await query(
      `INSERT INTO test_results (test_run_id, test_case_id)
       VALUES ($1, $2)
       RETURNING *`,
      [data.test_run_id, data.test_case_id]
    );
    return result.rows[0];
  }

  async createMany(results: CreateTestResultDTO[]): Promise<TestResult[]> {
    const created: TestResult[] = [];
    for (const r of results) {
      const result = await this.create(r);
      created.push(result);
    }
    return created;
  }

  async update(id: string, data: UpdateTestResultDTO): Promise<TestResult | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.status !== undefined) {
      fields.push(`status = $${paramCount++}`);
      values.push(data.status);
    }
    if (data.user_audio_url !== undefined) {
      fields.push(`user_audio_url = $${paramCount++}`);
      values.push(data.user_audio_url);
    }
    if (data.agent_audio_url !== undefined) {
      fields.push(`agent_audio_url = $${paramCount++}`);
      values.push(data.agent_audio_url);
    }
    if (data.user_transcript !== undefined) {
      fields.push(`user_transcript = $${paramCount++}`);
      values.push(data.user_transcript);
    }
    if (data.agent_transcript !== undefined) {
      fields.push(`agent_transcript = $${paramCount++}`);
      values.push(data.agent_transcript);
    }
    if (data.detected_intent !== undefined) {
      fields.push(`detected_intent = $${paramCount++}`);
      values.push(data.detected_intent);
    }
    if (data.intent_match !== undefined) {
      fields.push(`intent_match = $${paramCount++}`);
      values.push(data.intent_match);
    }
    if (data.output_match !== undefined) {
      fields.push(`output_match = $${paramCount++}`);
      values.push(data.output_match);
    }
    if (data.latency_ms !== undefined) {
      fields.push(`latency_ms = $${paramCount++}`);
      values.push(data.latency_ms);
    }
    if (data.conversation_turns !== undefined) {
      fields.push(`conversation_turns = $${paramCount++}`);
      values.push(JSON.stringify(data.conversation_turns));
    }
    if (data.metrics !== undefined) {
      fields.push(`metrics = $${paramCount++}`);
      values.push(JSON.stringify(data.metrics));
    }
    if (data.error_message !== undefined) {
      fields.push(`error_message = $${paramCount++}`);
      values.push(data.error_message);
    }
    if (data.started_at !== undefined) {
      fields.push(`started_at = $${paramCount++}`);
      values.push(data.started_at);
    }
    if (data.completed_at !== undefined) {
      fields.push(`completed_at = $${paramCount++}`);
      values.push(data.completed_at);
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);

    const result = await query(
      `UPDATE test_results SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM test_results WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getAggregatedMetrics(testRunId: string): Promise<{
    avg_latency: number;
    intent_accuracy: number;
    output_accuracy: number;
  }> {
    const result = await query(
      `SELECT 
        ROUND(AVG(latency_ms), 2) as avg_latency,
        ROUND(AVG(CASE WHEN intent_match THEN 1 ELSE 0 END) * 100, 2) as intent_accuracy,
        ROUND(AVG(CASE WHEN output_match THEN 1 ELSE 0 END) * 100, 2) as output_accuracy
       FROM test_results
       WHERE test_run_id = $1 AND status IN ('passed', 'failed')`,
      [testRunId]
    );
    return result.rows[0];
  }
}

export const testResultService = new TestResultService();
