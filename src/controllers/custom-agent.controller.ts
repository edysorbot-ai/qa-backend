/**
 * Custom Agent Controller
 * 
 * Handles CRUD operations and chat/simulation for custom agents.
 * Uses OpenRouter for LLM access, providing access to many models.
 */

import { Request, Response, NextFunction } from 'express';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';
import { customProvider, CustomAgentConfig } from '../providers/custom.provider';
import { v4 as uuidv4 } from 'uuid';
import { deductCreditsAfterSuccess, CreditRequest } from '../middleware/credits.middleware';

// Available TTS voices (OpenAI)
const AVAILABLE_VOICES = [
  { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Warm and engaging' },
  { id: 'echo', name: 'Echo', gender: 'male', description: 'Clear and professional' },
  { id: 'fable', name: 'Fable', gender: 'neutral', description: 'Expressive storyteller' },
  { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep and authoritative' },
  { id: 'nova', name: 'Nova', gender: 'female', description: 'Friendly and natural' },
  { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Soft and pleasant' },
];

export class CustomAgentController {
  constructor() {
    // Bind all methods to ensure 'this' context is preserved
    this.getAll = this.getAll.bind(this);
    this.create = this.create.bind(this);
    this.getById = this.getById.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
    this.chat = this.chat.bind(this);
    this.simulate = this.simulate.bind(this);
    this.getAvailableModels = this.getAvailableModels.bind(this);
    this.getAvailableVoices = this.getAvailableVoices.bind(this);
  }

  /**
   * Get all custom agents for the authenticated user
   */
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      // Get agents where provider is 'custom'
      const allAgents = await agentService.findByUserId(user.id);
      const customAgents = allAgents.filter(a => a.provider === 'custom');

      res.json({ agents: customAgents });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a new custom agent
   */
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const config: CustomAgentConfig = {
        name: req.body.name,
        description: req.body.description,
        systemPrompt: req.body.systemPrompt,
        startingMessage: req.body.startingMessage,
        llmModel: req.body.llmModel || 'openai/gpt-4o-mini',
        llmProvider: req.body.llmProvider || 'openrouter',
        temperature: req.body.temperature ?? 0.7,
        maxTokens: req.body.maxTokens ?? 500,
        voice: req.body.voice || 'nova',
        knowledgeBase: req.body.knowledgeBase,
        responseStyle: req.body.responseStyle || 'conversational',
        language: req.body.language || 'en-US',
      };

      if (!config.name || !config.systemPrompt) {
        return res.status(400).json({ error: 'Name and system prompt are required' });
      }

      // Create the agent with 'custom' provider
      // Custom agents have no integration_id (null)
      const agent = await agentService.create({
        user_id: user.id,
        integration_id: null as any, // No integration for custom agents
        external_agent_id: `custom_${uuidv4()}`,
        name: config.name,
        provider: 'custom',
        prompt: config.systemPrompt,
        intents: [],
        config: config as any,
      });

      // Deduct credits after successful creation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Created custom agent: ${config.name}`,
        { agentId: agent.id }
      );

      res.status(201).json({ agent });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific custom agent
   */
  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const agent = await agentService.findById(id);

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (agent.provider !== 'custom') {
        return res.status(400).json({ error: 'Not a custom agent' });
      }

      res.json({ agent });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a custom agent
   */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const existingAgent = await agentService.findById(id);

      if (!existingAgent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (existingAgent.provider !== 'custom') {
        return res.status(400).json({ error: 'Not a custom agent' });
      }

      const config: CustomAgentConfig = {
        name: req.body.name || existingAgent.config.name,
        description: req.body.description || existingAgent.config.description,
        systemPrompt: req.body.systemPrompt || existingAgent.config.systemPrompt,
        startingMessage: req.body.startingMessage ?? existingAgent.config.startingMessage,
        llmModel: req.body.llmModel || existingAgent.config.llmModel,
        llmProvider: req.body.llmProvider || existingAgent.config.llmProvider,
        temperature: req.body.temperature ?? existingAgent.config.temperature,
        maxTokens: req.body.maxTokens ?? existingAgent.config.maxTokens,
        voice: req.body.voice || existingAgent.config.voice,
        knowledgeBase: req.body.knowledgeBase ?? existingAgent.config.knowledgeBase,
        responseStyle: req.body.responseStyle || existingAgent.config.responseStyle,
        language: req.body.language || existingAgent.config.language,
      };

      const agent = await agentService.update(id, {
        name: config.name,
        prompt: config.systemPrompt,
        config: config as any,
      });

      res.json({ agent });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a custom agent
   */
  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const agent = await agentService.findById(id);

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (agent.provider !== 'custom') {
        return res.status(400).json({ error: 'Not a custom agent' });
      }

      await agentService.delete(id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Chat with a custom agent
   */
  async chat(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { message, sessionId } = req.body;

      if (!message) {
        return res.status(400).json({ error: 'Message is required' });
      }

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (agent.provider !== 'custom') {
        return res.status(400).json({ error: 'Not a custom agent' });
      }

      const config = agent.config as CustomAgentConfig;
      const response = await customProvider.chat('custom', id, message, {
        sessionId,
        config,
      });

      if (!response) {
        return res.status(500).json({ error: 'Failed to get agent response' });
      }

      // Deduct credits for chat
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Chat with custom agent: ${agent.name}`,
        { agentId: id, messageLength: message.length }
      );

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Run a multi-turn conversation simulation
   */
  async simulate(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { messages, testMode = 'chat' } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'Messages array is required' });
      }

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (agent.provider !== 'custom') {
        return res.status(400).json({ error: 'Not a custom agent' });
      }

      const config = agent.config as CustomAgentConfig;
      const result = await customProvider.runChatConversation('custom', id, messages, config);

      // Deduct credits for simulation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Simulation with custom agent: ${agent.name}`,
        { agentId: id, messageCount: messages.length }
      );

      res.json({
        success: result.success,
        transcript: result.transcript,
        testMode,
        error: result.error,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get available LLM models from OpenRouter
   */
  async getAvailableModels(req: Request, res: Response, next: NextFunction) {
    try {
      // Fetch models from OpenRouter
      const models = await customProvider.getAvailableModels();
      
      // Transform to frontend-friendly format
      const formattedModels = models.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description || '',
        provider: m.id.split('/')[0] || 'unknown', // Extract provider from model ID (e.g., 'openai/gpt-4o' -> 'openai')
        contextLength: m.context_length,
        pricing: m.pricing,
      }));

      res.json({ models: formattedModels });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get available TTS voices
   */
  async getAvailableVoices(req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ voices: AVAILABLE_VOICES });
    } catch (error) {
      next(error);
    }
  }
}

export const customAgentController = new CustomAgentController();
