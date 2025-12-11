import { query } from '../db';
import { TestRun, CreateTestRunDTO, UpdateTestRunDTO } from '../models/testRun.model';

export class TestRunService {
  async findById(id: string): Promise<TestRun | null> {
    const result = await query(
      'SELECT * FROM test_runs WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByUserId(userId: string, limit = 50): Promise<TestRun[]> {
    const result = await query(
      'SELECT * FROM test_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit]
    );
    return result.rows;
  }

  async findByAgentId(agentId: string, limit = 50): Promise<TestRun[]> {
    const result = await query(
      'SELECT * FROM test_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2',
      [agentId, limit]
    );
    return result.rows;
  }

  async create(data: CreateTestRunDTO): Promise<TestRun> {
    const result = await query(
      `INSERT INTO test_runs (user_id, agent_id, name, config)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        data.user_id,
        data.agent_id,
        data.name,
        JSON.stringify(data.config || {}),
      ]
    );
    return result.rows[0];
  }

  async update(id: string, data: UpdateTestRunDTO): Promise<TestRun | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.status !== undefined) {
      fields.push(`status = $${paramCount++}`);
      values.push(data.status);
    }
    if (data.total_tests !== undefined) {
      fields.push(`total_tests = $${paramCount++}`);
      values.push(data.total_tests);
    }
    if (data.passed_tests !== undefined) {
      fields.push(`passed_tests = $${paramCount++}`);
      values.push(data.passed_tests);
    }
    if (data.failed_tests !== undefined) {
      fields.push(`failed_tests = $${paramCount++}`);
      values.push(data.failed_tests);
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
      `UPDATE test_runs SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM test_runs WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getRunWithResults(id: string): Promise<TestRun & { results: any[] } | null> {
    const run = await this.findById(id);
    if (!run) return null;

    const results = await query(
      'SELECT * FROM test_results WHERE test_run_id = $1 ORDER BY created_at',
      [id]
    );

    return { ...run, results: results.rows };
  }

  async getStats(userId: string): Promise<{
    total_runs: number;
    total_passed: number;
    total_failed: number;
    avg_pass_rate: number;
  }> {
    const result = await query(
      `SELECT 
        COUNT(*)::int as total_runs,
        COALESCE(SUM(passed_tests), 0)::int as total_passed,
        COALESCE(SUM(failed_tests), 0)::int as total_failed,
        CASE 
          WHEN SUM(total_tests) > 0 
          THEN ROUND(SUM(passed_tests)::numeric / SUM(total_tests) * 100, 2)
          ELSE 0 
        END as avg_pass_rate
       FROM test_runs 
       WHERE user_id = $1 AND status = 'completed'`,
      [userId]
    );
    return result.rows[0];
  }
}

export const testRunService = new TestRunService();
