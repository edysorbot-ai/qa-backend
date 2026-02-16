/**
 * Common interface for all voice agent providers
 */

export interface ProviderValidationResult {
  valid: boolean;
  message: string;
  details?: {
    accountName?: string;
    accountEmail?: string;
    plan?: string;
    creditsRemaining?: number;
    agentsCount?: number;
    concurrencyLimit?: number;  // Max concurrent calls allowed
    currentConcurrency?: number; // Current active calls
    [key: string]: any;
  };
}

export interface ProviderLimits {
  concurrencyLimit: number;  // Max concurrent calls
  currentConcurrency?: number; // Current active calls (if available)
  callDurationLimitMs?: number; // Max call duration
  rateLimitPerMinute?: number; // API rate limit
  characterLimit?: number; // For TTS providers
  source: 'api' | 'plan' | 'default'; // Where the limit came from
}

export interface VoiceAgent {
  id: string;
  name: string;
  provider: string;
  description?: string;
  voice?: string;
  language?: string;
  metadata?: Record<string, any>;
}

export interface TTSRequest {
  text: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
}

export interface TTSResponse {
  audioBuffer: Buffer;
  contentType: string;
  duration?: number;
}

export interface AgentCallRequest {
  agentId: string;
  audioBuffer?: Buffer;
  text?: string;
  sessionId?: string;
  metadata?: Record<string, any>;
}

export interface AgentCallResponse {
  responseAudio?: Buffer;
  responseText?: string;
  transcript?: string;
  detectedIntent?: string;
  sessionId?: string;
  latencyMs?: number;
  metadata?: Record<string, any>;
}

/**
 * Chat API request for text-based testing
 */
export interface ChatRequest {
  agentId: string;
  message: string;
  sessionId?: string;
  previousChatId?: string;
  metadata?: Record<string, any>;
}

/**
 * Chat API response for text-based testing
 */
export interface ChatResponse {
  id: string;
  sessionId?: string;
  output: Array<{ role: string; message: string }>;
  messages?: Array<{ role: string; message: string }>;
  rawResponse?: any;
}

/**
 * Result of a multi-turn chat conversation
 */
export interface ChatConversationResult {
  success: boolean;
  transcript: Array<{ role: string; content: string; timestamp: number }>;
  error?: string;
}

export interface VoiceProviderClient {
  /**
   * Validate the API key and return account details
   */
  validateApiKey(apiKey: string, baseUrl?: string | null): Promise<ProviderValidationResult>;

  /**
   * List available agents for the account
   */
  listAgents(apiKey: string, baseUrl?: string | null): Promise<VoiceAgent[]>;

  /**
   * Get details of a specific agent
   */
  getAgent(apiKey: string, agentId: string, baseUrl?: string | null): Promise<VoiceAgent | null>;

  /**
   * Get provider limits (concurrency, rate limits, etc.)
   */
  getLimits?(apiKey: string, baseUrl?: string | null): Promise<ProviderLimits>;

  /**
   * Generate TTS audio (if supported)
   */
  textToSpeech?(apiKey: string, request: TTSRequest): Promise<TTSResponse>;

  /**
   * Make a call to the voice agent
   */
  callAgent?(apiKey: string, request: AgentCallRequest): Promise<AgentCallResponse>;

  /**
   * Send a text chat message to the agent (for chat-based testing)
   * This is more cost-effective than voice for certain test scenarios
   */
  chat?(
    apiKey: string,
    agentId: string,
    message: string,
    options?: { sessionId?: string; previousChatId?: string }
  ): Promise<ChatResponse | null>;

  /**
   * Run a multi-turn chat conversation with the agent
   * For executing complete test scenarios via chat
   */
  runChatConversation?(
    apiKey: string,
    agentId: string,
    userMessages: string[]
  ): Promise<ChatConversationResult>;

  /**
   * Check if this provider supports chat-based testing
   */
  supportsChatTesting?(): boolean;
}
