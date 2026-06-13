/**
 * RLAIF — Reinforcement Learning from AI Feedback.
 *
 * Periodically (default: end of day) reviews all FAILED test_results AND
 * low-rated production_calls in the period and uses an LLM to:
 *   1. Cluster the failures into a small set of categories
 *      (model_perf, missing_scenario, kb_gap, tool_failure, prompt_issue,
 *       tone_cosmetic, hallucination, security_refusal_missing, other).
 *   2. Recommend concrete changes per category (prompt edits, KB additions,
 *      tool fixes, persona tweaks).
 *
 * Output is persisted into rlaif_runs and exposed via GET /api/monitoring/rlaif.
 */

import OpenAI from 'openai';
import { pool } from '../db';
import { config } from '../config';
import { logger } from './logger.service';

let _openai: OpenAI | null = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: config.openai.apiKey });
  return _openai;
}

type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'quarterly';

function periodStart(freq: Frequency): Date {
  const now = new Date();
  switch (freq) {
    case 'hourly': return new Date(now.getTime() - 3600 * 1000);
    case 'daily': return new Date(now.getTime() - 24 * 3600 * 1000);
    case 'weekly': return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    case 'monthly': return new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    case 'quarterly': return new Date(now.getTime() - 90 * 24 * 3600 * 1000);
  }
}

interface RlaifResult {
  total_evaluated: number;
  total_failed: number;
  categories: { name: string; count: number; description: string }[];
  recommendations: { category: string; severity: 'low' | 'medium' | 'high'; title: string; details: string; suggested_action: string }[];
}

