/**
 * Periodic outage checks for every user's integrations.
 * Persists each result into outage_checks so the frontend status page can
 * render a 90-day grid and uptime %.
 *
 * Runs every 15 minutes from the scheduler.
 */

import { pool } from '../db';
import { logger } from './logger.service';

function providerHealthUrl(provider: string, baseUrl?: string | null): string | null {
  if (baseUrl) return baseUrl;
  switch ((provider || '').toLowerCase()) {
    case 'elevenlabs': return 'https://api.elevenlabs.io/v1/user';
    case 'retell': return 'https://api.retellai.com/v2/list-agents';
    case 'vapi': return 'https://api.vapi.ai/health';
    case 'bolna': return 'https://api.bolna.ai/healthz';
    case 'haptik': return 'https://api.haptik.ai/health';
    case 'livekit': return 'https://cloud.livekit.io/api/status';
    case 'openai': return 'https://api.openai.com/v1/models';
    default: return null;
  }
}

export async function runOutageChecksForAllUsers(): Promise<number> {
  let inserted = 0;
  try {
    const integ = await pool.query(
      `SELECT id, user_id, provider, base_url FROM integrations`,
    );
    for (const i of integ.rows) {
      const url = providerHealthUrl(i.provider, i.base_url);
      if (!url) {
        await pool.query(
          `INSERT INTO outage_checks (user_id, integration_id, provider, check_type, status, error)
           VALUES ($1, $2, $3, 'health', 'unknown', 'no health url')`,
          [i.user_id, i.id, i.provider],
        );
        inserted++;
        continue;
      }
      const startedAt = Date.now();
      let status = 'down';
      let httpStatus: number | null = null;
      let error: string | null = null;
      try {
        const r = await fetch(url, { method: 'GET' } as any);
        httpStatus = r.status;
        status = r.ok ? 'up' : 'down';
      } catch (e: any) {
        error = (e?.message || 'fetch failed').slice(0, 500);
      }
      const latencyMs = Date.now() - startedAt;
      await pool.query(
        `INSERT INTO outage_checks (user_id, integration_id, provider, check_type, status, http_status, latency_ms, error)
         VALUES ($1, $2, $3, 'health', $4, $5, $6, $7)`,
        [i.user_id, i.id, i.provider, status, httpStatus, latencyMs, error],
      );
      inserted++;
    }
  } catch (err: any) {
    logger.error?.(`[outage] runOutageChecksForAllUsers error: ${err.message}`);
  }
  return inserted;
}

/**
 * Daily roll-up for status-page UI.
 * Returns per-provider per-day status (worst-of: down > unknown > up).
 */
export async function getUptimeRollup(userId: string, days = 90) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const res = await pool.query(
    `SELECT provider,
            date_trunc('day', checked_at) AS day,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'up') AS up_count,
            COUNT(*) FILTER (WHERE status = 'down') AS down_count,
            AVG(latency_ms)::INT AS avg_latency
       FROM outage_checks
      WHERE user_id = $1 AND checked_at >= $2
      GROUP BY provider, day
      ORDER BY provider, day`,
    [userId, since],
  );
  // shape into { provider -> [{day, status, latency, uptime}] }
  const byProvider: Record<string, any[]> = {};
  for (const r of res.rows) {
    const list = byProvider[r.provider] || (byProvider[r.provider] = []);
    const total = Number(r.total) || 0;
    const ups = Number(r.up_count) || 0;
    const downs = Number(r.down_count) || 0;
    let status: 'up' | 'down' | 'degraded' = 'up';
    if (downs > 0 && ups === 0) status = 'down';
    else if (downs > 0) status = 'degraded';
    list.push({
      day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
      total, ups, downs,
      uptime: total === 0 ? null : Number(((ups / total) * 100).toFixed(2)),
      avg_latency: r.avg_latency,
      status,
    });
  }
  // compute overall uptime per provider
  const summary = Object.entries(byProvider).map(([provider, rows]) => {
    const totals = rows.reduce((a, r) => ({ t: a.t + r.total, u: a.u + r.ups }), { t: 0, u: 0 });
    return {
      provider,
      uptime_pct: totals.t === 0 ? null : Number(((totals.u / totals.t) * 100).toFixed(3)),
      checks: totals.t,
      days: rows.length,
    };
  });
  return { summary, byProvider };
}
