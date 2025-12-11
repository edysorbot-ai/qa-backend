import { query } from '../db';
import { Agent, CreateAgentDTO, UpdateAgentDTO } from '../models/agent.model';

export class AgentService {
  async findById(id: string): Promise<Agent | null> {
    const result = await query(
      'SELECT * FROM agents WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByUserId(userId: string): Promise<Agent[]> {
    const result = await query(
      'SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  async findByIntegrationId(integrationId: string): Promise<Agent[]> {
    const result = await query(
      'SELECT * FROM agents WHERE integration_id = $1 ORDER BY created_at DESC',
      [integrationId]
    );
    return result.rows;
  }

  async create(data: CreateAgentDTO): Promise<Agent> {
    const result = await query(
      `INSERT INTO agents (user_id, integration_id, external_agent_id, name, provider, prompt, intents, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.user_id,
        data.integration_id,
        data.external_agent_id,
        data.name,
        data.provider,
        data.prompt,
        JSON.stringify(data.intents || []),
        JSON.stringify(data.config || {}),
      ]
    );
    return result.rows[0];
  }

  async update(id: string, data: UpdateAgentDTO): Promise<Agent | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      fields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.prompt !== undefined) {
      fields.push(`prompt = $${paramCount++}`);
      values.push(data.prompt);
    }
    if (data.intents !== undefined) {
      fields.push(`intents = $${paramCount++}`);
      values.push(JSON.stringify(data.intents));
    }
    if (data.config !== undefined) {
      fields.push(`config = $${paramCount++}`);
      values.push(JSON.stringify(data.config));
    }
    if (data.status !== undefined) {
      fields.push(`status = $${paramCount++}`);
      values.push(data.status);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE agents SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM agents WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getWithStats(id: string): Promise<Agent & { test_count: number; last_run: Date | null } | null> {
    const result = await query(
      `SELECT a.*, 
              COALESCE(tc.count, 0)::int as test_count,
              tr.last_run
       FROM agents a
       LEFT JOIN (SELECT agent_id, COUNT(*) as count FROM test_cases GROUP BY agent_id) tc ON tc.agent_id = a.id
       LEFT JOIN (SELECT agent_id, MAX(created_at) as last_run FROM test_runs GROUP BY agent_id) tr ON tr.agent_id = a.id
       WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }
}

export const agentService = new AgentService();
