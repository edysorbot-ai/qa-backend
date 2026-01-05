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
    workflow_id?: string;
    conversation_flow_id?: string;
    version?: number;
  };
  last_modification_timestamp?: number;
}

// Retell Workflow (Conversation Flow) structure - for retell-llm-workflow type
interface RetellWorkflow {
  workflow_id: string;
  name?: string;
  global_prompt?: string;
  nodes?: Array<{
    node_id: string;
    name: string;
    prompt?: string;
    type?: string;
  }>;
  edges?: Array<{
    from_node_id: string;
    to_node_id: string;
    condition?: string;
  }>;
  version?: number;
  last_modification_timestamp?: number;
}

// Retell Conversation Flow structure - for conversation-flow type (newer API)
interface RetellConversationFlow {
  conversation_flow_id: string;
  name?: string;
  nodes?: Array<{
    id: string;
    name?: string;
    type: string;
    content?: {
      text?: string;
      prompt?: string;
    };
    data?: any;
  }>;
  edges?: Array<{
    source: string;
    target: string;
    condition?: string;
  }>;
  global_prompt?: string;
  starting_node_id?: string;
  version?: number;
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

      console.log(`[Retell] Agent response for ${agentId}:`, JSON.stringify(agent, null, 2));
      console.log(`[Retell] Response engine type: ${agent.response_engine?.type}`);

      // Variables to store prompt information
      let llmDetails: RetellLLM | null = null;
      let workflowDetails: RetellWorkflow | null = null;
      let fullPrompt: string | undefined;
      let statePrompts: Array<{ name: string; prompt: string }> | undefined;

      const responseEngineType = agent.response_engine?.type;

