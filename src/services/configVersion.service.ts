import { query } from '../db';
import { ConfigVersion, CreateConfigVersionDTO } from '../models/configVersion.model';
import * as crypto from 'crypto';

export class ConfigVersionService {
  /**
   * Generate a hash for the config to detect changes
   * Sort keys to ensure consistent hashing regardless of key order
   */
  private generateHash(config: Record<string, any>): string {
    const sortedConfig = this.sortObjectKeys(config);
    const configString = JSON.stringify(sortedConfig);
    return crypto.createHash('sha256').update(configString).digest('hex').substring(0, 64);
  }

  /**
   * Recursively sort object keys for consistent hashing
   */
  private sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }
    
    const sortedObj: Record<string, any> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sortedObj[key] = this.sortObjectKeys(obj[key]);
    }
    return sortedObj;
  }

  /**
   * Get all versions for an agent, ordered by version number descending
   */
  async findByAgentId(agentId: string): Promise<ConfigVersion[]> {
    const result = await query(
      'SELECT * FROM config_versions WHERE agent_id = $1 ORDER BY version_number DESC',
      [agentId]
    );
    return result.rows;
  }

  /**
   * Get the latest version for an agent
   */
  async getLatestVersion(agentId: string): Promise<ConfigVersion | null> {
    const result = await query(
      'SELECT * FROM config_versions WHERE agent_id = $1 ORDER BY version_number DESC LIMIT 1',
      [agentId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get the next version number for an agent
   */
  async getNextVersionNumber(agentId: string): Promise<number> {
    const result = await query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM config_versions WHERE agent_id = $1',
      [agentId]
    );
    return result.rows[0].next_version;
  }

  /**
   * Check if config has changed by comparing hash
   */
  async hasConfigChanged(agentId: string, config: Record<string, any>): Promise<boolean> {
    const newHash = this.generateHash(config);
    const latest = await this.getLatestVersion(agentId);
    
    if (!latest) {
      return true; // No version exists, so it's "changed" (new)
    }
    
    return latest.config_hash !== newHash;
  }

  /**
   * Create a new version if config has changed
   * Returns the new version if created, null if config unchanged
   */
  async createVersionIfChanged(data: CreateConfigVersionDTO): Promise<ConfigVersion | null> {
    const { agent_id, config } = data;
    
    if (!config || Object.keys(config).length === 0) {
      return null;
    }
    
    const hasChanged = await this.hasConfigChanged(agent_id, config);
    
    if (!hasChanged) {
      return null; // Config hasn't changed, no new version needed
    }
    
    const configHash = this.generateHash(config);
    const versionNumber = await this.getNextVersionNumber(agent_id);
    
    const result = await query(
      `INSERT INTO config_versions (agent_id, version_number, config, config_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [agent_id, versionNumber, JSON.stringify(config), configHash]
    );
    
    return result.rows[0];
  }

  /**
   * Get a specific version by ID
   */
  async findById(id: string): Promise<ConfigVersion | null> {
    const result = await query(
      'SELECT * FROM config_versions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Delete all versions for an agent
   */
  async deleteByAgentId(agentId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM config_versions WHERE agent_id = $1',
      [agentId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const configVersionService = new ConfigVersionService();
