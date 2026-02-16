/**
 * Monitoring Routes
 * 
 * API endpoints for real-time monitoring management
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { realtimeAnalysisService } from '../services/realtime-analysis.service';
import { callPollingService } from '../services/call-polling.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { deductCredits, FeatureKeys, getFeatureCreditCost } from '../middleware/credits.middleware';
import crypto from 'crypto';

const router = Router();

// Authenticated request type
interface AuthenticatedRequest extends Request {
  auth?: { userId: string };
}

// Helper to get the effective user ID from Clerk auth
async function getEffectiveUserId(req: AuthenticatedRequest): Promise<string> {
  const clerkUserId = req.auth?.userId;
  if (!clerkUserId) throw new Error('Not authenticated');
  
  const user = await userService.findOrCreateByClerkId(clerkUserId);
  return await teamMemberService.getOwnerUserId(user.id);
}

/**
 * Get webhook setup instructions for a provider
 */
const WEBHOOK_INSTRUCTIONS: Record<string, {
  title: string;
  steps: string[];
  docsUrl?: string;
  webhookLocation: string;
  jsonConfig?: object;
  useWebhookTool?: boolean;
}> = {
  retell: {
    title: 'Retell AI Webhook Setup',
    steps: [
      '1. Go to your Retell AI dashboard (retellai.com)',
      '2. Navigate to Settings → Webhooks',
      '3. Add a new webhook with the URL below',
      '4. Enable events: call_started, call_ended, call_analyzed',
      '5. Save the webhook configuration',
    ],
    docsUrl: 'https://docs.retellai.com/api-references/webhooks',
    webhookLocation: 'Settings → Webhooks → Add Webhook',
  },
  vapi: {
    title: 'VAPI Webhook Setup',
    steps: [
      '1. Go to your VAPI dashboard (vapi.ai)',
      '2. Select your assistant',
      '3. Go to Advanced Settings → Server URL',
      '4. Paste the webhook URL below',
      '5. Or configure via API: PATCH /assistant/{id} with serverUrl',
    ],
    docsUrl: 'https://docs.vapi.ai/webhooks',
    webhookLocation: 'Assistant → Advanced Settings → Server URL',
  },
  elevenlabs: {
    title: 'ElevenLabs Webhook Tool Setup',
    steps: [
      '1. Go to ElevenLabs dashboard → Your Agent → Tools tab',
      '2. Click "Add tool" button (top right)',
      '3. At the bottom, click "Add webhook tool"',
      '4. Click "Edit as JSON" (bottom left of the popup)',
      '5. Copy the JSON configuration below and paste it',
      '6. Click "Add tool" to save',
    ],
    docsUrl: 'https://elevenlabs.io/docs/conversational-ai/customization/tools',
    webhookLocation: 'Agent → Tools → Add tool → Add webhook tool → Edit as JSON',
    useWebhookTool: true,
  },
  bolna: {
    title: 'Bolna AI Webhook Setup',
    steps: [
      '1. Go to Bolna dashboard (bolna.ai)',
      '2. Select your agent',
      '3. Go to Agent Settings → Webhooks',
      '4. Add the webhook URL for call events',
      '5. Enable: call_started, call_ended notifications',
    ],
    docsUrl: 'https://docs.bolna.ai/webhooks',
    webhookLocation: 'Agent → Settings → Webhooks',
  },
  livekit: {
    title: 'LiveKit Webhook Setup',
    steps: [
      '1. Go to LiveKit Cloud (cloud.livekit.io)',
      '2. Select your project',
      '3. Go to Settings → Webhooks',
      '4. Add the webhook URL below',
      '5. Enable room and participant events',
    ],
    docsUrl: 'https://docs.livekit.io/home/server/webhooks/',
    webhookLocation: 'Project → Settings → Webhooks',
  },
};

/**
 * Generate ElevenLabs webhook tool JSON configuration
 * Simplified schema - let the LLM fill in values dynamically
 */
