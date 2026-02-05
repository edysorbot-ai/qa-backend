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

const router = Router();

// Builtin scenarios (can be fetched without agent context)
router.get('/builtin-scenarios', requireAuth(), getBuiltinScenarios);

// Agent-specific routes
router.get('/agents/:agentId/leakage-scenarios', requireAuth(), getLeakageScenarios);
router.post('/agents/:agentId/leakage-scenarios', requireAuth(), createLeakageScenario);
router.post('/agents/:agentId/leakage-tests/:scenarioId/run', requireAuth(), runLeakageTest);
router.get('/agents/:agentId/leakage-tests', requireAuth(), getLeakageTestRuns);
router.get('/agents/:agentId/security-summary', requireAuth(), getSecuritySummary);

// Auto-generation routes (uses agent's prompt and knowledge base)
router.post('/agents/:agentId/analyze-sensitive-data', requireAuth(), analyzeSensitiveData);
router.post('/agents/:agentId/generate-leakage-scenarios', requireAuth(), generateLeakageScenarios);

export default router;
