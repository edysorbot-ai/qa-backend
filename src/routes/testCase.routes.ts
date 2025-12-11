import { Router } from 'express';
import { testCaseController } from '../controllers/testCase.controller';

const router = Router();

// GET /api/test-cases - Get all test cases (optionally filtered by agent_id)
router.get('/', testCaseController.getAll.bind(testCaseController));

// GET /api/test-cases/:id - Get test case by ID
router.get('/:id', testCaseController.getById.bind(testCaseController));

// POST /api/test-cases - Create new test case
router.post('/', testCaseController.create.bind(testCaseController));

// POST /api/test-cases/bulk - Create multiple test cases
router.post('/bulk', testCaseController.createBulk.bind(testCaseController));

// PUT /api/test-cases/:id - Update test case
router.put('/:id', testCaseController.update.bind(testCaseController));

// DELETE /api/test-cases/:id - Delete test case
router.delete('/:id', testCaseController.delete.bind(testCaseController));

export default router;