function generateElevenLabsWebhookToolJson(webhookUrl: string, webhookSecret: string): object {
  return {
    type: "webhook",
    name: "stablr_monitoring",
    description: "Sends conversation data to STABLR monitoring platform for quality analysis. Call this tool at the end of every conversation with the conversation_id, agent_id, transcript text, and call duration.",
    api_schema: {
      url: webhookUrl,
      method: "POST",
      path_params_schema: [],
      query_params_schema: [],
      request_body_schema: {
        id: "body",
        type: "object",
        description: "Request body",
        required: false,
        properties: [
          {
            id: "conversation_id",
            type: "string",
            description: "The conversation ID",
            required: true,
            constant_value: ""
          },
          {
            id: "agent_id",
            type: "string",
            description: "The agent ID",
            required: true,
            constant_value: ""
          },
          {
            id: "transcript",
            type: "string",
            description: "The conversation transcript",
            required: false,
            constant_value: ""
          },
          {
            id: "call_duration_secs",
            type: "integer",
            description: "Call duration in seconds",
            required: false,
            constant_value: 0
          }
        ]
      },
      request_headers: [
        {
          id: "secret",
          type: "value",
          name: "X-Webhook-Secret",
          value: webhookSecret
        },
        {
          id: "ctype",
          type: "value",
          name: "Content-Type",
          value: "application/json"
        }
      ]
    },
    response_timeout_secs: 30,
    execution_mode: "async"
  };
}

/**
 * Get monitoring sessions for user
 */
router.get('/sessions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);

    const result = await pool.query(
      `SELECT ms.*, a.name as agent_name, a.provider, a.provider_agent_id
       FROM monitoring_sessions ms
       JOIN agents a ON ms.agent_id = a.id
       WHERE ms.user_id = $1
       ORDER BY ms.created_at DESC`,
      [userId]
    );

    res.json({ sessions: result.rows });
  } catch (error) {
    console.error('Error fetching monitoring sessions:', error);
    res.status(500).json({ error: 'Failed to fetch monitoring sessions' });
  }
});

/**
 * Get or create monitoring session for an agent
 */
