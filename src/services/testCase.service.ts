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
      `INSERT INTO test_cases (agent_id, user_id, name, description, user_input, expected_intent, expected_output, variations, config_overrides, is_auto_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.agent_id,
        data.user_id,
        data.name,
        data.description,
        data.user_input,
        data.expected_intent,
        data.expected_output,
        JSON.stringify(data.variations || []),
        JSON.stringify(data.config_overrides || {}),
        data.is_auto_generated || false,
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
    if (data.user_input !== undefined) {
      fields.push(`user_input = $${paramCount++}`);
      values.push(data.user_input);
    }
    if (data.expected_intent !== undefined) {
      fields.push(`expected_intent = $${paramCount++}`);
      values.push(data.expected_intent);
    }
    if (data.expected_output !== undefined) {
      fields.push(`expected_output = $${paramCount++}`);
      values.push(data.expected_output);
    }
    if (data.variations !== undefined) {
      fields.push(`variations = $${paramCount++}`);
      values.push(JSON.stringify(data.variations));
    }
    if (data.config_overrides !== undefined) {
      fields.push(`config_overrides = $${paramCount++}`);
      values.push(JSON.stringify(data.config_overrides));
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
