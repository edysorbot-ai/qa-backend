/**
 * Item 13: latency simulation across STT/TTS/LLM configs.
 *
 * Reads an existing test_run, then replays each agent turn under a set of
 * named stack profiles, returning a comparison report. This does NOT
 * actually re-call the LLM/STT/TTS — it uses published typical latencies
 * for each component and the response's text length to estimate timing.
 *
 * Output is intended to answer "if we switch our agent from
 * (Whisper + gpt-4o + ElevenLabs) to (Deepgram + claude-haiku + Polly),
 * what would happen to p50/p95 turn latency?"
 */

import pool from '../db';

export interface StackProfile {
  name: string;
  stt: 'whisper' | 'deepgram' | 'google_stt' | 'azure_stt' | 'aws_transcribe';
  llm: 'gpt-4o' | 'gpt-4o-mini' | 'gpt-3.5-turbo' | 'claude-3-5-sonnet' | 'claude-3-haiku' | 'gemini-1.5-pro' | 'gemini-1.5-flash' | 'llama-3-70b';
  tts: 'elevenlabs' | 'polly' | 'google_tts' | 'azure_tts' | 'cartesia';
}

// Published typical latencies (ms) — conservative averages.
const STT_MS: Record<StackProfile['stt'], number> = {
  whisper: 350,
  deepgram: 180,
  google_stt: 280,
  azure_stt: 260,
  aws_transcribe: 320,
};

// LLM: per-token latencies in ms-per-token + base.
const LLM_BASE_MS: Record<StackProfile['llm'], number> = {
  'gpt-4o': 480,
  'gpt-4o-mini': 280,
  'gpt-3.5-turbo': 200,
  'claude-3-5-sonnet': 520,
  'claude-3-haiku': 200,
  'gemini-1.5-pro': 460,
  'gemini-1.5-flash': 220,
  'llama-3-70b': 380,
};
const LLM_PER_TOKEN_MS: Record<StackProfile['llm'], number> = {
  'gpt-4o': 18,
  'gpt-4o-mini': 12,
  'gpt-3.5-turbo': 10,
  'claude-3-5-sonnet': 22,
  'claude-3-haiku': 11,
  'gemini-1.5-pro': 18,
  'gemini-1.5-flash': 9,
  'llama-3-70b': 16,
};

// TTS: ms per char of response.
const TTS_PER_CHAR_MS: Record<StackProfile['tts'], number> = {
  elevenlabs: 1.4,
  polly: 0.8,
  google_tts: 1.0,
  azure_tts: 1.1,
  cartesia: 1.6,
};
const TTS_BASE_MS: Record<StackProfile['tts'], number> = {
  elevenlabs: 220,
  polly: 120,
  google_tts: 160,
  azure_tts: 150,
  cartesia: 200,
};

export interface SimulatedTurnLatency {
  agentTurnIndex: number;
  textLength: number;
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface SimulatedProfileReport {
  profile: StackProfile;
  perTurn: SimulatedTurnLatency[];
  totals: { sttMs: number; llmMs: number; ttsMs: number; totalMs: number };
  p50TotalMs: number;
  p95TotalMs: number;
  p99TotalMs: number;
  avgTotalMs: number;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function estimateTokens(text: string): number {
  // Heuristic: 1 token ~= 4 chars in English.
  return Math.max(8, Math.round((text || '').length / 4));
}

function simulateOneTurn(text: string, profile: StackProfile): SimulatedTurnLatency {
  const tokens = estimateTokens(text);
  const sttMs = STT_MS[profile.stt];
  const llmMs = LLM_BASE_MS[profile.llm] + tokens * LLM_PER_TOKEN_MS[profile.llm];
  const ttsMs = TTS_BASE_MS[profile.tts] + Math.round((text || '').length * TTS_PER_CHAR_MS[profile.tts]);
  return {
    agentTurnIndex: -1,
    textLength: (text || '').length,
    sttMs,
    llmMs,
    ttsMs,
    totalMs: sttMs + llmMs + ttsMs,
  };
}

/**
 * Load all agent turns for a test run, then simulate under each profile.
 */
export async function simulateLatencyAcrossConfigs(
  testRunId: string,
  userId: string,
  profiles: StackProfile[],
): Promise<{
  testRunId: string;
  agentTurnsAnalysed: number;
  reports: SimulatedProfileReport[];
}> {
  // Owner check
  const ownerCheck = await pool.query(
    `SELECT 1 FROM test_runs WHERE id = $1 AND user_id = $2`,
    [testRunId, userId],
  );
  if (ownerCheck.rows.length === 0) {
    throw new Error('Test run not found');
  }

  const rows = await pool.query(
    `SELECT conversation_turns FROM test_results
     WHERE test_run_id = $1
       AND conversation_turns IS NOT NULL`,
    [testRunId],
  );

  const agentTurns: string[] = [];
  for (const r of rows.rows) {
    let turns = r.conversation_turns;
    if (typeof turns === 'string') {
      try { turns = JSON.parse(turns); } catch { turns = []; }
    }
    if (Array.isArray(turns)) {
      for (const t of turns) {
        const role = t.role || t.speaker;
        if (role === 'agent' || role === 'ai_agent' || role === 'bot') {
          agentTurns.push(t.content || t.text || t.message || '');
        }
      }
    }
  }

  const reports: SimulatedProfileReport[] = profiles.map(profile => {
    const perTurn = agentTurns.map((text, idx) => ({
      ...simulateOneTurn(text, profile),
      agentTurnIndex: idx,
    }));
    const totals = perTurn.reduce(
      (acc, t) => ({
        sttMs: acc.sttMs + t.sttMs,
        llmMs: acc.llmMs + t.llmMs,
        ttsMs: acc.ttsMs + t.ttsMs,
        totalMs: acc.totalMs + t.totalMs,
      }),
      { sttMs: 0, llmMs: 0, ttsMs: 0, totalMs: 0 },
    );
    const totals_per_turn = perTurn.map(t => t.totalMs);
    return {
      profile,
      perTurn,
      totals,
      p50TotalMs: percentile(totals_per_turn, 50),
      p95TotalMs: percentile(totals_per_turn, 95),
      p99TotalMs: percentile(totals_per_turn, 99),
      avgTotalMs: perTurn.length === 0 ? 0 : Math.round(totals.totalMs / perTurn.length),
    };
  });

  return {
    testRunId,
    agentTurnsAnalysed: agentTurns.length,
    reports,
  };
}

export const DEFAULT_PROFILES: StackProfile[] = [
  { name: 'Fast & cheap', stt: 'deepgram', llm: 'gpt-4o-mini', tts: 'polly' },
  { name: 'Balanced', stt: 'deepgram', llm: 'gpt-4o-mini', tts: 'elevenlabs' },
  { name: 'High quality', stt: 'whisper', llm: 'gpt-4o', tts: 'elevenlabs' },
  { name: 'Claude stack', stt: 'deepgram', llm: 'claude-3-haiku', tts: 'cartesia' },
  { name: 'Gemini stack', stt: 'google_stt', llm: 'gemini-1.5-flash', tts: 'google_tts' },
];
