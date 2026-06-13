/**
 * Agent Prompt Amendment Service
 *
 * When a user marks a test verdict wrong via the feedback dialog, two things
 * can be done:
 *
 *   1. Steer the evaluator only (existing `false_positive_patterns` / 
 *      `false_negative_patterns` path) — useful when the rubric was wrong
 *      but the agent itself is fine.
 *
 *   2. Amend the *agent's* system prompt so the agent stops producing the
 *      problematic behaviour in the first place. This is the path
 *      implemented here. The amendment is NOT auto-applied; it is dry-run
 *      against the failing scenario plus two sampled scenarios for the
 *      same agent so the user can see the impact before pushing it to the
 *      live agent.
 *
 * Dry-run uses the same OpenAI client to (a) simulate an agent response
 * to each scenario under BOTH the original and amended prompts, (b)
 * evaluate each simulated response with the rubric. The verdict pair per
 * scenario is recorded as a `verification_runs` entry. Status becomes
 * `verified` if the failing case improves and the others do not regress;
 * otherwise it stays `proposed` and the user must decide whether to apply
 * or reject.
 */

import OpenAI from 'openai';
import pool from '../db';
import { logger } from './logger.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4o-mini';
const DRY_RUN_SCENARIO_COUNT = 3; // 1 failing case + up to 2 other recent cases

export interface DryRunVerdict {
  scenario: string;
  expected: string | null;
  simulated_response_original: string;
  simulated_response_amended: string;
  original_passed: boolean;
  amended_passed: boolean;
  improved: boolean;            // amended better than original on this scenario
  regressed: boolean;           // amended worse than original on this scenario
  is_failing_case: boolean;     // true for the scenario that triggered the amendment
}

export interface AmendmentResult {
  amendmentId: string;
  status: 'proposed' | 'verified' | 'rejected';
  amendmentSummary: string;
  amendedPrompt: string;
  originalPrompt: string;
  verificationRuns: DryRunVerdict[];
  fixedFailingCase: boolean;
  regressionCount: number;
}

interface ScenarioForVerification {
  testCaseId: string | null;
  name: string;
  scenario: string;
  expectedBehavior: string | null;
  isFailingCase: boolean;
}

/**
 * Generate a minimal prompt amendment from the failing transcript + user feedback.
 */
async function generateAmendment(
  originalPrompt: string,
  failingScenario: string,
  failingExpected: string | null,
  failingTranscript: string,
  userFeedback: string,
): Promise<{ amended_prompt: string; summary: string }> {
  const system = `You are an expert at refining LLM system prompts for voice agents. You will be given:
  - the agent's current system prompt
  - a single failing test scenario the user disputes
  - the conversation transcript that failed
  - the user's feedback explaining what the agent SHOULD have done

Your job: produce the SMALLEST possible targeted edit to the system prompt that fixes the failure WITHOUT changing unrelated behaviour. Prefer adding 1-3 short rules over rewriting paragraphs. Never delete brand voice, identity, or safety lines.

Return JSON ONLY:
{
  "amended_prompt": "<full amended system prompt>",
  "summary": "<one sentence describing what changed and why>"
}`;

  const user = `CURRENT SYSTEM PROMPT:
"""
${originalPrompt}
"""

FAILING SCENARIO:
${failingScenario}

EXPECTED AGENT BEHAVIOUR:
${failingExpected || '(not specified)'}

TRANSCRIPT THAT FAILED:
${failingTranscript || '(no transcript provided)'}

USER FEEDBACK (authoritative — this is what they want fixed):
${userFeedback}

Return the JSON.`;

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_tokens: 2000,
  });

  const parsed = JSON.parse(resp.choices[0].message.content || '{}');
  return {
    amended_prompt: typeof parsed.amended_prompt === 'string' && parsed.amended_prompt.trim()
      ? parsed.amended_prompt
      : originalPrompt,
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
  };
}

/**
 * For a single scenario, generate (simulated agent reply, pass/fail verdict)
 * under both the original and the amended prompt in ONE LLM call to keep
 * cost down.
 */
