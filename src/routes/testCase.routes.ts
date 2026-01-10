import { Router } from 'express';
import { testCaseController } from '../controllers/testCase.controller';
import { 
  requireSubscriptionAndCredits,
  FeatureKeys 
} from '../middleware/credits.middleware';

const router = Router();

// GET /api/test-cases - Get all test cases (optionally filtered by agent_id)
router.get('/', testCaseController.getAll.bind(testCaseController));

// GET /api/test-cases/:id - Get test case by ID
router.get('/:id', testCaseController.getById.bind(testCaseController));

// POST /api/test-cases - Create new test case (requires subscription and credits)
router.post('/', 
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_CASE_CREATE),
  testCaseController.create.bind(testCaseController)
);

// POST /api/test-cases/bulk - Create multiple test cases (requires subscription and credits per test case)
router.post('/bulk', 
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_CASE_CREATE, (req) => {
    // Charge per test case being created
    return Array.isArray(req.body?.test_cases) ? req.body.test_cases.length : 1;
  }),
  testCaseController.createBulk.bind(testCaseController)
);

// PUT /api/test-cases/:id - Update test case
router.put('/:id', testCaseController.update.bind(testCaseController));

// DELETE /api/test-cases/:id - Delete test case
router.delete('/:id', testCaseController.delete.bind(testCaseController));

export default router;
