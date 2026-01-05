/**
 * Intelligent Test Case Batching Service
 * 
 * Uses AI to analyze agent prompts and test cases to create optimal call batches.
 * 
 * Key Features:
 * 1. Analyzes agent prompt to understand conversation flow, closing conditions
 * 2. Analyzes test cases to understand dependencies and natural groupings
 * 3. Orders test cases within batches for natural conversation flow
 * 4. Places call-ending test cases at the end of batches
 * 5. Creates fallback paths for failed test cases
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================================
// TYPES
// ============================================

export interface TestCaseForBatching {
  id: string;
  name: string;
  scenario: string;
  userInput?: string;
  expectedBehavior?: string;
  expectedOutcome?: string;
  category?: string;
  keyTopic?: string;
  priority?: 'high' | 'medium' | 'low';
  testMode?: 'voice' | 'chat' | 'auto';  // Existing test mode from test case
}

export interface AgentPromptAnalysis {
  // Conversation structure
  conversationFlow: {
    openingPhase: string[];
    mainPhase: string[];
    closingPhase: string[];
  };
  
  // Call ending conditions
  callEndingConditions: {
    condition: string;
    triggerPhrases: string[];
    isNaturalEnd: boolean;
  }[];
  
  // Topics the agent handles
  topicsHandled: {
    topic: string;
    priority: number;
    typicalOrder: number;
  }[];
  
  // Restrictions/rules
  restrictions: string[];
  
  // Expected conversation length
  estimatedTurnsPerTopic: number;
  maxRecommendedBatchSize: number;
}

export interface TestCaseAnalysis {
  id: string;
  name: string;
  
  // Classification
  testType: 'opening' | 'information_gathering' | 'objection' | 'edge_case' | 'closing' | 'error_handling';
  topicsTested: string[];
  
  // Dependencies
  requiresPriorContext: boolean;
  priorContextNeeded?: string;
  canBeFirst: boolean;
  mustBeLast: boolean;
  
  // Call impact
  likelyToEndCall: boolean;
  callEndingProbability: number;
  
  // Compatibility
  compatibleWith: string[];  // IDs of compatible test cases
  incompatibleWith: string[]; // IDs that can't be in same batch
  
  // Natural order
  naturalOrderScore: number; // 1-10, lower = earlier in conversation
  
  // Fallback handling
  failurePaths: {
    failureType: string;
    recoveryStrategy: string;
    canContinueBatch: boolean;
  }[];
  
  // Test mode recommendation (for cost optimization)
  recommendedTestMode: 'voice' | 'chat';
  testModeReason: string;
  voiceOnlyFeatures: string[];  // Features that require voice testing
}

export interface IntelligentBatch {
  batchId: number;
  name: string;
  testCases: TestCaseForBatching[];
  testCaseOrder: string[]; // Ordered IDs
  
  // Batch metadata
  reasoning: string;
  estimatedDuration: string;
  conversationFlow: string;
  
  // Call ending test case (always last)
  callEndingTestCase?: string;
  
  // Fallback paths
  fallbackPaths: {
    ifTestCaseFails: string;
    action: 'skip_remaining' | 'continue_with_context' | 'try_alternative';
    alternativeTestCases?: string[];
  }[];
  
  // Confidence score
  batchConfidenceScore: number;
  
  // Test mode for this batch (voice or chat)
  testMode: 'voice' | 'chat';
  testModeReason: string;
  estimatedCostSavings?: string;  // Estimated cost savings if using chat vs voice
}

export interface BatchingResult {
  batches: IntelligentBatch[];
  analysis: {
    promptAnalysis: AgentPromptAnalysis;
    testCaseAnalyses: TestCaseAnalysis[];
  };
  summary: {
    totalBatches: number;
    totalTestCases: number;
    estimatedTotalDuration: string;
    coverageScore: number;
    batchingStrategy: string;
    // Test mode breakdown
    voiceBatches: number;
    chatBatches: number;
    voiceTestCases: number;
    chatTestCases: number;
    estimatedCostSavings: string;
  };
}

// ============================================
// MAIN SERVICE CLASS
// ============================================

export class IntelligentBatchingService {
  
  /**
   * Main entry point: Analyze prompt and test cases, create intelligent batches
   */
  async createIntelligentBatches(
    agentPrompt: string,
    agentFirstMessage: string,
    testCases: TestCaseForBatching[],
    options: {
      maxTestsPerBatch?: number;
      preferredBatchCount?: number;
      prioritizeCallEnding?: boolean;
    } = {}
  ): Promise<BatchingResult> {
    const {
      maxTestsPerBatch = 5,
      preferredBatchCount,
      prioritizeCallEnding = true,
    } = options;

    console.log(`[IntelligentBatching] Analyzing ${testCases.length} test cases with AI...`);

    // Step 1: Analyze the agent's prompt
    const promptAnalysis = await this.analyzeAgentPrompt(agentPrompt, agentFirstMessage);
    console.log(`[IntelligentBatching] Prompt analysis complete. Found ${promptAnalysis.callEndingConditions.length} call ending conditions.`);

    // Step 2: Analyze each test case
    const testCaseAnalyses = await this.analyzeTestCases(testCases, promptAnalysis);
    console.log(`[IntelligentBatching] Test case analysis complete.`);

    // Step 3: Create intelligent batches
    const batches = await this.createBatches(
      testCases,
      testCaseAnalyses,
      promptAnalysis,
      maxTestsPerBatch,
      preferredBatchCount
    );
    console.log(`[IntelligentBatching] Created ${batches.length} intelligent batches.`);

    // Step 4: Generate fallback paths
    const batchesWithFallbacks = await this.generateFallbackPaths(batches, testCaseAnalyses);

    // Calculate test mode breakdown
    const voiceBatches = batchesWithFallbacks.filter(b => b.testMode === 'voice');
    const chatBatches = batchesWithFallbacks.filter(b => b.testMode === 'chat');
    const voiceTestCases = voiceBatches.reduce((acc, b) => acc + b.testCases.length, 0);
    const chatTestCases = chatBatches.reduce((acc, b) => acc + b.testCases.length, 0);
    
    // Estimate cost savings: assume chat is 90% cheaper than voice
    const voiceCostPerTest = 1; // relative unit
    const chatCostPerTest = 0.1; // 90% cheaper
    const actualCost = (voiceTestCases * voiceCostPerTest) + (chatTestCases * chatCostPerTest);
    const allVoiceCost = testCases.length * voiceCostPerTest;
    const savings = ((allVoiceCost - actualCost) / allVoiceCost) * 100;

    // Calculate summary
    const summary = {
      totalBatches: batchesWithFallbacks.length,
      totalTestCases: testCases.length,
      estimatedTotalDuration: this.calculateTotalDuration(batchesWithFallbacks),
      coverageScore: this.calculateCoverageScore(testCases, batchesWithFallbacks),
      batchingStrategy: this.describeBatchingStrategy(promptAnalysis),
      voiceBatches: voiceBatches.length,
      chatBatches: chatBatches.length,
      voiceTestCases,
      chatTestCases,
      estimatedCostSavings: `~${Math.round(savings)}% (${chatTestCases} chat tests, ${voiceTestCases} voice tests)`,
    };

    console.log(`[IntelligentBatching] Test mode breakdown: ${chatBatches.length} chat batches (${chatTestCases} tests), ${voiceBatches.length} voice batches (${voiceTestCases} tests)`);
    console.log(`[IntelligentBatching] Estimated cost savings: ${summary.estimatedCostSavings}`);

    return {
      batches: batchesWithFallbacks,
      analysis: {
        promptAnalysis,
        testCaseAnalyses,
      },
      summary,
    };
  }

  /**
   * Step 1: Analyze the agent's prompt to understand conversation structure
   */
  private async analyzeAgentPrompt(
    prompt: string,
    firstMessage: string
  ): Promise<AgentPromptAnalysis> {
    const analysisPrompt = `You are an expert at analyzing voice AI agent prompts. Analyze this agent's prompt and first message to understand its conversation structure.

AGENT'S SYSTEM PROMPT:
${prompt}

AGENT'S FIRST MESSAGE:
${firstMessage}

Analyze and return a JSON object with:

{
  "conversationFlow": {
    "openingPhase": ["list of topics/actions in opening phase"],
    "mainPhase": ["list of topics/actions in main conversation"],
    "closingPhase": ["list of topics/actions when closing call"]
  },
  "callEndingConditions": [
    {
      "condition": "description of what ends the call",
      "triggerPhrases": ["phrases that trigger this ending"],
      "isNaturalEnd": true/false
    }
  ],
  "topicsHandled": [
    {
      "topic": "topic name",
      "priority": 1-10,
      "typicalOrder": 1-10 (1=early in convo, 10=late)
    }
  ],
  "restrictions": ["list of things the agent should NOT do"],
  "estimatedTurnsPerTopic": number,
  "maxRecommendedBatchSize": number (based on natural conversation length)
}

Focus on:
1. What triggers the agent to end/close the call?
2. What topics must come before others?
3. What are the natural conversation phases?
4. How many topics can reasonably fit in one call?

Return ONLY valid JSON, no other text.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{}');
      
      return {
        conversationFlow: result.conversationFlow || { openingPhase: [], mainPhase: [], closingPhase: [] },
        callEndingConditions: result.callEndingConditions || [],
        topicsHandled: result.topicsHandled || [],
        restrictions: result.restrictions || [],
        estimatedTurnsPerTopic: result.estimatedTurnsPerTopic || 3,
        maxRecommendedBatchSize: result.maxRecommendedBatchSize || 4,
      };
    } catch (error) {
      console.error('[IntelligentBatching] Error analyzing prompt:', error);
      // Return default analysis
      return {
        conversationFlow: { openingPhase: [], mainPhase: [], closingPhase: [] },
        callEndingConditions: [],
        topicsHandled: [],
        restrictions: [],
        estimatedTurnsPerTopic: 3,
        maxRecommendedBatchSize: 4,
      };
    }
  }

  /**
   * Step 2: Analyze each test case in context of the agent's prompt
   * Processes in chunks for large test case sets
   */
  private async analyzeTestCases(
    testCases: TestCaseForBatching[],
    promptAnalysis: AgentPromptAnalysis
  ): Promise<TestCaseAnalysis[]> {
    const CHUNK_SIZE = 30; // Analyze 30 test cases at a time to avoid token limits
    
    if (testCases.length > CHUNK_SIZE) {
      console.log(`[IntelligentBatching] Large test case set (${testCases.length}), analyzing in chunks of ${CHUNK_SIZE}`);
      
      const allAnalyses: TestCaseAnalysis[] = [];
      
      for (let i = 0; i < testCases.length; i += CHUNK_SIZE) {
        const chunk = testCases.slice(i, i + CHUNK_SIZE);
        console.log(`[IntelligentBatching] Analyzing chunk ${Math.floor(i/CHUNK_SIZE) + 1}/${Math.ceil(testCases.length/CHUNK_SIZE)} (${chunk.length} test cases)`);
        
        const chunkAnalyses = await this.analyzeTestCasesChunk(chunk, promptAnalysis);
        allAnalyses.push(...chunkAnalyses);
      }
      
      return allAnalyses;
    }
    
    return this.analyzeTestCasesChunk(testCases, promptAnalysis);
  }

  /**
   * Analyze a chunk of test cases (up to ~30)
   */
  private async analyzeTestCasesChunk(
    testCases: TestCaseForBatching[],
    promptAnalysis: AgentPromptAnalysis
  ): Promise<TestCaseAnalysis[]> {
    const testCaseList = testCases.map((tc, idx) => 
      `${idx + 1}. ID: ${tc.id}
   Name: ${tc.name}
   Scenario: ${tc.scenario}
   User Input: ${tc.userInput || 'N/A'}
   Expected: ${tc.expectedBehavior || tc.expectedOutcome || 'N/A'}
   Category: ${tc.category || tc.keyTopic || 'General'}
   Explicit Test Mode: ${tc.testMode || 'auto'}`
    ).join('\n\n');

    const callEndingInfo = promptAnalysis.callEndingConditions
      .map(c => `- ${c.condition} (triggers: ${c.triggerPhrases.join(', ')})`)
      .join('\n');

    const analysisPrompt = `You are an expert at analyzing test cases for voice AI agents. Analyze each test case to understand:
1. How it should be grouped and ordered in call batches
2. Whether it can be tested via CHAT (text-based) or requires VOICE testing

COST OPTIMIZATION CONTEXT:
We want to minimize costs by using chat-based testing where possible. Chat testing is ~10x cheaper than voice testing.

AGENT'S CALL ENDING CONDITIONS:
${callEndingInfo || 'No specific ending conditions identified'}

AGENT'S CONVERSATION FLOW:
- Opening: ${promptAnalysis.conversationFlow.openingPhase.join(', ') || 'Standard greeting'}
- Main: ${promptAnalysis.conversationFlow.mainPhase.join(', ') || 'Information gathering'}
- Closing: ${promptAnalysis.conversationFlow.closingPhase.join(', ') || 'Standard closing'}

TEST CASES TO ANALYZE:
${testCaseList}

For EACH test case, analyze and return a JSON object with "analyses" array:

{
  "analyses": [
    {
      "id": "test case id",
      "name": "test case name",
      "testType": "opening|information_gathering|objection|edge_case|closing|error_handling",
      "topicsTested": ["list of topics this tests"],
      "requiresPriorContext": true/false,
      "priorContextNeeded": "what context is needed if any",
      "canBeFirst": true/false,
      "mustBeLast": true/false,
      "likelyToEndCall": true/false,
      "callEndingProbability": 0-100,
      "compatibleWith": ["IDs of test cases that can be in same batch"],
      "incompatibleWith": ["IDs that should NOT be in same batch"],
      "naturalOrderScore": 1-10 (1=should be early, 10=should be late in conversation),
      "failurePaths": [
        {
          "failureType": "what could go wrong",
          "recoveryStrategy": "how to handle it",
          "canContinueBatch": true/false
        }
      ],
      "recommendedTestMode": "voice|chat",
      "testModeReason": "explanation for the recommendation",
      "voiceOnlyFeatures": ["list of features that require voice testing, empty if chat is OK"]
    }
  ]
}

TEST MODE RULES - MUST USE VOICE:
1. Tests for INTERRUPTION handling (user interrupts agent mid-sentence)
2. Tests for BARGE-IN behavior (speaking over the agent)
3. Tests for VOICE QUALITY/TONE evaluation
4. Tests for LATENCY/RESPONSIVENESS timing
5. Tests for SILENCE HANDLING (long pauses)
6. Tests for BACKGROUND NOISE handling
7. Tests for SPEECH RECOGNITION accuracy
8. Tests for CONCURRENT SPEECH scenarios
9. Tests for NON-VERBAL cues (sighs, hesitation)
10. Tests explicitly marked with testMode: "voice"

TEST MODE RULES - CAN USE CHAT (cheaper):
1. Happy path conversations - basic Q&A flows
2. Information gathering - collecting user data
3. Intent recognition - testing if agent understands intent
4. Knowledge base queries - factual responses
5. Error message validation - checking error responses
6. Conversation flow - multi-turn dialogue logic
7. Edge cases that don't involve voice-specific features
8. Tests explicitly marked with testMode: "chat"

IMPORTANT BATCHING RULES:
1. Test cases that ask to end call, say goodbye, request callback = mustBeLast: true
2. Test cases about off-topic/inappropriate requests often end calls = high callEndingProbability
3. Test cases that build on previous info need requiresPriorContext: true
4. Opening/greeting test cases: canBeFirst: true, naturalOrderScore: 1-2
5. Objection handling: naturalOrderScore: 6-8 (comes after rapport building)
6. Call ending scenarios: naturalOrderScore: 9-10, mustBeLast: true

Return ONLY valid JSON, no other text.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: analysisPrompt }],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content || '{"analyses": []}';
      const parsed = JSON.parse(content);
      
      // Handle both array and object with analyses property
      const analyses = Array.isArray(parsed) ? parsed : (parsed.analyses || parsed.testCases || []);
      
      // Ensure all test cases have analysis
      return testCases.map(tc => {
        const analysis = analyses.find((a: any) => a.id === tc.id);
        if (analysis) {
          // Respect explicit test mode from test case
          if (tc.testMode && tc.testMode !== 'auto') {
            analysis.recommendedTestMode = tc.testMode;
            analysis.testModeReason = `Explicitly set to ${tc.testMode} in test case configuration`;
          }
          return {
            ...analysis,
            recommendedTestMode: analysis.recommendedTestMode || 'chat',
            testModeReason: analysis.testModeReason || 'Default to chat for cost optimization',
            voiceOnlyFeatures: analysis.voiceOnlyFeatures || [],
          } as TestCaseAnalysis;
        }
        // Default analysis if not found
        return {
          id: tc.id,
          name: tc.name,
          testType: 'information_gathering' as const,
          topicsTested: [tc.category || tc.keyTopic || 'General'],
          requiresPriorContext: false,
          canBeFirst: true,
          mustBeLast: false,
          likelyToEndCall: false,
          callEndingProbability: 10,
          compatibleWith: [],
          incompatibleWith: [],
          naturalOrderScore: 5,
          failurePaths: [],
          recommendedTestMode: tc.testMode === 'voice' ? 'voice' : 'chat',
          testModeReason: tc.testMode === 'voice' ? 'Explicitly set to voice' : 'Default to chat for cost optimization',
          voiceOnlyFeatures: [],
        };
      });
    } catch (error) {
      console.error('[IntelligentBatching] Error analyzing test cases:', error);
      // Return default analyses
      return testCases.map(tc => ({
        id: tc.id,
        name: tc.name,
        testType: 'information_gathering' as const,
        topicsTested: [tc.category || tc.keyTopic || 'General'],
        requiresPriorContext: false,
        canBeFirst: true,
        mustBeLast: false,
        likelyToEndCall: false,
        callEndingProbability: 10,
        compatibleWith: [],
        incompatibleWith: [],
        naturalOrderScore: 5,
        failurePaths: [],
        recommendedTestMode: tc.testMode === 'voice' ? 'voice' as const : 'chat' as const,
        testModeReason: tc.testMode === 'voice' ? 'Explicitly set to voice' : 'Default to chat for cost optimization',
        voiceOnlyFeatures: [],
      }));
    }
  }

  /**
   * Step 3: Create intelligent batches using AI
   * Now separates batches by test mode (voice vs chat)
   */
  private async createBatches(
    testCases: TestCaseForBatching[],
    analyses: TestCaseAnalysis[],
    promptAnalysis: AgentPromptAnalysis,
    maxPerBatch: number,
    preferredCount?: number
  ): Promise<IntelligentBatch[]> {
    // Separate test cases by recommended test mode
    const voiceTestCases = testCases.filter(tc => {
      const analysis = analyses.find(a => a.id === tc.id);
      return analysis?.recommendedTestMode === 'voice';
    });
    const chatTestCases = testCases.filter(tc => {
      const analysis = analyses.find(a => a.id === tc.id);
      return analysis?.recommendedTestMode !== 'voice';
    });

    console.log(`[IntelligentBatching] Test mode split: ${voiceTestCases.length} voice, ${chatTestCases.length} chat`);

    // Create batches for each mode
    const voiceBatches = voiceTestCases.length > 0 
      ? await this.createBatchesForMode(voiceTestCases, analyses, promptAnalysis, maxPerBatch, 'voice')
      : [];
    const chatBatches = chatTestCases.length > 0
      ? await this.createBatchesForMode(chatTestCases, analyses, promptAnalysis, maxPerBatch, 'chat')
      : [];

    // Combine batches, with chat batches first (cheaper)
    const allBatches = [...chatBatches, ...voiceBatches];
    
    // Re-number batch IDs
    return allBatches.map((batch, idx) => ({
      ...batch,
      batchId: idx + 1,
    }));
  }

  /**
   * Create batches for a specific test mode (voice or chat)
   * Handles large numbers of test cases by chunking
   */
  private async createBatchesForMode(
    testCases: TestCaseForBatching[],
    analyses: TestCaseAnalysis[],
    promptAnalysis: AgentPromptAnalysis,
    maxPerBatch: number,
    testMode: 'voice' | 'chat'
  ): Promise<IntelligentBatch[]> {
    // For large test case sets, process in chunks to avoid AI prompt/response limits
    const CHUNK_SIZE = 25; // Process 25 test cases at a time for AI batching
    
    if (testCases.length > CHUNK_SIZE) {
      console.log(`[IntelligentBatching] Large test case set (${testCases.length}), processing in chunks of ${CHUNK_SIZE}`);
      
      // Group test cases by category first for better batching
      const byCategory: Record<string, TestCaseForBatching[]> = {};
      testCases.forEach(tc => {
        const category = tc.category || tc.keyTopic || 'General';
        if (!byCategory[category]) byCategory[category] = [];
        byCategory[category].push(tc);
      });
      
      // Process each category group
      const allBatches: IntelligentBatch[] = [];
      const categories = Object.keys(byCategory);
      
      for (const category of categories) {
        const categoryTestCases = byCategory[category];
        const categoryAnalyses = analyses.filter(a => categoryTestCases.some(tc => tc.id === a.id));
        
        if (categoryTestCases.length <= CHUNK_SIZE) {
          // Process this category as one chunk
          const batches = await this.createBatchesForChunk(
            categoryTestCases, categoryAnalyses, promptAnalysis, maxPerBatch, testMode, category
          );
          allBatches.push(...batches);
        } else {
          // Category is too large, split into sub-chunks
          for (let i = 0; i < categoryTestCases.length; i += CHUNK_SIZE) {
            const chunk = categoryTestCases.slice(i, i + CHUNK_SIZE);
            const chunkAnalyses = analyses.filter(a => chunk.some(tc => tc.id === a.id));
            const batches = await this.createBatchesForChunk(
              chunk, chunkAnalyses, promptAnalysis, maxPerBatch, testMode, `${category} (Part ${Math.floor(i/CHUNK_SIZE) + 1})`
            );
            allBatches.push(...batches);
          }
        }
      }
      
      // Re-number batch IDs
      return allBatches.map((batch, idx) => ({
        ...batch,
        batchId: idx + 1,
      }));
    }
    
    // Small enough to process in one go
    return this.createBatchesForChunk(testCases, analyses, promptAnalysis, maxPerBatch, testMode);
  }

  /**
   * Create batches for a chunk of test cases (up to ~25)
   */
  private async createBatchesForChunk(
    testCases: TestCaseForBatching[],
    analyses: TestCaseAnalysis[],
    promptAnalysis: AgentPromptAnalysis,
    maxPerBatch: number,
    testMode: 'voice' | 'chat',
    categoryHint?: string
  ): Promise<IntelligentBatch[]> {
    // Prepare analysis summary for AI
    const testCaseSummary = analyses
      .filter(a => testCases.some(tc => tc.id === a.id))
      .map(a => ({
      id: a.id,
      name: a.name,
      type: a.testType,
      order: a.naturalOrderScore,
      mustBeLast: a.mustBeLast,
      canBeFirst: a.canBeFirst,
      endsCall: a.likelyToEndCall,
      endProb: a.callEndingProbability,
      topics: a.topicsTested,
      incompatible: a.incompatibleWith,
    }));

    const batchingPrompt = `You are an expert at organizing test cases into optimal call batches for voice AI testing.

GOAL: Create batches where each batch is ONE phone call that tests multiple scenarios naturally.
TEST MODE: ${testMode.toUpperCase()} - ${testMode === 'chat' ? 'These tests will use text-based chat API (cost-effective)' : 'These tests require voice-based testing'}

CONSTRAINTS:
- Maximum ${maxPerBatch} test cases per batch
- Create as many batches as needed for optimal coverage
- Test cases marked "mustBeLast" MUST be the last test in their batch (they end the call)
- Test cases marked "endsCall" with high "endProb" should be last or in their own batch
- Test cases that are "incompatible" cannot be in the same batch
- Order test cases by "order" score (low to high) within each batch

AGENT INFO:
- Max recommended batch size: ${promptAnalysis.maxRecommendedBatchSize}
- Topics typically handled: ${promptAnalysis.topicsHandled.map(t => t.topic).join(', ') || 'Various'}

TEST CASES WITH ANALYSIS:
${JSON.stringify(testCaseSummary, null, 2)}

Create batches and return JSON:

{
  "batches": [
    {
      "batchId": 1,
      "name": "descriptive batch name",
      "testCaseIds": ["ordered array of test case IDs"],
      "reasoning": "why these test cases are grouped together",
      "conversationFlow": "describe how the conversation will flow",
      "callEndingTestCase": "ID of the test case that will end the call (if any)",
      "estimatedDuration": "X-Y minutes",
      "confidenceScore": 0-100
    }
  ],
  "batchingStrategy": "overall strategy description"
}

BATCHING RULES:
1. Group related topics that flow naturally in conversation
2. Put greeting/opening tests first in batch
3. Put objection/edge cases in middle
4. Put call-ending tests LAST (they terminate the call!)
5. If a test case has high callEndingProbability (>70%), put it last or separate batch
6. Never put two "mustBeLast" test cases in same batch
7. Respect incompatibility constraints

Return ONLY valid JSON.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: batchingPrompt }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{"batches": []}');
      
      // Map AI batches to our format
      return (result.batches || []).map((batch: any, idx: number) => {
        const batchTestCases = (batch.testCaseIds || [])
          .map((id: string) => testCases.find(tc => tc.id === id))
          .filter(Boolean) as TestCaseForBatching[];

        return {
          batchId: batch.batchId || idx + 1,
          name: batch.name || `Batch ${idx + 1}`,
          testCases: batchTestCases,
          testCaseOrder: batch.testCaseIds || [],
          reasoning: batch.reasoning || 'AI-optimized grouping',
          estimatedDuration: batch.estimatedDuration || `${batchTestCases.length * 30}-${batchTestCases.length * 45} seconds`,
          conversationFlow: batch.conversationFlow || 'Natural conversation flow',
          callEndingTestCase: batch.callEndingTestCase,
          fallbackPaths: [],
          batchConfidenceScore: batch.confidenceScore || 80,
          testMode: testMode,
          testModeReason: testMode === 'chat' 
            ? 'Chat-based testing for cost optimization - no voice-specific features required'
            : 'Voice-based testing required - tests voice-specific features',
          estimatedCostSavings: testMode === 'chat' ? '~90% vs voice testing' : undefined,
        };
      });
    } catch (error) {
      console.error('[IntelligentBatching] Error creating batches:', error);
      // Fall back to simple batching
      return this.simpleBatchFallback(testCases, analyses, maxPerBatch, testMode);
    }
  }

  /**
   * Step 4: Generate fallback paths for each batch
   */
  private async generateFallbackPaths(
    batches: IntelligentBatch[],
    analyses: TestCaseAnalysis[]
  ): Promise<IntelligentBatch[]> {
    return batches.map(batch => {
      const fallbackPaths: IntelligentBatch['fallbackPaths'] = [];

      // For each test case in the batch, determine fallback behavior
      batch.testCaseOrder.forEach((testCaseId, index) => {
        const analysis = analyses.find(a => a.id === testCaseId);
        if (!analysis) return;

        // If this test case might end the call unexpectedly
        if (analysis.callEndingProbability > 50 && !analysis.mustBeLast) {
          fallbackPaths.push({
            ifTestCaseFails: testCaseId,
            action: 'skip_remaining',
            alternativeTestCases: batch.testCaseOrder.slice(index + 1),
          });
        }

        // If test case has specific failure paths from analysis
        analysis.failurePaths.forEach(fp => {
          if (!fp.canContinueBatch) {
            fallbackPaths.push({
              ifTestCaseFails: testCaseId,
              action: 'skip_remaining',
            });
          } else {
            fallbackPaths.push({
              ifTestCaseFails: testCaseId,
              action: 'continue_with_context',
            });
          }
        });
      });

      return {
        ...batch,
        fallbackPaths,
      };
    });
  }

  /**
   * Fallback: Simple batching if AI fails
   */
  private simpleBatchFallback(
    testCases: TestCaseForBatching[],
    analyses: TestCaseAnalysis[],
    maxPerBatch: number,
    testMode: 'voice' | 'chat' = 'chat'
  ): IntelligentBatch[] {
    // Sort by natural order score
    const sorted = [...testCases].sort((a, b) => {
      const analysisA = analyses.find(an => an.id === a.id);
      const analysisB = analyses.find(an => an.id === b.id);
      return (analysisA?.naturalOrderScore || 5) - (analysisB?.naturalOrderScore || 5);
    });

    // Separate call-ending test cases
    const callEnding = sorted.filter(tc => {
      const analysis = analyses.find(a => a.id === tc.id);
      return analysis?.mustBeLast || (analysis?.callEndingProbability || 0) > 70;
    });
    const nonEnding = sorted.filter(tc => !callEnding.includes(tc));

    const batches: IntelligentBatch[] = [];
    let currentBatch: TestCaseForBatching[] = [];

    nonEnding.forEach(tc => {
      currentBatch.push(tc);
      if (currentBatch.length >= maxPerBatch - 1 && callEnding.length > 0) {
        // Add a call-ending test case to close this batch
        const endingTC = callEnding.shift()!;
        currentBatch.push(endingTC);
        
        batches.push({
          batchId: batches.length + 1,
          name: `Batch ${batches.length + 1}`,
          testCases: [...currentBatch],
          testCaseOrder: currentBatch.map(tc => tc.id),
          reasoning: 'Fallback batching - grouped by natural order',
          estimatedDuration: `${currentBatch.length * 30}-${currentBatch.length * 45} seconds`,
          conversationFlow: 'Sequential test execution',
          callEndingTestCase: endingTC.id,
          fallbackPaths: [],
          batchConfidenceScore: 60,
          testMode: testMode,
          testModeReason: testMode === 'chat' ? 'Chat-based testing for cost optimization' : 'Voice-based testing required',
        });
        currentBatch = [];
      }
    });

    // Handle remaining test cases
    if (currentBatch.length > 0) {
      if (callEnding.length > 0) {
        currentBatch.push(callEnding.shift()!);
      }
      batches.push({
        batchId: batches.length + 1,
        name: `Batch ${batches.length + 1}`,
        testCases: currentBatch,
        testCaseOrder: currentBatch.map(tc => tc.id),
        reasoning: 'Fallback batching - remaining test cases',
        estimatedDuration: `${currentBatch.length * 30}-${currentBatch.length * 45} seconds`,
        conversationFlow: 'Sequential test execution',
        callEndingTestCase: currentBatch[currentBatch.length - 1]?.id,
        fallbackPaths: [],
        batchConfidenceScore: 60,
        testMode: testMode,
        testModeReason: testMode === 'chat' ? 'Chat-based testing for cost optimization' : 'Voice-based testing required',
      });
    }

    // Add remaining call-ending tests as separate batches
    callEnding.forEach(tc => {
      batches.push({
        batchId: batches.length + 1,
        name: `Call Ending Test: ${tc.name}`,
        testCases: [tc],
        testCaseOrder: [tc.id],
        reasoning: 'Separate batch for call-ending scenario',
        estimatedDuration: '30-45 seconds',
        conversationFlow: 'Single test that ends call',
        callEndingTestCase: tc.id,
        fallbackPaths: [],
        batchConfidenceScore: 70,
        testMode: testMode,
        testModeReason: testMode === 'chat' ? 'Chat-based testing for cost optimization' : 'Voice-based testing required',
      });
    });

    return batches;
  }

  /**
   * Calculate total estimated duration
   */
  private calculateTotalDuration(batches: IntelligentBatch[]): string {
    const totalSeconds = batches.reduce((acc, batch) => {
      const match = batch.estimatedDuration.match(/(\d+)-(\d+)/);
      if (match) {
        return acc + (parseInt(match[1]) + parseInt(match[2])) / 2;
      }
      return acc + batch.testCases.length * 35;
    }, 0);

    const minutes = Math.ceil(totalSeconds / 60);
    return `${minutes}-${minutes + Math.ceil(batches.length * 0.5)} minutes`;
  }

  /**
   * Calculate test coverage score
   */
  private calculateCoverageScore(
    testCases: TestCaseForBatching[],
    batches: IntelligentBatch[]
  ): number {
    const batchedIds = new Set(batches.flatMap(b => b.testCaseOrder));
    const coverage = (batchedIds.size / testCases.length) * 100;
    return Math.round(coverage);
  }

  /**
   * Describe the batching strategy
   */
  private describeBatchingStrategy(promptAnalysis: AgentPromptAnalysis): string {
    const endConditions = promptAnalysis.callEndingConditions.length;
    const topics = promptAnalysis.topicsHandled.length;
    
    if (endConditions > 3) {
      return `Careful batching due to ${endConditions} call-ending conditions. Call-ending tests separated.`;
    }
    if (topics > 5) {
      return `Topic-based batching across ${topics} identified topics. Related tests grouped together.`;
    }
    return 'Optimized batching for natural conversation flow with call-ending tests at batch ends.';
  }
}

// Export singleton instance
export const intelligentBatchingService = new IntelligentBatchingService();
