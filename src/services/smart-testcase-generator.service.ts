/**
 * Smart Test Case Generator Service
 * 
 * Enhanced test case generation that:
 * 1. Extracts key topics from agent prompts
 * 2. Generates test cases organized by topics
 * 3. Supports batching test cases for efficient single-call testing
 * 4. Provides comprehensive metrics analysis
 */

import OpenAI from 'openai';
import { config } from '../config';

// ============ INTERFACES ============

export interface KeyTopic {
  id: string;
  name: string;
  description: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
  testableAspects: string[];
  relatedTopics?: string[];
}

export interface SmartTestCase {
  id: string;
  name: string;
  scenario: string;
  userInput: string;
  expectedOutcome: string;
  category: string;
  keyTopicId: string;
  keyTopicName: string;
  priority: 'high' | 'medium' | 'low';
  canBatchWith: string[]; // IDs of test cases that can be tested in same call
  requiresSeparateCall: boolean;
  estimatedTurns: number;
  testType: TestType;
  isCallClosing: boolean; // Whether this test case may cause the agent to end the call
  batchPosition: 'start' | 'middle' | 'end' | 'any'; // Preferred position in batch
  semanticGroup?: string; // Semantic grouping for meaningful batching (e.g., "user_info_collection", "eligibility_flow")
}

export type TestType = 
  | 'happy_path'
  | 'edge_case'
  | 'error_handling'
  | 'boundary'
  | 'multi_turn'
  | 'topic_change'
  | 'interruption'
  | 'fallback'
  | 'budget_validation'
  | 'eligibility_check'
  | 'context_retention'
  | 'sentiment_handling'
  | 'call_closing'      // Test cases that trigger call end
  | 'call_transfer'     // Test cases that trigger call transfer
  | 'goodbye_handling'; // Test cases about ending conversation

export interface CallBatch {
  id: string;
  name: string;
  testCaseIds: string[];
  testCases: SmartTestCase[];
  estimatedDuration: number; // in seconds
  primaryTopic: string;
  description: string;
  semanticFlow?: string; // Description of the semantic flow this batch tests
}

export interface TestPlan {
  totalCalls: number;
  totalTestCases: number;
  estimatedDuration: number;
  batches: CallBatch[];
}

export interface AgentAnalysisResult {
  purpose: string;
  domain: string;
  keyTopics: KeyTopic[];
  capabilities: string[];
  expectedBehaviors: string[];
  configs: Record<string, any>;
}

export interface GenerationResult {
  agentAnalysis: AgentAnalysisResult;
  testCases: SmartTestCase[];
  testPlan: TestPlan;
}

// Comprehensive metrics structure
export interface TestMetrics {
  // Performance Metrics
  performance: {
    avgResponseTimeMs: number;
    minResponseTimeMs: number;
    maxResponseTimeMs: number;
    throughputRequestsPerMin: number;
  };
  
  // Accuracy Metrics
  accuracy: {
    intentRecognitionScore: number;
    entityRecognitionScore: number;
    wordErrorRate: number;
    sentenceErrorRate: number;
  };
  
  // User Experience Metrics
  userExperience: {
    turnCompletionRate: number;
    fallbackRate: number;
    escalationRate: number;
    naturalness: number;
    clarity: number;
  };
  
  // Error Handling Metrics
  errorHandling: {
    errorDetectionRate: number;
    errorRecoveryRate: number;
  };
  
  // Interaction Quality Metrics
  interactionQuality: {
    contextualUnderstanding: number;
    dialogueContinuity: number;
    engagementScore: number;
    sentimentScore: number;
  };
  
  // Task Completion Metrics
  taskCompletion: {
    successRate: number;
    failureRate: number;
    avgTimeToCompletion: number;
  };
  
  // Overall Scores
  overall: {
    score: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
  };
}

export interface PromptRecommendation {
  area: string;
  issue: string;
  currentBehavior: string;
  suggestedChange: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  affectedTestCases: string[];
}

export interface TestResultAnalysis {
  metrics: TestMetrics;
  promptRecommendations: PromptRecommendation[];
  strengths: string[];
  weaknesses: string[];
  summary: string;
}

// ============ SERVICE ============

