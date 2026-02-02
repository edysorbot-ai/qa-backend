/**
 * Haptik Voice Agent Provider
 * Documentation: https://docs.haptik.ai/
 * 
 * Haptik is a conversational AI platform that provides voice and chat agents
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
} from './provider.interface';

const HAPTIK_BASE_URL = 'https://api.haptik.ai';
const HAPTIK_DEFAULT_CONCURRENCY = 5;

interface HaptikBot {
  bot_id: string;
  bot_name: string;
  description?: string;
  domain?: string;
  language?: string;
  voice_enabled?: boolean;
  voice_config?: {
    voice_id?: string;
    voice_name?: string;
    language?: string;
    speed?: number;
    pitch?: number;
    provider?: string;
  };
  intents?: Array<{
    intent_id: string;
    intent_name: string;
    description?: string;
    examples?: string[];
  }>;
  flows?: Array<{
    flow_id: string;
    flow_name: string;
    description?: string;
  }>;
  settings?: {
    fallback_message?: string;
    welcome_message?: string;
    session_timeout_seconds?: number;
    max_retry_count?: number;
    handoff_enabled?: boolean;
    analytics_enabled?: boolean;
  };
  webhook_url?: string;
  created_at?: string;
  updated_at?: string;
  status?: 'active' | 'inactive' | 'draft';
}

interface HaptikBusinessInfo {
  business_id: string;
  business_name: string;
  plan?: string;
  credits_remaining?: number;
  bots_count?: number;
  active_bots_count?: number;
  created_at?: string;
}

interface HaptikConversation {
  conversation_id: string;
  bot_id: string;
  user_id: string;
  channel: string;
  status: 'active' | 'completed' | 'escalated';
  messages: Array<{
    message_id: string;
    type: 'user' | 'bot' | 'agent';
    content: string;
    timestamp: string;
    intent_detected?: string;
  }>;
  started_at: string;
  ended_at?: string;
  transcript?: string;
}

interface HaptikAnalytics {
  total_conversations: number;
  successful_conversations: number;
  failed_conversations: number;
  avg_resolution_time_seconds: number;
  top_intents: Array<{ intent: string; count: number }>;
  satisfaction_score?: number;
}

export class HaptikProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${HAPTIK_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Haptik-Client': 'qa-platform',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Haptik API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      // Try to get business info or list bots to validate the key
      const bots = await this.request<HaptikBot[]>(apiKey, '/v1/bots');

      return {
        valid: true,
        message: 'Haptik API key is valid',
        details: {
          accountName: 'Haptik Business Account',
          agentsCount: bots.length,
          plan: 'Active',
        },
      };
    } catch (error) {
      // Fallback: try alternate validation endpoint
      try {
        const businessInfo = await this.request<HaptikBusinessInfo>(apiKey, '/v1/business/info');
        return {
          valid: true,
          message: 'Haptik API key is valid',
          details: {
            accountName: businessInfo.business_name || 'Haptik Account',
            agentsCount: businessInfo.bots_count || 0,
            plan: businessInfo.plan || 'Active',
            creditsRemaining: businessInfo.credits_remaining,
          },
        };
      } catch (innerError) {
        return {
          valid: false,
          message: 'Invalid API key',
        };
      }
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      const bots = await this.request<HaptikBot[]>(apiKey, '/v1/bots');

      return bots.map((bot) => ({
        id: bot.bot_id,
        name: bot.bot_name,
        provider: 'haptik',
        description: bot.description,
        voice: bot.voice_config?.voice_id,
        language: bot.language || bot.voice_config?.language,
        metadata: {
          domain: bot.domain,
          voiceEnabled: bot.voice_enabled,
          voiceConfig: bot.voice_config,
          intentsCount: bot.intents?.length || 0,
          flowsCount: bot.flows?.length || 0,
          welcomeMessage: bot.settings?.welcome_message,
          fallbackMessage: bot.settings?.fallback_message,
          status: bot.status,
          createdAt: bot.created_at,
          updatedAt: bot.updated_at,
        },
      }));
    } catch (error) {
      console.error('Error listing Haptik bots:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const bot = await this.request<HaptikBot>(apiKey, `/v1/bots/${agentId}`);

      return {
        id: bot.bot_id,
        name: bot.bot_name,
        provider: 'haptik',
        description: bot.description,
        voice: bot.voice_config?.voice_id,
        language: bot.language || bot.voice_config?.language,
        metadata: {
          domain: bot.domain,
          voiceEnabled: bot.voice_enabled,
          voiceConfig: bot.voice_config,
          intents: bot.intents,
          flows: bot.flows,
          settings: bot.settings,
          welcomeMessage: bot.settings?.welcome_message,
          fallbackMessage: bot.settings?.fallback_message,
          sessionTimeout: bot.settings?.session_timeout_seconds,
          maxRetryCount: bot.settings?.max_retry_count,
          handoffEnabled: bot.settings?.handoff_enabled,
          webhookUrl: bot.webhook_url,
          status: bot.status,
          createdAt: bot.created_at,
          updatedAt: bot.updated_at,
        },
      };
    } catch (error) {
      console.error('Error getting Haptik bot:', error);
      return null;
    }
  }

  /**
   * List intents for a bot
   */
  async listIntents(apiKey: string, botId: string): Promise<any[]> {
    try {
      return await this.request<any[]>(apiKey, `/v1/bots/${botId}/intents`);
    } catch (error) {
      console.error('Error listing Haptik intents:', error);
      return [];
    }
  }

  /**
   * List conversation flows for a bot
   */
  async listFlows(apiKey: string, botId: string): Promise<any[]> {
    try {
      return await this.request<any[]>(apiKey, `/v1/bots/${botId}/flows`);
    } catch (error) {
      console.error('Error listing Haptik flows:', error);
      return [];
    }
  }

  /**
   * Get analytics for a bot
   */
  async getAnalytics(
    apiKey: string,
    botId: string,
    startDate?: string,
    endDate?: string
  ): Promise<HaptikAnalytics | null> {
    try {
      let endpoint = `/v1/bots/${botId}/analytics`;
      if (startDate && endDate) {
        endpoint += `?start_date=${startDate}&end_date=${endDate}`;
      }
      return await this.request<HaptikAnalytics>(apiKey, endpoint);
    } catch (error) {
      console.error('Error getting Haptik analytics:', error);
      return null;
    }
  }

  /**
   * Get conversation history
   */
  async getConversations(
    apiKey: string,
    botId: string,
    limit: number = 10
  ): Promise<HaptikConversation[]> {
    try {
      return await this.request<HaptikConversation[]>(
        apiKey,
        `/v1/bots/${botId}/conversations?limit=${limit}`
      );
    } catch (error) {
      console.error('Error getting Haptik conversations:', error);
      return [];
    }
  }

  /**
   * Get a specific conversation
   */
  async getConversation(
    apiKey: string,
    conversationId: string
  ): Promise<HaptikConversation | null> {
    try {
      return await this.request<HaptikConversation>(
        apiKey,
        `/v1/conversations/${conversationId}`
      );
    } catch (error) {
      console.error('Error getting Haptik conversation:', error);
      return null;
    }
  }

  /**
   * Send a message to a bot (for testing)
   */
  async sendMessage(
    apiKey: string,
    botId: string,
    message: string,
    userId?: string,
    sessionId?: string
  ): Promise<{
    response: string;
    intent?: string;
    confidence?: number;
    sessionId: string;
  } | null> {
    try {
      const result = await this.request<{
        response: string;
        intent?: string;
        confidence?: number;
        session_id: string;
      }>(apiKey, `/v1/bots/${botId}/message`, {
        method: 'POST',
        body: JSON.stringify({
          message,
          user_id: userId || `test_user_${Date.now()}`,
          session_id: sessionId,
          channel: 'api',
        }),
      });

      return {
        response: result.response,
        intent: result.intent,
        confidence: result.confidence,
        sessionId: result.session_id,
      };
    } catch (error) {
      console.error('Error sending message to Haptik bot:', error);
      return null;
    }
  }

  /**
   * Initiate a voice call with the bot
   */
  async initiateVoiceCall(
    apiKey: string,
    botId: string,
    phoneNumber?: string
  ): Promise<{
    callId: string;
    webSocketUrl?: string;
    status: string;
  } | null> {
    try {
      const result = await this.request<{
        call_id: string;
        websocket_url?: string;
        status: string;
      }>(apiKey, `/v1/bots/${botId}/voice/call`, {
        method: 'POST',
        body: JSON.stringify({
          phone_number: phoneNumber,
          channel: phoneNumber ? 'phone' : 'web',
        }),
      });

      return {
        callId: result.call_id,
        webSocketUrl: result.websocket_url,
        status: result.status,
      };
    } catch (error) {
      console.error('Error initiating Haptik voice call:', error);
      return null;
    }
  }

  /**
   * End a voice call
   */
  async endVoiceCall(apiKey: string, callId: string): Promise<boolean> {
    try {
      await this.request(apiKey, `/v1/voice/calls/${callId}/end`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      console.error('Error ending Haptik voice call:', error);
      return false;
    }
  }

  /**
   * Get call transcript
   */
  async getCallTranscript(
    apiKey: string,
    callId: string
  ): Promise<{
    transcript: string;
    turns: Array<{
      role: 'user' | 'bot';
      text: string;
      timestamp: string;
    }>;
    duration: number;
    status: string;
  } | null> {
    try {
      return await this.request(apiKey, `/v1/voice/calls/${callId}/transcript`);
    } catch (error) {
      console.error('Error getting Haptik call transcript:', error);
      return null;
    }
  }

  /**
   * Get provider limits including concurrency
   */
  async getLimits(apiKey: string): Promise<ProviderLimits> {
    try {
      // Try to get business info which may contain limits
      const businessInfo = await this.request<HaptikBusinessInfo>(apiKey, '/v1/business/info');
      
      return {
        concurrencyLimit: HAPTIK_DEFAULT_CONCURRENCY,
        source: 'default',
      };
    } catch (error) {
      console.error('[Haptik] Error getting limits:', error);
      return {
        concurrencyLimit: HAPTIK_DEFAULT_CONCURRENCY,
        source: 'default',
      };
    }
  }

  /**
   * Check if this provider supports chat-based testing
   * Haptik is primarily a chat platform, so chat testing is fully supported
   */
  supportsChatTesting(): boolean {
    return true;
  }

  /**
   * Send a text chat message to Haptik bot
   * Uses the message API for cost-effective testing
   * This is a wrapper around sendMessage to match the common interface
   */
  async chat(
    apiKey: string,
    agentId: string,
    message: string,
    options: {
      sessionId?: string;
      previousChatId?: string;
    } = {}
  ): Promise<{
    id: string;
    output: Array<{ role: string; message: string }>;
    messages: Array<{ role: string; message: string }>;
    sessionId?: string;
    rawResponse?: any;
  } | null> {
    try {
      console.log(`[Haptik Chat] Sending message to bot ${agentId}: "${message.substring(0, 100)}..."`);

      // Use the existing sendMessage method
      const result = await this.sendMessage(
        apiKey,
        agentId,
        message,
        undefined,  // userId will be auto-generated
        options.sessionId
      );

      if (!result) {
        console.error('[Haptik Chat] No response from sendMessage');
        return null;
      }

      console.log(`[Haptik Chat] Response received:`, JSON.stringify(result, null, 2));

      // Format the output
      const outputMessages: Array<{ role: string; message: string }> = [];
      if (result.response) {
        outputMessages.push({
          role: 'assistant',
          message: result.response,
        });
      }

      return {
        id: `haptik_${Date.now()}`,
        output: outputMessages,
        messages: outputMessages,
        sessionId: result.sessionId,
        rawResponse: result,
      };
    } catch (error) {
      console.error('[Haptik Chat] Error sending chat message:', error);
      return null;
    }
  }

  /**
   * Run a multi-turn chat conversation with Haptik bot
   * Uses the message API for cost-effective testing
   */
  async runChatConversation(
    apiKey: string,
    agentId: string,
    userMessages: string[]
  ): Promise<{
    success: boolean;
    transcript: Array<{ role: string; content: string; timestamp: number }>;
    error?: string;
  }> {
    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    let sessionId: string | undefined;

    try {
      for (const userMessage of userMessages) {
        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: userMessage,
          timestamp: Date.now(),
        });

        // Send to Haptik Chat API
        const response = await this.chat(apiKey, agentId, userMessage, {
          sessionId,
        });

        if (!response) {
          return {
            success: false,
            transcript,
            error: 'Failed to get response from Haptik Chat API',
          };
        }

        // Track session ID for continuity
        if (response.sessionId) {
          sessionId = response.sessionId;
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

export const haptikProvider = new HaptikProvider();