async function dryRunScenario(
  originalPrompt: string,
  amendedPrompt: string,
  scenario: ScenarioForVerification,
): Promise<DryRunVerdict> {
  const system = `You are a strict QA judge. You will simulate an LLM voice agent's likely first response under TWO different system prompts (A = original, B = amended) for the SAME caller scenario, and then grade each response against the expected behaviour.

Be honest: if both responses would be equivalent, mark both with the same verdict. Do not invent improvements that the amendment does not actually cause.

Return JSON ONLY:
{
  "simulated_A": "what the agent would say under prompt A (1-3 sentences)",
  "simulated_B": "what the agent would say under prompt B (1-3 sentences)",
  "verdict_A_passed": true|false,
  "verdict_B_passed": true|false,
  "rationale": "one short sentence"
}`;

  const user = `CALLER SCENARIO:
${scenario.scenario}

EXPECTED AGENT BEHAVIOUR:
${scenario.expectedBehavior || '(no specific expected behaviour — judge by general appropriateness)'}

PROMPT A (original):
"""
${originalPrompt}
"""

PROMPT B (amended):
"""
${amendedPrompt}
"""

Simulate and grade.`;

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_tokens: 800,
  });

  const parsed = JSON.parse(resp.choices[0].message.content || '{}');
  const origPass = !!parsed.verdict_A_passed;
  const amPass = !!parsed.verdict_B_passed;

  return {
    scenario: scenario.scenario,
    expected: scenario.expectedBehavior,
    simulated_response_original: String(parsed.simulated_A || ''),
    simulated_response_amended: String(parsed.simulated_B || ''),
    original_passed: origPass,
    amended_passed: amPass,
    improved: !origPass && amPass,
    regressed: origPass && !amPass,
    is_failing_case: scenario.isFailingCase,
  };
}

/**
 * Sample N-1 other recent test cases for the same agent, used as
 * regression-checks during dry-run.
 */
async function sampleSiblingScenarios(
  agentId: string,
  excludeTestCaseId: string | null,
  limit: number,
): Promise<ScenarioForVerification[]> {
  const params: any[] = [agentId];
  let exclusion = '';
  if (excludeTestCaseId) {
    params.push(excludeTestCaseId);
    exclusion = `AND id != $${params.length}`;
  }
  params.push(limit);
  const q = await pool.query(
    `SELECT id, name, scenario, expected_behavior
     FROM test_cases
     WHERE agent_id = $1
       ${exclusion}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return q.rows.map(r => ({
    testCaseId: r.id,
    name: r.name,
    scenario: r.scenario,
    expectedBehavior: r.expected_behavior,
    isFailingCase: false,
  }));
}

/**
 * Main entry. Loads the failing result + agent, asks the LLM for a minimal
 * amendment, dry-runs it on the failing scenario + 2 sampled siblings,
 * persists the amendment, and returns the verification summary so the UI
 * can show before/after and prompt the user to apply or reject.
 */
export async function proposeAgentPromptAmendment(args: {
  resultId: string;
  feedback: string;
  userId: string;
}): Promise<AmendmentResult> {
  const { resultId, feedback, userId } = args;

  // Load result + agent prompt + failing test case context.
  const resQ = await pool.query(
    `SELECT tr.id as result_id,
            tr.test_case_id,
            tr.actual_response,
            tr.expected_response,
            tr.scenario,
            tr.user_input,
            tr.conversation_turns,
            tc.id as tc_id,
            tc.name as tc_name,
            tc.scenario as tc_scenario,
            tc.expected_behavior as tc_expected,
            tc.agent_id,
            COALESCE(ag.prompt, ag.config->>'prompt', ag.config->'agent'->>'prompt') as agent_prompt
     FROM test_results tr
     LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
     LEFT JOIN agents ag ON tc.agent_id = ag.id
     WHERE tr.id = $1`,
    [resultId],
  );
  if (resQ.rows.length === 0) {
    throw new Error('Test result not found');
  }
  const row = resQ.rows[0];
  if (!row.agent_id) {
    throw new Error('No agent linked to this test result; cannot amend prompt');
  }
  if (!row.agent_prompt) {
    throw new Error('Agent has no prompt configured. Sync the agent from its provider or set a prompt on the agent before improving the test agent.');
  }

  // Render the failing transcript so the LLM can read it.
  let transcript: Array<{ role: string; content: string }> = [];
  if (row.conversation_turns) {
    try {
      transcript = typeof row.conversation_turns === 'string'
        ? JSON.parse(row.conversation_turns)
        : row.conversation_turns;
    } catch { transcript = []; }
  }
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map((t, i) =>
        `[Turn ${i}] ${(t.role || '').toUpperCase()}: ${String(t.content || '').slice(0, 400)}`,
      ).join('\n')
    : `User said: ${row.user_input || row.scenario || ''}\nAgent said: ${row.actual_response || ''}`;

  const failingScenarioText = row.tc_scenario || row.scenario || row.user_input || '';
  const failingExpected = row.tc_expected || row.expected_response || null;

  // 1. Generate a minimal amendment.
  const { amended_prompt, summary } = await generateAmendment(
    row.agent_prompt,
    failingScenarioText,
    failingExpected,
    transcriptText,
    feedback,
  );

  // 2. Build verification set: failing case + 2 recent siblings.
  const failingScenario: ScenarioForVerification = {
    testCaseId: row.tc_id || null,
    name: row.tc_name || 'Failing case',
    scenario: failingScenarioText,
    expectedBehavior: failingExpected,
    isFailingCase: true,
  };
  const siblings = await sampleSiblingScenarios(
    row.agent_id,
    row.tc_id,
    Math.max(0, DRY_RUN_SCENARIO_COUNT - 1),
  );
  const scenarios = [failingScenario, ...siblings];

  // 3. Dry-run in parallel (3 LLM calls).
  const verificationRuns: DryRunVerdict[] = await Promise.all(
    scenarios.map(s => dryRunScenario(row.agent_prompt, amended_prompt, s).catch(err => {
      logger.warn('[Amendment] dry-run failed for one scenario', { detail: err.message });
      return {
        scenario: s.scenario,
        expected: s.expectedBehavior,
        simulated_response_original: '',
        simulated_response_amended: '',
        original_passed: false,
        amended_passed: false,
        improved: false,
        regressed: false,
        is_failing_case: s.isFailingCase,
      } as DryRunVerdict;
    })),
  );

  const failingRun = verificationRuns.find(r => r.is_failing_case);
  const fixedFailingCase = !!(failingRun && failingRun.improved);
  const regressionCount = verificationRuns.filter(r => !r.is_failing_case && r.regressed).length;
  const status: 'proposed' | 'verified' = fixedFailingCase && regressionCount === 0
    ? 'verified'
    : 'proposed';

  // 4. Persist.
  const ins = await pool.query(
    `INSERT INTO agent_prompt_amendments
       (agent_id, user_id, source_result_id, user_feedback,
        original_prompt, amended_prompt, amendment_summary,
        verification_runs, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      row.agent_id,
      userId,
      resultId,
      feedback,
      row.agent_prompt,
      amended_prompt,
      summary,
      JSON.stringify(verificationRuns),
      status,
    ],
  );

  return {
    amendmentId: ins.rows[0].id,
    status,
    amendmentSummary: summary,
    amendedPrompt: amended_prompt,
    originalPrompt: row.agent_prompt,
    verificationRuns,
    fixedFailingCase,
    regressionCount,
  };
}

