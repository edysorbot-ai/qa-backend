/**
 * Bolna AI Voice Agent Provider
 * Documentation: https://www.bolna.ai/docs/api-reference
 * 
 * Bolna is a voice AI platform for creating conversational agents.
 * - Base URL: https://api.bolna.ai
 * - Authentication: Bearer token
 * - Supports: Agent management, outbound calls, execution/call data
 */

import {
  VoiceProviderClient,
  ProviderValidationResult,
  ProviderLimits,
  VoiceAgent,
  ChatRequest,
  ChatResponse,
  ChatConversationResult,
} from './provider.interface';

const BOLNA_BASE_URL = 'https://api.bolna.ai';

// Bolna Agent structure from API
interface BolnaAgent {
  id: string;
  agent_name: string;
  agent_type?: string;
  agent_status?: 'seeding' | 'processed';
  created_at?: string;
  updated_at?: string;
  tasks?: BolnaTask[];
  agent_prompts?: Record<string, { system_prompt?: string }>;
  ingest_source_config?: {
    source_type?: string;
    source_url?: string;
    source_auth_token?: string;
    source_name?: string;
  };
}

interface BolnaTask {
  task_type?: string;
  tools_config?: {
    llm_agent?: {
      agent_type?: string;
      agent_flow_type?: string;
      model?: string;
      provider?: string;
      temperature?: number;
      max_tokens?: number;
      llm_config?: {
        model?: string;
        provider?: string;
        temperature?: number;
        max_tokens?: number;
      };
      routes?: any;
    };
    synthesizer?: {
      provider?: string;
      provider_config?: {
        voice?: string;
        voice_id?: string;
        model?: string;
      };
      stream?: boolean;
      buffer_size?: number;
      audio_format?: string;
    };
    transcriber?: {
      provider?: string;
      model?: string;
      language?: string;
      stream?: boolean;
      sampling_rate?: number;
      encoding?: string;
      endpointing?: number;
    };
    input?: { provider?: string; format?: string };
    output?: { provider?: string; format?: string };
    api_tools?: any;
  };
  toolchain?: {
    execution?: string;
    pipelines?: string[][];
  };
  task_config?: {
    hangup_after_silence?: number;
    incremental_delay?: number;
    number_of_words_for_interruption?: number;
    hangup_after_LLMCall?: boolean;
    call_cancellation_prompt?: string | null;
    backchanneling?: boolean;
    backchanneling_message_gap?: number;
    backchanneling_start_delay?: number;
    ambient_noise?: boolean;
    ambient_noise_track?: string;
    call_terminate?: number;
    voicemail?: boolean;
    inbound_limit?: number;
    whitelist_phone_numbers?: string[] | null;
    disallow_unknown_numbers?: boolean;
  };
}

// Bolna Execution (Call) structure
interface BolnaExecution {
  id: string;
  agent_id: string;
  batch_id?: string;
  conversation_time?: number;
  total_cost?: number;
  status: 'completed' | 'call-disconnected' | 'no-answer' | 'busy' | 'failed' | 'in-progress' | 'canceled' | 'balance-low' | 'queued' | 'ringing' | 'initiated';
  error_message?: string;
  answered_by_voice_mail?: boolean;
  transcript?: string;
  created_at?: string;
  updated_at?: string;
  cost_breakdown?: {
    llm?: number;
    network?: number;
    platform?: number;
    synthesizer?: number;
    transcriber?: number;
  };
  telephony_data?: {
    duration?: number;
    to_number?: string;
    from_number?: string;
    recording_url?: string;
    hosted_telephony?: boolean;
    provider_call_id?: string;
    call_type?: string;
    provider?: string;
    hangup_by?: string;
    hangup_reason?: string;
    hangup_provider_code?: number;
  };
  extracted_data?: Record<string, any>;
  context_details?: Record<string, any>;
}

// Bolna Call initiation response
interface BolnaCallResponse {
  message: string;
  status: 'queued' | string;
  execution_id: string;
}

