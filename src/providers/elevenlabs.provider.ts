/**
 * ElevenLabs Voice AI Provider
 * Documentation: https://elevenlabs.io/docs/api-reference
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
  TTSRequest,
  TTSResponse,
} from './provider.interface';

const ELEVENLABS_DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1';

/**
 * Resolve the ElevenLabs base URL from a custom domain or use the default.
 * Accepts formats like:
 *   - "elevenlabs.in" → "https://api.elevenlabs.in/v1"
 *   - "api.elevenlabs.in" → "https://api.elevenlabs.in/v1"
 *   - "https://api.elevenlabs.in/v1" → as-is
 *   - null/undefined → default "https://api.elevenlabs.io/v1"
 */
export function resolveElevenLabsBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl || !baseUrl.trim()) {
    return ELEVENLABS_DEFAULT_BASE_URL;
  }
  
  let url = baseUrl.trim().replace(/\/+$/, ''); // Remove trailing slashes
  
  // If it's already a full URL with /v1, use as-is
  if (url.startsWith('https://') && url.includes('/v1')) {
    return url;
  }
  
  // If it's a full URL without /v1, append it
  if (url.startsWith('https://')) {
    return `${url}/v1`;
  }
  
  // If it starts with "api.", treat as full domain
  if (url.startsWith('api.')) {
    return `https://${url}/v1`;
  }
  
  // Otherwise, it's a bare domain like "elevenlabs.in" → "https://api.elevenlabs.in/v1"
  return `https://api.${url}/v1`;
}

// ElevenLabs plan concurrency limits
const ELEVENLABS_PLAN_LIMITS: Record<string, number> = {
  'free': 1,
  'starter': 2,
  'creator': 3,
  'pro': 5,
  'scale': 10,
  'business': 20,
  'enterprise': 50,
};

