import { Router } from 'express';
import { testRunController } from '../controllers/testRun.controller';

const router = Router();

// GET /api/test-runs - Get all test runs (optionally filtered by agent_id)
router.get('/', testRunController.getAll.bind(testRunController));

// GET /api/test-runs/stats - Get test run statistics
router.get('/stats', testRunController.getStats.bind(testRunController));

// GET /api/test-runs/compare - Compare multiple test runs
router.get('/compare', testRunController.compare.bind(testRunController));

// GET /api/test-runs/results/:resultId/context-metrics - Get context growth metrics for a test result
router.get('/results/:resultId/context-metrics', testRunController.getResultContextMetrics.bind(testRunController));

// GET /api/test-runs/agents/:agentId/context-summary - Get context growth summary for an agent
router.get('/agents/:agentId/context-summary', testRunController.getAgentContextSummary.bind(testRunController));

// GET /api/test-runs/:id - Get test run by ID with results
router.get('/:id', testRunController.getById.bind(testRunController));

// POST /api/test-runs - Create new test run
router.post('/', testRunController.create.bind(testRunController));

// POST /api/test-runs/start-workflow - Start a workflow-based test run
router.post('/start-workflow', testRunController.startWorkflow.bind(testRunController));

// POST /api/test-runs/:id/start - Start test run execution
router.post('/:id/start', testRunController.start.bind(testRunController));

// POST /api/test-runs/:id/cancel - Cancel test run
router.post('/:id/cancel', testRunController.cancel.bind(testRunController));

// DELETE /api/test-runs/:id - Delete test run
router.delete('/:id', testRunController.delete.bind(testRunController));

export default router;