router.post('/sessions', async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('[Monitoring] POST /sessions - Creating session');
    console.log('[Monitoring] Request body:', req.body);
    
    const userId = await getEffectiveUserId(req);
    console.log('[Monitoring] User ID:', userId);
    
    const { agentId } = req.body;

    if (!agentId) {
      console.log('[Monitoring] Error: Agent ID is required');
      return res.status(400).json({ error: 'Agent ID is required' });
    }

    // Verify agent belongs to user
    console.log('[Monitoring] Looking up agent:', agentId, 'for user:', userId);
    const agentResult = await pool.query(
      `SELECT id, provider, name, provider_agent_id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      console.log('[Monitoring] Error: Agent not found');
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agent = agentResult.rows[0];
    console.log('[Monitoring] Agent found:', agent.name, 'provider:', agent.provider);

    // Generate webhook URL and secret
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    const webhookUrl = `${baseUrl}/api/webhooks/${agent.provider}`;
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    console.log('[Monitoring] Webhook URL:', webhookUrl);

    // Create or update session
    console.log('[Monitoring] Creating/updating monitoring session...');
    const result = await pool.query(
      `INSERT INTO monitoring_sessions (user_id, agent_id, webhook_url, webhook_secret, is_active)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT (user_id, agent_id)
       DO UPDATE SET webhook_url = $3, updated_at = NOW()
       RETURNING *`,
      [userId, agentId, webhookUrl, webhookSecret]
    );
    console.log('[Monitoring] Session created:', result.rows[0]?.id);

    const session = result.rows[0];
    const instructions = WEBHOOK_INSTRUCTIONS[agent.provider] || {
      title: 'Webhook Setup',
      steps: ['Configure the webhook URL in your provider dashboard'],
      webhookLocation: 'Provider dashboard → Webhooks',
    };

    // Generate provider-specific configurations
    let jsonConfig = null;
    if (agent.provider === 'elevenlabs') {
      jsonConfig = generateElevenLabsWebhookToolJson(webhookUrl, webhookSecret);
    }

    res.json({
      session,
      agent,
      webhookUrl,
      instructions,
      jsonConfig,
    });
  } catch (error: any) {
    console.error('[Monitoring] Error creating monitoring session:', error);
    console.error('[Monitoring] Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to create monitoring session', details: error.message });
  }
});

/**
 * Start monitoring for an agent
 */
router.post('/sessions/:agentId/start', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    const result = await pool.query(
      `UPDATE monitoring_sessions 
       SET is_active = true, updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2
       RETURNING *`,
      [userId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Monitoring session not found' });
    }

    res.json({ session: result.rows[0], message: 'Monitoring started' });
  } catch (error) {
    console.error('Error starting monitoring:', error);
    res.status(500).json({ error: 'Failed to start monitoring' });
  }
});

/**
 * Stop monitoring for an agent
 */
router.post('/sessions/:agentId/stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    const result = await pool.query(
      `UPDATE monitoring_sessions 
       SET is_active = false, updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2
       RETURNING *`,
      [userId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Monitoring session not found' });
    }

    res.json({ session: result.rows[0], message: 'Monitoring stopped' });
  } catch (error) {
    console.error('Error stopping monitoring:', error);
    res.status(500).json({ error: 'Failed to stop monitoring' });
  }
});

/**
 * Get production calls for an agent
 */
router.get('/calls', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId, status, limit = '50', offset = '0' } = req.query;

    let query = `
      SELECT pc.*, a.name as agent_name, a.provider
      FROM production_calls pc
      JOIN agents a ON pc.agent_id = a.id
      WHERE pc.user_id = $1
    `;
    const params: any[] = [userId];
    let paramCount = 2;

    if (agentId) {
      query += ` AND pc.agent_id = $${paramCount++}`;
      params.push(agentId);
    }

    if (status) {
      query += ` AND pc.status = $${paramCount++}`;
      params.push(status);
    }

    query += ` ORDER BY pc.created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `SELECT COUNT(*) FROM production_calls pc WHERE pc.user_id = $1`;
    const countParams: any[] = [userId];
    if (agentId) {
      countQuery += ` AND pc.agent_id = $2`;
      countParams.push(agentId);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      calls: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error) {
    console.error('Error fetching production calls:', error);
    res.status(500).json({ error: 'Failed to fetch calls' });
  }
});

/**
 * Get a single production call with full details
 */
router.get('/calls/:callId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { callId } = req.params;

    const result = await pool.query(
      `SELECT pc.*, 
              a.name as agent_name, 
              a.provider,
              a.config as agent_config,
              a.provider_agent_id
       FROM production_calls pc
       JOIN agents a ON pc.agent_id = a.id
       WHERE pc.id = $1 AND pc.user_id = $2`,
      [callId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json({ call: result.rows[0] });
  } catch (error) {
    console.error('Error fetching call details:', error);
    res.status(500).json({ error: 'Failed to fetch call details' });
  }
});

/**
 * Get recording audio for a call (proxy to provider)
 */
