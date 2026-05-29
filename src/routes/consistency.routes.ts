import { Router } from 'express';
import { requireAuth } from '@clerk/express';
import {
  startConsistencyTest,
  getConsistencyRun,
  getAgentConsistencyRuns,
  getConsistencySummary,
} from '../controllers/consistency.controller';
import { requireSubscriptionAndCredits, FeatureKeys } from '../middleware/credits.middleware';

const router = Router();

// Agent-specific routes
router.post('/agents/:agentId/consistency-tests', requireAuth(), 
  ...requireSubscriptionAndCredits(FeatureKeys.CONSISTENCY_TEST_RUN, (req) => {
    // Default 5 iterations × 3 prompts = 15 calls, charge per iteration
    return req.body?.iterations || 5;
  }),
  startConsistencyTest
);
router.get('/agents/:agentId/consistency-tests', requireAuth(), getAgentConsistencyRuns);
router.get('/agents/:agentId/consistency-summary', requireAuth(), getConsistencySummary);

// Individual run route
router.get('/consistency-tests/:runId', requireAuth(), getConsistencyRun);

export default router;
