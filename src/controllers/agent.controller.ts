import { Request, Response, NextFunction } from 'express';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';
import { promptVersionService } from '../services/promptVersion.service';
import { configVersionService } from '../services/configVersion.service';
import { integrationService } from '../services/integration.service';
import { elevenlabsProvider } from '../providers/elevenlabs.provider';
import { teamMemberService } from '../services/teamMember.service';

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
        result.testCases.map((tc: any) => ({
          agent_id: id,
          user_id: userId,
          name: tc.name,
          scenario: tc.scenario,
          expected_behavior: tc.expectedOutcome || tc.expected_behavior || '',
          category: tc.category || 'General',
          key_topic: tc.keyTopic || tc.key_topic || tc.category || 'General',
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
          key_topic: tc.keyTopic || tc.key_topic || tc.category || 'General',
          priority: tc.priority || 'medium',
          batch_compatible: true,
        }))
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
      console.error('Error analyzing prompt:', error);
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
      console.error('Error extracting dynamic variables:', error);
      res.status(500).json({ error: error?.message || 'Failed to extract dynamic variables' });
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
              console.log('[KB] No external_agent_id found for ElevenLabs agent');
              break;
            }
            console.log(`[KB] Fetching ElevenLabs KB for agent: ${providerAgentId}`);
            const kbDocs = await elevenlabsProvider.getKnowledgeBase(integration.api_key, providerAgentId);
            console.log(`[KB] ElevenLabs returned ${kbDocs?.length || 0} documents`);
            
            if (Array.isArray(kbDocs) && kbDocs.length > 0) {
              console.log('[KB] First doc sample:', JSON.stringify(kbDocs[0], null, 2));
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
              console.log('[KB] No documents returned from ElevenLabs API');
            }
          } catch (elevenError: any) {
            console.error('[KB] Error fetching ElevenLabs knowledge base:', elevenError?.message || elevenError);
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
      console.error('Error fetching knowledge base:', error);
      res.status(500).json({ error: error?.message || 'Failed to fetch knowledge base' });
    }
  }

  /**
   * Get knowledge base document content
   */
  async getKnowledgeBaseDocumentContent(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, documentId } = req.params;
      console.log(`[KB Content] Fetching document content for agent: ${id}, document: ${documentId}`);

      const agent = await agentService.findById(id);
      if (!agent) {
        console.log('[KB Content] Agent not found');
        return res.status(404).json({ error: 'Agent not found' });
      }

      // Get integration to fetch from provider
      const integration = await integrationService.findById(agent.integration_id);
      if (!integration) {
        console.log('[KB Content] Integration not found');
        return res.status(404).json({ error: 'Integration not found' });
      }

      console.log(`[KB Content] Provider: ${agent.provider}, fetching from ElevenLabs...`);

      let content = '';
      let contentType = 'text/plain';

      switch (agent.provider) {
        case 'elevenlabs':
          try {
            content = await elevenlabsProvider.getKnowledgeBaseDocumentContent(
              integration.api_key,
              documentId
            );
            console.log(`[KB Content] Successfully fetched content, length: ${content.length}`);
            // Check if content is HTML
            if (content.trim().startsWith('<')) {
              contentType = 'text/html';
            }
          } catch (error: any) {
            console.error('[KB Content] ElevenLabs error:', error?.message);
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
      console.error('Error fetching document content:', error);
      res.status(500).json({ error: error?.message || 'Failed to fetch document content' });
    }
  }
}

export const agentController = new AgentController();
