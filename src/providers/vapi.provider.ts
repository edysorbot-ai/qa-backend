/**
 * VAPI Voice Agent Provider
 * Documentation: https://docs.vapi.ai/api-reference
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
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

      // Debug: Log sample of the first assistant to see structure
      if (assistants.length > 0) {
        console.log('VAPI listAgents - Sample assistant:', JSON.stringify(assistants[0], null, 2));
      }

      return assistants.map((assistant) => {
        // Extract system prompt - check multiple possible locations
        const systemPrompt = assistant.model?.systemPrompt || 
                            (assistant.model?.messages?.find((m: any) => m.role === 'system')?.content) ||
                            '';
        
        return {
          id: assistant.id,
          name: assistant.name,
          provider: 'vapi',
          description: systemPrompt?.substring(0, 200),
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
            // Store prompt in metadata for redundancy
            prompt: systemPrompt,
          },
        };
      });
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

      // Debug: Log the raw assistant data to see the actual structure
      console.log('VAPI getAgent - Raw assistant response:', JSON.stringify(assistant, null, 2));
      console.log('VAPI getAgent - assistant.model:', assistant.model);
      console.log('VAPI getAgent - assistant.model?.systemPrompt:', assistant.model?.systemPrompt);

      // Extract system prompt - check multiple possible locations
      const systemPrompt = assistant.model?.systemPrompt || 
                          (assistant.model?.messages?.find((m: any) => m.role === 'system')?.content) ||
                          '';

      console.log('VAPI getAgent - Extracted systemPrompt:', systemPrompt ? `Found (${systemPrompt.length} chars)` : 'NOT FOUND');

      return {
        id: assistant.id,
        name: assistant.name,
        provider: 'vapi',
        description: systemPrompt,
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
          // Also store prompt in metadata for redundancy
          prompt: systemPrompt,
          systemPrompt: systemPrompt,
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

  /**
   * Get provider limits including concurrency
   * VAPI has organization-level concurrency limits
   */
  async getLimits(apiKey: string): Promise<ProviderLimits> {
    try {
      // Try to get org info which contains concurrencyLimit
      const orgInfo = await this.request<VAPIOrg>(apiKey, '/org');
      
      return {
        concurrencyLimit: orgInfo.concurrencyLimit || 10,
        source: orgInfo.concurrencyLimit ? 'api' : 'default',
      };
    } catch (error) {
      console.error('[VAPI] Error getting limits:', error);
      // VAPI default is typically 10 concurrent calls
      return {
        concurrencyLimit: 10,
        source: 'default',
      };
    }
  }

  /**
   * Send a text chat message to VAPI assistant using the Chat API
   * This is VAPI's in-house text-based testing feature
   * @see https://docs.vapi.ai/api-reference/chats/create
   */
  async chat(
    apiKey: string,
    assistantId: string,
    input: string,
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
      console.log(`[VAPI Chat] Sending message to assistant ${assistantId}: "${input.substring(0, 100)}..."`);
      console.log(`[VAPI Chat] Options:`, JSON.stringify(options));

      const requestBody = {
        assistantId,
        input,
        ...(options.sessionId && { sessionId: options.sessionId }),
        ...(options.previousChatId && { previousChatId: options.previousChatId }),
      };
      console.log(`[VAPI Chat] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await this.request<any>(apiKey, '/chat', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      console.log(`[VAPI Chat] RAW Response received:`, JSON.stringify(response, null, 2));

      // Extract output - VAPI might return in different formats
      let outputMessages: Array<{ role: string; message: string }> = [];
      
      // Check for output array
      if (response.output && Array.isArray(response.output)) {
        outputMessages = response.output.map((o: any) => ({
          role: o.role || 'assistant',
          message: o.message || o.content || '',
        }));
        console.log(`[VAPI Chat] Found output array with ${outputMessages.length} messages`);
      }
      
      // Check for messages array (fallback)
      if (outputMessages.length === 0 && response.messages && Array.isArray(response.messages)) {
        // Filter for assistant messages only
        outputMessages = response.messages
          .filter((m: any) => m.role === 'assistant' || m.role === 'bot')
          .map((m: any) => ({
            role: 'assistant',
            message: m.message || m.content || '',
          }));
        console.log(`[VAPI Chat] Found messages array with ${outputMessages.length} assistant messages`);
      }

      // Check for direct response text
      if (outputMessages.length === 0 && response.response) {
        outputMessages = [{
          role: 'assistant',
          message: typeof response.response === 'string' ? response.response : JSON.stringify(response.response),
        }];
        console.log(`[VAPI Chat] Found direct response field`);
      }

      // Check for text field
      if (outputMessages.length === 0 && response.text) {
        outputMessages = [{
          role: 'assistant',
          message: response.text,
        }];
        console.log(`[VAPI Chat] Found text field`);
      }

      console.log(`[VAPI Chat] Extracted ${outputMessages.length} output messages:`, outputMessages);

      return {
        id: response.id || 'unknown',
        output: outputMessages,
        messages: response.messages || [],
        sessionId: response.sessionId,
        rawResponse: response,
      };
    } catch (error) {
      console.error('[VAPI Chat] Error sending chat message:', error);
      return null;
    }
  }

  /**
   * Run a multi-turn chat conversation with VAPI assistant
   * Uses the Chat API for text-based testing
   */
  async runChatConversation(
    apiKey: string,
    assistantId: string,
    userMessages: string[]
  ): Promise<{
    success: boolean;
    transcript: Array<{ role: string; content: string; timestamp: number }>;
    error?: string;
  }> {
    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    let previousChatId: string | undefined;
    let sessionId: string | undefined;

    try {
      for (const userMessage of userMessages) {
        // Add user message to transcript
        transcript.push({
          role: 'test_caller',
          content: userMessage,
          timestamp: Date.now(),
        });

        // Send to VAPI Chat API
        const response = await this.chat(apiKey, assistantId, userMessage, {
          sessionId,
          previousChatId,
        });

        if (!response) {
          return {
            success: false,
            transcript,
            error: 'Failed to get response from VAPI Chat API',
          };
        }

        // Track session for conversation continuity
        previousChatId = response.id;
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
        await new Promise(resolve => setTimeout(resolve, 500));
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

export const vapiProvider = new VAPIProvider();
