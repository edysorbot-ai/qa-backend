import { Router } from 'express';
import userRoutes from './user.routes';
import integrationRoutes from './integration.routes';
import agentRoutes from './agent.routes';
import testCaseRoutes from './testCase.routes';
import testRunRoutes from './testRun.routes';
import testExecutionRoutes from '../controllers/test-execution.controller';
import customAgentRoutes from './custom-agent.routes';
import scheduledTestRoutes from './scheduledTest.routes';
import alertSettingsRoutes from './alertSettings.routes';
import teamMemberRoutes from './teamMember.routes';
import goldenTestRoutes from './goldenTest.routes';
import inferenceRoutes from './inference.routes';
import leakageRoutes from './leakage.routes';
import consistencyRoutes from './consistency.routes';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
router.use('/users', userRoutes);
router.use('/integrations', integrationRoutes);
router.use('/agents', agentRoutes);
router.use('/custom-agents', customAgentRoutes);
router.use('/test-cases', testCaseRoutes);
router.use('/test-runs', testRunRoutes);
router.use('/test-execution', testExecutionRoutes);
router.use('/scheduled-tests', scheduledTestRoutes);
router.use('/alert-settings', alertSettingsRoutes);
router.use('/team-members', teamMemberRoutes);
router.use('/golden-tests', goldenTestRoutes);
router.use('/', inferenceRoutes);  // Inference routes use various base paths
router.use('/', leakageRoutes);  // Leakage routes use /agents/:agentId/... paths
router.use('/', consistencyRoutes);  // Consistency routes use /agents/:agentId/... paths

export default router;