      // Handle different response engine types
      if (responseEngineType === 'retell-llm' && agent.response_engine?.llm_id) {
        // Standard LLM-based agent
        console.log(`[Retell] Fetching LLM details for llm_id: ${agent.response_engine.llm_id}`);
        try {
          llmDetails = await this.request<RetellLLM>(
            apiKey,
            `/get-retell-llm/${agent.response_engine.llm_id}`
          );
          console.log(`[Retell] LLM details:`, JSON.stringify(llmDetails, null, 2));
          fullPrompt = llmDetails?.general_prompt;
          
          // Extract state prompts if available (multi-prompt agent)
          if (llmDetails?.states && Array.isArray(llmDetails.states)) {
            statePrompts = llmDetails.states.map((state: any) => ({
              name: state.name,
              prompt: state.state_prompt || '',
            }));
          }
        } catch (e) {
          console.error('[Retell] Error fetching LLM details:', e);
        }
      } else if (responseEngineType === 'retell-llm-workflow' && agent.response_engine?.workflow_id) {
        // Workflow/Conversation Flow based agent (Flex Mode)
        console.log(`[Retell] Fetching workflow details for workflow_id: ${agent.response_engine.workflow_id}`);
        try {
          workflowDetails = await this.request<RetellWorkflow>(
            apiKey,
            `/get-retell-llm-workflow/${agent.response_engine.workflow_id}`
          );
          console.log(`[Retell] Workflow details:`, JSON.stringify(workflowDetails, null, 2));
          fullPrompt = workflowDetails?.global_prompt;
          
          // Extract node prompts
          if (workflowDetails?.nodes && Array.isArray(workflowDetails.nodes)) {
            statePrompts = workflowDetails.nodes
              .filter((node: any) => node.prompt)
              .map((node: any) => ({
                name: node.name || node.node_id,
                prompt: node.prompt || '',
              }));
          }
        } catch (e) {
          console.error('[Retell] Error fetching workflow details:', e);
          // Workflow API might not be available - try to get LLM directly
          if (agent.response_engine?.llm_id) {
            try {
              llmDetails = await this.request<RetellLLM>(
                apiKey,
                `/get-retell-llm/${agent.response_engine.llm_id}`
              );
              fullPrompt = llmDetails?.general_prompt;
            } catch (e2) {
              console.error('[Retell] Fallback LLM fetch also failed:', e2);
            }
          }
        }
      } else if (agent.response_engine?.llm_id) {
        // Fallback: any response engine with llm_id
        console.log(`[Retell] Fallback: Fetching LLM for unknown type ${responseEngineType}, llm_id: ${agent.response_engine.llm_id}`);
        try {
          llmDetails = await this.request<RetellLLM>(
            apiKey,
            `/get-retell-llm/${agent.response_engine.llm_id}`
          );
          console.log(`[Retell] Fallback LLM details:`, JSON.stringify(llmDetails, null, 2));
          fullPrompt = llmDetails?.general_prompt;
          
          if (llmDetails?.states && Array.isArray(llmDetails.states)) {
            statePrompts = llmDetails.states.map((state: any) => ({
              name: state.name,
              prompt: state.state_prompt || '',
            }));
          }
        } catch (e) {
          console.error('[Retell] Error fetching fallback LLM:', e);
        }
      } else if (responseEngineType === 'conversation-flow' && agent.response_engine?.conversation_flow_id) {
        // Conversation Flow based agent (newer API - version 2)
        const conversationFlowId = agent.response_engine.conversation_flow_id;
        console.log(`[Retell] Fetching conversation flow details for conversation_flow_id: ${conversationFlowId}`);
        try {
          const conversationFlow = await this.request<RetellConversationFlow>(
            apiKey,
            `/get-conversation-flow/${conversationFlowId}`
          );
          console.log(`[Retell] Conversation flow details:`, JSON.stringify(conversationFlow, null, 2));
          
          // Extract global prompt
          fullPrompt = conversationFlow?.global_prompt || '';
          
          // Extract node prompts/content
          if (conversationFlow?.nodes && Array.isArray(conversationFlow.nodes)) {
            statePrompts = conversationFlow.nodes
              .filter((node: any) => node.content?.prompt || node.content?.text || node.data?.prompt)
              .map((node: any) => ({
                name: node.name || node.id || node.type,
                prompt: node.content?.prompt || node.content?.text || node.data?.prompt || '',
              }));
          }
        } catch (e) {
          console.error('[Retell] Error fetching conversation flow details:', e);
          // Try alternative endpoint
          try {
            console.log(`[Retell] Trying alternative conversation flow endpoint...`);
            const conversationFlow = await this.request<RetellConversationFlow>(
              apiKey,
              `/conversation-flow/${conversationFlowId}`
            );
            fullPrompt = conversationFlow?.global_prompt || '';
            if (conversationFlow?.nodes && Array.isArray(conversationFlow.nodes)) {
              statePrompts = conversationFlow.nodes
                .filter((node: any) => node.content?.prompt || node.content?.text || node.data?.prompt)
                .map((node: any) => ({
                  name: node.name || node.id || node.type,
                  prompt: node.content?.prompt || node.content?.text || node.data?.prompt || '',
                }));
            }
          } catch (e2) {
            console.error('[Retell] Alternative conversation flow fetch also failed:', e2);
            
            // If we can't fetch the flow, try to construct a meaningful description from post_call_analysis_data
            if (agent.post_call_analysis_data && agent.post_call_analysis_data.length > 0) {
              console.log(`[Retell] Using post_call_analysis_data to construct prompt context`);
              const questions = agent.post_call_analysis_data
                .filter((item: any) => item.name && item.type !== 'number')
                .map((item: any) => {
                  let description = `Question: ${item.name}`;
                  if (item.choices && Array.isArray(item.choices)) {
                    description += `\nOptions: ${item.choices.join(', ')}`;
                  }
                  return description;
                });
              
              if (questions.length > 0) {
                fullPrompt = `This is a patient screening voice agent. The agent asks the following questions:\n\n${questions.join('\n\n')}`;
                statePrompts = agent.post_call_analysis_data
                  .filter((item: any) => item.name)
                  .map((item: any) => ({
                    name: item.name,
                    prompt: item.choices ? `Options: ${item.choices.join(', ')}` : item.description || '',
                  }));
              }
            }
          }
        }
      } else {
        console.log(`[Retell] No LLM or workflow ID found. Response engine:`, JSON.stringify(agent.response_engine, null, 2));
        
        // If we have post_call_analysis_data but no prompt source, construct from that
        if (agent.post_call_analysis_data && agent.post_call_analysis_data.length > 0) {
          console.log(`[Retell] Constructing prompt context from post_call_analysis_data`);
          const questions = agent.post_call_analysis_data
            .filter((item: any) => item.name && item.type !== 'number')
            .map((item: any) => {
              let description = `Question: ${item.name}`;
              if (item.choices && Array.isArray(item.choices)) {
                description += `\nOptions: ${item.choices.join(', ')}`;
              }
              return description;
            });
          
          if (questions.length > 0) {
            fullPrompt = `Voice agent screening questions:\n\n${questions.join('\n\n')}`;
            statePrompts = agent.post_call_analysis_data
              .filter((item: any) => item.name)
              .map((item: any) => ({
                name: item.name,
                prompt: item.choices ? `Options: ${item.choices.join(', ')}` : item.description || '',
              }));
          }
        }
      }

