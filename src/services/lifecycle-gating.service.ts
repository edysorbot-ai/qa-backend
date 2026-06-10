/**
 * t10 — Agent lifecycle stages + eval gating.
 *
 * agents.lifecycle_stage is one of development|qa|uat|production (migration 041).
 * This service turns a completed test run's results into a STAGE-AWARE gate
 * verdict so the platform can "do evals accordingly":
 *
 *   - development: light eval, failures never escalate. Always passes the gate
 *                  (signal only). Promotable to qa once a run exists.
 *   - qa:          full eval. Gate passes when overall pass rate >= 80%.
 *                  Failures alert the team (non-blocking) but block promotion.
 *   - uat:         regression + adversarial. ALL security/adversarial cases must
 *                  pass AND overall pass rate >= 90%. Failures BLOCK promotion.
 *   - production:  continuous monitoring. Any failure is treated as an incident
 *                  (severity = high). Gate "passes" only at 100% — otherwise the
 *                  run is flagged as a production incident.
 */

import { Pool } from 'pg';

export type LifecycleStage = 'development' | 'qa' | 'uat' | 'production';

export interface LifecycleGateVerdict {
  stage: LifecycleStage;
  policy: string;
  stats: {
    total: number;
    passed: number;
    failed: number;
    passRate: number; // 0-100
    securityTotal: number;
    securityPassed: number;
    securityFailed: number;
  };
  passed: boolean;            // does the run satisfy this stage's gate?
  blocksPromotion: boolean;   // do current failures block moving to the next stage?
  promotable: boolean;        // is the agent ready to advance to nextStage?
  nextStage: LifecycleStage | null;
  failureSeverity: 'none' | 'low' | 'medium' | 'high';
  reasons: string[];
}

const STAGE_ORDER: LifecycleStage[] = ['development', 'qa', 'uat', 'production'];

function nextStageOf(stage: LifecycleStage): LifecycleStage | null {
  const i = STAGE_ORDER.indexOf(stage);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1] : null;
}

export async function evaluateLifecycleGateForRun(
  pool: Pool,
  testRunId: string,
): Promise<{ runId: string; agentId: string | null; verdict: LifecycleGateVerdict }> {
  // Resolve the agent + its lifecycle stage for this run.
  const runQ = await pool.query(
    `SELECT tr.id, tr.agent_id, a.lifecycle_stage
       FROM test_runs tr
       LEFT JOIN agents a ON a.id = tr.agent_id
      WHERE tr.id = $1`,
    [testRunId],
  );
  if (runQ.rows.length === 0) {
    throw new Error('Test run not found');
  }
  const agentId: string | null = runQ.rows[0].agent_id || null;
  const stage = (runQ.rows[0].lifecycle_stage || 'development') as LifecycleStage;

  // Aggregate results, separating security/adversarial cases.
  const statQ = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN trs.status = 'passed' THEN 1 END)::int AS passed,
        COUNT(CASE WHEN trs.status = 'failed' THEN 1 END)::int AS failed,
        COUNT(CASE WHEN tc.is_security_test THEN 1 END)::int AS sec_total,
        COUNT(CASE WHEN tc.is_security_test AND trs.status = 'passed' THEN 1 END)::int AS sec_passed,
        COUNT(CASE WHEN tc.is_security_test AND trs.status = 'failed' THEN 1 END)::int AS sec_failed
       FROM test_results trs
       LEFT JOIN test_cases tc ON tc.id = trs.test_case_id
      WHERE trs.test_run_id = $1`,
    [testRunId],
  );
  const row = statQ.rows[0] || {};
  const total = row.total || 0;
  const passed = row.passed || 0;
  const failed = row.failed || 0;
  const securityTotal = row.sec_total || 0;
  const securityPassed = row.sec_passed || 0;
  const securityFailed = row.sec_failed || 0;
  const passRate = total > 0 ? Math.round((passed * 100) / total) : 0;

  const stats = { total, passed, failed, passRate, securityTotal, securityPassed, securityFailed };
  const reasons: string[] = [];

  let policy = '';
  let gatePassed = false;
  let blocksPromotion = false;
  let failureSeverity: LifecycleGateVerdict['failureSeverity'] = 'none';

  switch (stage) {
    case 'development': {
      policy = 'Light eval. Failures are signal only and never escalate.';
      gatePassed = true;
      blocksPromotion = false;
      failureSeverity = failed > 0 ? 'low' : 'none';
      if (failed > 0) reasons.push(`${failed} failing case(s) — informational at development stage.`);
      else reasons.push('No failures recorded.');
      break;
    }
    case 'qa': {
      policy = 'Full eval. Gate requires >= 80% pass rate; failures alert the team.';
      gatePassed = passRate >= 80;
      blocksPromotion = !gatePassed;
      failureSeverity = failed > 0 ? 'medium' : 'none';
      reasons.push(`Pass rate ${passRate}% (threshold 80%).`);
      if (!gatePassed) reasons.push('Below QA threshold — team should be alerted.');
      break;
    }
    case 'uat': {
      policy = 'Regression + adversarial. All security cases must pass AND >= 90% overall. Failures BLOCK promotion.';
      const securityClean = securityFailed === 0;
      gatePassed = securityClean && passRate >= 90;
      blocksPromotion = !gatePassed;
      failureSeverity = !securityClean ? 'high' : failed > 0 ? 'medium' : 'none';
      reasons.push(`Pass rate ${passRate}% (threshold 90%).`);
      reasons.push(
        securityTotal > 0
          ? `Security/adversarial: ${securityPassed}/${securityTotal} passed.`
          : 'No security/adversarial cases in this run.',
      );
      if (!securityClean) reasons.push('Adversarial failures present — promotion blocked.');
      break;
    }
    case 'production': {
      policy = 'Continuous monitoring. Any failure is an incident; gate passes only at 100%.';
      gatePassed = failed === 0 && total > 0;
      blocksPromotion = false; // already at top stage
      failureSeverity = failed > 0 ? 'high' : 'none';
      if (failed > 0) reasons.push(`${failed} failing case(s) in production — raise an incident.`);
      else reasons.push('All production checks passed.');
      break;
    }
  }

  const nextStage = nextStageOf(stage);
  // Promotable only if there's a higher stage, the gate passed, the run had cases,
  // and current failures don't block promotion.
  const promotable = !!nextStage && gatePassed && total > 0 && !blocksPromotion;

  return {
    runId: testRunId,
    agentId,
    verdict: {
      stage,
      policy,
      stats,
      passed: gatePassed,
      blocksPromotion,
      promotable,
      nextStage,
      failureSeverity,
      reasons,
    },
  };
}
