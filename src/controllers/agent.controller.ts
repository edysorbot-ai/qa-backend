import { logger } from '../services/logger.service';
import { Request, Response, NextFunction } from 'express';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';
import { promptVersionService } from '../services/promptVersion.service';
import { configVersionService } from '../services/configVersion.service';
import { integrationService } from '../services/integration.service';
import { elevenlabsProvider } from '../providers/elevenlabs.provider';
import { teamMemberService } from '../services/teamMember.service';
import { deductCreditsAfterSuccess, CreditRequest } from '../middleware/credits.middleware';

export class AgentController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const agents = await agentService.findByUserId(effectiveUserId);
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
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { integration_id, external_agent_id, name, provider, prompt, intents, config } = req.body;

      if (!integration_id || !name || !provider) {
        return res.status(400).json({ error: 'Integration ID, name, and provider are required' });
      }

      // Prevent duplicate connections of the same provider agent for this user
      if (external_agent_id) {
        const existing = await agentService.findByUserAndExternal(
          effectiveUserId,
          provider,
          external_agent_id
        );
        if (existing) {
          return res.status(409).json({
            error: 'This agent is already connected.',
            agent: existing,
          });
        }
      }

      const agent = await agentService.create({
        user_id: effectiveUserId,
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

      // Deduct credits after successful creation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Created agent: ${name}`,
        { agentId: agent.id, provider }
      );

      res.status(201).json({ agent });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { name, prompt, intents, config, status, lifecycle_stage } = req.body;

      // Item 17 — validate lifecycle stage so junk values can't bypass the DB check.
      if (lifecycle_stage !== undefined && !['development', 'qa', 'uat', 'production'].includes(lifecycle_stage)) {
        return res.status(400).json({ error: 'lifecycle_stage must be one of: development, qa, uat, production' });
      }

      const agent = await agentService.update(id, { name, prompt, intents, config, status, lifecycle_stage });
      
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
   * If preview=true in request body, returns test cases without saving
   */
  async generateTestCases(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { maxTestCases = 35, preview = false } = req.body;
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

      // If preview mode, return test cases without saving
      if (preview) {
        const previewTestCases = result.testCases.map((tc: any, index: number) => ({
          id: `preview-${index}-${Date.now()}`, // Temporary ID for preview
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome || tc.expected_behavior || '',
          expectedOutcome: tc.expectedOutcome || tc.expected_behavior || '',
          category: tc.category || 'General',
          key_topic: tc.keyTopic || tc.key_topic || tc.category || 'General',
          priority: tc.priority || 'medium',
          is_security_test: tc.is_security_test || tc.category === 'Security' || false,
          security_test_type: tc.security_test_type || undefined,
        }));

        return res.json({
          agentAnalysis: result.agentAnalysis,
          testCases: previewTestCases,
          preview: true,
        });
      }

      // Auto-save the generated test cases
      const { testCaseService } = await import('../services/testCase.service');
      
      const savedTestCases = await testCaseService.createMany(
        result.testCases.map((tc: any) => {
          const isSeed = typeof tc.id === 'string' && tc.id.startsWith('tc-seed-');
          return {
            agent_id: id,
            user_id: userId,
            name: tc.name,
            scenario: tc.scenario,
            expected_behavior: tc.expectedOutcome || tc.expected_behavior || '',
            category: tc.category || 'General',
            key_topic: tc.keyTopic || tc.key_topic || tc.category || 'General',
            priority: tc.priority || 'medium',
            batch_compatible: true,
            // Persona + security fields (forwarded from seed adversarial cases)
            persona_type: tc.persona_type || undefined,
            behavior_modifiers: tc.behavior_modifiers || undefined,
            is_security_test: tc.is_security_test || false,
            security_test_type: tc.security_test_type || undefined,
            // Gold-example gate: auto-seed + AI-generated cases get the soft gate
            // (they already have strong rubrics). Manual cases default to strict.
            created_via: isSeed ? 'auto_seed' : 'ai_generated',
            gold_gate: 'soft',
          };
        })
      );

      // Deduct credits for generated test cases
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Generated ${savedTestCases.length} test cases for agent: ${agent.name}`,
        { agentId: id, testCaseCount: savedTestCases.length }
      );

      res.json({
        agentAnalysis: result.agentAnalysis,
        testCases: savedTestCases,
      });
    } catch (error: any) {
      logger.error(`Error generating test cases:`, { error });
      // Return more specific error message
      const errorMessage = error?.message || 'Failed to generate test cases';
      res.status(500).json({ error: errorMessage, message: errorMessage });
    }
  }

  /**
   * Generate test cases using the deterministic archetype catalog.
   * Layer 1 (categories, scoring, persona) is fixed in code; Layer 2 (slot
   * values) is filled by the LLM. Same request/response shape as
   * generateTestCases so the frontend treats both paths identically.
   *
   * Body: { archetypeIds?: string[], preview?: boolean }
   *  - archetypeIds: optional subset. If omitted/empty, uses full catalog.
   *  - preview: if true, returns generated cases WITHOUT saving (mirrors
   *    the existing AI-generation preview behavior).
   */
  async generateTestCasesFromArchetypes(req: Request, res: Response, _next: NextFunction) {
    try {
      const { id } = req.params;
      const { archetypeIds, preview = false } = req.body || {};
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const userId = user.id;

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const { archetypeTestCaseGeneratorService } = await import(
        '../services/archetype-testcase-generator.service'
      );

      const result = await archetypeTestCaseGeneratorService.generateFromArchetypes(
        agent.name,
        agent.prompt || '',
        Array.isArray(archetypeIds) ? archetypeIds : undefined,
      );

      if (preview) {
        const previewTestCases = result.testCases.map((tc, index) => ({
          id: `preview-arch-${index}-${Date.now()}`,
          archetype_id: tc.archetype_id,
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome,
          expectedOutcome: tc.expectedOutcome,
          category: tc.category,
          key_topic: tc.keyTopic,
          priority: tc.priority,
          persona_type: tc.persona_type,
          is_security_test: tc.is_security_test || tc.category === 'Security' || false,
          security_test_type: tc.security_test_type,
        }));
        return res.json({
          archetypesUsed: result.archetypesUsed,
          testCases: previewTestCases,
          preview: true,
          mode: 'archetype',
        });
      }

      const { testCaseService } = await import('../services/testCase.service');
      const savedTestCases = await testCaseService.createMany(
        result.testCases.map((tc) => ({
          agent_id: id,
          user_id: userId,
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome,
          category: tc.category,
          key_topic: tc.keyTopic,
          priority: tc.priority,
          batch_compatible: true,
          persona_type: (tc.persona_type as any) || undefined,
          behavior_modifiers: (tc.behavior_modifiers as any) || undefined,
          is_security_test: tc.is_security_test || false,
          security_test_type: (tc.security_test_type as any) || undefined,
          // Archetype-generated cases are deterministic-skeleton + LLM-filled,
          // so they inherit the soft gold gate (same as ai_generated).
          created_via: 'archetype',
          gold_gate: 'soft',
        })),
      );

      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Generated ${savedTestCases.length} archetype-based test cases for agent: ${agent.name}`,
        { agentId: id, testCaseCount: savedTestCases.length, mode: 'archetype' },
      );

      res.json({
        archetypesUsed: result.archetypesUsed,
        testCases: savedTestCases,
        mode: 'archetype',
      });
    } catch (error: any) {
      logger.error(`Error generating archetype-based test cases:`, { error });
      const errorMessage = error?.message || 'Failed to generate archetype test cases';
      res.status(500).json({ error: errorMessage, message: errorMessage });
    }
  }

  /**
   * Return the static archetype catalog so the UI can show users what each
   * "Generate from Archetypes" run will produce, and optionally let them
   * deselect specific archetypes.
   */
  async listArchetypes(_req: Request, res: Response, _next: NextFunction) {
    try {
      const { TEST_ARCHETYPES } = await import('../data/test-archetypes');
      res.json({
        archetypes: TEST_ARCHETYPES.map((a) => ({
          id: a.id,
          label: a.label,
          category: a.category,
          key_topic: a.key_topic,
          priority: a.priority,
          persona_type: a.persona_type,
          is_security_test: !!a.is_security_test,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || 'Failed to list archetypes' });
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
          key_topic: tc.keyTopic || tc.key_topic || tc.category || 'General',
          priority: tc.priority || 'medium',
          batch_compatible: true,
          // Honor created_via / gold_gate when forwarded by callers (e.g. the
          // archetype preview flow stamps 'archetype'). Defaults preserve the
          // pre-existing behavior for manual saves.
          created_via: tc.created_via || undefined,
          gold_gate: tc.gold_gate || undefined,
          persona_type: tc.persona_type || undefined,
          behavior_modifiers: tc.behavior_modifiers || undefined,
          is_security_test: tc.is_security_test || false,
          security_test_type: tc.security_test_type || undefined,
        }))
      );

      // Deduct credits for saved test cases
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Saved ${createdTestCases.length} test cases for agent: ${agent.name}`,
        { agentId: id, testCaseCount: createdTestCases.length }
      );

      res.json({ testCases: createdTestCases });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Analyze agent's prompt using AI
   */
  async analyzePrompt(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      if (!agent.prompt) {
        return res.status(400).json({ error: 'No prompt available to analyze' });
      }

      // Use OpenAI to analyze the prompt
      const OpenAI = (await import('openai')).default;
      const { config } = await import('../config');
      
      const openai = new OpenAI({
        apiKey: config.openai.apiKey,
        organization: config.openai.orgId,
      });

      const systemPrompt = `You are an expert voice AI agent analyst. Analyze the given voice agent's system prompt to understand its purpose, capabilities, expected behaviors, strengths, and weaknesses.

Return a JSON object with the following structure:
{
  "purpose": "A clear, concise description of what this agent is designed to do (1-2 sentences)",
  "capabilities": ["List of specific capabilities the agent has based on the prompt"],
  "expectedBehaviors": ["List of expected behaviors and guidelines from the prompt"],
  "strengths": ["List of strengths in this prompt design"],
  "weaknesses": ["List of areas that could be improved"]
}

Be specific and detailed in your analysis. Extract actual information from the prompt, not generic placeholders.`;

      const userPrompt = `Analyze this voice agent prompt:

Agent Name: ${agent.name}

System Prompt:
${agent.prompt}

Configuration:
${JSON.stringify(agent.config || {}, null, 2)}

Provide your analysis as a JSON object.`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const analysis = JSON.parse(response.choices[0].message.content || '{}');

      res.json({
        purpose: analysis.purpose || 'Purpose could not be determined',
        capabilities: analysis.capabilities || [],
        expectedBehaviors: analysis.expectedBehaviors || [],
        strengths: analysis.strengths || [],
        weaknesses: analysis.weaknesses || [],
      });
    } catch (error: any) {
      logger.error(`Error analyzing prompt:`, { error });
      res.status(500).json({ error: error?.message || 'Failed to analyze prompt' });
    }
  }

  /**
   * Extract dynamic variables from agent's prompt
   * Dynamic variables are placeholders like {{variable_name}} or {variable_name}
   */
  async getDynamicVariables(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const prompt = agent.prompt || '';
      const config = agent.config || {};

      // Extract variables from prompt using multiple patterns
      const variables: Array<{
        name: string;
        pattern: string;
        source: string;
        defaultValue?: string;
        description?: string;
      }> = [];

      // Pattern 1: {{variable_name}} - Handlebars style
      const handlebarsPattern = /\{\{([^}]+)\}\}/g;
      let match;
      while ((match = handlebarsPattern.exec(prompt)) !== null) {
        const varName = match[1].trim();
        if (!variables.find(v => v.name === varName)) {
          variables.push({
            name: varName,
            pattern: `{{${varName}}}`,
            source: 'prompt',
            description: `Dynamic variable found in prompt`,
          });
        }
      }

      // Pattern 2: {variable_name} - Single brace style
      const singleBracePattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
      while ((match = singleBracePattern.exec(prompt)) !== null) {
        const varName = match[1].trim();
        if (!variables.find(v => v.name === varName)) {
          variables.push({
            name: varName,
            pattern: `{${varName}}`,
            source: 'prompt',
            description: `Dynamic variable found in prompt`,
          });
        }
      }

      // Pattern 3: $variable_name or ${variable_name} - Shell style
      const shellPattern = /\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g;
      while ((match = shellPattern.exec(prompt)) !== null) {
        const varName = match[1].trim();
        if (!variables.find(v => v.name === varName)) {
          variables.push({
            name: varName,
            pattern: match[0],
            source: 'prompt',
            description: `Dynamic variable found in prompt`,
          });
        }
      }

      // Pattern 4: [variable_name] - Square bracket style
      const bracketPattern = /\[([A-Z_][A-Z0-9_]*)\]/g;
      while ((match = bracketPattern.exec(prompt)) !== null) {
        const varName = match[1].trim();
        if (!variables.find(v => v.name === varName)) {
          variables.push({
            name: varName,
            pattern: `[${varName}]`,
            source: 'prompt',
            description: `Dynamic variable found in prompt`,
          });
        }
      }

      // Check config for dynamic variable definitions (provider-specific)
      if (config.dynamic_variables || config.dynamicVariables) {
        const configVars = config.dynamic_variables || config.dynamicVariables;
        if (Array.isArray(configVars)) {
          configVars.forEach((v: any) => {
            const varName = v.name || v.key || v.variable;
            if (varName && !variables.find(existing => existing.name === varName)) {
              variables.push({
                name: varName,
                pattern: `{{${varName}}}`,
                source: 'config',
                defaultValue: v.default || v.defaultValue,
                description: v.description || `Defined in agent config`,
              });
            }
          });
        } else if (typeof configVars === 'object') {
          Object.entries(configVars).forEach(([key, value]: [string, any]) => {
            if (!variables.find(v => v.name === key)) {
              variables.push({
                name: key,
                pattern: `{{${key}}}`,
                source: 'config',
                defaultValue: typeof value === 'string' ? value : value?.default,
                description: value?.description || `Defined in agent config`,
              });
            }
          });
        }
      }

      // Check for Retell-specific dynamic variables webhook
      const dynamicVariablesWebhook = config.inbound_dynamic_variables_webhook_url ||
        config.metadata?.inbound_dynamic_variables_webhook_url;

      res.json({
        variables,
        webhookUrl: dynamicVariablesWebhook,
        totalCount: variables.length,
      });
    } catch (error: any) {
      logger.error(`Error extracting dynamic variables:`, { error });
      res.status(500).json({ error: error?.message || 'Failed to extract dynamic variables' });
    }
  }

  /**
   * Save dynamic variable test values for an agent
   */
  async saveDynamicVariables(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { variables } = req.body;

      if (!variables || typeof variables !== 'object') {
        return res.status(400).json({ error: 'Variables object is required' });
      }

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Store test values in the agent's config
      const currentConfig = agent.config || {};
      const updatedConfig = {
        ...currentConfig,
        testVariables: variables,
      };

      const updatedAgent = await agentService.update(id, { config: updatedConfig });

      res.json({
        success: true,
        message: 'Dynamic variable test values saved successfully',
        variables,
      });
    } catch (error: any) {
      logger.error(`Error saving dynamic variables:`, { error });
      res.status(500).json({ error: error?.message || 'Failed to save dynamic variables' });
    }
  }

  /**
   * Get knowledge base information for an agent
   */
  async getKnowledgeBase(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const agent = await agentService.findById(id);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Get integration to fetch from provider
      const integration = await integrationService.findById(agent.integration_id);
      if (!integration) {
        return res.status(404).json({ error: 'Integration not found' });
      }

      const config = agent.config || {};
      const knowledgeBase: {
        items: Array<{
          id: string;
          name: string;
          type: string;
          description?: string;
          url?: string;
          status?: string;
          createdAt?: string;
        }>;
        provider: string;
        totalCount: number;
      } = {
        items: [],
        provider: agent.provider,
        totalCount: 0,
      };

      // Extract knowledge base based on provider
      switch (agent.provider) {
        case 'vapi':
          // VAPI stores knowledge base in model.knowledgeBase
          if (config.model?.knowledgeBase) {
            const kb = config.model.knowledgeBase;
            if (Array.isArray(kb)) {
              knowledgeBase.items = kb.map((item: any, index: number) => ({
                id: item.id || `kb-${index}`,
                name: item.name || item.fileName || `Knowledge Base ${index + 1}`,
                type: item.type || item.fileType || 'document',
                description: item.description,
                url: item.url || item.fileUrl,
                status: item.status || 'active',
              }));
            } else if (kb.fileIds || kb.provider) {
              knowledgeBase.items = [{
                id: kb.id || 'kb-1',
                name: kb.name || 'Knowledge Base',
                type: kb.provider || 'custom',
                description: `Provider: ${kb.provider || 'N/A'}`,
                status: 'active',
              }];
            }
          }
          break;

        case 'retell':
          // Retell might store KB in general_tools or custom locations
          if (config.metadata?.knowledge_base || config.knowledge_base) {
            const kb = config.metadata?.knowledge_base || config.knowledge_base;
            if (Array.isArray(kb)) {
              knowledgeBase.items = kb.map((item: any, index: number) => ({
                id: item.id || `kb-${index}`,
                name: item.name || `Knowledge Base ${index + 1}`,
                type: item.type || 'document',
                description: item.description,
                url: item.url,
                status: item.status || 'active',
              }));
            }
          }
          // Check tools for retrieval-based KB
          if (config.metadata?.tools || config.tools) {
            const tools = config.metadata?.tools || config.tools;
            const kbTools = tools?.filter((t: any) => 
              t.type === 'retrieval' || t.type === 'knowledge_base' || t.name?.includes('knowledge')
            );
            if (kbTools?.length) {
              kbTools.forEach((tool: any, index: number) => {
                knowledgeBase.items.push({
                  id: tool.id || `tool-kb-${index}`,
                  name: tool.name || `Knowledge Tool ${index + 1}`,
                  type: 'retrieval_tool',
                  description: tool.description,
                  status: 'active',
                });
              });
            }
          }
          break;

        case 'elevenlabs':
          // ElevenLabs - fetch knowledge base from API
          try {
            const providerAgentId = agent.external_agent_id;
            if (!providerAgentId) {
              logger.info('[KB] No external_agent_id found for ElevenLabs agent');
              break;
            }
            logger.info(`[KB] Fetching ElevenLabs KB for agent: ${providerAgentId}`);
            const kbDocs = await elevenlabsProvider.getKnowledgeBase(integration.api_key, providerAgentId);
            logger.info(`[KB] ElevenLabs returned ${kbDocs?.length || 0} documents`);
            
            if (Array.isArray(kbDocs) && kbDocs.length > 0) {
              logger.info(`[KB] First doc sample:`, { detail: JSON.stringify(kbDocs[0], null, 2) });
              knowledgeBase.items = kbDocs.map((item: any, index: number) => ({
                id: item.id || item.document_id || `kb-${index}`,
                name: item.name || item.file_name || item.filename || `Document ${index + 1}`,
                type: item.type || item.document_type || 'document',
                description: item.description || (item.url ? `Source: ${item.url}` : (item.metadata?.size_bytes ? `Size: ${Math.round(item.metadata.size_bytes / 1024)} KB` : undefined)),
                url: item.url || item.source_url,
                status: item.status || 'active',
                createdAt: item.metadata?.created_at_unix_secs 
                  ? new Date(item.metadata.created_at_unix_secs * 1000).toISOString() 
                  : (item.created_at || item.createdAt),
                size: item.metadata?.size_bytes || item.size || item.file_size,
              }));
            } else {
              logger.info('[KB] No documents returned from ElevenLabs API');
            }
          } catch (elevenError: any) {
            logger.error(`[KB] Error fetching ElevenLabs knowledge base:`, { detail: elevenError?.message || elevenError });
            // Fallback to config-based extraction
            if (config.fullConfig?.knowledge_base || config.knowledge_base) {
              const kb = config.fullConfig?.knowledge_base || config.knowledge_base;
              if (Array.isArray(kb)) {
                knowledgeBase.items = kb.map((item: any, index: number) => ({
                  id: item.id || `kb-${index}`,
                  name: item.name || item.file_name || `Document ${index + 1}`,
                  type: item.type || 'document',
                  description: item.description,
                  url: item.url,
                  status: item.status || 'active',
                  createdAt: item.created_at,
                }));
              }
            }
          }
          break;

        case 'openai_realtime':
          // OpenAI Assistants use file_search tool with vector stores
          if (config.metadata?.toolResources?.file_search) {
            const fileSearch = config.metadata.toolResources.file_search;
            if (fileSearch.vector_store_ids) {
              fileSearch.vector_store_ids.forEach((vsId: string, index: number) => {
                knowledgeBase.items.push({
                  id: vsId,
                  name: `Vector Store ${index + 1}`,
                  type: 'vector_store',
                  description: 'OpenAI Vector Store for file search',
                  status: 'active',
                });
              });
            }
          }
          // Check for code_interpreter files
          if (config.metadata?.toolResources?.code_interpreter?.file_ids) {
            config.metadata.toolResources.code_interpreter.file_ids.forEach((fileId: string, index: number) => {
              knowledgeBase.items.push({
                id: fileId,
                name: `Code Interpreter File ${index + 1}`,
                type: 'code_interpreter_file',
                description: 'File for code interpreter',
                status: 'active',
              });
            });
          }
          break;
      }

      knowledgeBase.totalCount = knowledgeBase.items.length;

      res.json(knowledgeBase);
    } catch (error: any) {
      logger.error(`Error fetching knowledge base:`, { error });
      res.status(500).json({ error: error?.message || 'Failed to fetch knowledge base' });
    }
  }

  /**
   * Get knowledge base document content
   */
  async getKnowledgeBaseDocumentContent(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, documentId } = req.params;
      logger.info(`[KB Content] Fetching document content for agent: ${id}, document: ${documentId}`);

      const agent = await agentService.findById(id);
      if (!agent) {
        logger.info('[KB Content] Agent not found');
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Get integration to fetch from provider
      const integration = await integrationService.findById(agent.integration_id);
      if (!integration) {
        logger.info('[KB Content] Integration not found');
        return res.status(404).json({ error: 'Integration not found' });
      }

      logger.info(`[KB Content] Provider: ${agent.provider}, fetching from ElevenLabs...`);

      let content = '';
      let contentType = 'text/plain';

      switch (agent.provider) {
        case 'elevenlabs':
          try {
            content = await elevenlabsProvider.getKnowledgeBaseDocumentContent(
              integration.api_key,
              documentId
            );
            logger.info(`[KB Content] Successfully fetched content, length: ${content.length}`);
            // Check if content is HTML
            if (content.trim().startsWith('<')) {
              contentType = 'text/html';
            }
          } catch (error: any) {
            logger.error(`[KB Content] ElevenLabs error:`, { detail: error?.message });
            return res.status(500).json({ 
              error: error?.message || 'Failed to fetch document content' 
            });
          }
          break;

        default:
          return res.status(400).json({ 
            error: `Document content viewing not supported for provider: ${agent.provider}` 
          });
      }

      res.json({ content, contentType, documentId });
    } catch (error: any) {
      logger.error(`Error fetching document content:`, { error });
      res.status(500).json({ error: error?.message || 'Failed to fetch document content' });
    }
  }
}

export const agentController = new AgentController();
