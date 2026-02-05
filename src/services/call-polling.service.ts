/**
 * Call Polling Service
 * 
 * Polls provider APIs at regular intervals to fetch production call history.
 * This is an alternative to webhooks that works with all providers.
 * 
 * Benefits:
 * - No webhook configuration needed
 * - Works with providers that have webhook limitations (e.g., ElevenLabs single webhook)
 * - Unified approach across all providers
 */

import pool from '../db';
import { realtimeAnalysisService } from './realtime-analysis.service';
import { integrationService } from './integration.service';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const RETELL_BASE_URL = 'https://api.retellai.com';
const VAPI_BASE_URL = 'https://api.vapi.ai';

interface ProviderCall {
  provider_call_id: string;
  agent_id: string; // Provider's agent ID
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  transcript: Array<{ role: string; content: string; timestamp?: number }>;
  transcript_text: string;
  recording_url: string | null;
  call_type: string;
  caller_phone: string | null;
  callee_phone: string | null;
  metadata: Record<string, any>;
  call_analysis?: {
    summary?: string;
    sentiment?: string;
    successful?: boolean;
    custom_data?: Record<string, any>;
  };
  latency?: {
    e2e_p50?: number;
    e2e_p90?: number;
    llm_p50?: number;
    tts_p50?: number;
  };
  tool_calls?: Array<{
    name: string;
    arguments: Record<string, any>;
    result?: string;
  }>;
  disconnection_reason?: string;
}

interface PollingResult {
  agentId: string;
  provider: string;
  callsFetched: number;
  newCalls: number;
  errors: string[];
}

class CallPollingService {
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isPolling: Map<string, boolean> = new Map();