      // Build combined prompt from all sources
      let combinedPrompt = fullPrompt || '';
      if (statePrompts && statePrompts.length > 0) {
        combinedPrompt += '\n\n--- State/Node Prompts ---\n';
        statePrompts.forEach((sp) => {
          combinedPrompt += `\n[${sp.name}]\n${sp.prompt}\n`;
        });
      }

      console.log(`[Retell] Final prompt length: ${combinedPrompt.length} chars`);

      return {
        id: agent.agent_id,
        name: agent.agent_name,
        provider: 'retell',
        description: (fullPrompt || combinedPrompt)?.substring(0, 200),
        voice: agent.voice_id,
        language: agent.language,
        metadata: {
          voiceTemperature: agent.voice_temperature,
          voiceSpeed: agent.voice_speed,
          responsiveness: agent.responsiveness,
          webhookUrl: agent.webhook_url,
          responseEngineType: responseEngineType,
          llmId: agent.response_engine?.llm_id,
          workflowId: agent.response_engine?.workflow_id,
          conversationFlowId: agent.response_engine?.conversation_flow_id,
          llmModel: llmDetails?.model,
          beginMessage: llmDetails?.begin_message,
          fullPrompt: combinedPrompt || fullPrompt,
          statePrompts: statePrompts,
          tools: llmDetails?.general_tools,
          states: llmDetails?.states,
          startingState: llmDetails?.starting_state,
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

  /**
   * Check if this provider supports chat-based testing
   * 
   * RETELL LIMITATION: Retell does NOT provide a public API for chat-based testing of voice agents.
   * Their testing options are:
   * 1. Dashboard LLM Playground (manual, no API)
   * 2. Dashboard Batch Test (predefined cases, no public API)
   * 3. Actual calls (Web Call / Phone Call API)
   * 
   * For Retell, use voice-based testing (Web Call) instead.
   */
  supportsChatTesting(): boolean {
    return false;
  }

  /**
   * Chat method - NOT SUPPORTED for Retell voice agents
   * 
   * Retell does not expose a public API for text-based interaction with voice agents.
   * Use voice-based testing (Web Call API) instead.
   * 
   * @returns null - chat testing not available
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
    console.log(`[Retell Chat] Chat-based testing is NOT SUPPORTED for Retell voice agents.`);
    console.log(`[Retell Chat] Retell does not provide a public API for text-based interaction.`);
    console.log(`[Retell Chat] Please use voice-based testing (Web Call) for Retell agents.`);
    return null;
  }

  /**
   * Run a multi-turn chat conversation - NOT SUPPORTED for Retell
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
    return {
      success: false,
      transcript: [],
      error: 'Chat-based testing is not supported for Retell voice agents. Please use voice-based testing.',
    };
  }
}

export const retellProvider = new RetellProvider();
