import { Request, Response, NextFunction } from 'express';
import { integrationService } from '../services/integration.service';
import { userService } from '../services/user.service';

export class IntegrationController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const integrations = await integrationService.findByUserId(user.id);
      
      // Mask API keys
      const maskedIntegrations = integrations.map(i => ({
        ...i,
        api_key: i.api_key ? `****${i.api_key.slice(-4)}` : null,
      }));

      res.json({ integrations: maskedIntegrations });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const integration = await integrationService.findById(id);
      
      if (!integration) {
        return res.status(404).json({ error: 'Integration not found' });
      }

      // Mask API key
      res.json({
        integration: {
          ...integration,
          api_key: `****${integration.api_key.slice(-4)}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findByClerkId(clerkUser.userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { provider, api_key } = req.body;

      if (!provider || !api_key) {
        return res.status(400).json({ error: 'Provider and API key are required' });
      }

      // Validate API key with provider and create if valid
      const { integration, validation } = await integrationService.createWithValidation({
        user_id: user.id,
        provider,
        api_key,
      });

      if (!validation.valid || !integration) {
        return res.status(400).json({
          error: 'Invalid API key',
          message: validation.message,
        });
      }

      res.status(201).json({
        integration: {
          ...integration,
          api_key: `****${integration.api_key.slice(-4)}`,
        },
        validation: {
          valid: validation.valid,
          message: validation.message,
          details: validation.details,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { api_key, is_active } = req.body;

      // If API key is being updated, validate it first
      const { integration, validation } = await integrationService.updateWithValidation(
        id,
        { api_key, is_active }
      );

      if (validation && !validation.valid) {
        return res.status(400).json({
          error: 'Invalid API key',
          message: validation.message,
        });
      }
      
      if (!integration) {
        return res.status(404).json({ error: 'Integration not found' });
      }

      res.json({
        integration: {
          ...integration,
          api_key: `****${integration.api_key.slice(-4)}`,
        },
        ...(validation && {
          validation: {
            valid: validation.valid,
            message: validation.message,
            details: validation.details,
          },
        }),
      });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const deleted = await integrationService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Integration not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Test connection to the provider (re-validate stored API key)
   */
  async testConnection(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const validation = await integrationService.testConnection(id);

      res.json({
        connected: validation.valid,
        message: validation.message,
        details: validation.details,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List agents from the provider
   */
  async listAgents(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const agents = await integrationService.listProviderAgents(id);

      res.json({ agents });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a specific agent from the provider
   */
  async getAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, agentId } = req.params;
      const agent = await integrationService.getProviderAgent(id, agentId);

      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      res.json({ agent });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Validate an API key without saving it
   */
  async validateKey(req: Request, res: Response, next: NextFunction) {
    try {
      const { provider, api_key } = req.body;

      if (!provider || !api_key) {
        return res.status(400).json({ error: 'Provider and API key are required' });
      }

      const validation = await integrationService.validateApiKey(provider, api_key);

      res.json({
        valid: validation.valid,
        message: validation.message,
        details: validation.details,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const integrationController = new IntegrationController();
