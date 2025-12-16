/**
 * ElevenLabs Voice AI Provider
 * Documentation: https://elevenlabs.io/docs/api-reference
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  VoiceAgent,
  TTSRequest,
  TTSResponse,
} from './provider.interface';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

interface ElevenLabsUser {
  subscription: {
    tier: string;
    character_count: number;
    character_limit: number;
    status: string;
  };
  is_new_user: boolean;
  first_name?: string;
}

interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

interface ElevenLabsAgent {
  agent_id: string;
  name: string;
  conversation_config?: {
    agent?: {
      prompt?: {
        prompt: string;
        llm?: string;
        temperature?: number;
        max_tokens?: number;
      };
      first_message?: string;
      language?: string;
    };
    tts?: {
      voice_id?: string;
      model_id?: string;
      stability?: number;
      similarity_boost?: number;
      style?: number;
      speed?: number;
      optimize_streaming_latency?: number;
    };
    stt?: {
      provider?: string;
      model?: string;
      language?: string;
    };
    turn?: {
      turn_timeout?: number;
      silence_timeout_ms?: number;
      max_duration_ms?: number;
    };
  };
  metadata?: Record<string, any>;
}

export class ElevenLabsProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${ELEVENLABS_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      console.log('Validating ElevenLabs API key...');
      // Get user info to validate the key
      const user = await this.request<ElevenLabsUser>(apiKey, '/user');
      console.log('ElevenLabs validation success:', user.first_name);

      return {
        valid: true,
        message: 'ElevenLabs API key is valid',
        details: {
          accountName: user.first_name || 'ElevenLabs User',
          plan: user.subscription.tier,
          creditsRemaining: user.subscription.character_limit - user.subscription.character_count,
          subscriptionStatus: user.subscription.status,
          characterLimit: user.subscription.character_limit,
          characterUsed: user.subscription.character_count,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('ElevenLabs validation error:', message);
      return {
        valid: false,
        message: `Invalid ElevenLabs API key: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      // ElevenLabs Conversational AI agents endpoint
      const response = await this.request<{ agents: ElevenLabsAgent[] }>(
        apiKey,
        '/convai/agents'
      );

      return response.agents.map((agent) => ({
        id: agent.agent_id,
        name: agent.name,
        provider: 'elevenlabs',
        description: agent.conversation_config?.agent?.prompt?.prompt?.substring(0, 100),
        voice: agent.conversation_config?.tts?.voice_id,
        language: agent.conversation_config?.agent?.language,
        metadata: {
          firstMessage: agent.conversation_config?.agent?.first_message,
        },
      }));
    } catch (error) {
      console.error('Error listing ElevenLabs agents:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const agent = await this.request<ElevenLabsAgent>(
        apiKey,
        `/convai/agents/${agentId}`
      );

      const config = agent.conversation_config;
      const promptConfig = config?.agent?.prompt;
      const ttsConfig = config?.tts;
      const sttConfig = config?.stt;
      const turnConfig = config?.turn;

      return {
        id: agent.agent_id,
        name: agent.name,
        provider: 'elevenlabs',
        description: promptConfig?.prompt,
        voice: ttsConfig?.voice_id,
        language: config?.agent?.language,
        metadata: {
          // LLM Settings
          llmModel: promptConfig?.llm,
          temperature: promptConfig?.temperature,
          maxTokens: promptConfig?.max_tokens,
          
          // Voice/TTS Settings
          voiceModel: ttsConfig?.model_id,
          voiceStability: ttsConfig?.stability,
          voiceSimilarityBoost: ttsConfig?.similarity_boost,
          voiceStyle: ttsConfig?.style,
          voiceSpeed: ttsConfig?.speed,
          optimizeLatency: ttsConfig?.optimize_streaming_latency,
          
          // STT Settings
          transcriberProvider: sttConfig?.provider,
          transcriberModel: sttConfig?.model,
          transcriberLanguage: sttConfig?.language,
          
          // Turn Settings
          turnTimeout: turnConfig?.turn_timeout,
          silenceTimeout: turnConfig?.silence_timeout_ms,
          maxDuration: turnConfig?.max_duration_ms,
          
          // Other
          firstMessage: config?.agent?.first_message,
          fullConfig: config,
        },
      };
    } catch (error) {
      console.error('Error getting ElevenLabs agent:', error);
      return null;
    }
  }

  async listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
    try {
      const response = await this.request<{ voices: ElevenLabsVoice[] }>(
        apiKey,
        '/voices'
      );
      return response.voices;
    } catch (error) {
      console.error('Error listing ElevenLabs voices:', error);
      return [];
    }
  }

  async textToSpeech(apiKey: string, request: TTSRequest): Promise<TTSResponse> {
    const voiceId = request.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Default: Rachel
    const modelId = request.modelId || 'eleven_monolingual_v1';

    const response = await fetch(
      `${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: request.text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS error (${response.status}): ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      contentType: 'audio/mpeg',
    };
  }
}

export const elevenlabsProvider = new ElevenLabsProvider();
