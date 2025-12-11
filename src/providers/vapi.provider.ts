/**
 * VAPI Voice Agent Provider
 * Documentation: https://docs.vapi.ai/api-reference
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  VoiceAgent,
} from './provider.interface';

const VAPI_BASE_URL = 'https://api.vapi.ai';

interface VAPIAssistant {
  id: string;
  orgId: string;
  name: string;
  model?: {
    model: string;
    provider: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    emotionRecognitionEnabled?: boolean;
    knowledgeBase?: any;
    tools?: any[];
    messages?: any[];
  };
  voice?: {
    voiceId: string;
    provider: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
    optimizeStreamingLatency?: number;
    inputPreprocessingEnabled?: boolean;
    inputReformattingEnabled?: boolean;
    inputMinCharacters?: number;
    inputPunctuationBoundaries?: string[];
    fillerInjectionEnabled?: boolean;
  };
  firstMessage?: string;
  firstMessageMode?: string;
  hipaaEnabled?: boolean;
  silenceTimeoutSeconds?: number;
  responseDelaySeconds?: number;
  llmRequestDelaySeconds?: number;
  llmRequestNonPunctuatedDelaySeconds?: number;
  numWordsToInterruptAssistant?: number;
  maxDurationSeconds?: number;
  backgroundSound?: string;
  backchannelingEnabled?: boolean;
  backgroundDenoisingEnabled?: boolean;
  modelOutputInMessagesEnabled?: boolean;
  transportConfigurations?: any[];
  voicemailDetection?: any;
  voicemailMessage?: string;
  endCallMessage?: string;
  endCallPhrases?: string[];
  metadata?: Record<string, any>;
  serverUrl?: string;
  serverUrlSecret?: string;
  clientMessages?: string[];
  serverMessages?: string[];
  transcriber?: {
    provider: string;
    model?: string;
    language?: string;
    keywords?: string[];
  };
  recordingEnabled?: boolean;
  forwardingPhoneNumber?: string;
  endCallFunctionEnabled?: boolean;
  dialKeypadFunctionEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface VAPIOrg {
  id: string;
  name: string;
  billingLimit?: number;
  serverUrl?: string;
  serverUrlSecret?: string;
  concurrencyLimit?: number;
  createdAt?: string;
  updatedAt?: string;
}

export class VAPIProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${VAPI_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`VAPI API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      // List assistants to validate the key
      const assistants = await this.request<VAPIAssistant[]>(apiKey, '/assistant');

      return {
        valid: true,
        message: 'VAPI API key is valid',
        details: {
          accountName: 'VAPI Account',
          agentsCount: assistants.length,
          plan: 'Active',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        message: `Invalid VAPI API key: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      const assistants = await this.request<VAPIAssistant[]>(apiKey, '/assistant');

      return assistants.map((assistant) => ({
        id: assistant.id,
        name: assistant.name,
        provider: 'vapi',
        description: assistant.model?.systemPrompt?.substring(0, 200),
        voice: assistant.voice?.voiceId,
        language: assistant.transcriber?.language,
        metadata: {
          modelProvider: assistant.model?.provider,
          modelName: assistant.model?.model,
          voiceProvider: assistant.voice?.provider,
          firstMessage: assistant.firstMessage,
          maxDurationSeconds: assistant.maxDurationSeconds,
          silenceTimeoutSeconds: assistant.silenceTimeoutSeconds,
          backchannelingEnabled: assistant.backchannelingEnabled,
          transcriber: assistant.transcriber,
          createdAt: assistant.createdAt,
          updatedAt: assistant.updatedAt,
        },
      }));
    } catch (error) {
      console.error('Error listing VAPI assistants:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const assistant = await this.request<VAPIAssistant>(
        apiKey,
        `/assistant/${agentId}`
      );

      return {
        id: assistant.id,
        name: assistant.name,
        provider: 'vapi',
        description: assistant.model?.systemPrompt,
        voice: assistant.voice?.voiceId,
        language: assistant.transcriber?.language,
        metadata: {
          modelProvider: assistant.model?.provider,
          modelName: assistant.model?.model,
          voiceProvider: assistant.voice?.provider,
          voiceSettings: assistant.voice,
          firstMessage: assistant.firstMessage,
          firstMessageMode: assistant.firstMessageMode,
          maxDurationSeconds: assistant.maxDurationSeconds,
          silenceTimeoutSeconds: assistant.silenceTimeoutSeconds,
          responseDelaySeconds: assistant.responseDelaySeconds,
          backchannelingEnabled: assistant.backchannelingEnabled,
          backgroundSound: assistant.backgroundSound,
          transcriber: assistant.transcriber,
          tools: assistant.model?.tools,
          serverUrl: assistant.serverUrl,
          hipaaEnabled: assistant.hipaaEnabled,
          recordingEnabled: assistant.recordingEnabled,
          endCallPhrases: assistant.endCallPhrases,
          endCallMessage: assistant.endCallMessage,
          createdAt: assistant.createdAt,
          updatedAt: assistant.updatedAt,
        },
      };
    } catch (error) {
      console.error('Error getting VAPI assistant:', error);
      return null;
    }
  }

  async listPhoneNumbers(apiKey: string): Promise<any[]> {
    try {
      return await this.request<any[]>(apiKey, '/phone-number');
    } catch (error) {
      console.error('Error listing VAPI phone numbers:', error);
      return [];
    }
  }

  async listCalls(apiKey: string, limit = 10): Promise<any[]> {
    try {
      return await this.request<any[]>(apiKey, `/call?limit=${limit}`);
    } catch (error) {
      console.error('Error listing VAPI calls:', error);
      return [];
    }
  }
}

export const vapiProvider = new VAPIProvider();