router.get('/calls/:callId/recording', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { callId } = req.params;

    // Get call details including provider info and API key from integrations
    const result = await pool.query(
      `SELECT pc.provider_call_id, pc.provider, pc.recording_url, i.api_key, i.base_url
       FROM production_calls pc
       JOIN agents a ON pc.agent_id = a.id
       JOIN integrations i ON a.integration_id = i.id
       WHERE pc.id = $1 AND pc.user_id = $2`,
      [callId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const { provider_call_id, provider, api_key, recording_url, base_url } = result.rows[0];
    console.log(`[Recording] Fetching for call ${callId}, provider: ${provider}, provider_call_id: ${provider_call_id}`);

    if (provider === 'elevenlabs') {
      // Fetch audio from ElevenLabs Conversational AI API
      const { resolveElevenLabsBaseUrl } = await import('../providers/elevenlabs.provider');
      const elBaseUrl = resolveElevenLabsBaseUrl(base_url);
      console.log(`[Recording] Fetching ElevenLabs audio for conversation: ${provider_call_id}`);
      const audioResponse = await fetch(
        `${elBaseUrl}/convai/conversations/${provider_call_id}/audio`,
        { headers: { 'xi-api-key': api_key } }
      );

      if (!audioResponse.ok) {
        const errorBody = await audioResponse.text().catch(() => '');
        console.error(`[Recording] ElevenLabs error: ${audioResponse.status} ${audioResponse.statusText}`, errorBody);
        return res.status(404).json({ error: 'Recording not available' });
      }

      console.log(`[Recording] ElevenLabs audio fetched successfully, content-type: ${audioResponse.headers.get('content-type')}`);
      // Stream the audio response
      res.setHeader('Content-Type', audioResponse.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Content-Disposition', `inline; filename="recording-${callId}.mp3"`);
      
      const arrayBuffer = await audioResponse.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } else if ((provider === 'retell' || provider === 'vapi') && recording_url) {
      // For Retell and VAPI, the recording_url is a presigned S3 URL - direct access
      const audioResponse = await fetch(recording_url);

      if (!audioResponse.ok) {
        console.error(`${provider} recording error: ${audioResponse.status} ${audioResponse.statusText}`);
        return res.status(404).json({ error: 'Recording not available' });
      }

      res.setHeader('Content-Type', audioResponse.headers.get('content-type') || 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="recording-${callId}.wav"`);
      
      const arrayBuffer = await audioResponse.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } else if (recording_url) {
      // Generic fallback - try to fetch the recording URL directly
      const audioResponse = await fetch(recording_url);

      if (!audioResponse.ok) {
        return res.status(404).json({ error: 'Recording not available' });
      }

      res.setHeader('Content-Type', audioResponse.headers.get('content-type') || 'audio/mpeg');
      res.setHeader('Content-Disposition', `inline; filename="recording-${callId}.mp3"`);
      
      const arrayBuffer = await audioResponse.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } else {
      res.status(404).json({ error: 'Recording not available for this call' });
    }
  } catch (error) {
    console.error('Error fetching recording:', error);
    res.status(500).json({ error: 'Failed to fetch recording' });
  }
});

/**
 * Re-analyze a production call
 */
router.post('/calls/:callId/reanalyze', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { callId } = req.params;

    // Verify ownership
    const result = await pool.query(
      `SELECT id FROM production_calls WHERE id = $1 AND user_id = $2`,
      [callId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Deduct credits for re-analysis
    const cost = await getFeatureCreditCost(FeatureKeys.PRODUCTION_CALL_ANALYZE);
    const creditDeducted = await deductCredits(
      userId,
      cost,
      `Re-analyze production call`,
      { callId }
    );
    if (!creditDeducted) {
      return res.status(402).json({ error: 'Insufficient credits to analyze call' });
    }

    // Trigger re-analysis
    realtimeAnalysisService.processCall(callId).catch(console.error);

    res.json({ message: 'Re-analysis started', callId });
  } catch (error) {
    console.error('Error re-analyzing call:', error);
    res.status(500).json({ error: 'Failed to re-analyze call' });
  }
});

/**
 * Get insights for an agent
 */
router.get('/insights/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;
    const days = parseInt(req.query.days as string) || 7;

    // Verify agent belongs to user
    const agentResult = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const insights = await realtimeAnalysisService.getAgentInsights(agentId, days);

    res.json({ insights });
  } catch (error) {
    console.error('Error fetching insights:', error);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

/**
 * Delete a production call
 */
router.delete('/calls/:callId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { callId } = req.params;

    const result = await pool.query(
      `DELETE FROM production_calls WHERE id = $1 AND user_id = $2 RETURNING id`,
      [callId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json({ message: 'Call deleted', callId });
  } catch (error) {
    console.error('Error deleting call:', error);
    res.status(500).json({ error: 'Failed to delete call' });
  }
});

// ============================================
// POLLING ENDPOINTS
// ============================================

/**
 * Enable polling for an agent
 */
router.post('/polling/:agentId/enable', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;
    const { intervalSeconds = 30 } = req.body;

    // Check if monitoring is already enabled for this agent
    const existingSession = await pool.query(
      `SELECT polling_enabled FROM monitoring_sessions WHERE user_id = $1 AND agent_id = $2`,
      [userId, agentId]
    );
    
    const isNewEnable = !existingSession.rows[0]?.polling_enabled;

    // Deduct credits only for new monitoring enablement
    if (isNewEnable) {
      const cost = await getFeatureCreditCost(FeatureKeys.PRODUCTION_MONITORING_ENABLE);
      const creditDeducted = await deductCredits(
        userId,
        cost,
        `Enable production monitoring for agent`,
        { agentId }
      );
      if (!creditDeducted) {
        return res.status(402).json({ error: 'Insufficient credits to enable monitoring' });
      }
    }

    // Validate interval (min 15 seconds, max 300 seconds)
    const interval = Math.max(15, Math.min(300, intervalSeconds));

    // Generate webhook URL for fallback (but we'll use polling)
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
    
    // Get agent provider
    const agentResult = await pool.query(
      `SELECT provider FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const webhookUrl = `${baseUrl}/api/webhooks/${agentResult.rows[0].provider}`;

    // Create or update monitoring session with polling enabled
    const result = await pool.query(
      `INSERT INTO monitoring_sessions (user_id, agent_id, webhook_url, polling_enabled, polling_interval_seconds, is_active, sync_method)
       VALUES ($1, $2, $3, true, $4, true, 'polling')
       ON CONFLICT (user_id, agent_id)
       DO UPDATE SET 
         polling_enabled = true, 
         polling_interval_seconds = $4, 
         is_active = true,
         sync_method = 'polling',
         updated_at = NOW()
       RETURNING *`,
      [userId, agentId, webhookUrl, interval]
    );

    // Start polling
    callPollingService.startPolling(agentId, interval);

    res.json({
      session: result.rows[0],
      message: `Polling enabled with ${interval}s interval`,
      pollingStatus: callPollingService.getPollingStatus(agentId)
    });
  } catch (error) {
    console.error('Error enabling polling:', error);
    res.status(500).json({ error: 'Failed to enable polling' });
  }
});

/**
 * Disable polling for an agent
 */
router.post('/polling/:agentId/disable', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    // Update session
    const result = await pool.query(
      `UPDATE monitoring_sessions 
       SET polling_enabled = false, is_active = false, updated_at = NOW()
       WHERE user_id = $1 AND agent_id = $2
       RETURNING *`,
      [userId, agentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Monitoring session not found' });
    }

    // Stop polling
    callPollingService.stopPolling(agentId);

    res.json({
      session: result.rows[0],
      message: 'Polling disabled',
      pollingStatus: callPollingService.getPollingStatus(agentId)
    });
  } catch (error) {
    console.error('Error disabling polling:', error);
    res.status(500).json({ error: 'Failed to disable polling' });
  }
});

/**
 * Manually trigger a sync/poll for an agent
 */
router.post('/polling/:agentId/sync', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    // Verify agent belongs to user
    const agentResult = await pool.query(
      `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Trigger immediate poll
    const result = await callPollingService.pollAgentCalls(agentId);

    res.json({
      message: 'Sync completed',
      result
    });
  } catch (error) {
    console.error('Error syncing calls:', error);
    res.status(500).json({ error: 'Failed to sync calls' });
  }
});

/**
 * Get polling status for an agent
 */
router.get('/polling/:agentId/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    // Get session info
    const sessionResult = await pool.query(
      `SELECT ms.*, a.name as agent_name, a.provider
       FROM monitoring_sessions ms
       JOIN agents a ON ms.agent_id = a.id
       WHERE ms.agent_id = $1 AND ms.user_id = $2`,
      [agentId, userId]
    );

    // Get call stats
    const statsResult = await pool.query(
      `SELECT 
         COUNT(*) as total_calls,
         COUNT(*) FILTER (WHERE analysis_status = 'completed') as analyzed_calls,
         COUNT(*) FILTER (WHERE analysis_status IN ('pending', 'analyzing')) as pending_calls,
         AVG(overall_score) as avg_score,
         MAX(created_at) as last_call_at
       FROM production_calls 
       WHERE agent_id = $1`,
      [agentId]
    );

    const pollingStatus = callPollingService.getPollingStatus(agentId);

    res.json({
      session: sessionResult.rows[0] || null,
      stats: statsResult.rows[0],
      pollingStatus
    });
  } catch (error) {
    console.error('Error getting polling status:', error);
    res.status(500).json({ error: 'Failed to get polling status' });
  }
});

/**
 * Get comprehensive overview of all monitoring
 */
router.get('/overview', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);

    // Get all agents with their monitoring status
    const agentsResult = await pool.query(
      `SELECT 
         a.id, a.name, a.provider, a.provider_agent_id,
         ms.is_active, ms.polling_enabled, ms.last_polled_at, ms.sync_method,
         ms.polling_interval_seconds,
         (SELECT COUNT(*) FROM production_calls pc WHERE pc.agent_id = a.id) as total_calls,
         (SELECT COALESCE(SUM(issues_found), 0) FROM production_calls pc WHERE pc.agent_id = a.id AND analysis_status = 'completed') as issues_found,
         (SELECT MAX(created_at) FROM production_calls pc WHERE pc.agent_id = a.id) as last_call_at
       FROM agents a
       LEFT JOIN monitoring_sessions ms ON a.id = ms.agent_id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [userId]
    );

    // Get overall stats
    const overallStats = await pool.query(
      `SELECT 
         COUNT(*) as total_calls,
         COUNT(*) FILTER (WHERE analysis_status = 'completed') as analyzed_calls,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as calls_today,
         COALESCE(SUM(issues_found) FILTER (WHERE analysis_status = 'completed'), 0) as total_issues,
         COUNT(DISTINCT agent_id) as agents_with_calls
       FROM production_calls 
       WHERE user_id = $1`,
      [userId]
    );

    // Get recent issues
    const recentIssues = await pool.query(
      `SELECT 
         pc.id as call_id,
         a.name as agent_name,
         pc.analysis->'issues' as issues,
         pc.overall_score,
         pc.created_at
       FROM production_calls pc
       JOIN agents a ON pc.agent_id = a.id
       WHERE pc.user_id = $1 
         AND pc.analysis_status = 'completed'
         AND (pc.analysis->'issues')::jsonb != '[]'::jsonb
       ORDER BY pc.created_at DESC
       LIMIT 10`,
      [userId]
    );

    res.json({
      agents: agentsResult.rows,
      stats: overallStats.rows[0],
      recentIssues: recentIssues.rows,
      activePolling: callPollingService.getActivePollingAgents()
    });
  } catch (error) {
    console.error('Error getting monitoring overview:', error);
    res.status(500).json({ error: 'Failed to get monitoring overview' });
  }
});

