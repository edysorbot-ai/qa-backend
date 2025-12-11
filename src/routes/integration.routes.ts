import { Router } from 'express';
import { integrationController } from '../controllers/integration.controller';

const router = Router();

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

export default router;
