/**
 * Monitoring Routes
 * 
 * API endpoints for real-time monitoring management
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { realtimeAnalysisService } from '../services/realtime-analysis.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
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
    name: "voiceqa_monitoring",
    description: "Sends conversation data to Voice QA monitoring platform for quality analysis. Call this tool at the end of every conversation with the conversation_id, agent_id, transcript text, and call duration.",
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

export default router;
