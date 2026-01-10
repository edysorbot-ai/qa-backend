/**
 * Custom Agent Provider
 * 
 * This provider handles custom agents created in the Agent Builder.
 * It uses OpenRouter for LLM access, giving users access to many models.
 * 
 * Custom agents don't have external API integrations - they run entirely
 * on our platform using configurable LLM models and voice services.
 */

import OpenAI from 'openai';
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
  llmProvider: string; // Now accepts 'openrouter' or specific provider names
  temperature: number;
  maxTokens: number;
  voice?: string;
  knowledgeBase?: string;
  responseStyle?: 'concise' | 'detailed' | 'conversational';
  language?: string;
}

// OpenRouter model info interface
export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
  };
}

export class CustomProvider implements VoiceProviderClient {
  private openrouterClient: OpenAI | null = null;
  private openaiClient: OpenAI | null = null;

  constructor() {
    // Initialize OpenRouter client (primary)
    if (process.env.OPENROUTER_API_KEY) {
      this.openrouterClient = new OpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultHeaders: {
          'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:3000',
          'X-Title': 'Voice QA Platform',
        },
      });
    }
    // Fallback to direct OpenAI if no OpenRouter key
    if (process.env.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
  }

  /**
   * Fetch available models from OpenRouter
   */
  async getAvailableModels(): Promise<OpenRouterModel[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
      });

      if (!response.ok) {
        console.error('[Custom] Failed to fetch OpenRouter models:', response.statusText);
        return this.getDefaultModels();
      }

      const data = await response.json() as { data: OpenRouterModel[] };
      
      // Filter to only include chat/text models, exclude image/audio models
      const chatModels = (data.data || []).filter((model: OpenRouterModel) => {
        const modality = model.architecture?.modality || '';
        // Include text-only models
        return modality.includes('text') || !modality;
      });

      // Sort by name for better UX
      return chatModels.sort((a: OpenRouterModel, b: OpenRouterModel) => 
        a.name.localeCompare(b.name)
      );
    } catch (error) {
      console.error('[Custom] Error fetching OpenRouter models:', error);
      return this.getDefaultModels();
    }
  }

  /**
   * Get default models as fallback
   */
  private getDefaultModels(): OpenRouterModel[] {
    return [
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'Most capable, best for complex tasks', context_length: 128000, pricing: { prompt: '0.0025', completion: '0.01' } },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast and cost-effective', context_length: 128000, pricing: { prompt: '0.00015', completion: '0.0006' } },
      { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Balanced performance', context_length: 128000, pricing: { prompt: '0.01', completion: '0.03' } },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Excellent reasoning', context_length: 200000, pricing: { prompt: '0.003', completion: '0.015' } },
      { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', description: 'Fast and efficient', context_length: 200000, pricing: { prompt: '0.00025', completion: '0.00125' } },
      { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', description: 'Google\'s latest model', context_length: 1000000, pricing: { prompt: '0.00125', completion: '0.005' } },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', description: 'Open source, powerful', context_length: 131072, pricing: { prompt: '0.00035', completion: '0.0004' } },
      { id: 'mistralai/mistral-large', name: 'Mistral Large', description: 'Strong reasoning capabilities', context_length: 128000, pricing: { prompt: '0.002', completion: '0.006' } },
    ];
  }

  /**
   * Get available TTS voices
   * Returns a static list of common voice options
   */
  async getAvailableVoices(): Promise<{ id: string; name: string; language?: string; gender?: string }[]> {
    // For custom agents, we'll use ElevenLabs or browser TTS
    // This is a static list of common voice IDs
    return [
      { id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' },
      { id: 'echo', name: 'Echo', language: 'en', gender: 'male' },
      { id: 'fable', name: 'Fable', language: 'en', gender: 'male' },
      { id: 'onyx', name: 'Onyx', language: 'en', gender: 'male' },
      { id: 'nova', name: 'Nova', language: 'en', gender: 'female' },
      { id: 'shimmer', name: 'Shimmer', language: 'en', gender: 'female' },
      // More natural voices
      { id: 'rachel', name: 'Rachel', language: 'en', gender: 'female' },
      { id: 'drew', name: 'Drew', language: 'en', gender: 'male' },
      { id: 'clyde', name: 'Clyde', language: 'en', gender: 'male' },
      { id: 'paul', name: 'Paul', language: 'en', gender: 'male' },
      { id: 'domi', name: 'Domi', language: 'en', gender: 'female' },
      { id: 'bella', name: 'Bella', language: 'en', gender: 'female' },
      { id: 'antoni', name: 'Antoni', language: 'en', gender: 'male' },
      { id: 'josh', name: 'Josh', language: 'en', gender: 'male' },
      { id: 'arnold', name: 'Arnold', language: 'en', gender: 'male' },
      { id: 'adam', name: 'Adam', language: 'en', gender: 'male' },
      { id: 'sam', name: 'Sam', language: 'en', gender: 'male' },
      { id: 'nicole', name: 'Nicole', language: 'en', gender: 'female' },
      { id: 'glinda', name: 'Glinda', language: 'en', gender: 'female' },
    ];
  }

  /**
   * Validate that we have the necessary API keys configured
   */
  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;
    const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY;

    if (!hasOpenRouter && !hasOpenAI) {
      return {
        valid: false,
        message: 'No LLM provider configured. Please set OPENROUTER_API_KEY or OPENAI_API_KEY.',
      };
    }

    return {
      valid: true,
      message: 'Custom agent services are available',
      details: {
        openrouterAvailable: hasOpenRouter,
        openaiAvailable: hasOpenAI,
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

      // Generate response using OpenRouter (primary) or OpenAI (fallback)
      const responseText = await this.generateLLMResponse(session.messages, config);

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
   * Generate LLM response using OpenRouter or fallback to direct OpenAI
   */
  private async generateLLMResponse(
    messages: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<string> {
    // Use OpenRouter if available (supports all models)
    if (this.openrouterClient) {
      return this.generateOpenRouterResponse(messages, config);
    }
    
    // Fallback to direct OpenAI for OpenAI models only
    if (this.openaiClient && config.llmModel.startsWith('openai/')) {
      return this.generateDirectOpenAIResponse(messages, config);
    }

    throw new Error('No LLM provider available. Please configure OPENROUTER_API_KEY.');
  }

  /**
   * Generate response using OpenRouter (supports all models)
   */
  private async generateOpenRouterResponse(
    messages: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<string> {
    if (!this.openrouterClient) {
      throw new Error('OpenRouter client not initialized');
    }

    const response = await this.openrouterClient.chat.completions.create({
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
   * Generate response using direct OpenAI (fallback)
   */
  private async generateDirectOpenAIResponse(
    messages: ConversationMessage[],
    config: CustomAgentConfig
  ): Promise<string> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized');
    }

    // Strip 'openai/' prefix for direct API
    const modelId = config.llmModel.replace('openai/', '');

    const response = await this.openaiClient.chat.completions.create({
      model: modelId,
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
