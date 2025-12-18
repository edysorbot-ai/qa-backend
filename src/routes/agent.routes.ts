import { Router } from 'express';
import { agentController } from '../controllers/agent.controller';

const router = Router();

// GET /api/agents - Get all agents for user
router.get('/', agentController.getAll.bind(agentController));

// GET /api/agents/:id - Get agent by ID
router.get('/:id', agentController.getById.bind(agentController));

// POST /api/agents - Create new agent
router.post('/', agentController.create.bind(agentController));

// PUT /api/agents/:id - Update agent
router.put('/:id', agentController.update.bind(agentController));

// DELETE /api/agents/:id - Delete agent
router.delete('/:id', agentController.delete.bind(agentController));

// GET /api/agents/:id/prompt-versions - Get prompt versions for agent
router.get('/:id/prompt-versions', agentController.getPromptVersions.bind(agentController));

// GET /api/agents/:id/config-versions - Get config versions for agent
router.get('/:id/config-versions', agentController.getConfigVersions.bind(agentController));

// POST /api/agents/:id/check-prompt - Check if prompt/config changed and create version
router.post('/:id/check-prompt', agentController.checkPromptUpdate.bind(agentController));

// POST /api/agents/:id/generate-test-cases - Generate test cases for agent
router.post('/:id/generate-test-cases', agentController.generateTestCases.bind(agentController));

// GET /api/agents/:id/test-cases - Get test cases for agent
router.get('/:id/test-cases', agentController.getTestCases.bind(agentController));

// POST /api/agents/:id/test-cases - Save test cases for agent
router.post('/:id/test-cases', agentController.saveTestCases.bind(agentController));

export default router;
