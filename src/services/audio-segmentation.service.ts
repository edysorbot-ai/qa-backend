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
  return otherTurns
    .map((t) => {
      const s = (t.startMs / 1000).toFixed(3);
      const e = (t.endMs / 1000).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=0`;
    })
    .join(',');
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
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