  /**
   * Fetch call history from ElevenLabs
   */
  async fetchElevenLabsCalls(
    apiKey: string,
    providerAgentId: string,
    sinceTimestamp?: number
  ): Promise<ProviderCall[]> {
    try {
      const params = new URLSearchParams();
      params.append('agent_id', providerAgentId);
      params.append('page_size', '100');
      
      if (sinceTimestamp) {
        params.append('call_start_after_unix', Math.floor(sinceTimestamp / 1000).toString());
      }

      const response = await fetch(`${ELEVENLABS_BASE_URL}/convai/conversations?${params}`, {
        headers: { 'xi-api-key': apiKey }
      });

      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status}`);
      }

      const data = await response.json() as { conversations?: any[] };
      const calls: ProviderCall[] = [];

      for (const conv of data.conversations || []) {
        // Fetch detailed conversation data
        const detailResponse = await fetch(
          `${ELEVENLABS_BASE_URL}/convai/conversations/${conv.conversation_id}`,
          { headers: { 'xi-api-key': apiKey } }
        );

        if (detailResponse.ok) {
          const detail = await detailResponse.json() as Record<string, any>;
          
          // ElevenLabs always has recordings - we'll use our proxy endpoint
          // Set recording_url to 'proxy' to indicate the frontend should use the proxy endpoint
          const recordingUrl = 'proxy';
          
          // Parse transcript - ElevenLabs may provide full transcript in 'messages' or 'transcript' array
          const transcript: Array<{ role: string; content: string; timestamp?: number }> = [];
          let transcriptText = '';
          
          // Try 'messages' first (often has full content), then fall back to 'transcript'
          const transcriptSource = detail.messages || detail.transcript;
          
          if (transcriptSource && Array.isArray(transcriptSource)) {
            for (const turn of transcriptSource) {
              // ElevenLabs can return message in different fields: message, text, content, or tool_results
              const content = turn.message || turn.text || turn.content || turn.tool_results?.content || '';
              transcript.push({
                role: turn.role === 'agent' ? 'agent' : 'user',
                content,
                timestamp: turn.time_in_call_secs || turn.timestamp
              });
              transcriptText += `${turn.role}: ${content}\n`;
            }
          }

          // Extract tool calls
          const toolCalls = Array.isArray(detail.tool_calls) 
            ? detail.tool_calls.map((tc: any) => ({
                name: tc.tool_name || tc.name,
                arguments: tc.parameters || tc.arguments || {},
                result: tc.result
              }))
            : [];

          calls.push({
            provider_call_id: conv.conversation_id,
            agent_id: conv.agent_id,
            status: conv.status === 'done' ? 'completed' : conv.status,
            started_at: conv.start_time_unix_secs ? new Date(conv.start_time_unix_secs * 1000) : null,
            ended_at: conv.start_time_unix_secs && conv.call_duration_secs 
              ? new Date((conv.start_time_unix_secs + conv.call_duration_secs) * 1000) 
              : null,
            duration_seconds: conv.call_duration_secs || null,
            transcript,
            transcript_text: transcriptText.trim(),
            recording_url: recordingUrl,
            call_type: 'conversation',
            caller_phone: null,
            callee_phone: null,
            metadata: {
              message_count: conv.message_count,
              rating: conv.rating,
              branch_id: conv.branch_id,
              version_id: conv.version_id,
              direction: conv.direction
            },
            call_analysis: {
              summary: conv.transcript_summary || detail.summary,
              successful: conv.call_successful === 'success',
              sentiment: detail.user_sentiment
            },
            tool_calls: toolCalls,
            latency: detail.latency ? {
              e2e_p50: detail.latency.e2e?.p50,
              e2e_p90: detail.latency.e2e?.p90
            } : undefined
          });
        }
      }

      return calls;
    } catch (error) {
      console.error('[CallPolling] ElevenLabs fetch error:', error);
      return [];
    }
  }

  /**
   * Fetch call history from Retell
   */
  async fetchRetellCalls(
    apiKey: string,
    providerAgentId: string,
    sinceTimestamp?: number
  ): Promise<ProviderCall[]> {
    try {
      const body: any = {
        filter_criteria: {
          agent_id: [providerAgentId],
          call_status: ['ended']
        },
        sort_order: 'descending',
        limit: 100
      };

      if (sinceTimestamp) {
        body.filter_criteria.start_timestamp = {
          lower_threshold: sinceTimestamp
        };
      }

      const response = await fetch(`${RETELL_BASE_URL}/v2/list-calls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Retell API error: ${response.status}`);
      }

      const callsData = await response.json() as any[];
      const calls: ProviderCall[] = [];

      for (const call of callsData || []) {
        // Parse transcript
        const transcript: Array<{ role: string; content: string; timestamp?: number }> = [];
        
        if (call.transcript_object && Array.isArray(call.transcript_object)) {
          for (const turn of call.transcript_object) {
            transcript.push({
              role: turn.role,
              content: turn.content,
              timestamp: turn.words?.[0]?.start
            });
          }
        }

        // Extract tool calls from transcript_with_tool_calls
        const toolCalls: Array<{ name: string; arguments: Record<string, any>; result?: string }> = [];
        if (call.transcript_with_tool_calls && Array.isArray(call.transcript_with_tool_calls)) {
          for (const item of call.transcript_with_tool_calls) {
            if (item.tool_call_invocation) {
              toolCalls.push({
                name: item.tool_call_invocation.name,
                arguments: item.tool_call_invocation.arguments || {},
                result: item.tool_call_result
              });
            }
          }
        }

        calls.push({
          provider_call_id: call.call_id,
          agent_id: call.agent_id,
          status: call.call_status,
          started_at: call.start_timestamp ? new Date(call.start_timestamp) : null,
          ended_at: call.end_timestamp ? new Date(call.end_timestamp) : null,
          duration_seconds: call.duration_ms ? Math.round(call.duration_ms / 1000) : null,
          transcript,
          transcript_text: call.transcript || '',
          recording_url: call.recording_url || null,
          call_type: call.call_type || 'phone_call',
          caller_phone: call.from_number || null,
          callee_phone: call.to_number || null,
          metadata: {
            agent_version: call.agent_version,
            dynamic_variables: call.retell_llm_dynamic_variables,
            collected_variables: call.collected_dynamic_variables
          },
          call_analysis: call.call_analysis ? {
            summary: call.call_analysis.call_summary,
            sentiment: call.call_analysis.user_sentiment,
            successful: call.call_analysis.call_successful,
            custom_data: call.call_analysis.custom_analysis_data
          } : undefined,
          latency: call.latency ? {
            e2e_p50: call.latency.e2e?.p50,
            e2e_p90: call.latency.e2e?.p90,
            llm_p50: call.latency.llm?.p50,
            tts_p50: call.latency.tts?.p50
          } : undefined,
          tool_calls: toolCalls,
          disconnection_reason: call.disconnection_reason
        });
      }

      return calls;
    } catch (error) {
      console.error('[CallPolling] Retell fetch error:', error);
      return [];
    }
  }

  /**
   * Fetch call history from VAPI
   */
  async fetchVAPICalls(
    apiKey: string,
    providerAgentId: string,
    sinceTimestamp?: number
  ): Promise<ProviderCall[]> {
    try {
      let url = `${VAPI_BASE_URL}/call?assistantId=${providerAgentId}&limit=100`;
      
      if (sinceTimestamp) {
        url += `&createdAtGte=${new Date(sinceTimestamp).toISOString()}`;
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`VAPI API error: ${response.status}`);
      }

      const callsData = await response.json() as any[];
      const calls: ProviderCall[] = [];

      for (const call of callsData || []) {
        // Only process ended calls
        if (call.status !== 'ended') continue;

        // Parse transcript
        const transcript: Array<{ role: string; content: string; timestamp?: number }> = [];
        let transcriptText = '';

        if (call.messages && Array.isArray(call.messages)) {
          for (const msg of call.messages) {
            if (msg.role === 'assistant' || msg.role === 'user') {
              transcript.push({
                role: msg.role === 'assistant' ? 'agent' : 'user',
                content: msg.content || msg.message || ''
              });
              transcriptText += `${msg.role}: ${msg.content || msg.message || ''}\n`;
            }
          }
        }

        // Extract tool calls
        const toolCalls: Array<{ name: string; arguments: Record<string, any>; result?: string }> = [];
        if (call.messages && Array.isArray(call.messages)) {
          for (const msg of call.messages) {
            if (msg.role === 'tool_calls' && msg.toolCalls && Array.isArray(msg.toolCalls)) {
              for (const tc of msg.toolCalls) {
                toolCalls.push({
                  name: tc.function?.name || tc.name,
                  arguments: tc.function?.arguments || tc.arguments || {},
                  result: tc.result
                });
              }
            }
          }
        }

        calls.push({
          provider_call_id: call.id,
          agent_id: call.assistantId,
          status: call.status,
          started_at: call.startedAt ? new Date(call.startedAt) : null,
          ended_at: call.endedAt ? new Date(call.endedAt) : null,
          duration_seconds: call.startedAt && call.endedAt 
            ? Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000)
            : null,
          transcript,
          transcript_text: transcriptText.trim(),
          recording_url: call.recordingUrl || null,
          call_type: call.type || 'web',
          caller_phone: call.customer?.number || null,
          callee_phone: call.phoneNumber?.number || null,
          metadata: {
            cost: call.cost,
            ended_reason: call.endedReason,
            stereo_recording_url: call.stereoRecordingUrl
          },
          call_analysis: call.analysis ? {
            summary: call.analysis.summary,
            successful: call.analysis.successEvaluation,
            sentiment: call.analysis.userSentiment
          } : undefined,
          tool_calls: toolCalls,
          disconnection_reason: call.endedReason
        });
      }

      return calls;
    } catch (error) {
      console.error('[CallPolling] VAPI fetch error:', error);
      return [];
    }
  }

  /**
   * Poll calls for a specific agent and sync to database
   */
  async pollAgentCalls(agentId: string): Promise<PollingResult> {
    const result: PollingResult = {
      agentId,
      provider: '',
      callsFetched: 0,
      newCalls: 0,
      errors: []
    };

    try {
      // Get agent and integration info
      const agentResult = await pool.query(
        `SELECT a.*, i.provider, i.api_key
         FROM agents a
         JOIN integrations i ON a.integration_id = i.id
         WHERE a.id = $1`,
        [agentId]
      );

      if (agentResult.rows.length === 0) {
        result.errors.push('Agent not found');
        return result;
      }

      const agent = agentResult.rows[0];
      result.provider = agent.provider;
      const apiKey = agent.api_key;
      const providerAgentId = agent.provider_agent_id;

      if (!providerAgentId) {
        result.errors.push('Agent has no provider_agent_id configured');
        return result;
      }

      // Get last polled timestamp for this agent
      const sessionResult = await pool.query(
        `SELECT last_polled_at FROM monitoring_sessions WHERE agent_id = $1`,
        [agentId]
      );
      const lastPolledAt = sessionResult.rows[0]?.last_polled_at;
      const sinceTimestamp = lastPolledAt ? new Date(lastPolledAt).getTime() : undefined;

      // Fetch calls based on provider
      let providerCalls: ProviderCall[] = [];
      
      switch (agent.provider) {
        case 'elevenlabs':
          providerCalls = await this.fetchElevenLabsCalls(apiKey, providerAgentId, sinceTimestamp);
          break;
        case 'retell':
          providerCalls = await this.fetchRetellCalls(apiKey, providerAgentId, sinceTimestamp);
          break;
        case 'vapi':
          providerCalls = await this.fetchVAPICalls(apiKey, providerAgentId, sinceTimestamp);
          break;
        default:
          result.errors.push(`Provider ${agent.provider} not supported for polling`);
          return result;
      }

      result.callsFetched = providerCalls.length;

      // Insert new calls into database
      for (const call of providerCalls) {
        // Check if call already exists
        const existingCall = await pool.query(
          `SELECT id FROM production_calls WHERE provider_call_id = $1 AND agent_id = $2`,
          [call.provider_call_id, agentId]
        );

        if (existingCall.rows.length === 0) {
          // Get user_id from agent
          const userResult = await pool.query(
            `SELECT user_id FROM agents WHERE id = $1`,
            [agentId]
          );
          const userId = userResult.rows[0]?.user_id;

          if (userId) {
            // Insert new call
            const insertResult = await pool.query(
              `INSERT INTO production_calls (
                user_id, agent_id, provider, provider_call_id,
                call_type, caller_phone, callee_phone, status,
                started_at, ended_at, duration_seconds,
                transcript, transcript_text, recording_url,
                analysis_status, webhook_payload
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
              RETURNING id`,
              [
                userId, agentId, agent.provider, call.provider_call_id,
                call.call_type, call.caller_phone, call.callee_phone, call.status,
                call.started_at, call.ended_at, call.duration_seconds,
                JSON.stringify(call.transcript), call.transcript_text, call.recording_url,
                'pending', JSON.stringify({
                  metadata: call.metadata,
                  call_analysis: call.call_analysis,
                  latency: call.latency,
                  tool_calls: call.tool_calls,
                  disconnection_reason: call.disconnection_reason,
                  polled_at: new Date().toISOString()
                })
              ]
            );

            result.newCalls++;

            // Trigger analysis for the new call
            const callId = insertResult.rows[0].id;
            realtimeAnalysisService.processCall(callId).catch(console.error);
          }
        }
      }

      // Update last_polled_at
      await pool.query(
        `UPDATE monitoring_sessions 
         SET last_polled_at = NOW(), updated_at = NOW() 
         WHERE agent_id = $1`,
        [agentId]
      );

      console.log(`[CallPolling] Agent ${agentId}: Fetched ${result.callsFetched} calls, ${result.newCalls} new`);
      return result;
    } catch (error) {
      console.error(`[CallPolling] Error polling agent ${agentId}:`, error);
      result.errors.push(error instanceof Error ? error.message : 'Unknown error');
      return result;
    }
  }

  /**
   * Start automatic polling for an agent
   */
  startPolling(agentId: string, intervalSeconds: number = 30): void {
    // Stop existing polling if any
    this.stopPolling(agentId);

    console.log(`[CallPolling] Starting polling for agent ${agentId} every ${intervalSeconds}s`);

    // Initial poll
    this.pollAgentCalls(agentId).catch(console.error);

    // Set up interval
    const intervalId = setInterval(() => {
      if (!this.isPolling.get(agentId)) {
        this.isPolling.set(agentId, true);
        this.pollAgentCalls(agentId)
          .catch(console.error)
          .finally(() => this.isPolling.set(agentId, false));
      }
    }, intervalSeconds * 1000);

    this.pollingIntervals.set(agentId, intervalId);
  }

  /**
   * Stop automatic polling for an agent
   */
  stopPolling(agentId: string): void {
    const intervalId = this.pollingIntervals.get(agentId);
    if (intervalId) {
      clearInterval(intervalId);
      this.pollingIntervals.delete(agentId);
      this.isPolling.delete(agentId);
      console.log(`[CallPolling] Stopped polling for agent ${agentId}`);
    }
  }

  /**
   * Resume polling for all active sessions on service startup
   */
  async resumeAllPolling(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT agent_id, polling_interval_seconds 
         FROM monitoring_sessions 
         WHERE polling_enabled = true AND is_active = true`
      );

      for (const row of result.rows) {
        this.startPolling(row.agent_id, row.polling_interval_seconds || 30);
      }

      console.log(`[CallPolling] Resumed polling for ${result.rows.length} agents`);
    } catch (error) {
      console.error('[CallPolling] Error resuming polling:', error);
    }
  }

  /**
   * Get polling status for an agent
   */
  getPollingStatus(agentId: string): { isPolling: boolean; intervalActive: boolean } {
    return {
      isPolling: this.isPolling.get(agentId) || false,
      intervalActive: this.pollingIntervals.has(agentId)
    };
  }

  /**
   * Get all active polling sessions
   */
  getActivePollingAgents(): string[] {
    return Array.from(this.pollingIntervals.keys());
  }
}

export const callPollingService = new CallPollingService();
