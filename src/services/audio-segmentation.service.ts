import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import ffmpegStaticImport from 'ffmpeg-static';
import { logger } from './logger.service';

// `ffmpeg-static` returns the path to the bundled binary; inside the
// Alpine container we install ffmpeg via apk, so fall back to the system one.
const ffmpegPath: string =
  (typeof ffmpegStaticImport === 'string' && ffmpegStaticImport) ||
  (process.env.FFMPEG_PATH as string) ||
  'ffmpeg';

export type Speaker = 'user' | 'agent';

export interface DiarizationTurn {
  role: 'user' | 'agent';
  startMs: number;
  endMs: number;
}

/**
 * Convert ConversationTurn[] timestamps into wall-clock segments relative to
 * the start of the recording. The persisted `timestamp` field is unix-ms (set
 * at turn emit time); we normalise to "ms from first turn" and use the next
 * turn's start as the current turn's end (or +durationMs for the last turn).
 */
export function turnsToDiarization(
  turns: Array<{ role: string; timestamp?: number | string; durationMs?: number }>,
  recordingDurationMs?: number,
): DiarizationTurn[] {
  if (!turns?.length) return [];
  const parsed = turns
    .map((t) => {
      const tsRaw = t.timestamp;
      const ts = typeof tsRaw === 'string' ? Date.parse(tsRaw) : Number(tsRaw || 0);
      return {
        role: (t.role === 'user' ? 'user' : 'agent') as Speaker,
        ts: Number.isFinite(ts) ? ts : 0,
        durationMs: Number(t.durationMs || 0),
      };
    })
    .filter((t) => t.ts > 0)
    .sort((a, b) => a.ts - b.ts);

  if (!parsed.length) return [];
  const base = parsed[0].ts;
  const out: DiarizationTurn[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    const startMs = Math.max(0, cur.ts - base);
    const nextTs = i + 1 < parsed.length ? parsed[i + 1].ts : 0;
    let endMs: number;
    if (nextTs > cur.ts) {
      endMs = nextTs - base;
    } else if (cur.durationMs > 0) {
      endMs = startMs + cur.durationMs;
    } else if (recordingDurationMs && recordingDurationMs > startMs) {
      endMs = recordingDurationMs;
    } else {
      endMs = startMs + 4000; // 4s fallback for last turn when nothing else known
    }
    out.push({ role: cur.role, startMs, endMs });
  }
  return out;
}

/**
 * Build an ffmpeg `volume` filter that mutes every segment NOT belonging to
 * the requested speaker. The result is a same-length recording with the other
 * speaker silenced — ideal for "listen to user only" / "listen to agent only".
 *
 * Example for speaker='agent' with user turns [0-3s] and [8-10s]:
 *   volume=enable='between(t,0,3)':volume=0,volume=enable='between(t,8,10)':volume=0
 */
function buildMuteFilter(diarization: DiarizationTurn[], keepSpeaker: Speaker): string {
  const otherTurns = diarization.filter((t) => t.role !== keepSpeaker);
  if (!otherTurns.length) return 'anull';
  // Issue #20: when calls have hundreds of short turns, the per-turn `volume`
  // filter chain blows up the ffmpeg filtergraph (>50KB) and ffmpeg crashes
  // around the 100s mark while parsing it. Coalesce contiguous "other"
  // turns so the chain stays bounded.
  const sorted = [...otherTurns].sort((a, b) => a.startMs - b.startMs);
  const merged: DiarizationTurn[] = [];
  for (const t of sorted) {
    const last = merged[merged.length - 1];
    // Merge if the gap to the previous "other" turn is < 250ms.
    if (last && t.startMs - last.endMs < 250) {
      last.endMs = Math.max(last.endMs, t.endMs);
    } else {
      merged.push({ ...t });
    }
  }
  // Hard cap: keep the longest 200 mute segments. The remainder is rare
  // chatter and not worth crashing the pipeline over.
  const capped = merged.length > 200
    ? [...merged].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, 200)
    : merged;
  return capped
    .map((t) => {
      const s = (t.startMs / 1000).toFixed(3);
      const e = (t.endMs / 1000).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=0`;
    })
    .join(',');
}

function runFfmpeg(args: string[], timeoutMs = 600_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`ffmpeg timeout after ${timeoutMs}ms: ${stderr.slice(-500)}`));
    }, timeoutMs);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      // Cap stderr accumulation to avoid memory pressure on long jobs.
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export interface SegmentationResult {
  outputPath: string;
  cached: boolean;
}

/**
 * Produce (or return cached) per-speaker WAV file. Inputs:
 *   - inputPath: full path to the mixed recording (raw ulaw OR wav OR mp3)
 *   - diarization: per-turn time windows (see turnsToDiarization)
 *   - speaker: 'user' | 'agent'
 *   - outputDir: where to write the cached file
 *   - cacheKey: unique stem for the output file (e.g. testRunId_batchId)
 *
 * The mixed audio is decoded by ffmpeg and re-encoded to wav with the other
 * speaker's turns muted via the `volume`/`between` filter.
 */
export async function segmentSpeaker(
  inputPath: string,
  diarization: DiarizationTurn[],
  speaker: Speaker,
  outputDir: string,
  cacheKey: string,
): Promise<SegmentationResult> {
  const outputPath = path.join(outputDir, `${cacheKey}.${speaker}.wav`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
    return { outputPath, cached: true };
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input audio not found: ${inputPath}`);
  }
  const filter = buildMuteFilter(diarization, speaker);

  // Build args. `.raw` files are assumed to be 8kHz mono mu-law (the only
  // raw format produced by the platform); for everything else we let ffmpeg
  // auto-detect.
  const isUlaw = inputPath.toLowerCase().endsWith('.raw');
  const args: string[] = ['-y', '-loglevel', 'error'];
  if (isUlaw) {
    args.push('-f', 'mulaw', '-ar', '8000', '-ac', '1');
  }
  args.push('-i', inputPath, '-af', filter, '-ac', '1', '-ar', '16000', outputPath);

  const t0 = Date.now();
  await runFfmpeg(args);
  logger.info(
    `[AudioSegmentation] Generated ${speaker} track for ${cacheKey} in ${Date.now() - t0}ms`,
  );
  return { outputPath, cached: false };
}
