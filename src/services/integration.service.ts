import { query } from '../db';
import { Integration, CreateIntegrationDTO, UpdateIntegrationDTO, Provider } from '../models/integration.model';

export class IntegrationService {
  async findById(id: string): Promise<Integration | null> {
    const result = await query(
      'SELECT * FROM integrations WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByUserId(userId: string): Promise<Integration[]> {
    const result = await query(
      'SELECT * FROM integrations WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows;
  }

  async findByUserAndProvider(userId: string, provider: Provider): Promise<Integration | null> {
    const result = await query(
      'SELECT * FROM integrations WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );
    return result.rows[0] || null;
  }

  async create(data: CreateIntegrationDTO): Promise<Integration> {
    const result = await query(
      `INSERT INTO integrations (user_id, provider, api_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider) 
       DO UPDATE SET api_key = $3, is_active = true, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [data.user_id, data.provider, data.api_key]
    );
    return result.rows[0];
  }

  async update(id: string, data: UpdateIntegrationDTO): Promise<Integration | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.api_key !== undefined) {
      fields.push(`api_key = $${paramCount++}`);
      values.push(data.api_key);
    }
    if (data.is_active !== undefined) {
      fields.push(`is_active = $${paramCount++}`);
      values.push(data.is_active);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE integrations SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM integrations WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // Validate API key with provider (to be implemented per provider)
  async validateApiKey(provider: Provider, apiKey: string): Promise<boolean> {
    // TODO: Implement validation for each provider
    switch (provider) {
      case 'elevenlabs':
        // Validate with ElevenLabs API
        return true;
      case 'retell':
        // Validate with Retell API
        return true;
      case 'vapi':
        // Validate with VAPI API
        return true;
      case 'openai_realtime':
        // Validate with OpenAI API
        return true;
      default:
        return false;
    }
  }
}

export const integrationService = new IntegrationService();
