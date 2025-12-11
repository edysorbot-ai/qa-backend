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

      // Validate API key with provider
      const isValid = await integrationService.validateApiKey(provider, api_key);
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid API key' });
      }

      const integration = await integrationService.create({
        user_id: user.id,
        provider,
        api_key,
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
      const { api_key, is_active } = req.body;

      const integration = await integrationService.update(id, { api_key, is_active });
      
      if (!integration) {
        return res.status(404).json({ error: 'Integration not found' });
      }

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
}

export const integrationController = new IntegrationController();