/**
 * Get all monitored agents
 */
router.get('/agents', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);

    const result = await pool.query(
      `SELECT 
         ma.id,
         ma.agent_id,
         a.name,
         a.provider,
         ma.polling_enabled,
         ma.created_at,
         (SELECT COUNT(*) FROM production_calls pc WHERE pc.agent_id = a.id) as total_calls,
         (SELECT COUNT(*) FROM production_calls pc WHERE pc.agent_id = a.id AND analysis_status = 'completed') as analyzed_calls,
         (SELECT COALESCE(SUM(issues_found), 0) FROM production_calls pc WHERE pc.agent_id = a.id AND analysis_status = 'completed') as issues_found,
         (SELECT MAX(created_at) FROM production_calls pc WHERE pc.agent_id = a.id) as last_call_at
       FROM monitored_agents ma
       JOIN agents a ON ma.agent_id = a.id
       WHERE ma.user_id = $1
       ORDER BY ma.created_at DESC`,
      [userId]
    );

    // Get overall stats
    const statsResult = await pool.query(
      `SELECT 
         COUNT(*) as total_calls,
         COUNT(*) FILTER (WHERE analysis_status = 'completed') as analyzed_calls,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as calls_today,
         COALESCE(SUM(issues_found) FILTER (WHERE analysis_status = 'completed'), 0) as total_issues
       FROM production_calls 
       WHERE user_id = $1`,
      [userId]
    );

    res.json({
      agents: result.rows,
      stats: {
        ...statsResult.rows[0],
        active_agents: result.rows.filter((a: { polling_enabled: boolean }) => a.polling_enabled).length
      }
    });
  } catch (error) {
    console.error('Error getting monitored agents:', error);
    res.status(500).json({ error: 'Failed to get monitored agents' });
  }
});

