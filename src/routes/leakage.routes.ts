import { Router } from 'express';
import { requireAuth } from '@clerk/express';
import {
  getLeakageScenarios,
  createLeakageScenario,
  runLeakageTest,
  getLeakageTestRuns,
  getSecuritySummary,
  getBuiltinScenarios,
  analyzeSensitiveData,
  generateLeakageScenarios,
} from '../controllers/leakage.controller';
import { requireSubscriptionAndCredits, FeatureKeys } from '../middleware/credits.middleware';

const router = Router();

// Builtin scenarios (can be fetched without agent context)
router.get('/builtin-scenarios', requireAuth(), getBuiltinScenarios);

// Agent-specific routes
router.get('/agents/:agentId/leakage-scenarios', requireAuth(), getLeakageScenarios);
router.post('/agents/:agentId/leakage-scenarios', requireAuth(), createLeakageScenario);
router.post('/agents/:agentId/leakage-tests/:scenarioId/run', requireAuth(), runLeakageTest);
router.get('/agents/:agentId/leakage-tests', requireAuth(), getLeakageTestRuns);
router.get('/agents/:agentId/security-summary', requireAuth(), getSecuritySummary);

// Auto-generation routes (uses agent's prompt and knowledge base) — credit protected
router.post('/agents/:agentId/analyze-sensitive-data', requireAuth(), 
  ...requireSubscriptionAndCredits(FeatureKeys.SENSITIVE_DATA_ANALYZE),
  analyzeSensitiveData
);
router.post('/agents/:agentId/generate-leakage-scenarios', requireAuth(), 
  ...requireSubscriptionAndCredits(FeatureKeys.LEAKAGE_SCENARIO_GENERATE),
  generateLeakageScenarios
);

export default router;