export async function runRlaifForUser(
  userId: string,
  freq: Frequency = 'daily',
  agentId?: string,
): Promise<RlaifResult & { id: number }> {
  const start = periodStart(freq);
  const end = new Date();

  // 1. Pull failed test_results in window
  const failedTests = await pool.query(
    `SELECT tr.id, tr.error_message, tr.scenario, tr.expected_response, tr.actual_response,
            tr.metrics, tr.category, tc.is_security_test, tc.name AS test_name
       FROM test_results tr
       JOIN test_runs trn ON trn.id = tr.test_run_id
       LEFT JOIN test_cases tc ON tc.id = tr.test_case_id
      WHERE trn.user_id = $1
        AND tr.status = 'failed'
        AND tr.created_at BETWEEN $2 AND $3
        ${agentId ? 'AND trn.agent_id = $4' : ''}
      ORDER BY tr.created_at DESC
      LIMIT 200`,
    agentId ? [userId, start, end, agentId] : [userId, start, end],
  );

  // 2. Pull low-rated production calls
  const lowRated = await pool.query(
    `SELECT id, analysis, agent_id
       FROM production_calls
      WHERE user_id = $1
        AND created_at BETWEEN $2 AND $3
        ${agentId ? 'AND agent_id = $4' : ''}
        AND (analysis->'human_feedback'->>'rating')::INT <= 2
      LIMIT 100`,
    agentId ? [userId, start, end, agentId] : [userId, start, end],
  );

  const totalEvaluated = failedTests.rows.length + lowRated.rows.length;
  const totalFailed = failedTests.rows.length;

  if (totalEvaluated === 0) {
    const empty: RlaifResult = {
      total_evaluated: 0,
      total_failed: 0,
      categories: [],
      recommendations: [{
        category: 'none',
        severity: 'low',
        title: 'No failures in period',
        details: 'No failed test results or low-rated production calls found.',
        suggested_action: 'Continue monitoring.',
      }],
    };
    const ins = await pool.query(
      `INSERT INTO rlaif_runs (user_id, agent_id, scope, period_start, period_end,
                               total_evaluated, total_failed, categories, recommendations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING id`,
      [userId, agentId || null, freq, start, end, 0, 0, JSON.stringify([]), JSON.stringify(empty.recommendations)],
    );
    return { ...empty, id: ins.rows[0].id };
  }

  // 3. Compact summaries for the LLM
  const failureBriefs = failedTests.rows.slice(0, 60).map((r, idx) => ({
    idx,
    test_name: r.test_name,
    category: r.category,
    is_security: !!r.is_security_test,
    expected: (r.expected_response || '').slice(0, 300),
    actual: (r.actual_response || '').slice(0, 300),
    error: (r.error_message || '').slice(0, 200),
    hallucination: !!r.metrics?.factualAssessment?.suspectedHallucinations?.length,
    tone: r.metrics?.toneStyle?.tone,
  }));
  const lowRatedBriefs = lowRated.rows.slice(0, 40).map((r, idx) => ({
    idx,
    rating: r.analysis?.human_feedback?.rating,
    comment: (r.analysis?.human_feedback?.comment || '').slice(0, 200),
  }));

  // 4. Ask LLM to cluster + recommend
  const prompt = `You are a voice-AI QA root-cause analyst. Cluster the following failures into a small set of categories and recommend concrete fixes.

Categories you may use (pick the relevant ones, omit others):
- model_performance, missing_scenario, kb_gap, tool_failure, prompt_issue, tone_cosmetic, hallucination, security_refusal_missing, other.

Failed test cases (${failureBriefs.length}):
${JSON.stringify(failureBriefs)}

Low-rated production calls (${lowRatedBriefs.length}):
${JSON.stringify(lowRatedBriefs)}

Respond as STRICT JSON only, shape:
{
  "categories": [{"name":"...","count":N,"description":"..."}],
  "recommendations": [{"category":"...","severity":"low|medium|high","title":"...","details":"...","suggested_action":"..."}]
}

Limit categories to at most 6 and recommendations to at most 8. Be specific (mention prompt sections to edit, KB topics to add, tool names to fix when hinted by the data).`;

  let parsed: { categories?: any[]; recommendations?: any[] } = {};
  try {
    const resp = await openai().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You output strict JSON only.' },
        { role: 'user', content: prompt },
      ],
    });
    parsed = JSON.parse(resp.choices[0]?.message?.content || '{}');
  } catch (e: any) {
    logger.error?.(`[rlaif] LLM error: ${e?.message}`);
    parsed = {
      categories: [{ name: 'analysis_error', count: totalFailed, description: 'LLM clustering failed; see logs.' }],
      recommendations: [{
        category: 'analysis_error', severity: 'medium',
        title: 'RLAIF clustering failed', details: e?.message || 'unknown',
        suggested_action: 'Retry later or check OPENAI_API_KEY quota.',
      }],
    };
  }

  const out: RlaifResult = {
    total_evaluated: totalEvaluated,
    total_failed: totalFailed,
    categories: parsed.categories || [],
    recommendations: parsed.recommendations || [],
  };

  const ins = await pool.query(
    `INSERT INTO rlaif_runs (user_id, agent_id, scope, period_start, period_end,
                             total_evaluated, total_failed, categories, recommendations)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING id`,
    [userId, agentId || null, freq, start, end, totalEvaluated, totalFailed,
     JSON.stringify(out.categories), JSON.stringify(out.recommendations)],
  );

  return { ...out, id: ins.rows[0].id };
}

/**
 * Sweep: run daily RLAIF for every user that has at least one failure or
 * low-rated call in the last 24h. Called by the scheduler at 00:30 server time.
 */
export async function runDailyRlaifSweep(): Promise<number> {
  let count = 0;
  try {
    const users = await pool.query(
      `SELECT DISTINCT tr.user_id AS user_id
         FROM test_runs tr
         JOIN test_results res ON res.test_run_id = tr.id
        WHERE res.status = 'failed'
          AND res.created_at >= NOW() - INTERVAL '24 hours'
       UNION
       SELECT DISTINCT user_id FROM production_calls
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND (analysis->'human_feedback'->>'rating')::INT <= 2`,
    );
    for (const u of users.rows) {
      try {
        await runRlaifForUser(u.user_id, 'daily');
        count++;
      } catch (e: any) {
        logger.error?.(`[rlaif] sweep user ${u.user_id} failed: ${e.message}`);
      }
    }
  } catch (e: any) {
    logger.error?.(`[rlaif] sweep error: ${e.message}`);
  }
  return count;
}
