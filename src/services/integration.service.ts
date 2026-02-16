import { query } from '../db';
import { Integration, CreateIntegrationDTO, UpdateIntegrationDTO, Provider } from '../models/integration.model';
import { getProviderClient } from '../providers/provider.factory';
import { ProviderValidationResult, VoiceAgent } from '../providers/provider.interface';

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
      `INSERT INTO integrations (user_id, provider, api_key, base_url, is_active)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (user_id, provider) 
       DO UPDATE SET api_key = $3, base_url = $4, is_active = false, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [data.user_id, data.provider, data.api_key, data.base_url || null]
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
    if (data.base_url !== undefined) {
      fields.push(`base_url = $${paramCount++}`);
      values.push(data.base_url);
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

  /**
   * Validate API key with the actual provider API
   * Returns detailed validation result including account info
   */
  async validateApiKey(provider: Provider, apiKey: string, baseUrl?: string | null): Promise<ProviderValidationResult> {
    try {
      const client = getProviderClient(provider);
      return await client.validateApiKey(apiKey, baseUrl);
    } catch (error) {
      return {
        valid: false,
        message: 'Invalid API key',
      };
    }
  }

  /**
   * Create integration with API key validation
   * Validates the key before saving to database
   */
  async createWithValidation(data: CreateIntegrationDTO): Promise<{
    integration: Integration | null;
    validation: ProviderValidationResult;
  }> {
    // First validate the API key
    const validation = await this.validateApiKey(data.provider, data.api_key, data.base_url);

    if (!validation.valid) {
      return { integration: null, validation };
    }

    // If valid, save to database
    const integration = await this.create(data);
    return { integration, validation };
  }

  /**
   * Update integration with API key validation (if API key is being changed)
   */
  async updateWithValidation(
    id: string,
    data: UpdateIntegrationDTO
  ): Promise<{
    integration: Integration | null;
    validation: ProviderValidationResult | null;
  }> {
    // If API key is being updated, validate it first
    if (data.api_key) {
      const existing = await this.findById(id);
      if (!existing) {
        return {
          integration: null,
          validation: { valid: false, message: 'Integration not found' },
        };
      }

      const validation = await this.validateApiKey(existing.provider, data.api_key, existing.base_url);
      if (!validation.valid) {
        return { integration: null, validation };
      }

      const integration = await this.update(id, data);
      return { integration, validation };
    }

    // No API key change, just update other fields
    const integration = await this.update(id, data);
    return { integration, validation: null };
  }

  /**
   * List agents from the provider using the stored API key
   */
  async listProviderAgents(integrationId: string): Promise<VoiceAgent[]> {
    const integration = await this.findById(integrationId);
    if (!integration || !integration.is_active) {
      return [];
    }

    try {
      const client = getProviderClient(integration.provider);
      return await client.listAgents(integration.api_key, integration.base_url);
    } catch (error) {
      console.error(`Error listing agents for ${integration.provider}:`, error);
      return [];
    }
  }

  /**
   * Get a specific agent from the provider
   */
  async getProviderAgent(integrationId: string, agentId: string): Promise<VoiceAgent | null> {
    const integration = await this.findById(integrationId);
    if (!integration || !integration.is_active) {
      return null;
    }

    try {
      const client = getProviderClient(integration.provider);
      return await client.getAgent(integration.api_key, agentId, integration.base_url);
    } catch (error) {
      console.error(`Error getting agent ${agentId} from ${integration.provider}:`, error);
      return null;
    }
  }

  /**
   * Test connection to provider (re-validate stored key)
   */
  async testConnection(integrationId: string): Promise<ProviderValidationResult> {
    const integration = await this.findById(integrationId);
    if (!integration) {
      return { valid: false, message: 'Integration not found' };
    }

    const validation = await this.validateApiKey(integration.provider, integration.api_key, integration.base_url);
    
    // Update is_active based on validation result
    if (validation.valid) {
      await this.update(integrationId, { is_active: true });
    } else {
      await this.update(integrationId, { is_active: false });
    }
    
    return validation;
  }

  /**
   * Get provider limits (concurrency, rate limits, etc.)
   */
  async getProviderLimits(integrationId: string): Promise<{
    concurrencyLimit: number;
    source: string;
    provider: string;
  } | null> {
    const integration = await this.findById(integrationId);
    if (!integration || !integration.is_active) {
      return null;
    }

    try {
      const client = getProviderClient(integration.provider);
      if (client.getLimits) {
        const limits = await client.getLimits(integration.api_key, integration.base_url);
        return {
          ...limits,
          provider: integration.provider,
        };
      }
      // Default limits if provider doesn't support getLimits
      return {
        concurrencyLimit: 5,
        source: 'default',
        provider: integration.provider,
      };
    } catch (error) {
      console.error(`Error getting limits for ${integration.provider}:`, error);
      return {
        concurrencyLimit: 5,
        source: 'default',
        provider: integration.provider,
      };
    }
  }

  /**
   * Analyze agent and generate test cases using OpenAI
   * Uses SmartTestCaseGeneratorService for topic-based test case generation
   */
  async analyzeAgentAndGenerateTestCases(
    integrationId: string,
    agentId: string,
    maxTestCases: number = 20
  ): Promise<{
    agent: VoiceAgent | null;
    agentAnalysis: any;
    testCases: any[];
    keyTopics?: any[];
    testPlan?: any;
  }> {
    // Import the SMART test case generator service (with topic-based categorization)
    const { smartTestCaseGeneratorService } = await import('./smart-testcase-generator.service');

    // Get the full agent details
    const agent = await this.getProviderAgent(integrationId, agentId);
    if (!agent) {
      throw new Error('Agent not found');
    }

    // Extract prompt and config from agent metadata
    const agentPrompt = agent.description || 
      agent.metadata?.fullPrompt || 
      agent.metadata?.fullConfig?.agent?.prompt?.prompt ||
      '';
    
    const agentConfig = {
      ...agent.metadata,
      voice: agent.voice,
      language: agent.language,
    };

    // Generate test cases using SmartTestCaseGeneratorService
    // This generates test cases grouped by KEY TOPICS (e.g., Budget, Eligibility, Off-Topic)
    const result = await smartTestCaseGeneratorService.generateSmartTestCases(
      agent.name,
      agentPrompt,
      agentConfig,
      maxTestCases
    );

    // Transform smart test cases to the expected format
    // Category is set to keyTopicName (e.g., "Budget", "Eligibility")
    const testCases = result.testCases.map(tc => ({
      id: tc.id,
      name: tc.name,
      scenario: tc.scenario,
      category: tc.keyTopicName, // Use key topic as category for batch grouping
      expectedOutcome: tc.expectedOutcome,
      priority: tc.priority,
      keyTopic: tc.keyTopicName,
      keyTopicId: tc.keyTopicId,
      testType: tc.testType,
      canBatchWith: tc.canBatchWith,
      estimatedTurns: tc.estimatedTurns,
    }));

    return {
      agent,
      agentAnalysis: result.agentAnalysis,
      testCases,
      keyTopics: result.agentAnalysis.keyTopics,
      testPlan: result.testPlan,
    };
  }
}

export const integrationService = new IntegrationService();
