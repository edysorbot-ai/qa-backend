import { Router } from 'express';
import { goldenTestController } from '../controllers/goldenTest.controller';

const router = Router();

// GET /api/golden-tests - Get all golden tests for user
router.get('/', goldenTestController.getAll.bind(goldenTestController));

// GET /api/golden-tests/summary - Get summary stats
router.get('/summary', goldenTestController.getSummary.bind(goldenTestController));

// GET /api/golden-tests/agent/:agentId - Get golden tests for an agent
router.get('/agent/:agentId', goldenTestController.getByAgent.bind(goldenTestController));

// GET /api/golden-tests/:id - Get a specific golden test
router.get('/:id', goldenTestController.getById.bind(goldenTestController));

// GET /api/golden-tests/:id/history - Get run history
router.get('/:id/history', goldenTestController.getHistory.bind(goldenTestController));

// POST /api/golden-tests - Create a golden test
router.post('/', goldenTestController.create.bind(goldenTestController));

// POST /api/golden-tests/mark/:resultId - Mark a test result as golden
router.post('/mark/:resultId', goldenTestController.markAsGolden.bind(goldenTestController));

// POST /api/golden-tests/:id/run - Run a golden test now
router.post('/:id/run', goldenTestController.runNow.bind(goldenTestController));

// PUT /api/golden-tests/:id - Update a golden test
router.put('/:id', goldenTestController.update.bind(goldenTestController));

// PUT /api/golden-tests/:id/baseline - Update baseline
router.put('/:id/baseline', goldenTestController.updateBaseline.bind(goldenTestController));

// DELETE /api/golden-tests/:id - Delete a golden test
router.delete('/:id', goldenTestController.delete.bind(goldenTestController));

export default router;
