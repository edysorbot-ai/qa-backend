/**
 * Items 8 & 16: TTS and ASR quality evaluation routes.
 *   POST /api/voice-quality/tts   { spokenText, audioDurationMs? }
 *   POST /api/voice-quality/asr   { expectedScript, actualTranscript }
 */

import { Router, Request, Response } from 'express';
import * as path from 'path';
import { evaluateTtsQuality, evaluateAsrQuality } from '../services/tts-asr-quality.service';
import { analysePitchConsistency } from '../services/pitch-analysis.service';

const router = Router();

const recordingsDir = path.join(__dirname, '../../recordings');

router.post('/tts', (req: Request, res: Response) => {
  try {
    const { spokenText, audioDurationMs } = req.body || {};
    if (typeof spokenText !== 'string') {
      return res.status(400).json({ success: false, error: 'spokenText is required' });
    }
    const report = evaluateTtsQuality({ spokenText, audioDurationMs });
    res.json({ success: true, ...report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/asr', (req: Request, res: Response) => {
  try {
    const { expectedScript, actualTranscript } = req.body || {};
    if (typeof expectedScript !== 'string' || typeof actualTranscript !== 'string') {
      return res.status(400).json({ success: false, error: 'expectedScript and actualTranscript are required' });
    }
    const report = evaluateAsrQuality(expectedScript, actualTranscript);
    res.json({ success: true, ...report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * t09: pitch / voice consistency analysis from a stored recording.
 *   POST /api/voice-quality/pitch  { filename }
 * `filename` is the recording file name (as referenced by /api/audio/:filename
 * or agent_audio_url). Resolved safely inside the recordings dir.
 */
router.post('/pitch', async (req: Request, res: Response) => {
  try {
    let { filename } = req.body || {};
    if (typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ success: false, error: 'filename is required' });
    }
    // Accept either a bare filename or a /api/audio/<file> URL.
    filename = filename.split('/').pop() as string;
    const safeName = path.basename(filename);
    const filePath = path.join(recordingsDir, safeName);
    if (!filePath.startsWith(recordingsDir)) {
      return res.status(400).json({ success: false, error: 'invalid filename' });
    }
    const report = await analysePitchConsistency(filePath);
    res.json({ success: true, filename: safeName, ...report });
  } catch (err: any) {
    const notFound = err?.message === 'Audio file not found';
    res.status(notFound ? 404 : 500).json({ success: false, error: err.message });
  }
});

export default router;
