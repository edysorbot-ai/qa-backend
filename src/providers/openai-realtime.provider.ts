/**
 * OpenAI Realtime Voice Agent Provider
 * Documentation: https://platform.openai.com/docs/api-reference
 * Note: OpenAI Realtime API is for real-time voice conversations
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  VoiceAgent,
} from './provider.interface';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

interface OpenAIAssistant {
  id: string;
  object: string;
  created_at: number;
  name: string | null;
  description: string | null;
  model: string;
  instructions: string | null;
  tools: Array<{ type: string; [key: string]: any }>;
  tool_resources?: Record<string, any>;
  metadata: Record<string, any>;
  temperature?: number;
  top_p?: number;
  response_format?: any;
}

interface OpenAIAssistantsResponse {
  object: string;
  data: OpenAIAssistant[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

export class OpenAIRealtimeProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      // List models to validate the key
      const response = await this.request<OpenAIModelsResponse>(apiKey, '/models');

      // Check if realtime models are available (gpt-4o-realtime-preview)
      const realtimeModels = response.data.filter(
        (model) =>
          model.id.includes('realtime') ||
          model.id.includes('gpt-4o') ||
          model.id.includes('gpt-4-turbo')
      );

      // Also check for assistants (as OpenAI's "agents")
      let assistantCount = 0;
      try {
        const assistants = await this.request<OpenAIAssistantsResponse>(
          apiKey,
          '/assistants?limit=100'
        );
        assistantCount = assistants.data.length;
      } catch (e) {
        // Assistants API might not be available for all accounts
      }

      return {
        valid: true,
        message: 'OpenAI API key is valid',
        details: {
          accountName: 'OpenAI Account',
          plan: realtimeModels.length > 0 ? 'Realtime Enabled' : 'Standard',
          agentsCount: assistantCount,
          availableModels: realtimeModels.map((m) => m.id),
          totalModels: response.data.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        message: `Invalid OpenAI API key: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      // OpenAI uses "Assistants" as their agent concept
      const response = await this.request<OpenAIAssistantsResponse>(
        apiKey,
        '/assistants?limit=100'
      );

      return response.data.map((assistant) => ({
        id: assistant.id,
        name: assistant.name || 'Unnamed Assistant',
        provider: 'openai_realtime',
        description: assistant.description || assistant.instructions?.substring(0, 200),
        voice: 'alloy', // Default OpenAI voice
        language: 'en',
        metadata: {
          model: assistant.model,
          instructions: assistant.instructions,
          tools: assistant.tools,
          temperature: assistant.temperature,
          topP: assistant.top_p,
          createdAt: new Date(assistant.created_at * 1000).toISOString(),
        },
      }));
    } catch (error) {
      console.error('Error listing OpenAI assistants:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const assistant = await this.request<OpenAIAssistant>(
        apiKey,
        `/assistants/${agentId}`
      );

      return {
        id: assistant.id,
        name: assistant.name || 'Unnamed Assistant',
        provider: 'openai_realtime',
        description: assistant.description || assistant.instructions || undefined,
        voice: 'alloy', // Default voice, can be: alloy, echo, fable, onyx, nova, shimmer
        language: 'en',
        metadata: {
          model: assistant.model,
          instructions: assistant.instructions,
          tools: assistant.tools,
          toolResources: assistant.tool_resources,
          temperature: assistant.temperature,
          topP: assistant.top_p,
          responseFormat: assistant.response_format,
          metadata: assistant.metadata,
          createdAt: new Date(assistant.created_at * 1000).toISOString(),
        },
      };
    } catch (error) {
      console.error('Error getting OpenAI assistant:', error);
      return null;
    }
  }

  async listVoices(): Promise<string[]> {
    // OpenAI has fixed voices for TTS/Realtime
    return ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  }

  async listModels(apiKey: string): Promise<OpenAIModel[]> {
    try {
      const response = await this.request<OpenAIModelsResponse>(apiKey, '/models');
      return response.data;
    } catch (error) {
      console.error('Error listing OpenAI models:', error);
      return [];
    }
  }

  async getRealtimeModels(apiKey: string): Promise<string[]> {
    const models = await this.listModels(apiKey);
    return models
      .filter(
        (m) =>
          m.id.includes('realtime') ||
          m.id === 'gpt-4o' ||
          m.id === 'gpt-4o-mini' ||
          m.id.includes('gpt-4o-audio')
      )
      .map((m) => m.id);
  }
}

export const openaiRealtimeProvider = new OpenAIRealtimeProvider();