/**
 * Get a single monitored agent
 */
router.get('/agents/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    const result = await pool.query(
      `SELECT 
         a.id, a.name, a.provider, a.provider_agent_id,
         ma.polling_enabled, ma.created_at as monitored_since
       FROM agents a
       LEFT JOIN monitored_agents ma ON a.id = ma.agent_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [agentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({ agent: result.rows[0] });
  } catch (error) {
    console.error('Error getting monitored agent:', error);
    res.status(500).json({ error: 'Failed to get monitored agent' });
  }
});

/**
 * Add an agent to monitoring
 */
router.post('/agents', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    // Verify agent belongs to user
    const agentCheck = await pool.query(
      'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Check if already monitored
    const existing = await pool.query(
      'SELECT id FROM monitored_agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Agent is already being monitored' });
    }

    // Add to monitored agents
    const result = await pool.query(
      `INSERT INTO monitored_agents (id, user_id, agent_id, polling_enabled, created_at)
       VALUES ($1, $2, $3, false, NOW())
       RETURNING *`,
      [crypto.randomUUID(), userId, agentId]
    );

    res.status(201).json({ monitoredAgent: result.rows[0] });
  } catch (error) {
    console.error('Error adding agent to monitoring:', error);
    res.status(500).json({ error: 'Failed to add agent to monitoring' });
  }
});

/**
 * Remove an agent from monitoring
 */
router.delete('/agents/:agentId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    // Stop polling if active
    callPollingService.stopPolling(agentId);

    // Remove from monitored agents
    await pool.query(
      'DELETE FROM monitored_agents WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing agent from monitoring:', error);
    res.status(500).json({ error: 'Failed to remove agent from monitoring' });
  }
});

/**
 * Analyze pending calls for an agent
 */
router.post('/calls/:agentId/analyze', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = await getEffectiveUserId(req);
    const { agentId } = req.params;

    // Verify agent belongs to user
    const agentResult = await pool.query(
      'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
      [agentId, userId]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Get pending calls for this agent (including stuck analyzing ones)
    const pendingCalls = await pool.query(
      `SELECT id FROM production_calls 
       WHERE agent_id = $1 AND analysis_status IN ('pending', 'analyzing')
       ORDER BY created_at DESC
       LIMIT 10`,
      [agentId]
    );

    const callsToAnalyze = pendingCalls.rows;
    console.log(`[Monitoring] Analyzing ${callsToAnalyze.length} pending calls for agent ${agentId}`);

    // Start analysis for each call
    const analysisPromises = callsToAnalyze.map(call => 
      realtimeAnalysisService.processCall(call.id).catch(err => {
        console.error(`[Monitoring] Analysis failed for call ${call.id}:`, err);
        return { id: call.id, error: err.message };
      })
    );

    // Don't wait for all to complete - just start them
    Promise.all(analysisPromises).then(results => {
      console.log(`[Monitoring] Completed analysis for ${results.length} calls`);
    });

    res.json({ 
      message: `Started analysis for ${callsToAnalyze.length} calls`,
      callIds: callsToAnalyze.map(c => c.id)
    });
  } catch (error) {
    console.error('Error triggering analysis:', error);
    res.status(500).json({ error: 'Failed to trigger analysis' });
  }
});

export default router;
