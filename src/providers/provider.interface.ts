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
    [key: string]: any;
  };
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

export interface VoiceProviderClient {
  /**
   * Validate the API key and return account details
   */
  validateApiKey(apiKey: string): Promise<ProviderValidationResult>;

  /**
   * List available agents for the account
   */
  listAgents(apiKey: string): Promise<VoiceAgent[]>;

  /**
   * Get details of a specific agent
   */
  getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null>;

  /**
   * Generate TTS audio (if supported)
   */
  textToSpeech?(apiKey: string, request: TTSRequest): Promise<TTSResponse>;

  /**
   * Make a call to the voice agent
   */
  callAgent?(apiKey: string, request: AgentCallRequest): Promise<AgentCallResponse>;
}
