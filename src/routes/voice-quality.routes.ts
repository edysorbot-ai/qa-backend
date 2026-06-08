/**
 * Items 8 & 16: TTS and ASR quality evaluation routes.
 *   POST /api/voice-quality/tts   { spokenText, audioDurationMs? }
 *   POST /api/voice-quality/asr   { expectedScript, actualTranscript }
 */

import { Router, Request, Response } from 'express';
import { evaluateTtsQuality, evaluateAsrQuality } from '../services/tts-asr-quality.service';

const router = Router();

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

export default router;
