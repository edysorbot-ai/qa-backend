/**
 * Custom Agent Routes
 * 
 * API endpoints for managing custom agents created in the Agent Builder.
 * Custom agents are stored locally and use our own LLM/TTS/STT for simulation.
 */

import { Router } from 'express';
import { customAgentController } from '../controllers/custom-agent.controller';
import { 
  requireSubscriptionAndCredits,
  FeatureKeys 
} from '../middleware/credits.middleware';

const router = Router();

// Note: Authentication is handled at the /api level in app.ts

// Static routes first (before parameterized routes)
// Get available LLM models
router.get('/config/models', customAgentController.getAvailableModels);

// Get available voices
router.get('/config/voices', customAgentController.getAvailableVoices);

// List all custom agents for the user
router.get('/', customAgentController.getAll);

// Create a new custom agent (requires subscription and credits)
router.post('/', 
  ...requireSubscriptionAndCredits(FeatureKeys.CUSTOM_AGENT_CREATE),
  customAgentController.create
);

// Get a specific custom agent
router.get('/:id', customAgentController.getById);

// Update a custom agent
router.put('/:id', customAgentController.update);

// Delete a custom agent
router.delete('/:id', customAgentController.delete);

// Chat with a custom agent (for testing) - requires subscription and credits
router.post('/:id/chat', 
  ...requireSubscriptionAndCredits(FeatureKeys.CUSTOM_AGENT_SIMULATE),
  customAgentController.chat
);

// Run a multi-turn conversation simulation - requires subscription and credits
router.post('/:id/simulate', 
  ...requireSubscriptionAndCredits(FeatureKeys.CUSTOM_AGENT_SIMULATE),
  customAgentController.simulate
);

export default router;
