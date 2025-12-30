import { Router } from 'express';
import { agentController } from '../controllers/agent.controller';
import { workflowController } from '../controllers/workflow.controller';

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

// POST /api/agents/:id/analyze-prompt - Analyze agent's prompt using AI
router.post('/:id/analyze-prompt', agentController.analyzePrompt.bind(agentController));

// GET /api/agents/:id/dynamic-variables - Get dynamic variables from agent's prompt
router.get('/:id/dynamic-variables', agentController.getDynamicVariables.bind(agentController));

// GET /api/agents/:id/knowledge-base - Get knowledge base for agent
router.get('/:id/knowledge-base', agentController.getKnowledgeBase.bind(agentController));

// GET /api/agents/:id/test-cases - Get test cases for agent
router.get('/:id/test-cases', agentController.getTestCases.bind(agentController));

// POST /api/agents/:id/test-cases - Save test cases for agent
router.post('/:id/test-cases', agentController.saveTestCases.bind(agentController));

// Workflow routes
// GET /api/agents/:agentId/workflow - Get workflow for agent
router.get('/:agentId/workflow', workflowController.getWorkflow.bind(workflowController));

// POST /api/agents/:agentId/workflow - Save/Update workflow for agent
router.post('/:agentId/workflow', workflowController.saveWorkflow.bind(workflowController));

// DELETE /api/agents/:agentId/workflow/:workflowId - Delete workflow
router.delete('/:agentId/workflow/:workflowId', workflowController.deleteWorkflow.bind(workflowController));

// GET /api/agents/:agentId/workflow/execution-plan - Get execution plan
router.get('/:agentId/workflow/execution-plan', workflowController.getExecutionPlan.bind(workflowController));

// GET /api/agents/:id/knowledge-base/:documentId/content - Get knowledge base document content
router.get('/:id/knowledge-base/:documentId/content', agentController.getKnowledgeBaseDocumentContent.bind(agentController));

export default router;
