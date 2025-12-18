import { Request, Response, NextFunction } from 'express';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';
import { promptVersionService } from '../services/promptVersion.service';
import { configVersionService } from '../services/configVersion.service';
import { integrationService } from '../services/integration.service';

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

      // Get prompt versions for this agent
      const promptVersions = await promptVersionService.findByAgentId(id);
      
      // Get config versions for this agent
      const configVersions = await configVersionService.findByAgentId(id);

      res.json({ agent, promptVersions, configVersions });
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

      // Create initial prompt version if prompt exists
      if (prompt) {
        await promptVersionService.createVersionIfChanged({
          agent_id: agent.id,
          prompt,
        });
      }

      // Create initial config version if config exists
      if (config) {
        await configVersionService.createVersionIfChanged({
          agent_id: agent.id,
          config,
        });
      }

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

      // Create new prompt version if prompt changed
      let newPromptVersion = null;
      if (prompt) {
        newPromptVersion = await promptVersionService.createVersionIfChanged({
          agent_id: id,
          prompt,
        });
      }

      // Create new config version if config changed
      let newConfigVersion = null;
      if (config) {
        newConfigVersion = await configVersionService.createVersionIfChanged({
          agent_id: id,
          config,
        });
      }

      res.json({ agent, newPromptVersion, newConfigVersion });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      
      // Delete prompt versions first
      await promptVersionService.deleteByAgentId(id);
      
      // Delete config versions
      await configVersionService.deleteByAgentId(id);
      
      const deleted = await agentService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get prompt versions for an agent
   */
  async getPromptVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const versions = await promptVersionService.findByAgentId(id);
      res.json({ versions });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Check if prompt has changed from provider and create new version if so
   */
  async checkPromptUpdate(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      
      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Fetch latest from provider
      const providerAgent = await integrationService.getProviderAgent(
        agent.integration_id,
        agent.external_agent_id || agent.id
      );

      if (!providerAgent) {
        return res.status(404).json({ error: 'Could not fetch agent from provider' });
      }

      // Extract prompt from provider response
      const newPrompt = providerAgent.description || 
                        (providerAgent as any).prompt || 
                        (providerAgent as any).system_prompt || 
                        '';

      // Extract config (the full provider response)
      const newConfig = providerAgent as Record<string, any>;

      let promptChanged = false;
      let configChanged = false;
      let newPromptVersion = null;
      let newConfigVersion = null;

      // Check if prompt changed
      if (newPrompt) {
        promptChanged = await promptVersionService.hasPromptChanged(id, newPrompt);
        if (promptChanged) {
          newPromptVersion = await promptVersionService.createVersionIfChanged({
            agent_id: id,
            prompt: newPrompt,
          });
        }
      }

      // Check if config changed
      if (newConfig && Object.keys(newConfig).length > 0) {
        configChanged = await configVersionService.hasConfigChanged(id, newConfig);
        if (configChanged) {
          newConfigVersion = await configVersionService.createVersionIfChanged({
            agent_id: id,
            config: newConfig,
          });
        }
      }

      // Update agent if anything changed
      if (promptChanged || configChanged) {
        await agentService.update(id, { 
          prompt: newPrompt || agent.prompt,
          config: newConfig 
        });

        const allPromptVersions = await promptVersionService.findByAgentId(id);
        const allConfigVersions = await configVersionService.findByAgentId(id);

        return res.json({ 
          changed: true,
          promptChanged,
          configChanged,
          newPromptVersion,
          newConfigVersion,
          promptVersions: allPromptVersions,
          configVersions: allConfigVersions,
          currentPrompt: newPrompt,
          currentConfig: newConfig
        });
      }

      return res.json({ changed: false, message: 'No changes detected' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get config versions for an agent
   */
  async getConfigVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const versions = await configVersionService.findByAgentId(id);
      res.json({ versions });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Generate test cases for an agent based on its prompt
   */
  async generateTestCases(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { maxTestCases = 35 } = req.body;
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const userId = user.id;

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Use the testCaseGeneratorService to generate test cases
      const { testCaseGeneratorService } = await import('../services/testcase-generator.service');
      
      const result = await testCaseGeneratorService.analyzeAndGenerateTestCases(
        agent.name,
        agent.prompt || '',
        agent.config || {},
        maxTestCases
      );

      // Auto-save the generated test cases
      const { testCaseService } = await import('../services/testCase.service');
      
      const savedTestCases = await testCaseService.createMany(
        result.testCases.map((tc: any) => ({
          agent_id: id,
          user_id: userId,
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome || tc.expected_behavior || '',
          category: tc.category || 'General',
          priority: tc.priority || 'medium',
          batch_compatible: true,
        }))
      );

      res.json({
        agentAnalysis: result.agentAnalysis,
        testCases: savedTestCases,
      });
    } catch (error: any) {
      console.error('Error generating test cases:', error);
      // Return more specific error message
      const errorMessage = error?.message || 'Failed to generate test cases';
      res.status(500).json({ error: errorMessage, message: errorMessage });
    }
  }

  /**
   * Get test cases for an agent
   */
  async getTestCases(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { testCaseService } = await import('../services/testCase.service');
      
      const testCases = await testCaseService.findByAgentId(id);
      res.json({ testCases });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Save test cases for an agent (bulk create)
   */
  async saveTestCases(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { testCases } = req.body;
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const userId = user.id;

      if (!testCases || !Array.isArray(testCases)) {
        return res.status(400).json({ error: 'testCases array is required' });
      }

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const { testCaseService } = await import('../services/testCase.service');

      // Create test cases with agent_id and user_id
      const createdTestCases = await testCaseService.createMany(
        testCases.map((tc: any) => ({
          agent_id: id,
          user_id: userId,
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome || tc.expected_behavior,
          category: tc.category || 'General',
          priority: tc.priority || 'medium',
          batch_compatible: true,
        }))
      );

      res.json({ testCases: createdTestCases });
    } catch (error) {
      next(error);
    }
  }
}

export const agentController = new AgentController();
