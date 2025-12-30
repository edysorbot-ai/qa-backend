/**
 * Retell AI Voice Agent Provider
 * Documentation: https://docs.retellai.com/api-references
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
} from './provider.interface';

const RETELL_BASE_URL = 'https://api.retellai.com';

// Retell default limits (they don't expose this via API, but these are typical)
const RETELL_DEFAULT_CONCURRENCY = 5;

interface RetellAgent {
  agent_id: string;
  agent_name: string;
  voice_id: string;
  fallback_voice_ids?: string[];
  voice_temperature?: number;
  voice_speed?: number;
  responsiveness?: number;
  interruption_sensitivity?: number;
  enable_backchannel?: boolean;
  backchannel_frequency?: number;
  backchannel_words?: string[];
  reminder_trigger_ms?: number;
  reminder_max_count?: number;
  ambient_sound?: string;
  ambient_sound_volume?: number;
  language?: string;
  webhook_url?: string;
  boosted_keywords?: string[];
  enable_voicemail_detection?: boolean;
  voicemail_message?: string;
  max_call_duration_ms?: number;
  opt_out_sensitive_data_storage?: boolean;
  pronunciation_dictionary?: Array<{ word: string; alphabet: string; phoneme: string }>;
  normalize_for_speech?: boolean;
  end_call_after_silence_ms?: number;
  enable_transcription_formatting?: boolean;
  post_call_analysis_data?: Array<{ name: string; type: string; description: string }>;
  llm_websocket_url?: string;
  response_engine?: {
    type: string;
    llm_id?: string;
    version?: number;
  };
  last_modification_timestamp?: number;
}

interface RetellLLM {
  llm_id: string;
  llm_websocket_url: string;
  model?: string;
  general_prompt?: string;
  general_tools?: any[];
  states?: any[];
  starting_state?: string;
  begin_message?: string;
  inbound_dynamic_variables_webhook_url?: string;
  last_modification_timestamp?: number;
}

export class RetellProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${RETELL_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Retell API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      // List agents to validate the key - Retell doesn't have a /user endpoint
      const agents = await this.request<RetellAgent[]>(apiKey, '/list-agents');

      return {
        valid: true,
        message: 'Retell API key is valid',
        details: {
          accountName: 'Retell AI Account',
          agentsCount: agents.length,
          plan: 'Active',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        message: `Invalid Retell API key: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      const agents = await this.request<RetellAgent[]>(apiKey, '/list-agents');

      return agents.map((agent) => ({
        id: agent.agent_id,
        name: agent.agent_name,
        provider: 'retell',
        voice: agent.voice_id,
        language: agent.language,
        metadata: {
          voiceTemperature: agent.voice_temperature,
          voiceSpeed: agent.voice_speed,
          responsiveness: agent.responsiveness,
          interruptionSensitivity: agent.interruption_sensitivity,
          enableBackchannel: agent.enable_backchannel,
          maxCallDurationMs: agent.max_call_duration_ms,
          responseEngine: agent.response_engine,
        },
      }));
    } catch (error) {
      console.error('Error listing Retell agents:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const agent = await this.request<RetellAgent>(
        apiKey,
        `/get-agent/${agentId}`
      );

      // Also try to get the LLM details if available
      let llmDetails: RetellLLM | null = null;
      if (agent.response_engine?.llm_id) {
        try {
          llmDetails = await this.request<RetellLLM>(
            apiKey,
            `/get-retell-llm/${agent.response_engine.llm_id}`
          );
        } catch (e) {
          // LLM might not exist or be accessible
        }
      }

      return {
        id: agent.agent_id,
        name: agent.agent_name,
        provider: 'retell',
        description: llmDetails?.general_prompt?.substring(0, 200),
        voice: agent.voice_id,
        language: agent.language,
        metadata: {
          voiceTemperature: agent.voice_temperature,
          voiceSpeed: agent.voice_speed,
          responsiveness: agent.responsiveness,
          webhookUrl: agent.webhook_url,
          llmId: agent.response_engine?.llm_id,
          llmModel: llmDetails?.model,
          beginMessage: llmDetails?.begin_message,
          fullPrompt: llmDetails?.general_prompt,
          tools: llmDetails?.general_tools,
        },
      };
    } catch (error) {
      console.error('Error getting Retell agent:', error);
      return null;
    }
  }

  async listLLMs(apiKey: string): Promise<RetellLLM[]> {
    try {
      return await this.request<RetellLLM[]>(apiKey, '/list-retell-llms');
    } catch (error) {
      console.error('Error listing Retell LLMs:', error);
      return [];
    }
  }

  async listVoices(apiKey: string): Promise<any[]> {
    try {
      return await this.request<any[]>(apiKey, '/list-voices');
    } catch (error) {
      console.error('Error listing Retell voices:', error);
      return [];
    }
  }

  /**
   * Get provider limits including concurrency
   * Note: Retell doesn't expose concurrency limits via API, using defaults
   */
  async getLimits(apiKey: string): Promise<ProviderLimits> {
    try {
      // Try to get account info if available
      // Retell doesn't have a direct limits endpoint, so we use defaults
      const agents = await this.listAgents(apiKey);
      
      return {
        concurrencyLimit: RETELL_DEFAULT_CONCURRENCY,
        source: 'default',
      };
    } catch (error) {
      console.error('[Retell] Error getting limits:', error);
      return {
        concurrencyLimit: RETELL_DEFAULT_CONCURRENCY,
        source: 'default',
      };
    }
  }

  /**
   * Create a web call to get access token for WebSocket connection
   * @see https://docs.retellai.com/api-references/create-web-call
   */
  async createWebCall(
    apiKey: string,
    agentId: string,
    metadata?: Record<string, any>
  ): Promise<{
    callId: string;
    accessToken: string;
    agentId: string;
    callStatus: string;
  } | null> {
    try {
      const result = await this.request<{
        call_id: string;
        access_token: string;
        agent_id: string;
        call_status: string;
        call_type: string;
      }>(apiKey, '/v2/create-web-call', {
        method: 'POST',
        body: JSON.stringify({
          agent_id: agentId,
          metadata: metadata || {},
        }),
      });

      console.log(`[Retell] Created web call: ${result.call_id}`);

      return {
        callId: result.call_id,
        accessToken: result.access_token,
        agentId: result.agent_id,
        callStatus: result.call_status,
      };
    } catch (error) {
      console.error('[Retell] Error creating web call:', error);
      return null;
    }
  }

  /**
   * Get call details including transcript after call ends
   * @see https://docs.retellai.com/api-references/get-call
   */
  async getCall(
    apiKey: string,
    callId: string
  ): Promise<{
    callId: string;
    callStatus: string;
    transcript?: string;
    transcriptObject?: Array<{
      role: 'agent' | 'user';
      content: string;
      words?: Array<{ word: string; start: number; end: number }>;
    }>;
    recordingUrl?: string;
    durationMs?: number;
    disconnectionReason?: string;
  } | null> {
    try {
      const result = await this.request<{
        call_id: string;
        call_status: string;
        transcript?: string;
        transcript_object?: Array<{
          role: 'agent' | 'user';
          content: string;
          words?: Array<{ word: string; start: number; end: number }>;
        }>;
        recording_url?: string;
        duration_ms?: number;
        disconnection_reason?: string;
      }>(apiKey, `/v2/get-call/${callId}`);

      return {
        callId: result.call_id,
        callStatus: result.call_status,
        transcript: result.transcript,
        transcriptObject: result.transcript_object,
        recordingUrl: result.recording_url,
        durationMs: result.duration_ms,
        disconnectionReason: result.disconnection_reason,
      };
    } catch (error) {
      console.error('[Retell] Error getting call:', error);
      return null;
    }
  }

  /**
   * Get the WebSocket URL for audio streaming
   */
  getWebSocketUrl(callId: string, enableUpdate: boolean = true): string {
    return `wss://api.retellai.com/audio-websocket/${callId}?enable_update=${enableUpdate}`;
  }
}

export const retellProvider = new RetellProvider();
