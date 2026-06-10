/**
 * Items 18-24: monitoring control plane.
 *
 *  18: PUT  /api/monitoring/agents/:agentId/sampling
 *           { sampling_rate?: 0..1, signal_filters?: { keywords?: string[] } }
 *  19: POST /api/monitoring/outage-test                  -> ping all providers
 *  20: GET  /api/monitoring/calls/:callId/latency-rca    -> per-component RCA
 *  22: GET  /api/monitoring/analytics?agentId&days       -> consumption/in/out
 *  23: POST /api/monitoring/calls/:callId/feedback       { rating, comment }
 *  24: POST /api/monitoring/escalate                     -> Slack + PagerDuty
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';
import { aggregateLatencyAttribution } from '../services/latency-attribution.service';

const router = Router();

// ===== Item 18: sampling controls =====
router.put('/agents/:agentId/sampling', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.params;
    const { sampling_rate, signal_filters } = req.body || {};

    if (sampling_rate !== undefined) {
      const n = Number(sampling_rate);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        return res.status(400).json({ success: false, error: 'sampling_rate must be 0..1' });
      }
    }

    const ownership = await pool.query(
      `SELECT 1 FROM monitored_agents WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId],
    );
    if (ownership.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'monitored agent not found' });
    }

    const result = await pool.query(
      `UPDATE monitored_agents
       SET sampling_rate = COALESCE($2, sampling_rate),
           signal_filters = COALESCE($3::jsonb, signal_filters),
           updated_at = NOW()
       WHERE agent_id = $1 AND user_id = $4
       RETURNING agent_id, sampling_rate, signal_filters`,
      [agentId, sampling_rate ?? null, signal_filters ? JSON.stringify(signal_filters) : null, userId],
    );
    res.json({ success: true, monitored_agent: result.rows[0] });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] sampling error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Item 19: outage testing =====
router.post('/outage-test', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const integ = await pool.query(
      `SELECT id, provider, base_url FROM integrations WHERE user_id = $1`,
      [userId],
    );
    const results: any[] = [];
    for (const i of integ.rows) {
      const url = i.base_url || providerHealthUrl(i.provider);
      if (!url) {
        results.push({ id: i.id, provider: i.provider, status: 'unknown', reason: 'no health url' });
        continue;
      }
      const startedAt = Date.now();
      try {
        const r = await fetch(url, { method: 'GET' });
        results.push({
          id: i.id,
          provider: i.provider,
          status: r.ok ? 'up' : 'down',
          httpStatus: r.status,
          latencyMs: Date.now() - startedAt,
        });
      } catch (e: any) {
        results.push({
          id: i.id,
          provider: i.provider,
          status: 'down',
          reason: e?.message || 'fetch failed',
          latencyMs: Date.now() - startedAt,
        });
      }
    }
    res.json({ success: true, checkedAt: new Date().toISOString(), results });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] outage-test error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

function providerHealthUrl(provider: string): string | null {
  switch (provider) {
    case 'elevenlabs': return 'https://api.elevenlabs.io/v1/health';
    case 'retell':     return 'https://api.retellai.com/health';
    case 'vapi':       return 'https://api.vapi.ai/health';
    case 'haptik':     return 'https://api.haptik.ai/health';
    case 'bolna':      return 'https://api.bolna.dev/health';
    default:           return null;
  }
}

// ===== Item 20: latency RCA per call =====
router.get('/calls/:callId/latency-rca', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { callId } = req.params;
    const row = await pool.query(
      `SELECT pc.*
       FROM production_calls pc
       WHERE pc.id = $1 AND pc.user_id = $2`,
      [callId, userId],
    );
    if (row.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'call not found' });
    }
    // production_calls stores transcript JSONB, treat it like conversation turns
    let turns = row.rows[0].transcript;
    if (typeof turns === 'string') {
      try { turns = JSON.parse(turns); } catch { turns = []; }
    }
    const agg = aggregateLatencyAttribution(Array.isArray(turns) ? turns : []);
    const worst = Object.entries(agg.totals).sort((a, b) => (b[1] as number) - (a[1] as number))[0];
    const recommendations: string[] = [];
    if (worst && (worst[1] as number) > 0) {
      const [component, ms] = worst;
      recommendations.push(`${component} dominates at ${ms}ms — consider a faster provider or smaller model for that component.`);
    }
    if (agg.providerSourceShare < 0.3) {
      recommendations.push('Most timings are estimated (no provider component breakdown). Enable provider webhooks with component timestamps for accurate RCA.');
    }
    res.json({
      success: true,
      callId,
      ...agg,
      worstComponent: worst ? { component: worst[0], totalMs: worst[1] } : null,
      recommendations,
    });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] latency-rca error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Item 22: consumption / inbound / outbound analytics =====
router.get('/analytics', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const agentId = (req.query.agentId as string) || null;
    const days = Number((req.query.days as string) || '30');

    const params: any[] = [userId, days.toString()];
    let agentFilter = '';
    if (agentId) {
      params.push(agentId);
      agentFilter = ` AND pc.agent_id = $${params.length}`;
    }

    const rows = await pool.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE call_type = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE call_type = 'outbound')::int AS outbound,
         COALESCE(SUM(duration_seconds), 0)::int AS total_seconds,
         COALESCE(AVG(duration_seconds), 0)::float AS avg_seconds,
         COUNT(DISTINCT pc.agent_id)::int AS active_agents
       FROM production_calls pc
       WHERE pc.user_id = $1
         AND pc.created_at >= NOW() - ($2 || ' days')::interval
         ${agentFilter}`,
      params,
    );

    const perDay = await pool.query(
      `SELECT date_trunc('day', pc.created_at) AS day,
              COUNT(*)::int AS calls,
              COALESCE(SUM(duration_seconds), 0)::int AS seconds
       FROM production_calls pc
       WHERE pc.user_id = $1
         AND pc.created_at >= NOW() - ($2 || ' days')::interval
         ${agentFilter}
       GROUP BY day
       ORDER BY day`,
      params,
    );

    res.json({
      success: true,
      windowDays: days,
      ...rows.rows[0],
      perDay: perDay.rows,
    });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] analytics error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Item 23: human feedback on monitored calls =====
router.post('/calls/:callId/feedback', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { callId } = req.params;
    const { rating, comment, label } = req.body || {};
    if (rating === undefined && !comment && !label) {
      return res.status(400).json({ success: false, error: 'rating, comment, or label required' });
    }
    if (rating !== undefined) {
      const n = Number(rating);
      if (Number.isNaN(n) || n < 1 || n > 5) {
        return res.status(400).json({ success: false, error: 'rating must be 1..5' });
      }
    }
    const owner = await pool.query(
      `SELECT 1 FROM production_calls WHERE id = $1 AND user_id = $2`,
      [callId, userId],
    );
    if (owner.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'call not found' });
    }
    // Persist feedback inside the analysis JSONB (no schema change needed).
    await pool.query(
      `UPDATE production_calls
       SET analysis = COALESCE(analysis, '{}'::jsonb) || jsonb_build_object('human_feedback',
         jsonb_build_object('rating', $2::int, 'comment', $3::text, 'label', $4::text, 'at', NOW()::text, 'by', $5::text)
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [callId, rating ?? null, comment ?? null, label ?? null, userId],
    );
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] feedback error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Item 24: escalation (Slack + PagerDuty) =====
router.post('/escalate', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, callId, severity, summary, details } = req.body || {};
    if (!summary || !severity) {
      return res.status(400).json({ success: false, error: 'summary and severity are required' });
    }
    const settings = await pool.query(
      `SELECT slack_webhook_url, pagerduty_routing_key, teams_webhook_url, whatsapp_webhook_url, escalation_enabled
       FROM alert_settings WHERE user_id = $1`,
      [userId],
    );
    const s = settings.rows[0] || {};
    if (s.escalation_enabled === false) {
      return res.json({ success: true, dispatched: [], note: 'Escalations are turned off in notification settings.' });
    }
    const dispatched: Array<{ target: string; ok: boolean; status?: number; reason?: string }> = [];

    if (s.slack_webhook_url) {
      try {
        const r = await fetch(s.slack_webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[${severity.toUpperCase()}] ${summary}`,
            attachments: details ? [{ text: typeof details === 'string' ? details : JSON.stringify(details) }] : undefined,
          }),
        });
        dispatched.push({ target: 'slack', ok: r.ok, status: r.status });
      } catch (e: any) {
        dispatched.push({ target: 'slack', ok: false, reason: e?.message });
      }
    }

    if (s.teams_webhook_url) {
      try {
        // Microsoft Teams incoming webhook expects a MessageCard payload.
        const r = await fetch(s.teams_webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            '@type': 'MessageCard',
            '@context': 'https://schema.org/extensions',
            themeColor: severity === 'critical' ? 'D00000' : severity === 'error' ? 'E8A317' : '1A5253',
            summary: `[${severity.toUpperCase()}] ${summary}`,
            title: `[${String(severity).toUpperCase()}] ${summary}`,
            text: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : '',
          }),
        });
        dispatched.push({ target: 'teams', ok: r.ok, status: r.status });
      } catch (e: any) {
        dispatched.push({ target: 'teams', ok: false, reason: e?.message });
      }
    }

    if (s.whatsapp_webhook_url) {
      try {
        // Generic WhatsApp relay: POST { text }. Works with a Twilio/360dialog
        // bridge or a custom forwarder that turns this into a WhatsApp message.
        const r = await fetch(s.whatsapp_webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[${String(severity).toUpperCase()}] ${summary}${details ? `\n${typeof details === 'string' ? details : JSON.stringify(details)}` : ''}`,
          }),
        });
        dispatched.push({ target: 'whatsapp', ok: r.ok, status: r.status });
      } catch (e: any) {
        dispatched.push({ target: 'whatsapp', ok: false, reason: e?.message });
      }
    }

    if (s.pagerduty_routing_key) {
      try {
        const r = await fetch('https://events.pagerduty.com/v2/enqueue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            routing_key: s.pagerduty_routing_key,
            event_action: 'trigger',
            payload: {
              summary,
              severity: severity === 'critical' ? 'critical' : severity === 'error' ? 'error' : 'warning',
              source: agentId || 'stablr-voice-qa',
              custom_details: { agentId, callId, details },
            },
          }),
        });
        dispatched.push({ target: 'pagerduty', ok: r.ok, status: r.status });
      } catch (e: any) {
        dispatched.push({ target: 'pagerduty', ok: false, reason: e?.message });
      }
    }

    if (dispatched.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No escalation channels configured. Set Slack, Teams, WhatsApp or PagerDuty in notification settings.',
      });
    }

    res.json({ success: true, dispatched });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] escalate error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== t17: notification channel settings (on/off + webhooks) =====
router.get('/notification-settings', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const r = await pool.query(
      `SELECT escalation_enabled, slack_webhook_url, teams_webhook_url, whatsapp_webhook_url, pagerduty_routing_key
       FROM alert_settings WHERE user_id = $1`,
      [userId],
    );
    const s = r.rows[0] || {};
    // Never echo full secrets back — report only whether each channel is configured.
    res.json({
      success: true,
      settings: {
        escalation_enabled: s.escalation_enabled !== false,
        slack_configured: !!s.slack_webhook_url,
        teams_configured: !!s.teams_webhook_url,
        whatsapp_configured: !!s.whatsapp_webhook_url,
        pagerduty_configured: !!s.pagerduty_routing_key,
      },
    });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] get notification-settings error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/notification-settings', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { escalation_enabled, slack_webhook_url, teams_webhook_url, whatsapp_webhook_url, pagerduty_routing_key } = req.body || {};

    // Ensure a row exists for this user.
    await pool.query(
      `INSERT INTO alert_settings (user_id, enabled)
       VALUES ($1, true)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    const setField = (col: string, val: any) => {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val === '' ? null : val);
      }
    };
    setField('escalation_enabled', typeof escalation_enabled === 'boolean' ? escalation_enabled : undefined);
    setField('slack_webhook_url', slack_webhook_url);
    setField('teams_webhook_url', teams_webhook_url);
    setField('whatsapp_webhook_url', whatsapp_webhook_url);
    setField('pagerduty_routing_key', pagerduty_routing_key);

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No settings provided' });
    }
    values.push(userId);
    await pool.query(
      `UPDATE alert_settings SET ${fields.join(', ')} WHERE user_id = $${i}`,
      values,
    );
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[MonitoringExtras] put notification-settings error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
