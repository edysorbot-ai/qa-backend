import { Router } from 'express';
import userRoutes from './user.routes';
import integrationRoutes from './integration.routes';
import agentRoutes from './agent.routes';
import testCaseRoutes from './testCase.routes';
import testRunRoutes from './testRun.routes';
import testExecutionRoutes from '../controllers/test-execution.controller';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
router.use('/users', userRoutes);
router.use('/integrations', integrationRoutes);
router.use('/agents', agentRoutes);
router.use('/test-cases', testCaseRoutes);
router.use('/test-runs', testRunRoutes);
router.use('/test-execution', testExecutionRoutes);

export default router;