interface ElevenLabsUser {
  subscription: {
    tier: string;
    character_count: number;
    character_limit: number;
    status: string;
    max_concurrent_requests?: number; // If available from API
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
    options: RequestInit = {},
    baseUrl?: string | null
  ): Promise<T> {
    const resolvedBaseUrl = resolveElevenLabsBaseUrl(baseUrl);
    const response = await fetch(`${resolvedBaseUrl}${endpoint}`, {
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

  async validateApiKey(apiKey: string, baseUrl?: string | null): Promise<ProviderValidationResult> {
    try {
      console.log('Validating ElevenLabs API key...');
      // Get user info to validate the key
      const user = await this.request<ElevenLabsUser>(apiKey, '/user', {}, baseUrl);
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
      console.error('ElevenLabs validation error:', error instanceof Error ? error.message : 'Unknown error');
      return {
        valid: false,
        message: 'Invalid API key',
      };
    }
  }

  async listAgents(apiKey: string, baseUrl?: string | null): Promise<VoiceAgent[]> {
    try {
      // ElevenLabs Conversational AI agents endpoint
      const response = await this.request<{ agents: ElevenLabsAgent[] }>(
        apiKey,
        '/convai/agents',
        {},
        baseUrl
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

  async getAgent(apiKey: string, agentId: string, baseUrl?: string | null): Promise<VoiceAgent | null> {
    try {
      const agent = await this.request<ElevenLabsAgent>(
        apiKey,
        `/convai/agents/${agentId}`,
        {},
        baseUrl
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

  async getKnowledgeBase(apiKey: string, agentId: string, baseUrl?: string | null): Promise<any[]> {
    try {
      // ElevenLabs knowledge base endpoint - list all documents
      console.log(`[ElevenLabs] Fetching knowledge base for agent: ${agentId}`);
      
      // First, get the agent details to check for knowledge_base configuration
      const agentResponse = await this.request<any>(
        apiKey,
        `/convai/agents/${agentId}`,
        {},
        baseUrl
      );
      
      console.log('[ElevenLabs] Agent response keys:', Object.keys(agentResponse || {}));
      
      // Get knowledge base items directly from agent's prompt config
      // This includes both files AND URLs
      const agentKbItems: any[] = [];
      const agentKbIds: string[] = [];
      
      // Check various locations for knowledge base references
      if (agentResponse.knowledge_base) {
        console.log('[ElevenLabs] Found knowledge_base in agent response:', agentResponse.knowledge_base);
        if (Array.isArray(agentResponse.knowledge_base)) {
          agentKbItems.push(...agentResponse.knowledge_base);
          agentKbIds.push(...agentResponse.knowledge_base.map((kb: any) => kb.id || kb.document_id || kb));
        }
      }
      
      if (agentResponse.conversation_config?.agent?.prompt?.knowledge_base) {
        const kb = agentResponse.conversation_config.agent.prompt.knowledge_base;
        console.log('[ElevenLabs] Found knowledge_base in prompt config:', kb);
        if (Array.isArray(kb)) {
          // Store the full KB items from agent config (includes URLs)
          agentKbItems.push(...kb);
          agentKbIds.push(...kb.map((item: any) => item.id || item.document_id || item));
        }
      }
      
      // Now fetch all knowledge base documents to get metadata
      const kbResponse = await this.request<{ documents: any[]; has_more: boolean }>(
        apiKey,
        `/convai/knowledge-base?page_size=100`,
        {},
        baseUrl
      );
      
      console.log('[ElevenLabs] Knowledge base list response - total documents:', kbResponse.documents?.length || 0);
      
      // Create a map of document details from the full list
      const docDetailsMap = new Map<string, any>();
      if (kbResponse.documents && Array.isArray(kbResponse.documents)) {
        for (const doc of kbResponse.documents) {
          docDetailsMap.set(doc.id, doc);
        }
      }
      
      // Build the final list using agent's KB items as the source of truth
      // This ensures we include both files AND URLs
      const result: any[] = [];
      const seenIds = new Set<string>();
      
      for (const item of agentKbItems) {
        const itemId = item.id || item.document_id;
        if (!itemId || seenIds.has(itemId)) continue;
        seenIds.add(itemId);
        
        // Get full details from the documents list if available
        const fullDetails = docDetailsMap.get(itemId);
        
        if (fullDetails) {
          // File document with full metadata
          result.push({
            ...fullDetails,
            name: fullDetails.name || fullDetails.file_name || item.name || 'Unknown Document',
            type: fullDetails.type || item.type || 'file',
            metadata: fullDetails.metadata || {},
          });
        } else {
          // URL or item not in documents list - use agent config data
          result.push({
            id: itemId,
            name: item.name || 'Unknown',
            type: item.type || 'url',
            url: item.url || (item.type === 'url' ? `https://elevenlabs.io/kb/${itemId}` : undefined),
            usage_mode: item.usage_mode,
            metadata: {
              source: 'agent_config',
            },
          });
        }
      }
      
      console.log(`[ElevenLabs] Returning ${result.length} knowledge base items for agent ${agentId}`);
      
      return result;
    } catch (error: any) {
      console.error('[ElevenLabs] Error getting knowledge base:', error?.message || error);
      return [];
    }
  }

  async listVoices(apiKey: string, baseUrl?: string | null): Promise<ElevenLabsVoice[]> {
    try {
      const response = await this.request<{ voices: ElevenLabsVoice[] }>(
        apiKey,
        '/voices',
        {},
        baseUrl
      );
      return response.voices;
    } catch (error) {
      console.error('Error listing ElevenLabs voices:', error);
      return [];
    }
  }

  async textToSpeech(apiKey: string, request: TTSRequest, baseUrl?: string | null): Promise<TTSResponse> {
    const voiceId = request.voiceId || '21m00Tcm4TlvDq8ikWAM'; // Default: Rachel
    const modelId = request.modelId || 'eleven_monolingual_v1';
    const resolvedBaseUrl = resolveElevenLabsBaseUrl(baseUrl);

    const response = await fetch(
      `${resolvedBaseUrl}/text-to-speech/${voiceId}`,
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

  async getKnowledgeBaseDocumentContent(apiKey: string, documentId: string, baseUrl?: string | null): Promise<string> {
    try {
      console.log(`[ElevenLabs] Fetching document content for: ${documentId}`);
      const resolvedBaseUrl = resolveElevenLabsBaseUrl(baseUrl);
      
      const response = await fetch(
        `${resolvedBaseUrl}/convai/knowledge-base/${documentId}/content`,
        {
          headers: {
            'xi-api-key': apiKey,
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ElevenLabs API error (${response.status}): ${error}`);
      }

      const content = await response.text();
      console.log(`[ElevenLabs] Document content fetched, length: ${content.length}`);
      return content;
    } catch (error: any) {
      console.error('[ElevenLabs] Error getting document content:', error?.message || error);
      throw error;
    }
  }

  /**
   * Get provider limits including concurrency
   */
  async getLimits(apiKey: string, baseUrl?: string | null): Promise<ProviderLimits> {
    try {
      const user = await this.request<ElevenLabsUser>(apiKey, '/user', {}, baseUrl);
      const tier = user.subscription.tier?.toLowerCase() || 'free';
      
      // Get concurrency limit from API if available, otherwise from plan
      const concurrencyLimit = user.subscription.max_concurrent_requests || 
                               ELEVENLABS_PLAN_LIMITS[tier] || 
                               ELEVENLABS_PLAN_LIMITS['free'];
      
      return {
        concurrencyLimit,
        characterLimit: user.subscription.character_limit,
        source: user.subscription.max_concurrent_requests ? 'api' : 'plan',
      };
    } catch (error) {
      console.error('[ElevenLabs] Error getting limits:', error);
      // Return conservative default
      return {
        concurrencyLimit: 2,
        source: 'default',
      };
    }
  }

  /**
   * Check if this provider supports chat-based testing
   * ElevenLabs Conversational AI supports text-based conversations
   */
  supportsChatTesting(): boolean {
    return true;
  }

  /**
   * Send a text chat message to ElevenLabs Conversational AI agent
   * Uses the text-mode conversation API for cost-effective testing
   * @see https://elevenlabs.io/docs/api-reference/conversational-ai
   */
  async chat(
    apiKey: string,
    agentId: string,
    message: string,
    options: {
      sessionId?: string;
      previousChatId?: string;
      baseUrl?: string | null;
    } = {}
  ): Promise<{
    id: string;
    output: Array<{ role: string; message: string }>;
    messages: Array<{ role: string; message: string }>;
    sessionId?: string;
    rawResponse?: any;
  } | null> {
    try {
      console.log(`[ElevenLabs Chat] Sending message to agent ${agentId}: "${message.substring(0, 100)}..."`);

      // ElevenLabs uses a conversation session endpoint for text-based interactions
      const requestBody: any = {
        agent_id: agentId,
        text: message,
      };

      // If we have an existing session, continue it
      if (options.sessionId) {
        requestBody.conversation_id = options.sessionId;
      }

      const response = await this.request<any>(apiKey, '/convai/conversation/text', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      }, options.baseUrl);

      console.log(`[ElevenLabs Chat] Response received:`, JSON.stringify(response, null, 2));

      // Extract output from ElevenLabs response format
      let outputMessages: Array<{ role: string; message: string }> = [];

      // Check for response text
      if (response.response || response.text || response.agent_response) {
        const text = response.response || response.text || response.agent_response;
        outputMessages.push({
          role: 'assistant',
          message: typeof text === 'string' ? text : JSON.stringify(text),
        });
      }

      // Check for messages array
      if (response.messages && Array.isArray(response.messages)) {
        for (const msg of response.messages) {
          if (msg.role === 'assistant' || msg.role === 'agent') {
            outputMessages.push({
              role: 'assistant',
              message: msg.content || msg.text || msg.message || '',
            });
          }
        }
      }

      return {
        id: response.conversation_id || response.id || 'unknown',
        output: outputMessages,
        messages: response.messages || [],
        sessionId: response.conversation_id,
        rawResponse: response,
      };
    } catch (error) {
      console.error('[ElevenLabs Chat] Error sending chat message:', error);
      return null;
    }
  }

  /**
   * Run a multi-turn chat conversation with ElevenLabs agent
   * Uses the text conversation API for cost-effective testing
   */
  async runChatConversation(
    apiKey: string,
    agentId: string,
    userMessages: string[],
    baseUrl?: string | null
  ): Promise<{
    success: boolean;
    transcript: Array<{ role: string; content: string; timestamp: number }>;
    error?: string;
  }> {
    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    let conversationId: string | undefined;

    try {
      for (const userMessage of userMessages) {
        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: userMessage,
          timestamp: Date.now(),
        });

        // Send to ElevenLabs Chat API
        const response = await this.chat(apiKey, agentId, userMessage, {
          sessionId: conversationId,
          baseUrl,
        });

        if (!response) {
          return {
            success: false,
            transcript,
            error: 'Failed to get response from ElevenLabs Chat API',
          };
        }

        // Track conversation ID for continuity
        if (response.sessionId) {
          conversationId = response.sessionId;
        }

        // Add assistant responses to transcript
        for (const output of response.output) {
          if (output.message) {
            transcript.push({
              role: 'ai_agent',
              content: output.message,
              timestamp: Date.now(),
            });
          }
        }

        // Small delay between messages
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return { success: true, transcript };
    } catch (error) {
      return {
        success: false,
        transcript,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const elevenlabsProvider = new ElevenLabsProvider();