/**
 * Push an amendment into agents.system_prompt and mark it applied.
 * Returns the new agent system prompt.
 */
export async function applyAgentPromptAmendment(args: {
  amendmentId: string;
  userId: string;
}): Promise<{ agentId: string; appliedPrompt: string }> {
  const { amendmentId, userId } = args;
  const q = await pool.query(
    `SELECT a.id, a.agent_id, a.amended_prompt, a.status, ag.user_id as agent_owner
     FROM agent_prompt_amendments a
     LEFT JOIN agents ag ON a.agent_id = ag.id
     WHERE a.id = $1`,
    [amendmentId],
  );
  if (q.rows.length === 0) throw new Error('Amendment not found');
  const row = q.rows[0];
  if (row.status === 'applied') throw new Error('Amendment already applied');
  if (row.status === 'rejected') throw new Error('Amendment was rejected');

  await pool.query(
    `UPDATE agents SET prompt = $1, updated_at = NOW() WHERE id = $2`,
    [row.amended_prompt, row.agent_id],
  );
  await pool.query(
    `UPDATE agent_prompt_amendments
       SET status = 'applied', applied_at = NOW(), user_id = $1
       WHERE id = $2`,
    [userId, amendmentId],
  );

  return { agentId: row.agent_id, appliedPrompt: row.amended_prompt };
}

export async function rejectAgentPromptAmendment(amendmentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_prompt_amendments SET status = 'rejected' WHERE id = $1`,
    [amendmentId],
  );
}

export async function listAmendmentsForAgent(agentId: string): Promise<any[]> {
  const q = await pool.query(
    `SELECT id, agent_id, source_result_id, user_feedback, amendment_summary,
            verification_runs, status, created_at, applied_at
     FROM agent_prompt_amendments
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [agentId],
  );
  return q.rows;
}
