/**
 * t09: Pitch / voice consistency analysis from a recorded audio file.
 *
 * True F0 (fundamental frequency) tracking needs a dedicated DSP library. As a
 * production-pragmatic and dependency-free approach we use ffmpeg's
 * `aspectralstats` filter to extract the spectral CENTROID per analysis frame
 * (a well-established proxy for perceived pitch/brightness), then measure how
 * STABLE that centroid is across the utterance:
 *   - mean centroid (Hz-ish)
 *   - stddev + coefficient of variation (CV = stddev/mean)
 *   - a 0-100 consistency score (lower variation => more consistent pitch)
 *
 * ffmpeg is already a dependency (ffmpeg-static + audio-segmentation.service).
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import ffmpegStaticImport from 'ffmpeg-static';
import { logger } from './logger.service';

const ffmpegPath: string =
  (typeof ffmpegStaticImport === 'string' && ffmpegStaticImport) ||
  (process.env.FFMPEG_PATH as string) ||
  'ffmpeg';

export interface PitchConsistencyReport {
  framesAnalysed: number;
  meanCentroidHz: number;
  stddevCentroidHz: number;
  coefficientOfVariation: number; // stddev / mean
  consistencyScore: number; // 0-100
  rating: 'very_consistent' | 'consistent' | 'variable' | 'erratic';
  notes: string[];
}

function runFfmpegCaptureStdout(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      // aspectralstats prints metadata to stdout; some builds route ametadata to
      // stderr, so we concatenate both before parsing.
      if (code === 0 || stdout.length > 0 || stderr.length > 0) {
        resolve(stdout + '\n' + stderr);
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
      }
    });
  });
}

function std(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Analyse pitch consistency for an audio file on disk.
 * @param filePath absolute path to the recording (.raw ulaw or .mp3/.wav)
 */
export async function analysePitchConsistency(filePath: string): Promise<PitchConsistencyReport> {
  if (!fs.existsSync(filePath)) {
    throw new Error('Audio file not found');
  }

  // Twilio recordings are raw 8kHz mono mu-law; everything else is a normal
  // container ffmpeg can sniff.
  const isRawUlaw = filePath.toLowerCase().endsWith('.raw');
  const inputArgs = isRawUlaw ? ['-f', 'mulaw', '-ar', '8000', '-ac', '1', '-i', filePath] : ['-i', filePath];

  const args = [
    ...inputArgs,
    '-af',
    'aspectralstats=measure=centroid,ametadata=mode=print:file=-',
    '-f',
    'null',
    '-',
  ];

  const output = await runFfmpegCaptureStdout(args);

  const centroids: number[] = [];
  const re = /centroid=([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v > 0) centroids.push(v);
  }

  if (centroids.length === 0) {
    logger.info('[PitchAnalysis] no centroid frames parsed', { filePath });
    return {
      framesAnalysed: 0,
      meanCentroidHz: 0,
      stddevCentroidHz: 0,
      coefficientOfVariation: 0,
      consistencyScore: 0,
      rating: 'erratic',
      notes: ['Could not extract spectral frames — audio may be silent or unsupported.'],
    };
  }

  const mean = centroids.reduce((a, b) => a + b, 0) / centroids.length;
  const stddev = std(centroids, mean);
  const cv = mean > 0 ? stddev / mean : 0;

  // Map coefficient of variation to a 0-100 consistency score. Empirically a CV
  // below ~0.15 is very stable speech; above ~0.6 is erratic.
  const consistencyScore = Math.max(0, Math.min(100, Math.round(100 - cv * 140)));

  let rating: PitchConsistencyReport['rating'];
  if (consistencyScore >= 85) rating = 'very_consistent';
  else if (consistencyScore >= 65) rating = 'consistent';
  else if (consistencyScore >= 40) rating = 'variable';
  else rating = 'erratic';

  const notes: string[] = [];
  if (cv > 0.6) notes.push('High spectral variation — pitch swings widely, may sound unstable or robotic.');
  if (mean < 150) notes.push('Low mean centroid — voice is on the darker/lower end.');
  if (centroids.length < 10) notes.push('Few frames analysed — result is approximate for a short clip.');

  return {
    framesAnalysed: centroids.length,
    meanCentroidHz: Math.round(mean),
    stddevCentroidHz: Math.round(stddev),
    coefficientOfVariation: Math.round(cv * 1000) / 1000,
    consistencyScore,
    rating,
    notes,
  };
}
