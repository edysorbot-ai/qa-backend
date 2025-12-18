import { query } from '../db';
import { TestCase, CreateTestCaseDTO, UpdateTestCaseDTO } from '../models/testCase.model';

export class TestCaseService {
  async findById(id: string): Promise<TestCase | null> {
    const result = await query(
      'SELECT * FROM test_cases WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByAgentId(agentId: string): Promise<TestCase[]> {
    const result = await query(
      'SELECT * FROM test_cases WHERE agent_id = $1 ORDER BY created_at DESC',
      [agentId]
    );
    return result.rows;
  }

  async findByUserId(userId: string): Promise<TestCase[]> {
    const result = await query(
      'SELECT * FROM test_cases WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  async create(data: CreateTestCaseDTO): Promise<TestCase> {
    const result = await query(
      `INSERT INTO test_cases (
        agent_id, user_id, name, description, scenario, user_input,
        expected_behavior, key_topic, test_type, category, priority, batch_compatible
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        data.agent_id,
        data.user_id,
        data.name,
        data.description || null,
        data.scenario,
        data.scenario, // user_input - use scenario as the user input
        data.expected_behavior || null,
        data.key_topic || null,
        data.test_type || null,
        data.category || 'General',
        data.priority || 'medium',
        data.batch_compatible ?? true,
      ]
    );
    return result.rows[0];
  }

  async createMany(testCases: CreateTestCaseDTO[]): Promise<TestCase[]> {
    const results: TestCase[] = [];
    for (const tc of testCases) {
      const result = await this.create(tc);
      results.push(result);
    }
    return results;
  }

  async update(id: string, data: UpdateTestCaseDTO): Promise<TestCase | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push(`description = $${paramCount++}`);
      values.push(data.description);
    }
    if (data.scenario !== undefined) {
      fields.push(`scenario = $${paramCount++}`);
      values.push(data.scenario);
    }
    if (data.expected_behavior !== undefined) {
      fields.push(`expected_behavior = $${paramCount++}`);
      values.push(data.expected_behavior);
    }
    if (data.key_topic !== undefined) {
      fields.push(`key_topic = $${paramCount++}`);
      values.push(data.key_topic);
    }
    if (data.test_type !== undefined) {
      fields.push(`test_type = $${paramCount++}`);
      values.push(data.test_type);
    }
    if (data.category !== undefined) {
      fields.push(`category = $${paramCount++}`);
      values.push(data.category);
    }
    if (data.priority !== undefined) {
      fields.push(`priority = $${paramCount++}`);
      values.push(data.priority);
    }
    if (data.batch_compatible !== undefined) {
      fields.push(`batch_compatible = $${paramCount++}`);
      values.push(data.batch_compatible);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE test_cases SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM test_cases WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByAgentId(agentId: string): Promise<number> {
    const result = await query(
      'DELETE FROM test_cases WHERE agent_id = $1',
      [agentId]
    );
    return result.rowCount ?? 0;
  }
}

export const testCaseService = new TestCaseService();
