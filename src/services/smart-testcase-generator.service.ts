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
  | 'sentiment_handling';

export interface CallBatch {
  id: string;
  name: string;
  testCaseIds: string[];
  testCases: SmartTestCase[];
  estimatedDuration: number; // in seconds
  primaryTopic: string;
  description: string;
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

IMPORTANT RULES:
1. Each test case should be associated with ONE primary key topic
2. Mark test cases that can be tested together in ONE call (canBatchWith)
3. Mark test cases that MUST have their own separate call (requiresSeparateCall)
4. Estimate the number of conversation turns needed (estimatedTurns)

Test cases that CAN be batched together:
- Multiple questions about the same topic
- Related follow-up scenarios
- Variations of similar queries

Test cases that REQUIRE separate calls:
- Completely different user personas
- Conflicting scenarios (e.g., high budget vs low budget)
- Tests that need a fresh conversation context
- Topic change tests (where user changes subject)

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
      "testType": "happy_path|edge_case|error_handling|boundary|multi_turn|topic_change|interruption|fallback|budget_validation|eligibility_check|context_retention|sentiment_handling"
    }
  ]
}`;

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
      
      return (result.testCases || []).map((tc: any, index: number) => ({
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
      }));
    } catch (error) {
      console.error('[SmartTestCaseGenerator] Error generating test cases:', error);
      return [];
    }
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
        });
        assigned.add(tc.id);
      });
    
    // Group remaining test cases by topic
    const topicGroups = new Map<string, SmartTestCase[]>();
    testCases
      .filter(tc => !assigned.has(tc.id))
      .forEach(tc => {
        const group = topicGroups.get(tc.keyTopicId) || [];
        group.push(tc);
        topicGroups.set(tc.keyTopicId, group);
      });
    
    // Create batches from topic groups
    topicGroups.forEach((cases, topicId) => {
      const topic = keyTopics.find(t => t.id === topicId);
      const batchableGroups = this.groupBatchableCases(cases);
      
      batchableGroups.forEach((group, idx) => {
        const totalTurns = group.reduce((sum, tc) => sum + tc.estimatedTurns, 0);
        batches.push({
          id: `batch-${batches.length + 1}`,
          name: `${topic?.name || topicId} - Batch ${idx + 1}`,
          testCaseIds: group.map(tc => tc.id),
          testCases: group,
          estimatedDuration: Math.min(totalTurns * 8, 300), // Cap at 5 minutes
          primaryTopic: topic?.name || topicId,
          description: `Testing ${group.length} scenarios for ${topic?.name || topicId}`,
        });
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
   * Group test cases that can be tested together
   */
  private groupBatchableCases(cases: SmartTestCase[]): SmartTestCase[][] {
    const groups: SmartTestCase[][] = [];
    const maxTurnsPerCall = 30;
    
    let currentGroup: SmartTestCase[] = [];
    let currentTurns = 0;
    
    // Sort by estimated turns (shorter first)
    const sorted = [...cases].sort((a, b) => a.estimatedTurns - b.estimatedTurns);
    
    for (const tc of sorted) {
      if (currentTurns + tc.estimatedTurns <= maxTurnsPerCall) {
        currentGroup.push(tc);
        currentTurns += tc.estimatedTurns;
      } else {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [tc];
        currentTurns = tc.estimatedTurns;
      }
    }
    
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    
    return groups;
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
