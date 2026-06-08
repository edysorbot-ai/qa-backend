/**
 * Item 11: per-action latency attribution.
 *
 * Real production telemetry comes from provider webhooks (ElevenLabs, VAPI,
 * Retell all expose component-level timings). When that data is present we
 * surface it as-is. When it is missing (e.g. older recordings or providers
 * that do not break it down), we fall back to a heuristic split based on
 * the agent turn's text length and total measured durationMs.
 *
 * The heuristic split percentages are taken from public benchmarks of voice
 * agent stacks (rough average for an end-to-end voice turn):
 *   STT  ~ 15-20%   LLM ~ 35-45%   Tool (when invoked) ~ 10-20%   TTS ~ 25-30%
 *
 * When there is no tool call, the share is redistributed across STT/LLM/TTS.
 */

export type LatencyBreakdown = {
  sttMs?: number;
  llmMs?: number;
  toolMs?: number;
  ttsMs?: number;
  otherMs?: number;
  source?: 'provider' | 'heuristic';
};

export interface AttributionInput {
  totalDurationMs: number;
  hasToolCall: boolean;
  textLength: number; // length of the agent's spoken/written response (chars)
  providerBreakdown?: LatencyBreakdown;
}

/**
 * Returns a breakdown that always sums (approximately) to totalDurationMs.
 */
export function attributeLatency(input: AttributionInput): LatencyBreakdown {
  if (input.providerBreakdown && Object.keys(input.providerBreakdown).length > 0) {
    return { ...input.providerBreakdown, source: 'provider' };
  }

  const total = Math.max(0, input.totalDurationMs || 0);
  if (total === 0) {
    return { source: 'heuristic' };
  }

  // Base shares
  let stt = 0.17;
  let llm = 0.40;
  let tool = input.hasToolCall ? 0.18 : 0;
  let tts = 0.28;
  // Slight bump for TTS when the response is long.
  if (input.textLength > 240) {
    tts += 0.05;
    llm -= 0.03;
    stt -= 0.02;
  }
  // Normalise to 1.0
  const sum = stt + llm + tool + tts;
  stt /= sum; llm /= sum; tool /= sum; tts /= sum;

  const sttMs = Math.round(total * stt);
  const llmMs = Math.round(total * llm);
  const toolMs = input.hasToolCall ? Math.round(total * tool) : 0;
  const ttsMs = Math.round(total * tts);
  const otherMs = Math.max(0, total - (sttMs + llmMs + toolMs + ttsMs));

  return {
    sttMs,
    llmMs,
    toolMs: input.hasToolCall ? toolMs : undefined,
    ttsMs,
    otherMs: otherMs > 0 ? otherMs : undefined,
    source: 'heuristic',
  };
}

/**
 * Aggregate per-action latency across a whole transcript.
 * Returns sum + average per component.
 */
export function aggregateLatencyAttribution(
  turns: Array<{
    role: 'user' | 'agent' | string;
    latency_breakdown?: LatencyBreakdown;
  }>,
): {
  totals: { sttMs: number; llmMs: number; toolMs: number; ttsMs: number; otherMs: number };
  agentTurnCount: number;
  toolCalls: number;
  providerSourceShare: number; // 0..1 — what fraction of agent turns had provider data
} {
  const totals = { sttMs: 0, llmMs: 0, toolMs: 0, ttsMs: 0, otherMs: 0 };
  let agentTurnCount = 0;
  let toolCalls = 0;
  let providerTurns = 0;
  for (const t of turns) {
    if (t.role !== 'agent') continue;
    agentTurnCount++;
    const b = t.latency_breakdown || {};
    if (b.source === 'provider') providerTurns++;
    totals.sttMs += b.sttMs || 0;
    totals.llmMs += b.llmMs || 0;
    totals.toolMs += b.toolMs || 0;
    totals.ttsMs += b.ttsMs || 0;
    totals.otherMs += b.otherMs || 0;
    if (b.toolMs && b.toolMs > 0) toolCalls++;
  }
  return {
    totals,
    agentTurnCount,
    toolCalls,
    providerSourceShare: agentTurnCount === 0 ? 0 : providerTurns / agentTurnCount,
  };
}
