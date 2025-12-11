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

export default router;
