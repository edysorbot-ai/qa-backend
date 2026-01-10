/**
 * Webhook Routes for Voice Agent Providers
 * 
 * Receives real-time call events from production voice agents.
 * Each provider has its own webhook format.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { realtimeAnalysisService } from '../services/realtime-analysis.service';

const router = Router();

// Store for WebSocket connections (will be set from main app)
let broadcastToUser: ((userId: string, event: string, data: any) => void) | null = null;

export function setWebSocketBroadcast(fn: (userId: string, event: string, data: any) => void) {
  broadcastToUser = fn;
}

/**
 * Helper to find agent and user by provider call details
 */
async function findAgentByProviderCallId(
  provider: string,
  providerAgentId: string
): Promise<{ agentId: string; userId: string; agentConfig: any } | null> {
  // Find agent in our database that matches the provider's agent ID
  const result = await pool.query(
    `SELECT a.id as agent_id, a.user_id, a.config
     FROM agents a
     WHERE a.provider = $1 AND a.provider_agent_id = $2`,
    [provider, providerAgentId]
  );

  if (result.rows.length > 0) {
    return {
      agentId: result.rows[0].agent_id,
      userId: result.rows[0].user_id,
      agentConfig: result.rows[0].config,
    };
  }

  return null;
}

/**
 * Check if monitoring is active for an agent
 */
async function isMonitoringActive(agentId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT is_active FROM monitoring_sessions WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows.length > 0 && result.rows[0].is_active;
}

/**
 * Create a production call record
 */
async function createProductionCall(data: {
  userId: string;
  agentId: string;
  provider: string;
  providerCallId: string;
  callType?: string;
  callerPhone?: string;
  calleePhone?: string;
  status: string;
  startedAt?: Date;
  webhookPayload: any;
}): Promise<string> {
  const result = await pool.query(
    `INSERT INTO production_calls 
     (user_id, agent_id, provider, provider_call_id, call_type, 
      caller_phone, callee_phone, status, started_at, webhook_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (provider_call_id) WHERE provider_call_id IS NOT NULL
     DO UPDATE SET status = $8, webhook_payload = $10, updated_at = NOW()
     RETURNING id`,
    [
      data.userId,
      data.agentId,
      data.provider,
      data.providerCallId,
      data.callType || 'inbound',
      data.callerPhone,
      data.calleePhone,
      data.status,
      data.startedAt || new Date(),
      JSON.stringify(data.webhookPayload),
    ]
  );
  return result.rows[0].id;
}

/**
 * Update production call with completion data
 */
async function completeProductionCall(
  providerCallId: string,
  provider: string,
  data: {
    status: string;
    endedAt?: Date;
    durationSeconds?: number;
    transcript?: any[];
    transcriptText?: string;
    recordingUrl?: string;
  }
): Promise<string | null> {
  const result = await pool.query(
    `UPDATE production_calls 
     SET status = $1, ended_at = $2, duration_seconds = $3,
         transcript = $4, transcript_text = $5, recording_url = $6,
         updated_at = NOW()
     WHERE provider_call_id = $7 AND provider = $8
     RETURNING id, user_id`,
    [
      data.status,
      data.endedAt || new Date(),
      data.durationSeconds,
      JSON.stringify(data.transcript || []),
      data.transcriptText || '',
      data.recordingUrl,
      providerCallId,
      provider,
    ]
  );

  if (result.rows.length > 0) {
    return result.rows[0].id;
  }
  return null;
}