export class SmartTestCaseGeneratorService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      organization: config.openai.orgId,
      timeout: 120000, // 120 seconds timeout
    });
  }

  /**
   * Main entry point: Analyze agent and generate smart test cases with batching
   */
  async generateSmartTestCases(
    agentName: string,
    agentPrompt: string,
    agentConfig: Record<string, any>,
    maxTestCases: number = 20
  ): Promise<GenerationResult> {
    console.log(`[SmartTestCaseGenerator] Starting analysis for: ${agentName}`);
    
    // Step 1: Extract key topics from the prompt
    const keyTopics = await this.extractKeyTopics(agentPrompt, agentConfig);
    console.log(`[SmartTestCaseGenerator] Extracted ${keyTopics.length} key topics`);
    
    // Step 2: Analyze the agent
    const agentAnalysis = await this.analyzeAgent(agentName, agentPrompt, agentConfig, keyTopics);
    
    // Step 3: Generate test cases organized by topics
    const testCases = await this.generateTestCasesByTopics(agentAnalysis, agentPrompt, keyTopics, maxTestCases);
    console.log(`[SmartTestCaseGenerator] Generated ${testCases.length} test cases`);
    
    // Step 4: Create optimal test plan with batching
    const testPlan = await this.createTestPlan(testCases, keyTopics);
    console.log(`[SmartTestCaseGenerator] Created test plan with ${testPlan.totalCalls} calls`);
    
    return {
      agentAnalysis,
      testCases,
      testPlan,
    };
  }

  /**
   * Extract key topics from the agent's prompt
   */
  private async extractKeyTopics(
    agentPrompt: string,
    agentConfig: Record<string, any>
  ): Promise<KeyTopic[]> {
    const systemPrompt = `You are an expert at analyzing voice AI agent prompts and extracting key topics/themes that need to be tested.

Analyze the given prompt and identify ALL key topics that the agent handles. These topics will be used to generate comprehensive test cases.

For a study abroad counselor, topics might include:
- Budget validation (checking if user's budget meets requirements)
- Eligibility criteria (academic qualifications, language scores)
- Destination preferences (country selection, reasons)
- Program types (Masters, PhD, undergraduate)
- Timeline/deadlines
- Documentation requirements
- Visa process
- Scholarships/funding
- Topic changes (user changing subject mid-conversation)
- Off-topic handling
- Error/edge cases

Return a JSON object with this structure:
{
  "keyTopics": [
    {
      "id": "unique_id_snake_case",
      "name": "Human Readable Name",
      "description": "What this topic covers",
      "importance": "critical|high|medium|low",
      "testableAspects": ["aspect1", "aspect2"],
      "relatedTopics": ["other_topic_id"]
    }
  ]
}

Be comprehensive - identify ALL topics that can be tested. Include both domain-specific topics AND general conversation handling topics.`;

    const userPrompt = `Extract key topics from this voice agent prompt:

${agentPrompt || 'No prompt provided'}

Configuration context:
${JSON.stringify(agentConfig, null, 2)}

Identify all testable topics as JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const result = JSON.parse(response.choices[0].message.content || '{"keyTopics": []}');
      
      // Ensure all topics have required fields
      return (result.keyTopics || []).map((topic: any, index: number) => ({
        id: topic.id || `topic_${index}`,
        name: topic.name || `Topic ${index + 1}`,
        description: topic.description || '',
        importance: topic.importance || 'medium',
        testableAspects: topic.testableAspects || [],
        relatedTopics: topic.relatedTopics || [],
      }));
    } catch (error) {
      console.error('[SmartTestCaseGenerator] Error extracting key topics:', error);
      // Return default topics if extraction fails
      return this.getDefaultTopics();
    }
  }

  /**
   * Default topics if AI extraction fails
   */
  private getDefaultTopics(): KeyTopic[] {
    return [
      {
        id: 'happy_path',
        name: 'Happy Path',
        description: 'Normal expected conversation flow',
        importance: 'critical',
        testableAspects: ['greeting', 'main_flow', 'conclusion'],
      },
      {
        id: 'error_handling',
        name: 'Error Handling',
        description: 'How agent handles errors and unexpected inputs',
        importance: 'high',
        testableAspects: ['invalid_input', 'unclear_speech', 'out_of_scope'],
      },
      {
        id: 'edge_cases',
        name: 'Edge Cases',
        description: 'Unusual but valid scenarios',
        importance: 'medium',
        testableAspects: ['boundary_values', 'rare_scenarios'],
      },
    ];
  }

  /**
   * Analyze agent with key topics context
   */
  private async analyzeAgent(
    agentName: string,
    agentPrompt: string,
    agentConfig: Record<string, any>,
    keyTopics: KeyTopic[]
  ): Promise<AgentAnalysisResult> {
    const systemPrompt = `You are an expert voice AI agent analyst. Analyze the given voice agent to understand its purpose, domain, capabilities, and expected behaviors.

Return a JSON object:
{
  "purpose": "What this agent does (1-2 sentences)",
  "domain": "The domain/industry (e.g., 'Study Abroad Counseling', 'Customer Support')",
  "capabilities": ["List of specific capabilities"],
  "expectedBehaviors": ["List of expected behaviors"]
}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Agent: ${agentName}\n\nPrompt:\n${agentPrompt}\n\nConfig:\n${JSON.stringify(agentConfig, null, 2)}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const analysis = JSON.parse(response.choices[0].message.content || '{}');

    return {
      purpose: analysis.purpose || 'Purpose not determined',
      domain: analysis.domain || 'General',
      keyTopics,
      capabilities: analysis.capabilities || [],
      expectedBehaviors: analysis.expectedBehaviors || [],
      configs: this.extractConfigs(agentConfig),
    };
  }

  /**
   * Extract configuration values
   */
  private extractConfigs(agentConfig: Record<string, any>): Record<string, any> {
    const configs: Record<string, any> = {};
    
    // Extract relevant config values
    const keys = ['language', 'voice', 'model', 'temperature', 'maxTokens', 'firstMessage'];
    keys.forEach(key => {
      if (agentConfig[key] !== undefined) {
        configs[key] = agentConfig[key];
      }
    });
    
    return configs;
  }

  /**
   * Generate test cases organized by key topics
   */
  private async generateTestCasesByTopics(
    analysis: AgentAnalysisResult,
    agentPrompt: string,
    keyTopics: KeyTopic[],
    maxTestCases: number
  ): Promise<SmartTestCase[]> {
    const systemPrompt = `You are an expert QA engineer. Generate test cases for a voice AI agent, organized by the provided key topics.

CRITICAL RULES FOR CALL-CLOSING SCENARIOS:
1. IDENTIFY ALL scenarios in the prompt that could END the call:
   - Explicit goodbye/end call commands
   - Disqualification scenarios (not eligible, wrong country, insufficient budget)
   - Transfer to human scenarios
   - "I'm not interested" scenarios
   - Maximum retry/failure scenarios
2. Mark these with "isCallClosing": true
3. These MUST be placed at the END of any batch (batchPosition: "end")
4. Call-closing test cases should ideally be in their own batch or at the very end

SEMANTIC GROUPING (semanticGroup field):
Group test cases that form a logical conversation flow:
- "user_info_collection": Getting user details (name, email, phone)
- "eligibility_flow": Checking qualifications, requirements
- "budget_validation": Discussing costs, budget constraints
- "preference_exploration": Understanding user preferences
- "recommendation_flow": Agent providing recommendations
- "objection_handling": Handling user concerns/objections
- "call_closing": Ending the conversation scenarios
- "error_recovery": Handling errors, unclear inputs

BATCH POSITION RULES:
- "start": Should be at beginning (greetings, initial questions)
- "middle": Can go anywhere in conversation
- "end": Should be at end (call-closing, goodbye scenarios)
- "any": Flexible positioning

Return JSON:
{
  "testCases": [
    {
      "name": "Short name",
      "scenario": "Detailed scenario description",
      "userInput": "What the test caller should say/do",
      "expectedOutcome": "Expected agent behavior",
      "category": "Category name",
      "keyTopicId": "topic_id from provided topics",
      "keyTopicName": "Topic Name",
      "priority": "high|medium|low",
      "canBatchWith": ["other_test_case_names that can be in same call"],
      "requiresSeparateCall": true/false,
      "estimatedTurns": 3,
      "testType": "happy_path|edge_case|error_handling|boundary|multi_turn|topic_change|interruption|fallback|budget_validation|eligibility_check|context_retention|sentiment_handling|call_closing|call_transfer|goodbye_handling",
      "isCallClosing": false,
      "batchPosition": "start|middle|end|any",
      "semanticGroup": "user_info_collection|eligibility_flow|budget_validation|preference_exploration|recommendation_flow|objection_handling|call_closing|error_recovery"
    }
  ]
}

CRITICAL: Carefully analyze the agent prompt for ALL scenarios that end the call (goodbye, not interested, not eligible, transfer, etc.) and mark them as isCallClosing=true with batchPosition="end".`;

    const topicsContext = keyTopics.map(t => 
      `- ${t.id}: ${t.name} (${t.importance}) - ${t.description}\n  Testable: ${t.testableAspects.join(', ')}`
    ).join('\n');

    // Calculate minimum test cases per topic to ensure comprehensive coverage
    const minPerTopic = Math.max(3, Math.ceil(maxTestCases / keyTopics.length));

    const userPrompt = `Generate ${maxTestCases} test cases for this voice agent:

AGENT ANALYSIS:
- Purpose: ${analysis.purpose}
- Domain: ${analysis.domain}
- Capabilities: ${analysis.capabilities.join(', ')}

KEY TOPICS TO TEST:
${topicsContext}

ORIGINAL PROMPT:
${agentPrompt}

IMPORTANT REQUIREMENTS:
1. Generate AT LEAST ${minPerTopic} test cases for EACH key topic
2. Each topic MUST have multiple test cases covering different scenarios:
   - Happy path (normal expected flow)
   - Edge cases (unusual inputs)
   - Error handling (invalid inputs)
   - Boundary conditions (limits, extremes)
3. Ensure COMPREHENSIVE coverage - don't just create 1 test case per topic
4. Test cases of the SAME topic can be batched together in ONE call
5. Total: Generate ${maxTestCases} well-distributed test cases across all ${keyTopics.length} topics

Generate comprehensive test cases covering ALL key topics with MULTIPLE scenarios each.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
        max_tokens: 8000, // Increased for more test cases
      });

      const result = JSON.parse(response.choices[0].message.content || '{"testCases": []}');
      
      // Map and detect call-closing scenarios
      const testCases = (result.testCases || []).map((tc: any, index: number) => {
        // Auto-detect call-closing scenarios from name/scenario if not explicitly marked
        const isCallClosing = tc.isCallClosing || this.detectCallClosingScenario(tc);
        const batchPosition = tc.batchPosition || (isCallClosing ? 'end' : 'any');
        
        return {
          id: `tc-${Date.now()}-${index}`,
          name: tc.name || `Test Case ${index + 1}`,
          scenario: tc.scenario || '',
          userInput: tc.userInput || tc.scenario || '',
          expectedOutcome: tc.expectedOutcome || '',
          category: tc.category || 'General',
          keyTopicId: tc.keyTopicId || 'general',
          keyTopicName: tc.keyTopicName || 'General',
          priority: tc.priority || 'medium',
          canBatchWith: tc.canBatchWith || [],
          requiresSeparateCall: tc.requiresSeparateCall || false,
          estimatedTurns: tc.estimatedTurns || 4,
          testType: tc.testType || 'happy_path',
          isCallClosing,
          batchPosition,
          semanticGroup: tc.semanticGroup || this.inferSemanticGroup(tc),
        };
      });
      
      return testCases;
    } catch (error) {
      console.error('[SmartTestCaseGenerator] Error generating test cases:', error);
      return [];
    }
  }

  /**
   * Detect if a test case is a call-closing scenario based on keywords
   */
  private detectCallClosingScenario(tc: any): boolean {
    const text = `${tc.name || ''} ${tc.scenario || ''} ${tc.expectedOutcome || ''} ${tc.userInput || ''}`.toLowerCase();
    
    const callClosingKeywords = [
      'goodbye', 'bye', 'end call', 'hang up', 'disconnect',
      'not interested', 'not eligible', 'ineligible', 'disqualified',
      'wrong country', 'not available', 'cannot help',
      'transfer to human', 'transfer call', 'speak to human', 'live agent',
      'close call', 'terminate', 'end conversation',
      'thank you goodbye', 'have a nice day',
      'insufficient budget', 'budget too low', 'cannot afford',
      'maximum attempts', 'too many retries', 'giving up'
    ];
    
    return callClosingKeywords.some(keyword => text.includes(keyword));
  }

  /**
   * Infer semantic group based on test case content
   */
  private inferSemanticGroup(tc: any): string {
    const text = `${tc.name || ''} ${tc.scenario || ''} ${tc.category || ''}`.toLowerCase();
    
    if (text.includes('email') || text.includes('name') || text.includes('phone') || text.includes('contact')) {
      return 'user_info_collection';
    }
    if (text.includes('eligible') || text.includes('qualify') || text.includes('requirement') || text.includes('criteria')) {
      return 'eligibility_flow';
    }
    if (text.includes('budget') || text.includes('cost') || text.includes('price') || text.includes('afford')) {
      return 'budget_validation';
    }
    if (text.includes('prefer') || text.includes('interest') || text.includes('want') || text.includes('like')) {
      return 'preference_exploration';
    }
    if (text.includes('recommend') || text.includes('suggest') || text.includes('option')) {
      return 'recommendation_flow';
    }
    if (text.includes('concern') || text.includes('objection') || text.includes('worry') || text.includes('but')) {
      return 'objection_handling';
    }
    if (text.includes('goodbye') || text.includes('end') || text.includes('close') || text.includes('transfer')) {
      return 'call_closing';
    }
    if (text.includes('error') || text.includes('invalid') || text.includes('unclear') || text.includes('repeat')) {
      return 'error_recovery';
    }
    
    return 'general';
  }

  /**
   * Create optimal test plan with batched calls
   */
  private async createTestPlan(
    testCases: SmartTestCase[],
    keyTopics: KeyTopic[]
  ): Promise<TestPlan> {
    const batches: CallBatch[] = [];
    const assigned = new Set<string>();
    
    // First, handle test cases that require separate calls
    testCases
      .filter(tc => tc.requiresSeparateCall)
      .forEach(tc => {
        batches.push({
          id: `batch-${batches.length + 1}`,
          name: `${tc.keyTopicName} - ${tc.name}`,
          testCaseIds: [tc.id],
          testCases: [tc],
          estimatedDuration: tc.estimatedTurns * 10, // ~10 seconds per turn
          primaryTopic: tc.keyTopicName,
          description: `Dedicated call for: ${tc.name}`,
          semanticFlow: tc.semanticGroup,
        });
        assigned.add(tc.id);
      });
    
    // Use semantic batching instead of simple topic grouping
    const remainingCases = testCases.filter(tc => !assigned.has(tc.id));
    const semanticBatches = this.createSemanticBatches(remainingCases, keyTopics);
    
    semanticBatches.forEach((batch, idx) => {
      batches.push({
        ...batch,
        id: `batch-${batches.length + 1}`,
      });
    });
    
    const totalDuration = batches.reduce((sum, b) => sum + b.estimatedDuration, 0);
    
    return {
      totalCalls: batches.length,
      totalTestCases: testCases.length,
      estimatedDuration: totalDuration,
      batches,
    };
  }

  /**
   * Create semantically meaningful batches
   * Groups test cases that form a logical conversation flow
   */
  private createSemanticBatches(cases: SmartTestCase[], keyTopics: KeyTopic[]): CallBatch[] {
    const batches: CallBatch[] = [];
    const maxTurnsPerCall = 30;
    
    // Define semantic flow order (logical conversation progression)
    const semanticFlowOrder: string[] = [
      'user_info_collection',   // First: Get user details
      'preference_exploration', // Then: Understand preferences
      'eligibility_flow',       // Then: Check eligibility
      'budget_validation',      // Then: Validate budget
      'recommendation_flow',    // Then: Provide recommendations
      'objection_handling',     // Then: Handle objections
      'error_recovery',         // Error handling scenarios
      'general',                // General scenarios
      'call_closing',           // ALWAYS LAST: Call-closing scenarios
    ];
    
    // Group cases by semantic group
    const semanticGroups = new Map<string, SmartTestCase[]>();
    cases.forEach(tc => {
      const group = tc.semanticGroup || 'general';
      const existing = semanticGroups.get(group) || [];
      existing.push(tc);
      semanticGroups.set(group, existing);
    });
    
    // Create batches that follow a logical flow
    // Each batch should tell a "story" - a logical conversation progression
    
    // First, separate call-closing cases (they go at the end of batches)
    const callClosingCases = cases.filter(tc => tc.isCallClosing);
    const nonClosingCases = cases.filter(tc => !tc.isCallClosing);
    
    // Create meaningful batches from non-closing cases
    const batchableGroups = this.groupBySemanticFlow(nonClosingCases, semanticFlowOrder, maxTurnsPerCall);
    
    batchableGroups.forEach((group, idx) => {
      // For each batch, add one call-closing case at the end if available
      const batchCases = [...group];
      const closingCase = callClosingCases.shift();
      if (closingCase) {
        batchCases.push(closingCase);
      }
      
      // Sort cases within batch by position
      batchCases.sort((a, b) => {
        const posOrder: Record<string, number> = { 'start': 0, 'any': 1, 'middle': 1, 'end': 2 };
        return (posOrder[a.batchPosition] || 1) - (posOrder[b.batchPosition] || 1);
      });
      
      const totalTurns = batchCases.reduce((sum, tc) => sum + tc.estimatedTurns, 0);
      const primaryGroups = [...new Set(batchCases.map(tc => tc.semanticGroup))];
      
      batches.push({
        id: `semantic-batch-${idx + 1}`,
        name: this.generateBatchName(batchCases),
        testCaseIds: batchCases.map(tc => tc.id),
        testCases: batchCases,
        estimatedDuration: Math.min(totalTurns * 8, 300),
        primaryTopic: batchCases[0]?.keyTopicName || 'General',
        description: this.generateBatchDescription(batchCases),
        semanticFlow: primaryGroups.join(' → '),
      });
    });
    
    // Add remaining call-closing cases as separate batches if any left
    callClosingCases.forEach(tc => {
      batches.push({
        id: `closing-batch-${batches.length + 1}`,
        name: `Call Closing - ${tc.name}`,
        testCaseIds: [tc.id],
        testCases: [tc],
        estimatedDuration: tc.estimatedTurns * 10,
        primaryTopic: tc.keyTopicName,
        description: `Call-closing scenario: ${tc.scenario?.substring(0, 100)}...`,
        semanticFlow: 'call_closing',
      });
    });
    
    return batches;
  }

  /**
   * Group cases by semantic flow, ensuring logical progression
   */
  private groupBySemanticFlow(
    cases: SmartTestCase[],
    flowOrder: string[],
    maxTurns: number
  ): SmartTestCase[][] {
    const groups: SmartTestCase[][] = [];
    
    // Sort cases by semantic flow order
    const sortedCases = [...cases].sort((a, b) => {
      const aOrder = flowOrder.indexOf(a.semanticGroup || 'general');
      const bOrder = flowOrder.indexOf(b.semanticGroup || 'general');
      return (aOrder === -1 ? 999 : aOrder) - (bOrder === -1 ? 999 : bOrder);
    });
    
    let currentGroup: SmartTestCase[] = [];
    let currentTurns = 0;
    let lastSemanticGroup = '';
    
    for (const tc of sortedCases) {
      const tcGroup = tc.semanticGroup || 'general';
      
      // Start new batch if:
      // 1. Would exceed max turns
      // 2. Semantic group changes significantly (unless related)
      const shouldStartNewBatch = 
        currentTurns + tc.estimatedTurns > maxTurns ||
        (lastSemanticGroup && !this.areSemanticGroupsRelated(lastSemanticGroup, tcGroup) && currentGroup.length >= 3);
      
      if (shouldStartNewBatch && currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
        currentTurns = 0;
      }
      
      currentGroup.push(tc);
      currentTurns += tc.estimatedTurns;
      lastSemanticGroup = tcGroup;
    }
    
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    
    return groups;
  }

  /**
   * Check if two semantic groups are related and can be in same batch
   */
  private areSemanticGroupsRelated(group1: string, group2: string): boolean {
    const relatedGroups: Record<string, string[]> = {
      'user_info_collection': ['preference_exploration', 'eligibility_flow'],
      'preference_exploration': ['user_info_collection', 'recommendation_flow'],
      'eligibility_flow': ['user_info_collection', 'budget_validation'],
      'budget_validation': ['eligibility_flow', 'recommendation_flow'],
      'recommendation_flow': ['preference_exploration', 'budget_validation', 'objection_handling'],
      'objection_handling': ['recommendation_flow', 'call_closing'],
      'error_recovery': ['general'],
      'general': ['error_recovery', 'preference_exploration'],
      'call_closing': [], // Call closing should generally be separate
    };
    
    return relatedGroups[group1]?.includes(group2) || 
           relatedGroups[group2]?.includes(group1) ||
           group1 === group2;
  }

  /**
   * Generate a meaningful batch name based on test cases
   */
  private generateBatchName(cases: SmartTestCase[]): string {
    const groups = [...new Set(cases.map(tc => tc.semanticGroup).filter((g): g is string => g !== undefined))];
    const groupNames: Record<string, string> = {
      'user_info_collection': 'User Info',
      'preference_exploration': 'Preferences',
      'eligibility_flow': 'Eligibility',
      'budget_validation': 'Budget',
      'recommendation_flow': 'Recommendations',
      'objection_handling': 'Objections',
      'error_recovery': 'Error Handling',
      'call_closing': 'Call Close',
      'general': 'General',
    };
    
    const names = groups
      .filter(g => g !== 'call_closing') // Don't include closing in main name
      .map(g => groupNames[g] || g)
      .slice(0, 3);
    
    const hasClosing = groups.includes('call_closing');
    const baseName = names.join(' + ') || 'Mixed';
    
    return hasClosing ? `${baseName} → Close` : baseName;
  }

  /**
   * Generate a meaningful batch description
   */
  private generateBatchDescription(cases: SmartTestCase[]): string {
    const nonClosing = cases.filter(tc => !tc.isCallClosing);
    const closing = cases.filter(tc => tc.isCallClosing);
    
    let desc = `Tests ${nonClosing.length} scenarios`;
    
    if (nonClosing.length > 0) {
      const categories = [...new Set(nonClosing.map(tc => tc.category))];
      desc += ` across ${categories.slice(0, 3).join(', ')}`;
      if (categories.length > 3) desc += ` and ${categories.length - 3} more`;
    }
    
    if (closing.length > 0) {
      desc += `. Ends with: ${closing.map(tc => tc.name).join(', ')}`;
    }
    
    return desc;
  }

  /**
   * Group test cases that can be tested together (legacy method, kept for compatibility)
   */
  private groupBatchableCases(cases: SmartTestCase[]): SmartTestCase[][] {
    // Use semantic batching instead
    return this.groupBySemanticFlow(cases, [
      'user_info_collection', 'preference_exploration', 'eligibility_flow',
      'budget_validation', 'recommendation_flow', 'objection_handling',
      'error_recovery', 'general', 'call_closing'
    ], 30);
  }

  /**
   * Analyze test results and generate comprehensive metrics
   */
  async analyzeTestResults(
    transcript: Array<{ role: string; content: string; timestamp: number }>,
    testCases: SmartTestCase[],
    agentPrompt: string,
    callDuration: number
  ): Promise<TestResultAnalysis> {
    const systemPrompt = `You are an expert QA analyst for voice AI agents. Analyze the conversation transcript and generate comprehensive metrics and recommendations.

Evaluate the following metrics (score 0-100):

PERFORMANCE METRICS:
- Response time analysis
- Throughput estimation

ACCURACY METRICS:
- Intent recognition accuracy
- Entity recognition accuracy
- Word/sentence error estimation

USER EXPERIENCE METRICS:
- Turn completion rate
- Fallback rate
- Escalation rate
- Naturalness and clarity

ERROR HANDLING:
- Error detection rate
- Error recovery rate

INTERACTION QUALITY:
- Contextual understanding
- Dialogue continuity
- Engagement score
- Sentiment analysis

TASK COMPLETION:
- Success rate
- Time to completion

Also identify:
1. Strengths of the agent
2. Weaknesses that need improvement
3. Specific prompt recommendations with:
   - What area of the prompt needs change
   - What the current behavior is
   - What the suggested change is
   - Priority of the change

Return JSON:
{
  "metrics": {
    "performance": { "avgResponseTimeMs": 0, "minResponseTimeMs": 0, "maxResponseTimeMs": 0, "throughputRequestsPerMin": 0 },
    "accuracy": { "intentRecognitionScore": 0, "entityRecognitionScore": 0, "wordErrorRate": 0, "sentenceErrorRate": 0 },
    "userExperience": { "turnCompletionRate": 0, "fallbackRate": 0, "escalationRate": 0, "naturalness": 0, "clarity": 0 },
    "errorHandling": { "errorDetectionRate": 0, "errorRecoveryRate": 0 },
    "interactionQuality": { "contextualUnderstanding": 0, "dialogueContinuity": 0, "engagementScore": 0, "sentimentScore": 0 },
    "taskCompletion": { "successRate": 0, "failureRate": 0, "avgTimeToCompletion": 0 },
    "overall": { "score": 0, "grade": "A|B|C|D|F" }
  },
  "promptRecommendations": [
    {
      "area": "Area of prompt",
      "issue": "What's wrong",
      "currentBehavior": "What's happening now",
      "suggestedChange": "What to change",
      "priority": "critical|high|medium|low",
      "affectedTestCases": ["test case names"]
    }
  ],
  "strengths": ["strength1", "strength2"],
  "weaknesses": ["weakness1", "weakness2"],
  "summary": "Overall summary of agent performance"
}`;

    const transcriptText = transcript
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n');

    const testCaseContext = testCases
      .map(tc => `- ${tc.name}: ${tc.expectedOutcome}`)
      .join('\n');

    const userPrompt = `Analyze this voice agent conversation:

TRANSCRIPT:
${transcriptText}

TEST CASES BEING EVALUATED:
${testCaseContext}

AGENT PROMPT:
${agentPrompt}

CALL DURATION: ${callDuration}ms

Provide comprehensive analysis as JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
        max_tokens: 3000,
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      return {
        metrics: result.metrics || this.getDefaultMetrics(),
        promptRecommendations: result.promptRecommendations || [],
        strengths: result.strengths || [],
        weaknesses: result.weaknesses || [],
        summary: result.summary || 'Analysis could not be completed.',
      };
    } catch (error) {
      console.error('[SmartTestCaseGenerator] Error analyzing results:', error);
      return {
        metrics: this.getDefaultMetrics(),
        promptRecommendations: [],
        strengths: [],
        weaknesses: [],
        summary: 'Analysis failed due to an error.',
      };
    }
  }

  /**
   * Get default metrics structure
   */
  private getDefaultMetrics(): TestMetrics {
    return {
      performance: { avgResponseTimeMs: 0, minResponseTimeMs: 0, maxResponseTimeMs: 0, throughputRequestsPerMin: 0 },
      accuracy: { intentRecognitionScore: 0, entityRecognitionScore: 0, wordErrorRate: 0, sentenceErrorRate: 0 },
      userExperience: { turnCompletionRate: 0, fallbackRate: 0, escalationRate: 0, naturalness: 0, clarity: 0 },
      errorHandling: { errorDetectionRate: 0, errorRecoveryRate: 0 },
      interactionQuality: { contextualUnderstanding: 0, dialogueContinuity: 0, engagementScore: 0, sentimentScore: 0 },
      taskCompletion: { successRate: 0, failureRate: 0, avgTimeToCompletion: 0 },
      overall: { score: 0, grade: 'F' },
    };
  }

  /**
   * Allow user to modify test plan batches
   */
  modifyTestPlan(
    testPlan: TestPlan,
    modifications: Array<{ testCaseId: string; targetBatchId: string }>
  ): TestPlan {
    const testCaseMap = new Map<string, SmartTestCase>();
    
    // Build map of all test cases
    testPlan.batches.forEach(batch => {
      batch.testCases.forEach(tc => testCaseMap.set(tc.id, tc));
    });
    
    // Apply modifications
    modifications.forEach(mod => {
      const testCase = testCaseMap.get(mod.testCaseId);
      if (!testCase) return;
      
      // Remove from current batch
      testPlan.batches.forEach(batch => {
        batch.testCaseIds = batch.testCaseIds.filter(id => id !== mod.testCaseId);
        batch.testCases = batch.testCases.filter(tc => tc.id !== mod.testCaseId);
      });
      
      // Add to target batch
      const targetBatch = testPlan.batches.find(b => b.id === mod.targetBatchId);
      if (targetBatch) {
        targetBatch.testCaseIds.push(mod.testCaseId);
        targetBatch.testCases.push(testCase);
      }
    });
    
    // Remove empty batches
    testPlan.batches = testPlan.batches.filter(b => b.testCases.length > 0);
    
    // Recalculate totals
    testPlan.totalCalls = testPlan.batches.length;
    testPlan.estimatedDuration = testPlan.batches.reduce((sum, b) => sum + b.estimatedDuration, 0);
    
    return testPlan;
  }
}

export const smartTestCaseGeneratorService = new SmartTestCaseGeneratorService();
