/**
 * Item 13: Latency simulation routes.
 *   GET  /api/latency-simulation/profiles                       -> default profiles
 *   POST /api/latency-simulation/run/:testRunId  { profiles? }   -> simulate
 */

import { Router, Request, Response } from 'express';
import {
  simulateLatencyAcrossConfigs,
  DEFAULT_PROFILES,
  type StackProfile,
} from '../services/latency-simulation.service';
import { logger } from '../services/logger.service';

const router = Router();

router.get('/profiles', (_req, res) => {
  res.json({ success: true, profiles: DEFAULT_PROFILES });
});

router.post('/run/:testRunId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    const { testRunId } = req.params;
    const profiles: StackProfile[] = Array.isArray(req.body?.profiles) && req.body.profiles.length > 0
      ? req.body.profiles
      : DEFAULT_PROFILES;

    // Light validation
    for (const p of profiles) {
      if (!p?.name || !p?.stt || !p?.llm || !p?.tts) {
        return res.status(400).json({ success: false, error: 'profile entries must have name, stt, llm, tts' });
      }
    }

    const report = await simulateLatencyAcrossConfigs(testRunId, userId, profiles);
    res.json({ success: true, ...report });
  } catch (err: any) {
    logger.error(`[LatencySimulation] error: ${err.message}`);
    res.status(err.message === 'Test run not found' ? 404 : 500).json({ success: false, error: err.message });
  }
});

export default router;
