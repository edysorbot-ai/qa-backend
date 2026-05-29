import { Router, Request, Response } from 'express';
import { logger } from '../services/logger.service';
import { abTestService } from '../services/ab-test.service';
import { requireSubscriptionAndCredits, FeatureKeys } from '../middleware/credits.middleware';

const router = Router();

/**
 * Create a new A/B test
 */
router.post('/', requireSubscriptionAndCredits(FeatureKeys.PROMPT_ANALYZE), async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, name, promptA, promptB, promptALabel, promptBLabel, testCaseIds, sampleSize } = req.body;

    if (!agentId || !promptA || !promptB || !testCaseIds?.length) {
      return res.status(400).json({ success: false, error: 'agentId, promptA, promptB, and testCaseIds are required' });
    }

    const id = await abTestService.createABTest({
      userId,
      agentId,
      name: name || `A/B Test ${new Date().toLocaleDateString()}`,
      promptA,
      promptB,
      promptALabel,
      promptBLabel,
      testCaseIds,
      sampleSize,
    });

    // Start the test asynchronously
    abTestService.runABTest(id).catch(err => {
      logger.error(`[ABTest] Background execution failed for ${id}: ${err.message}`);
    });

    res.json({ success: true, id, message: 'A/B test started' });
  } catch (error: any) {
    logger.error(`[ABTest] Create error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get all A/B tests for user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.query;
    
    const tests = await abTestService.getABTests(userId, agentId as string);
    res.json({ success: true, tests });
  } catch (error: any) {
    logger.error(`[ABTest] List error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a single A/B test with results
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const test = await abTestService.getABTest(req.params.id);
    if (!test) {
      return res.status(404).json({ success: false, error: 'A/B test not found' });
    }
    res.json({ success: true, test });
  } catch (error: any) {
    logger.error(`[ABTest] Get error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
