import { Request, Response, NextFunction } from 'express';
import { integrationService } from '../services/integration.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';

export class IntegrationController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const integrations = await integrationService.findByUserId(effectiveUserId);
      
      // Mask API keys
      const maskedIntegrations = integrations.map(i => ({
        ...i,
        api_key: i.api_key ? `****${i.api_key.slice(-4)}` : null,
        base_url: i.base_url || null,
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
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { provider, api_key, base_url, validate = false } = req.body;

      if (!provider || !api_key) {
        return res.status(400).json({ error: 'Provider and API key are required' });
      }

      // If validate flag is true, validate before saving
      if (validate) {
        const { integration, validation } = await integrationService.createWithValidation({
          user_id: effectiveUserId,
          provider,
          api_key,
          base_url: base_url || null,
        });

        if (!validation.valid || !integration) {
          return res.status(400).json({
            error: 'Invalid API key',
            message: validation.message,
          });
        }

        return res.status(201).json({
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
      }

      // Save without validation (default)
      const integration = await integrationService.create({
        user_id: effectiveUserId,
        provider,
        api_key,
        base_url: base_url || null,
      });

      res.status(201).json({
        integration: {
          ...integration,
          api_key: `****${integration.api_key.slice(-4)}`,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { api_key, base_url, is_active } = req.body;

      // If API key is being updated, validate it first
      const { integration, validation } = await integrationService.updateWithValidation(
        id,
        { api_key, base_url, is_active }
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
      const { provider, api_key, base_url } = req.body;

      if (!provider || !api_key) {
        return res.status(400).json({ error: 'Provider and API key are required' });
      }

      const validation = await integrationService.validateApiKey(provider, api_key, base_url);

      res.json({
        valid: validation.valid,
        message: validation.message,
        details: validation.details,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Analyze agent and generate test cases
   */
  async analyzeAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, agentId } = req.params;
      const { maxTestCases = 20 } = req.body;

      const result = await integrationService.analyzeAgentAndGenerateTestCases(
        id,
        agentId,
        maxTestCases
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get provider limits (concurrency, etc.)
   */
  async getLimits(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const limits = await integrationService.getProviderLimits(id);

      if (!limits) {
        return res.status(404).json({ error: 'Integration not found or inactive' });
      }

      res.json({ limits });
    } catch (error) {
      next(error);
    }
  }
}

export const integrationController = new IntegrationController();
