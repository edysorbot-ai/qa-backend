/**
 * Test Case Generator Service
 * Uses OpenAI to analyze voice agents and generate test cases
 */

import OpenAI from 'openai';
import { config } from '../config';

interface AgentAnalysis {
  purpose: string;
  capabilities: string[];
  expectedBehaviors: string[];
  configs: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    voice?: string;
    language?: string;
    responseDelay?: number;
    silenceTimeout?: number;
    maxDuration?: number;
    tools?: string[];
    [key: string]: any;
  };
}

interface GeneratedTestCase {
  id: string;
  name: string;
  scenario: string;
  category: string;
  keyTopic: string; // Logical topic for batching (e.g., "Budget Validation", "Eligibility Check")
  expectedOutcome: string;
  priority: 'high' | 'medium' | 'low';
}

interface TestCaseGenerationResult {
  agentAnalysis: AgentAnalysis;
  testCases: GeneratedTestCase[];
}

export class TestCaseGeneratorService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      organization: config.openai.orgId,
    });
  }

  /**
   * Analyze agent and generate test cases
   */
  async analyzeAndGenerateTestCases(
    agentName: string,
    agentPrompt: string,
    agentConfig: Record<string, any>,
    maxTestCases: number = 20
  ): Promise<TestCaseGenerationResult> {
    // First, analyze the agent
    const agentAnalysis = await this.analyzeAgent(agentName, agentPrompt, agentConfig);
    
    // Then, generate test cases based on analysis
    const testCases = await this.generateTestCases(agentAnalysis, agentPrompt, maxTestCases);

    return {
      agentAnalysis,
      testCases,
    };
  }

  /**
   * Analyze agent's purpose, capabilities, and configurations
   */
  private async analyzeAgent(
    agentName: string,
    agentPrompt: string,
    agentConfig: Record<string, any>
  ): Promise<AgentAnalysis> {
    const systemPrompt = `You are an expert voice AI agent analyst. Analyze the given voice agent's system prompt and configuration to understand its purpose, capabilities, and expected behaviors.

Return a JSON object with the following structure:
{
  "purpose": "A clear, concise description of what this agent is designed to do (1-2 sentences)",
  "capabilities": ["List of specific capabilities the agent has"],
  "expectedBehaviors": ["List of expected behaviors based on the prompt"]
}

Be specific and actionable in your analysis. Focus on what the agent CAN do, not general descriptions.`;

    const userPrompt = `Analyze this voice agent:

Agent Name: ${agentName}

System Prompt:
${agentPrompt || 'No system prompt provided'}

Configuration:
${JSON.stringify(agentConfig, null, 2)}

Provide your analysis as a JSON object.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const analysis = JSON.parse(response.choices[0].message.content || '{}');

    // Extract comprehensive config values from agentConfig
    // Values are now directly in metadata from the provider
    // Also handle nested fullConfig as fallback
    const fullConfig = agentConfig.fullConfig || {};
    const agentSection = fullConfig.agent || {};
    const promptSection = agentSection.prompt || {};
    const ttsSection = fullConfig.tts || {};
    const sttSection = fullConfig.stt || {};
    const turnSection = fullConfig.turn || {};

    const configs: AgentAnalysis['configs'] = {
      // LLM Settings - direct from metadata or from nested config
      llmModel: agentConfig.llmModel || agentConfig.modelName || agentConfig.model || promptSection.llm,
      llmProvider: agentConfig.modelProvider || agentConfig.llmProvider,
      temperature: agentConfig.temperature ?? promptSection.temperature,
      maxTokens: agentConfig.maxTokens ?? promptSection.max_tokens,
      
      // Voice Settings - direct from metadata or from nested config
      voice: agentConfig.voice || agentConfig.voiceId || ttsSection.voice_id,
      voiceModel: agentConfig.voiceModel || ttsSection.model_id,
      voiceProvider: agentConfig.voiceProvider || ttsSection.provider,
      voiceSpeed: agentConfig.voiceSpeed ?? ttsSection.speed,
      voiceStability: agentConfig.voiceStability ?? ttsSection.stability,
      voiceSimilarityBoost: agentConfig.voiceSimilarityBoost ?? ttsSection.similarity_boost,
      voiceStyle: agentConfig.voiceStyle ?? ttsSection.style,
      optimizeLatency: agentConfig.optimizeLatency ?? ttsSection.optimize_streaming_latency,
      
      // Language & Transcription
      language: agentConfig.language || agentSection.language,
      transcriberProvider: agentConfig.transcriberProvider || sttSection.provider || agentConfig.transcriber?.provider,
      transcriberModel: agentConfig.transcriberModel || sttSection.model || agentConfig.transcriber?.model,
      transcriberLanguage: agentConfig.transcriberLanguage || sttSection.language || agentConfig.transcriber?.language,
      
      // Conversation Settings
      firstMessage: agentConfig.firstMessage || agentConfig.beginMessage || agentSection.first_message,
      responseDelay: agentConfig.responseDelaySeconds ?? agentConfig.responsiveness,
      silenceTimeout: agentConfig.silenceTimeout ?? agentConfig.silenceTimeoutSeconds ?? turnSection.silence_timeout_ms,
      maxDuration: agentConfig.maxDuration ?? agentConfig.maxDurationSeconds ?? turnSection.max_duration_ms,
      turnTimeout: agentConfig.turnTimeout ?? turnSection.turn_timeout,
      
      // Features
      backchannelingEnabled: agentConfig.backchannelingEnabled ?? agentConfig.enableBackchannel,
      interruptionSensitivity: agentConfig.interruptionSensitivity,
      backgroundSound: agentConfig.backgroundSound,
      backgroundDenoisingEnabled: agentConfig.backgroundDenoisingEnabled,
      recordingEnabled: agentConfig.recordingEnabled,
      hipaaEnabled: agentConfig.hipaaEnabled,
      
      // Tools
      tools: agentConfig.tools ? (Array.isArray(agentConfig.tools) ? agentConfig.tools.map((t: any) => t.name || t.type || 'tool') : []) : undefined,
    };

    // Remove undefined values
    Object.keys(configs).forEach(key => {
      if (configs[key] === undefined) {
        delete configs[key];
      }
    });

    return {
      purpose: analysis.purpose || 'Purpose could not be determined',
      capabilities: analysis.capabilities || [],
      expectedBehaviors: analysis.expectedBehaviors || [],
      configs,
    };
  }

  /**
   * Generate test cases based on agent analysis
   */
  private async generateTestCases(
    analysis: AgentAnalysis,
    agentPrompt: string,
    maxTestCases: number
  ): Promise<GeneratedTestCase[]> {
    const systemPrompt = `You are an expert QA engineer specializing in voice AI agent testing. Generate comprehensive test cases for voice agent testing.

Create test cases that cover:
1. Happy path scenarios (normal expected interactions)
2. Edge cases (unusual but valid inputs)
3. Error handling (invalid inputs, unclear speech)
4. Boundary testing (timeouts, long conversations)
5. Conversation flow testing (multi-turn interactions)
6. Tool/function testing (if applicable)
7. Language/accent variations (if multilingual)
8. Interruption handling
9. Fallback behaviors

IMPORTANT: Group test cases by LOGICAL TOPIC. A topic represents a semantic area that the agent handles.
Examples of topics: "Budget Validation", "Eligibility Check", "Greeting", "Call Transfer", "Product Information", etc.
Test cases with the SAME topic can be tested together in a single call.

Return a JSON object with the following structure:
{
  "testCases": [
    {
      "name": "Short descriptive name",
      "scenario": "Detailed description of the test scenario and what the user will say/do",
      "category": "Test type (e.g., 'Happy Path', 'Edge Case', 'Error Handling')",
      "keyTopic": "Logical topic being tested (e.g., 'Budget Validation', 'Eligibility Check', 'Greeting')",
      "expectedOutcome": "What should happen when this test is executed",
      "priority": "high|medium|low"
    }
  ]
}

CRITICAL: keyTopic must be a SPECIFIC, SEMANTIC topic from the agent's domain. NOT generic test categories.
Test cases with the same keyTopic should be logically related and can be tested in sequence.

Generate exactly ${maxTestCases} diverse test cases that thoroughly test the agent.`;

    const userPrompt = `Generate test cases for this voice agent:

Agent Purpose: ${analysis.purpose}

Capabilities:
${analysis.capabilities.map(c => `- ${c}`).join('\n')}

Expected Behaviors:
${analysis.expectedBehaviors.map(b => `- ${b}`).join('\n')}

Agent Configurations:
${JSON.stringify(analysis.configs, null, 2)}

Original System Prompt:
${agentPrompt || 'Not provided'}

Generate ${maxTestCases} comprehensive test cases as a JSON object.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content || '{"testCases": []}');
    
    // Add unique IDs to test cases
    return (result.testCases || []).map((tc: any, index: number) => ({
      id: `tc-${Date.now()}-${index}`,
      name: tc.name || `Test Case ${index + 1}`,
      scenario: tc.scenario || '',
      category: tc.category || 'General',
      keyTopic: tc.keyTopic || tc.key_topic || tc.category || 'General',
      expectedOutcome: tc.expectedOutcome || '',
      priority: tc.priority || 'medium',
    }));
  }
}

export const testCaseGeneratorService = new TestCaseGeneratorService();
