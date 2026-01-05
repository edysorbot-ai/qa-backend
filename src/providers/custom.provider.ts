/**
 * Custom Agent Provider
 * 
 * This provider handles custom agents created in the Agent Builder.
 * It uses our own LLM, TTS, and STT services to simulate voice conversations.
 * 
 * Custom agents don't have external API integrations - they run entirely
 * on our platform using configurable LLM models and voice services.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
  ChatResponse,
  ChatConversationResult,
} from './provider.interface';

// Conversation history for maintaining context
interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Session storage for multi-turn conversations
const conversationSessions: Map<string, {
  messages: ConversationMessage[];
  config: CustomAgentConfig;
  createdAt: Date;
}> = new Map();

// Clean up old sessions every hour
setInterval(() => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [sessionId, session] of conversationSessions) {
    if (session.createdAt < oneHourAgo) {
      conversationSessions.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);

export interface CustomAgentConfig {
  name: string;
  description?: string;
  systemPrompt: string;
  startingMessage?: string;
  llmModel: string;
  llmProvider: 'openai' | 'anthropic';
  temperature: number;
  maxTokens: number;
  voice?: string;
  knowledgeBase?: string;
  responseStyle?: 'concise' | 'detailed' | 'conversational';
  language?: string;
}

export class CustomProvider implements VoiceProviderClient {
  private openai: OpenAI | null = null;
  private anthropic: Anthropic | null = null;

  constructor() {
    // Initialize clients if API keys are available
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  /**
   * Validate that we have the necessary API keys configured
   */
  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    // For custom agents, we validate that the platform has the required services configured
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
    const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY;

    if (!hasOpenAI && !hasAnthropic) {
      return {
        valid: false,
        message: 'No LLM provider configured. Please set OPENAI_API_KEY or ANTHROPIC_API_KEY.',
      };
    }

    return {
      valid: true,
      message: 'Custom agent services are available',
      details: {
        openaiAvailable: hasOpenAI,
        anthropicAvailable: hasAnthropic,
        sttAvailable: hasDeepgram,
        ttsAvailable: hasElevenLabs,
        plan: 'Custom Agent',
      },
    };
  }

  /**
   * List custom agents - handled by agent service, not provider
   */
  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    // Custom agents are stored in our database, not from external provider
    return [];
  }

  /**
   * Get custom agent details from config
   */
  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    // Agent details come from our database
    return null;
  }

  /**
   * Get provider limits
   */
  async getLimits(apiKey: string): Promise<ProviderLimits> {
    return {
      concurrencyLimit: 10, // Default concurrent simulations
      rateLimitPerMinute: 60,
      source: 'default',
    };
  }

  /**
   * Check if chat testing is supported
   */
  supportsChatTesting(): boolean {
    return true;
  }

  /**
   * Send a chat message to the custom agent
   */
  async chat(
    apiKey: string,
    agentId: string,
    message: string,
    options?: { sessionId?: string; config?: CustomAgentConfig }
  ): Promise<ChatResponse | null> {
    const config = options?.config;
    if (!config) {
      console.error('[Custom] No config provided for chat');
      return null;
    }

    const sessionId = options?.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Get or create session
      let session = conversationSessions.get(sessionId);
      if (!session) {
        // Build system prompt with knowledge base
        let fullSystemPrompt = config.systemPrompt;
        if (config.knowledgeBase) {
          fullSystemPrompt += `\n\n--- Knowledge Base ---\n${config.knowledgeBase}`;
        }
        if (config.responseStyle) {
          const styleInstructions: Record<string, string> = {
            concise: '\n\nKeep responses brief and to the point.',
            detailed: '\n\nProvide comprehensive and detailed responses.',
            conversational: '\n\nRespond in a natural, conversational manner.',
          };
          fullSystemPrompt += styleInstructions[config.responseStyle] || '';
        }

        session = {
          messages: [{ role: 'system', content: fullSystemPrompt }],
          config,
          createdAt: new Date(),
        };
        
        // Add starting message if this is a new conversation
        if (config.startingMessage) {
          session.messages.push({ role: 'assistant', content: config.startingMessage });
        }
        
        conversationSessions.set(sessionId, session);
      }

      // Add user message
      session.messages.push({ role: 'user', content: message });

      // Generate response based on provider
      let responseText: string;
      
      if (config.llmProvider === 'anthropic' && this.anthropic) {
        responseText = await this.generateAnthropicResponse(session.messages, config);
      } else if (this.openai) {
        responseText = await this.generateOpenAIResponse(session.messages, config);
      } else {
        throw new Error('No LLM provider available');
      }

      // Add assistant response to history
      session.messages.push({ role: 'assistant', content: responseText });

      return {
        id: `msg_${Date.now()}`,
        sessionId,
        output: [{ role: 'assistant', message: responseText }],
        messages: session.messages.slice(1).map(m => ({ role: m.role, message: m.content })),
      };
    } catch (error) {
      console.error('[Custom] Chat error:', error);
      return null;
    }
  }

  /**
   * Run a multi-turn chat conversation
   */
  async runChatConversation(
    apiKey: string,
    agentId: string,
    userMessages: string[],
    config?: CustomAgentConfig
  ): Promise<ChatConversationResult> {
    if (!config) {
      return {
        success: false,
        transcript: [],
        error: 'No agent configuration provided',
      };
    }

    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    const sessionId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Add starting message if present
      if (config.startingMessage) {
        transcript.push({
          role: 'assistant',
          content: config.startingMessage,
          timestamp: Date.now(),
        });
      }

      // Process each user message
      for (const userMessage of userMessages) {
        transcript.push({
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        });

        const response = await this.chat(apiKey, agentId, userMessage, { sessionId, config });
        
        if (response && response.output.length > 0) {
          transcript.push({
            role: 'assistant',
            content: response.output[0].message,
            timestamp: Date.now(),
          });
        } else {
          return {
            success: false,
            transcript,
            error: 'Failed to get agent response',
          };
        }
      }

      // Clean up session
      conversationSessions.delete(sessionId);

      return {
        success: true,
        transcript,
      };
    } catch (error) {
      conversationSessions.delete(sessionId);
      return {
        success: false,
        transcript,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate response using OpenAI
   */
  private async generateOpenAIResponse(
    messages: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await this.openai.chat.completions.create({
      model: config.llmModel,
      messages: messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      })),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    });

    return response.choices[0]?.message?.content || 'I apologize, I could not generate a response.';
  }

  /**
   * Generate response using Anthropic
   */
  private async generateAnthropicResponse(
    messages: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<string> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    // Extract system message and convert others to Anthropic format
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.anthropic.messages.create({
      model: config.llmModel,
      max_tokens: config.maxTokens,
      system: systemMessage,
      messages: conversationMessages,
    });

    const textContent = response.content.find((c: { type: string }) => c.type === 'text') as { type: 'text'; text: string } | undefined;
    return textContent?.text || 'I apologize, I could not generate a response.';
  }

  /**
   * Simulate a voice conversation (uses TTS/STT services externally)
   * Returns the text response - caller handles TTS conversion
   */
  async simulateVoiceResponse(
    config: CustomAgentConfig,
    userTranscript: string,
    sessionId?: string
  ): Promise<{ responseText: string; sessionId: string }> {
    const sid = sessionId || `voice_${Date.now()}`;
    
    const response = await this.chat('custom', 'custom-agent', userTranscript, {
      sessionId: sid,
      config,
    });

    if (!response) {
      throw new Error('Failed to generate response');
    }

    return {
      responseText: response.output[0]?.message || '',
      sessionId: sid,
    };
  }
}

export const customProvider = new CustomProvider();
