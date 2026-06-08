import { Router } from 'express';
import { testCaseController } from '../controllers/testCase.controller';
import { goldExampleController } from '../controllers/goldExample.controller';
import { 
  requireSubscriptionAndCredits,
  FeatureKeys 
} from '../middleware/credits.middleware';

const router = Router();

// GET /api/test-cases/csv-template - Download CSV template for importing test cases
router.get('/csv-template', testCaseController.csvTemplate.bind(testCaseController));

// GET /api/test-cases - Get all test cases (optionally filtered by agent_id)
router.get('/', testCaseController.getAll.bind(testCaseController));

// GET /api/test-cases/:id - Get test case by ID
router.get('/:id', testCaseController.getById.bind(testCaseController));

// POST /api/test-cases - Create new test case (requires subscription and credits)
router.post('/', 
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_CASE_CREATE),
  testCaseController.create.bind(testCaseController)
);

// POST /api/test-cases/import-csv - Import test cases from CSV (requires subscription and credits)
router.post('/import-csv',
  ...requireSubscriptionAndCredits(FeatureKeys.TEST_CASE_CREATE, (req) => {
    // We'll charge based on rows - estimate from csv_content line count minus header
    const csvContent = req.body?.csv_content || '';
    const lineCount = csvContent.split(/\r?\n/).filter((l: string) => l.trim()).length;
    return Math.max(lineCount - 1, 1); // minus header row
  }),
  testCaseController.importCSV.bind(testCaseController)
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

// --- Gold examples (acceptable / unacceptable reference conversations) ---
// GET    /api/test-cases/:id/gold-examples
// POST   /api/test-cases/:id/gold-examples/generate           body: { kind?: 'acceptable'|'unacceptable'|'both' }
// PUT    /api/test-cases/:id/gold-examples/:kind              body: { transcript, notes? }
// POST   /api/test-cases/:id/gold-examples/:kind/approve
// POST   /api/test-cases/:id/gold-examples/:kind/unapprove
// DELETE /api/test-cases/:id/gold-examples/:kind
router.get('/:id/gold-examples', goldExampleController.list.bind(goldExampleController));
router.post('/:id/gold-examples/generate', goldExampleController.generate.bind(goldExampleController));
router.put('/:id/gold-examples/:kind', goldExampleController.update.bind(goldExampleController));
router.post('/:id/gold-examples/:kind/approve', goldExampleController.approve.bind(goldExampleController));
router.post('/:id/gold-examples/:kind/unapprove', goldExampleController.unapprove.bind(goldExampleController));
router.delete('/:id/gold-examples/:kind', goldExampleController.remove.bind(goldExampleController));

export default router;
