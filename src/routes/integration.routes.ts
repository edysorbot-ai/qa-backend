import { Router } from 'express';
import { integrationController } from '../controllers/integration.controller';

const router = Router();

// POST /api/integrations/validate - Validate API key without saving
router.post('/validate', integrationController.validateKey.bind(integrationController));

// GET /api/integrations - Get all integrations for user
router.get('/', integrationController.getAll.bind(integrationController));

// GET /api/integrations/:id - Get integration by ID
router.get('/:id', integrationController.getById.bind(integrationController));

// POST /api/integrations - Create new integration
router.post('/', integrationController.create.bind(integrationController));

// PUT /api/integrations/:id - Update integration
router.put('/:id', integrationController.update.bind(integrationController));

// DELETE /api/integrations/:id - Delete integration
router.delete('/:id', integrationController.delete.bind(integrationController));

// POST /api/integrations/:id/test - Test connection to provider
router.post('/:id/test', integrationController.testConnection.bind(integrationController));

// GET /api/integrations/:id/agents - List agents from provider
router.get('/:id/agents', integrationController.listAgents.bind(integrationController));

// GET /api/integrations/:id/agents/:agentId - Get specific agent from provider
router.get('/:id/agents/:agentId', integrationController.getAgent.bind(integrationController));

// POST /api/integrations/:id/agents/:agentId/analyze - Analyze agent and generate test cases
router.post('/:id/agents/:agentId/analyze', integrationController.analyzeAgent.bind(integrationController));

// GET /api/integrations/:id/limits - Get provider limits (concurrency, etc.)
router.get('/:id/limits', integrationController.getLimits.bind(integrationController));

export default router;
