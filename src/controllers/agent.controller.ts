import { Request, Response, NextFunction } from 'express';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';

export class AgentController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const agents = await agentService.findByUserId(user.id);
      res.json({ agents });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const agent = await agentService.getWithStats(id);
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      res.json({ agent });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const { integration_id, external_agent_id, name, provider, prompt, intents, config } = req.body;

      if (!integration_id || !name || !provider) {
        return res.status(400).json({ error: 'Integration ID, name, and provider are required' });
      }

      const agent = await agentService.create({
        user_id: user.id,
        integration_id,
        external_agent_id,
        name,
        provider,
        prompt,
        intents,
        config,
      });

      res.status(201).json({ agent });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { name, prompt, intents, config, status } = req.body;

      const agent = await agentService.update(id, { name, prompt, intents, config, status });
      
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      res.json({ agent });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const deleted = await agentService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}

export const agentController = new AgentController();