// ============================================
// RETELL WEBHOOK
// ============================================
router.post('/retell', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Webhook:Retell] Received:', payload.event || 'unknown event');

    const event = payload.event;
    const call = payload.call || payload.data?.call || payload;

    if (!call.agent_id) {
      console.log('[Webhook:Retell] No agent_id in payload, skipping');
      return res.status(200).json({ received: true });
    }

    // Find our agent
    const agentInfo = await findAgentByProviderCallId('retell', call.agent_id);
    if (!agentInfo) {
      console.log(`[Webhook:Retell] Agent ${call.agent_id} not found in our system`);
      return res.status(200).json({ received: true });
    }

    // Check if monitoring is active
    if (!(await isMonitoringActive(agentInfo.agentId))) {
      console.log(`[Webhook:Retell] Monitoring not active for agent ${agentInfo.agentId}`);
      return res.status(200).json({ received: true });
    }

    if (event === 'call_started' || event === 'call.started') {
      const callId = await createProductionCall({
        userId: agentInfo.userId,
        agentId: agentInfo.agentId,
        provider: 'retell',
        providerCallId: call.call_id,
        callType: call.direction || 'inbound',
        callerPhone: call.from_number,
        calleePhone: call.to_number,
        status: 'active',
        startedAt: call.start_timestamp ? new Date(call.start_timestamp) : new Date(),
        webhookPayload: payload,
      });

      // Broadcast to frontend
      if (broadcastToUser) {
        broadcastToUser(agentInfo.userId, 'call:started', {
          callId,
          provider: 'retell',
          agentId: agentInfo.agentId,
          callerPhone: call.from_number,
        });
      }
    } else if (event === 'call_ended' || event === 'call.ended' || event === 'call_analyzed') {
      // Parse transcript
      const transcript = (call.transcript_object || call.transcript || []).map((t: any) => ({
        role: t.role === 'agent' ? 'agent' : 'user',
        content: t.content || t.text,
        timestamp: t.timestamp,
      }));

      const transcriptText = transcript
        .map((t: any) => `${t.role}: ${t.content}`)
        .join('\n');

      const callId = await completeProductionCall(call.call_id, 'retell', {
        status: 'completed',
        endedAt: call.end_timestamp ? new Date(call.end_timestamp) : new Date(),
        durationSeconds: call.duration_seconds || call.duration,
        transcript,
        transcriptText,
        recordingUrl: call.recording_url,
      });

      if (callId) {
        // Trigger analysis
        realtimeAnalysisService.processCall(callId).catch(console.error);

        // Broadcast to frontend
        if (broadcastToUser) {
          broadcastToUser(agentInfo.userId, 'call:completed', {
            callId,
            provider: 'retell',
            agentId: agentInfo.agentId,
            duration: call.duration_seconds,
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook:Retell] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// VAPI WEBHOOK
// ============================================
router.post('/vapi', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Webhook:VAPI] Received:', payload.message?.type || 'unknown');

    const messageType = payload.message?.type;
    const call = payload.message?.call || payload.call || payload;

    if (!call.assistantId) {
      console.log('[Webhook:VAPI] No assistantId in payload, skipping');
      return res.status(200).json({ received: true });
    }

    const agentInfo = await findAgentByProviderCallId('vapi', call.assistantId);
    if (!agentInfo) {
      console.log(`[Webhook:VAPI] Agent ${call.assistantId} not found in our system`);
      return res.status(200).json({ received: true });
    }

    if (!(await isMonitoringActive(agentInfo.agentId))) {
      return res.status(200).json({ received: true });
    }

    if (messageType === 'call-started' || messageType === 'status-update' && call.status === 'in-progress') {
      const callId = await createProductionCall({
        userId: agentInfo.userId,
        agentId: agentInfo.agentId,
        provider: 'vapi',
        providerCallId: call.id,
        callType: call.type || 'inbound',
        callerPhone: call.customer?.number,
        calleePhone: call.phoneNumber?.number,
        status: 'active',
        webhookPayload: payload,
      });

      if (broadcastToUser) {
        broadcastToUser(agentInfo.userId, 'call:started', {
          callId,
          provider: 'vapi',
          agentId: agentInfo.agentId,
        });
      }
    } else if (messageType === 'end-of-call-report' || messageType === 'call-ended') {
      const transcript = (call.messages || call.transcript || [])
        .filter((m: any) => m.role === 'assistant' || m.role === 'user')
        .map((m: any) => ({
          role: m.role === 'assistant' ? 'agent' : 'user',
          content: m.message || m.content,
          timestamp: m.time,
        }));

      const transcriptText = transcript
        .map((t: any) => `${t.role}: ${t.content}`)
        .join('\n');

      const callId = await completeProductionCall(call.id, 'vapi', {
        status: 'completed',
        durationSeconds: call.duration || Math.round((call.endedAt - call.startedAt) / 1000),
        transcript,
        transcriptText,
        recordingUrl: call.recordingUrl,
      });

      if (callId) {
        realtimeAnalysisService.processCall(callId).catch(console.error);

        if (broadcastToUser) {
          broadcastToUser(agentInfo.userId, 'call:completed', {
            callId,
            provider: 'vapi',
            agentId: agentInfo.agentId,
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook:VAPI] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// ELEVENLABS WEBHOOK
// ============================================
router.post('/elevenlabs', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Webhook:ElevenLabs] Received:', payload.type || payload.event || 'unknown');

    const event = payload.type || payload.event;
    const data = payload.data || payload;

    if (!data.agent_id) {
      return res.status(200).json({ received: true });
    }

    const agentInfo = await findAgentByProviderCallId('elevenlabs', data.agent_id);
    if (!agentInfo || !(await isMonitoringActive(agentInfo.agentId))) {
      return res.status(200).json({ received: true });
    }

    if (event === 'conversation.started' || event === 'call_started') {
      const callId = await createProductionCall({
        userId: agentInfo.userId,
        agentId: agentInfo.agentId,
        provider: 'elevenlabs',
        providerCallId: data.conversation_id || data.call_id,
        status: 'active',
        webhookPayload: payload,
      });

      if (broadcastToUser) {
        broadcastToUser(agentInfo.userId, 'call:started', {
          callId,
          provider: 'elevenlabs',
          agentId: agentInfo.agentId,
        });
      }
    } else if (event === 'conversation.ended' || event === 'call_ended') {
      const transcript = (data.transcript || []).map((t: any) => ({
        role: t.role === 'ai' || t.role === 'agent' ? 'agent' : 'user',
        content: t.message || t.text,
        timestamp: t.timestamp,
      }));

      const callId = await completeProductionCall(
        data.conversation_id || data.call_id,
        'elevenlabs',
        {
          status: 'completed',
          durationSeconds: data.duration,
          transcript,
          transcriptText: transcript.map((t: any) => `${t.role}: ${t.content}`).join('\n'),
          recordingUrl: data.recording_url,
        }
      );

      if (callId) {
        realtimeAnalysisService.processCall(callId).catch(console.error);

        if (broadcastToUser) {
          broadcastToUser(agentInfo.userId, 'call:completed', {
            callId,
            provider: 'elevenlabs',
            agentId: agentInfo.agentId,
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook:ElevenLabs] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// BOLNA WEBHOOK
// ============================================
router.post('/bolna', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Webhook:Bolna] Received:', payload.event || payload.status || 'unknown');

    const event = payload.event || payload.status;
    const data = payload.data || payload;

    if (!data.agent_id) {
      return res.status(200).json({ received: true });
    }

    const agentInfo = await findAgentByProviderCallId('bolna', data.agent_id);
    if (!agentInfo || !(await isMonitoringActive(agentInfo.agentId))) {
      return res.status(200).json({ received: true });
    }

    if (event === 'call_started' || event === 'in_progress') {
      const callId = await createProductionCall({
        userId: agentInfo.userId,
        agentId: agentInfo.agentId,
        provider: 'bolna',
        providerCallId: data.execution_id || data.call_id,
        callType: data.direction || 'outbound',
        callerPhone: data.from_number,
        calleePhone: data.to_number,
        status: 'active',
        webhookPayload: payload,
      });

      if (broadcastToUser) {
        broadcastToUser(agentInfo.userId, 'call:started', {
          callId,
          provider: 'bolna',
          agentId: agentInfo.agentId,
        });
      }
    } else if (event === 'call_ended' || event === 'completed') {
      const transcript = (data.transcript || data.context_data?.transcript || []).map((t: any) => ({
        role: t.role === 'assistant' || t.role === 'agent' ? 'agent' : 'user',
        content: t.content || t.text,
        timestamp: t.timestamp,
      }));

      const callId = await completeProductionCall(
        data.execution_id || data.call_id,
        'bolna',
        {
          status: 'completed',
          durationSeconds: data.duration || data.call_duration,
          transcript,
          transcriptText: transcript.map((t: any) => `${t.role}: ${t.content}`).join('\n'),
          recordingUrl: data.recording_url || data.telephony_data?.recording_url,
        }
      );

      if (callId) {
        realtimeAnalysisService.processCall(callId).catch(console.error);

        if (broadcastToUser) {
          broadcastToUser(agentInfo.userId, 'call:completed', {
            callId,
            provider: 'bolna',
            agentId: agentInfo.agentId,
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook:Bolna] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================
// LIVEKIT WEBHOOK
// ============================================
router.post('/livekit', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Webhook:LiveKit] Received:', payload.event || 'unknown');

    const event = payload.event;
    const room = payload.room || {};
    const participant = payload.participant || {};

    // LiveKit uses room metadata to identify the agent
    let agentId = null;
    try {
      const metadata = JSON.parse(room.metadata || '{}');
      agentId = metadata.agentId;
    } catch {
      // No metadata
    }

    if (!agentId) {
      return res.status(200).json({ received: true });
    }

    const agentInfo = await findAgentByProviderCallId('livekit', agentId);
    if (!agentInfo || !(await isMonitoringActive(agentInfo.agentId))) {
      return res.status(200).json({ received: true });
    }

    if (event === 'room_started' || event === 'participant_joined') {
      const callId = await createProductionCall({
        userId: agentInfo.userId,
        agentId: agentInfo.agentId,
        provider: 'livekit',
        providerCallId: room.sid || room.name,
        status: 'active',
        webhookPayload: payload,
      });

      if (broadcastToUser) {
        broadcastToUser(agentInfo.userId, 'call:started', {
          callId,
          provider: 'livekit',
          agentId: agentInfo.agentId,
          roomName: room.name,
        });
      }
    } else if (event === 'room_finished') {
      // LiveKit doesn't provide transcript via webhook - would need to use egress
      const callId = await completeProductionCall(room.sid || room.name, 'livekit', {
        status: 'completed',
        durationSeconds: Math.round((Date.now() - room.creation_time) / 1000),
      });

      if (callId) {
        // Note: LiveKit transcript would need to be fetched separately
        if (broadcastToUser) {
          broadcastToUser(agentInfo.userId, 'call:completed', {
            callId,
            provider: 'livekit',
            agentId: agentInfo.agentId,
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Webhook:LiveKit] Error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Health check for webhooks
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', providers: ['retell', 'vapi', 'elevenlabs', 'bolna', 'livekit'] });
});

export default router;
