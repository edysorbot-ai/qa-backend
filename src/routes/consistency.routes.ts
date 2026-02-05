import { Router } from 'express';
import { requireAuth } from '@clerk/express';
import {
  startConsistencyTest,
  getConsistencyRun,
  getAgentConsistencyRuns,
  getConsistencySummary,
} from '../controllers/consistency.controller';

const router = Router();

// Agent-specific routes
router.post('/agents/:agentId/consistency-tests', requireAuth(), startConsistencyTest);
router.get('/agents/:agentId/consistency-tests', requireAuth(), getAgentConsistencyRuns);
router.get('/agents/:agentId/consistency-summary', requireAuth(), getConsistencySummary);

// Individual run route
router.get('/consistency-tests/:runId', requireAuth(), getConsistencyRun);

export default router;
