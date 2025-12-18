import { query } from '../db';
import { PromptVersion, CreatePromptVersionDTO } from '../models/promptVersion.model';
import * as crypto from 'crypto';

export class PromptVersionService {
  /**
   * Generate a hash for the prompt to detect changes
   */
  private generateHash(prompt: string): string {
    return crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 64);
  }

  /**
   * Get all versions for an agent, ordered by version number descending
   */
  async findByAgentId(agentId: string): Promise<PromptVersion[]> {
    const result = await query(
      'SELECT * FROM prompt_versions WHERE agent_id = $1 ORDER BY version_number DESC',
      [agentId]
    );
    return result.rows;
  }

  /**
   * Get the latest version for an agent
   */
  async getLatestVersion(agentId: string): Promise<PromptVersion | null> {
    const result = await query(
      'SELECT * FROM prompt_versions WHERE agent_id = $1 ORDER BY version_number DESC LIMIT 1',
      [agentId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get the next version number for an agent
   */
  async getNextVersionNumber(agentId: string): Promise<number> {
    const result = await query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM prompt_versions WHERE agent_id = $1',
      [agentId]
    );
    return result.rows[0].next_version;
  }

  /**
   * Check if prompt has changed by comparing hash
   */
  async hasPromptChanged(agentId: string, prompt: string): Promise<boolean> {
    const newHash = this.generateHash(prompt);
    const latest = await this.getLatestVersion(agentId);
    
    if (!latest) {
      return true; // No version exists, so it's "changed" (new)
    }
    
    return latest.prompt_hash !== newHash;
  }

  /**
   * Create a new version if prompt has changed
   * Returns the new version if created, null if prompt unchanged
   */
  async createVersionIfChanged(data: CreatePromptVersionDTO): Promise<PromptVersion | null> {
    const { agent_id, prompt } = data;
    
    if (!prompt || prompt.trim() === '') {
      return null;
    }
    
    const hasChanged = await this.hasPromptChanged(agent_id, prompt);
    
    if (!hasChanged) {
      return null; // Prompt hasn't changed, no new version needed
    }
    
    const promptHash = this.generateHash(prompt);
    const versionNumber = await this.getNextVersionNumber(agent_id);
    
    const result = await query(
      `INSERT INTO prompt_versions (agent_id, version_number, prompt, prompt_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [agent_id, versionNumber, prompt, promptHash]
    );
    
    return result.rows[0];
  }

  /**
   * Get a specific version by ID
   */
  async findById(id: string): Promise<PromptVersion | null> {
    const result = await query(
      'SELECT * FROM prompt_versions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete all versions for an agent
   */
  async deleteByAgentId(agentId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM prompt_versions WHERE agent_id = $1',
      [agentId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const promptVersionService = new PromptVersionService();