export class BolnaProvider implements VoiceProviderClient {
  private async request<T>(
    apiKey: string,
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${BOLNA_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bolna API error (${response.status}): ${error}`);
    }

    return response.json() as T;
  }

  async validateApiKey(apiKey: string): Promise<ProviderValidationResult> {
    try {
      // List agents to validate the key
      const agents = await this.request<BolnaAgent[]>(apiKey, '/v2/agent/all');

      return {
        valid: true,
        message: 'Bolna API key is valid',
        details: {
          accountName: 'Bolna AI Account',
          agentsCount: agents.length,
          plan: 'Active',
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        message: `Invalid Bolna API key: ${message}`,
      };
    }
  }

  async listAgents(apiKey: string): Promise<VoiceAgent[]> {
    try {
      const agents = await this.request<BolnaAgent[]>(apiKey, '/v2/agent/all');

      return agents.map((agent) => {
        // Extract system prompt from agent_prompts
        const firstTaskPrompt = agent.agent_prompts?.task_1?.system_prompt || '';
        
        // Get voice and language from tasks
        const task = agent.tasks?.[0];
        const voice = task?.tools_config?.synthesizer?.provider_config?.voice || 
                     task?.tools_config?.synthesizer?.provider_config?.voice_id;
        const language = task?.tools_config?.transcriber?.language;
        const voiceProvider = task?.tools_config?.synthesizer?.provider;
        const llmModel = task?.tools_config?.llm_agent?.llm_config?.model || 
                        task?.tools_config?.llm_agent?.model;

        return {
          id: agent.id,
          name: agent.agent_name,
          provider: 'bolna',
          description: firstTaskPrompt?.substring(0, 200),
          voice: voice,
          language: language,
          metadata: {
            agentType: agent.agent_type,
            agentStatus: agent.agent_status,
            voiceProvider: voiceProvider,
            llmModel: llmModel,
            createdAt: agent.created_at,
            updatedAt: agent.updated_at,
            prompt: firstTaskPrompt,
          },
        };
      });
    } catch (error) {
      console.error('Error listing Bolna agents:', error);
      return [];
    }
  }

  async getAgent(apiKey: string, agentId: string): Promise<VoiceAgent | null> {
    try {
      const agent = await this.request<BolnaAgent>(
        apiKey,
        `/v2/agent/${agentId}`
      );

      console.log(`[Bolna] Agent response for ${agentId}:`, JSON.stringify(agent, null, 2));

      // Extract all task prompts
      const taskPrompts: { taskId: string; prompt: string }[] = [];
      if (agent.agent_prompts) {
        for (const [taskId, taskData] of Object.entries(agent.agent_prompts)) {
          if (taskData.system_prompt) {
            taskPrompts.push({ taskId, prompt: taskData.system_prompt });
          }
        }
      }

      // Get primary system prompt
      const primaryPrompt = agent.agent_prompts?.task_1?.system_prompt || 
                           taskPrompts[0]?.prompt || '';

      // Get voice and language from tasks
      const task = agent.tasks?.[0];
      const voice = task?.tools_config?.synthesizer?.provider_config?.voice || 
                   task?.tools_config?.synthesizer?.provider_config?.voice_id;
      const language = task?.tools_config?.transcriber?.language;
      const voiceProvider = task?.tools_config?.synthesizer?.provider;
      const llmProvider = task?.tools_config?.llm_agent?.llm_config?.provider ||
                         task?.tools_config?.llm_agent?.provider;
      const llmModel = task?.tools_config?.llm_agent?.llm_config?.model || 
                      task?.tools_config?.llm_agent?.model;

      return {
        id: agent.id,
        name: agent.agent_name,
        provider: 'bolna',
        description: primaryPrompt?.substring(0, 200),
        voice: voice,
        language: language,
        metadata: {
          agentType: agent.agent_type,
          agentStatus: agent.agent_status,
          voiceProvider: voiceProvider,
          llmProvider: llmProvider,
          llmModel: llmModel,
          createdAt: agent.created_at,
          updatedAt: agent.updated_at,
          prompt: primaryPrompt,
          taskPrompts: taskPrompts,
          tasks: agent.tasks,
          ingestSourceConfig: agent.ingest_source_config,
        },
      };
    } catch (error) {
      console.error('Error getting Bolna agent:', error);
      return null;
    }
  }

  async getLimits(apiKey: string): Promise<ProviderLimits> {
    // Bolna doesn't expose limits via API, return defaults
    return {
      concurrencyLimit: 10,
      source: 'default',
    };
  }

  /**
   * Initiate an outbound call using Bolna
   * This is used for real voice testing
   */
  async initiateCall(
    apiKey: string,
    agentId: string,
    recipientPhoneNumber: string,
    fromPhoneNumber?: string,
    userData?: Record<string, any>
  ): Promise<BolnaCallResponse> {
    const payload: any = {
      agent_id: agentId,
      recipient_phone_number: recipientPhoneNumber,
    };

    if (fromPhoneNumber) {
      payload.from_phone_number = fromPhoneNumber;
    }

    if (userData) {
      payload.user_data = userData;
    }

    return this.request<BolnaCallResponse>(apiKey, '/call', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Get execution (call) details
   */
  async getExecution(apiKey: string, executionId: string): Promise<BolnaExecution | null> {
    try {
      return await this.request<BolnaExecution>(
        apiKey,
        `/executions/${executionId}`
      );
    } catch (error) {
      console.error('Error getting Bolna execution:', error);
      return null;
    }
  }

  /**
   * Get all executions for an agent
   */
  async getAgentExecutions(apiKey: string, agentId: string): Promise<BolnaExecution[]> {
    try {
      return await this.request<BolnaExecution[]>(
        apiKey,
        `/v2/agent/${agentId}/executions`
      );
    } catch (error) {
      console.error('Error getting Bolna agent executions:', error);
      return [];
    }
  }

  /**
   * Poll for execution completion
   */
  async waitForExecutionComplete(
    apiKey: string,
    executionId: string,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 2000
  ): Promise<BolnaExecution | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const execution = await this.getExecution(apiKey, executionId);
      
      if (!execution) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      // Check if call is complete
      const terminalStatuses = ['completed', 'call-disconnected', 'no-answer', 'busy', 'failed', 'canceled'];
      if (terminalStatuses.includes(execution.status)) {
        return execution;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    console.error(`[Bolna] Execution ${executionId} timed out after ${timeoutMs}ms`);
    return null;
  }

  /**
   * Parse transcript from execution
   */
  parseTranscript(execution: BolnaExecution): Array<{ role: string; content: string; timestamp: number }> {
    const transcript: Array<{ role: string; content: string; timestamp: number }> = [];
    
    if (!execution.transcript) {
      return transcript;
    }

    // Bolna transcript format varies - try to parse it
    // Common format: "Agent: Hello... User: Hi..."
    const lines = execution.transcript.split('\n');
    let currentTime = Date.now();
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      if (trimmedLine.toLowerCase().startsWith('agent:') || trimmedLine.toLowerCase().startsWith('assistant:')) {
        const content = trimmedLine.replace(/^(agent|assistant):\s*/i, '');
        transcript.push({ role: 'ai_agent', content, timestamp: currentTime });
      } else if (trimmedLine.toLowerCase().startsWith('user:') || trimmedLine.toLowerCase().startsWith('human:')) {
        const content = trimmedLine.replace(/^(user|human):\s*/i, '');
        transcript.push({ role: 'test_caller', content, timestamp: currentTime });
      } else {
        // If no prefix, assume it's part of the previous speaker or agent
        if (transcript.length > 0) {
          transcript[transcript.length - 1].content += ' ' + trimmedLine;
        } else {
          transcript.push({ role: 'ai_agent', content: trimmedLine, timestamp: currentTime });
        }
      }
      currentTime += 1000;
    }

    return transcript;
  }

  /**
   * Bolna currently doesn't have a direct chat API for testing
   * This is a placeholder for future implementation
   */
  supportsChatTesting(): boolean {
    return false;
  }
}

// Export singleton instance
export const bolnaProvider = new BolnaProvider();
