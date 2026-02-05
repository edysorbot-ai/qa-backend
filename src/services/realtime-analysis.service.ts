/**
 * Realtime Analysis Service
 * 
 * Analyzes production calls in real-time against agent prompts.
 * Comprehensive analysis includes:
 * 1. Agent's system prompt and expected behaviors
 * 2. Conversation flow and quality
 * 3. Detecting incorrect/hallucinated information
 * 4. Sentiment analysis
 * 5. Intent detection and handling
 * 6. Compliance checking
 * 7. Tool usage analysis
 * 8. Prompt improvement suggestions
 */

import OpenAI from 'openai';
import pool from '../db';

interface TranscriptTurn {
  role: 'agent' | 'user' | 'system';
  content: string;
  timestamp?: number;
}

interface AnalysisResult {
  overallScore: number; // 0-100
  summary: string;
  issues: AnalysisIssue[];
  strengths: string[];
  promptSuggestions: PromptSuggestion[];
  metrics: {
    responseQuality: number;
    promptAdherence: number;
    conversationFlow: number;
    informationAccuracy: number;
    userSatisfaction: number;
    empathy: number;
    clarity: number;
    efficiency: number;
  };
  // Enhanced analysis fields
  sentiment: {
    user: 'positive' | 'neutral' | 'negative' | 'frustrated' | 'confused';
    agent: 'professional' | 'empathetic' | 'robotic' | 'helpful';
    overall: 'positive' | 'neutral' | 'negative';
  };
  intent: {
    detected: string;
    handled: boolean;
    handlingQuality: number; // 0-100
    alternativeIntents?: string[];
  };
  compliance: {
    score: number; // 0-100
    flags: ComplianceFlag[];
    passedChecks: string[];
  };
  toolUsage: {
    toolsCalled: ToolUsageDetail[];
    appropriateUsage: boolean;
    missedOpportunities: string[];
  };
  conversationDynamics: {
    avgResponseLength: number;
    userEngagement: 'high' | 'medium' | 'low';
    interruptionCount: number;
    clarificationRequests: number;
    topicChanges: number;
  };
}

interface ComplianceFlag {
  type: 'pii_exposure' | 'unauthorized_disclosure' | 'missing_disclaimer' | 'off_script' | 'inappropriate_response';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  turnIndex?: number;
}

interface ToolUsageDetail {
  toolName: string;
  callCount: number;
  success: boolean;
  timing: 'appropriate' | 'early' | 'late' | 'unnecessary';
}

interface AnalysisIssue {
  severity: 'critical' | 'major' | 'minor';
  category: string;
  description: string;
  turnIndex?: number;
  suggestion: string;
}

interface PromptSuggestion {
  type: 'addition' | 'modification' | 'removal';
  priority: 'high' | 'medium' | 'low';
  currentBehavior: string;
  suggestedChange: string;
  reasoning: string;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

class RealtimeAnalysisService {
  /**
   * Analyze a production call against the agent's prompt
   * Comprehensive analysis including sentiment, intent, compliance, and tool usage
   */
  async analyzeCall(
    callId: string,
    transcript: TranscriptTurn[],
    agentPrompt: string,
    agentConfig?: Record<string, any>,
    providerData?: { tool_calls?: any[]; call_analysis?: any; latency?: any }
  ): Promise<AnalysisResult> {
    console.log(`[RealtimeAnalysis] Analyzing call ${callId}`);

    // Format transcript for analysis
    const transcriptText = transcript
      .map((turn, i) => `[${i + 1}] ${turn.role.toUpperCase()}: ${turn.content}`)
      .join('\n');

    // Include tool calls if available
    const toolCallsText = providerData?.tool_calls?.length 
      ? `\n## TOOL CALLS MADE:\n${JSON.stringify(providerData.tool_calls, null, 2)}`
      : '';

    const analysisPrompt = `You are an expert voice AI quality analyst and compliance officer. Perform a COMPREHENSIVE analysis of this production call.

## AGENT'S SYSTEM PROMPT:
${agentPrompt || 'No system prompt provided'}

## AGENT CONFIGURATION:
${agentConfig ? JSON.stringify(agentConfig, null, 2) : 'No additional configuration'}

## CALL TRANSCRIPT:
${transcriptText}
${toolCallsText}

## COMPREHENSIVE ANALYSIS REQUIREMENTS:

### 1. Core Quality Metrics
- **Prompt Adherence**: Did the agent follow its instructions exactly?
- **Information Accuracy**: Flag any hallucinations, incorrect facts, or made-up information
- **Conversation Quality**: Natural flow, appropriate responses, helpful demeanor
- **Goal Achievement**: Did the agent accomplish its intended purpose?

### 2. Sentiment Analysis
- Analyze the USER's sentiment throughout the call (positive/neutral/negative/frustrated/confused)
- Analyze the AGENT's tone (professional/empathetic/robotic/helpful)
- Overall call sentiment

### 3. Intent Detection
- What was the user trying to accomplish?
- Was their intent correctly identified and handled?
- Were there alternative intents that were missed?

### 4. Compliance Checking
- PII exposure: Did the agent inappropriately handle or expose personal information?
- Unauthorized disclosure: Did the agent share information it shouldn't?
- Missing disclaimers: Were required disclaimers or warnings provided?
- Off-script responses: Did the agent go beyond its authorized scope?

### 5. Tool Usage Analysis
- Were tools called appropriately?
- Were there missed opportunities to use tools?
- Was timing of tool calls optimal?

### 6. Conversation Dynamics
- Average response length and appropriateness
- User engagement level
- Number of clarification requests
- Topic changes and handling

## RESPOND IN THIS EXACT JSON FORMAT:
{
  "overallScore": <0-100>,
  "summary": "<2-3 sentence summary of the call quality>",
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "<hallucination|off-script|missed-info|poor-response|compliance|tool-misuse|sentiment>",
      "description": "<what went wrong>",
      "turnIndex": <optional: which turn had the issue>,
      "suggestion": "<how to fix this>"
    }
  ],
  "strengths": ["<what the agent did well>"],
  "promptSuggestions": [
    {
      "type": "addition|modification|removal",
      "priority": "high|medium|low",
      "currentBehavior": "<what the agent currently does>",
      "suggestedChange": "<specific prompt change to make>",
      "reasoning": "<why this change would help>"
    }
  ],
  "metrics": {
    "responseQuality": <0-100>,
    "promptAdherence": <0-100>,
    "conversationFlow": <0-100>,
    "informationAccuracy": <0-100>,
    "userSatisfaction": <0-100>,
    "empathy": <0-100>,
    "clarity": <0-100>,
    "efficiency": <0-100>
  },
  "sentiment": {
    "user": "positive|neutral|negative|frustrated|confused",
    "agent": "professional|empathetic|robotic|helpful",
    "overall": "positive|neutral|negative"
  },
  "intent": {
    "detected": "<the user's primary intent>",
    "handled": <true|false>,
    "handlingQuality": <0-100>,
    "alternativeIntents": ["<other possible intents>"]
  },
  "compliance": {
    "score": <0-100>,
    "flags": [
      {
        "type": "pii_exposure|unauthorized_disclosure|missing_disclaimer|off_script|inappropriate_response",
        "severity": "critical|major|minor",
        "description": "<what happened>",
        "turnIndex": <optional>
      }
    ],
    "passedChecks": ["<checks that passed>"]
  },
  "toolUsage": {
    "toolsCalled": [
      {
        "toolName": "<name>",
        "callCount": <number>,
        "success": <true|false>,
        "timing": "appropriate|early|late|unnecessary"
      }
    ],
    "appropriateUsage": <true|false>,
    "missedOpportunities": ["<tools that should have been called>"]
  },
  "conversationDynamics": {
    "avgResponseLength": <word count>,
    "userEngagement": "high|medium|low",
    "interruptionCount": <number>,
    "clarificationRequests": <number>,
    "topicChanges": <number>
  }
}

Be thorough, fair, and focus on actionable insights.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a voice AI quality analyst. Respond only with valid JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        temperature: 0.3,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content || '{}';
      
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const analysis: AnalysisResult = JSON.parse(jsonMatch[0]);
      
      // Validate and normalize all fields
      analysis.overallScore = Math.max(0, Math.min(100, analysis.overallScore || 50));
      analysis.issues = analysis.issues || [];
      analysis.strengths = analysis.strengths || [];
      analysis.promptSuggestions = analysis.promptSuggestions || [];
      
      // Core metrics
      analysis.metrics = {
        responseQuality: analysis.metrics?.responseQuality || 50,
        promptAdherence: analysis.metrics?.promptAdherence || 50,
        conversationFlow: analysis.metrics?.conversationFlow || 50,
        informationAccuracy: analysis.metrics?.informationAccuracy || 50,
        userSatisfaction: analysis.metrics?.userSatisfaction || 50,
        empathy: analysis.metrics?.empathy || 50,
        clarity: analysis.metrics?.clarity || 50,
        efficiency: analysis.metrics?.efficiency || 50,
      };

      // Sentiment defaults
      analysis.sentiment = analysis.sentiment || {
        user: 'neutral',
        agent: 'professional',
        overall: 'neutral'
      };

      // Intent defaults
      analysis.intent = analysis.intent || {
        detected: 'unknown',
        handled: false,
        handlingQuality: 50,
        alternativeIntents: []
      };

      // Compliance defaults
      analysis.compliance = analysis.compliance || {
        score: 100,
        flags: [],
        passedChecks: []
      };

      // Tool usage defaults
      analysis.toolUsage = analysis.toolUsage || {
        toolsCalled: [],
        appropriateUsage: true,
        missedOpportunities: []
      };

      // Conversation dynamics defaults
      analysis.conversationDynamics = analysis.conversationDynamics || {
        avgResponseLength: 0,
        userEngagement: 'medium',
        interruptionCount: 0,
        clarificationRequests: 0,
        topicChanges: 0
      };

      console.log(`[RealtimeAnalysis] Call ${callId} analyzed: score=${analysis.overallScore}, issues=${analysis.issues.length}, sentiment=${analysis.sentiment.overall}`);
      
      return analysis;
    } catch (error) {
      console.error(`[RealtimeAnalysis] Error analyzing call ${callId}:`, error);
      
      // Return comprehensive default analysis on error
      return {
        overallScore: 50,
        summary: 'Analysis could not be completed due to an error.',
        issues: [],
        strengths: [],
        promptSuggestions: [],
        metrics: {
          responseQuality: 50,
          promptAdherence: 50,
          conversationFlow: 50,
          informationAccuracy: 50,
          userSatisfaction: 50,
          empathy: 50,
          clarity: 50,
          efficiency: 50,
        },
        sentiment: {
          user: 'neutral',
          agent: 'professional',
          overall: 'neutral'
        },
        intent: {
          detected: 'unknown',
          handled: false,
          handlingQuality: 50,
          alternativeIntents: []
        },
        compliance: {
          score: 100,
          flags: [],
          passedChecks: []
        },
        toolUsage: {
          toolsCalled: [],
          appropriateUsage: true,
          missedOpportunities: []
        },
        conversationDynamics: {
          avgResponseLength: 0,
          userEngagement: 'medium',
          interruptionCount: 0,
          clarificationRequests: 0,
          topicChanges: 0
        }
      };
    }
  }

  /**
   * Process and analyze a production call
   * Called when webhook receives call completion
   */
  async processCall(callId: string): Promise<void> {
    console.log(`[RealtimeAnalysis] Processing call ${callId}`);

    try {
      // Update status to analyzing
      await pool.query(
        `UPDATE production_calls SET analysis_status = 'analyzing', updated_at = NOW() WHERE id = $1`,
        [callId]
      );

      // Get call details with agent info
      const callResult = await pool.query(
        `SELECT pc.*, a.config as agent_config
         FROM production_calls pc
         LEFT JOIN agents a ON pc.agent_id = a.id
         WHERE pc.id = $1`,
        [callId]
      );

      if (callResult.rows.length === 0) {
        console.error(`[RealtimeAnalysis] Call ${callId} not found`);
        return;
      }

      const call = callResult.rows[0];
      const transcript: TranscriptTurn[] = call.transcript || [];
      
      // Get agent's system prompt
      const agentConfig = call.agent_config || {};
      const systemPrompt = agentConfig.systemPrompt || 
                          agentConfig.prompt || 
                          agentConfig.instructions ||
                          'No system prompt available';

      // Extract provider data from webhook payload for enhanced analysis
      const webhookPayload = call.webhook_payload || {};
      const providerData = {
        tool_calls: webhookPayload.tool_calls || call.tool_calls,
        call_analysis: webhookPayload.call_analysis,
        latency: webhookPayload.latency
      };

      // Run comprehensive analysis
      const analysis = await this.analyzeCall(callId, transcript, systemPrompt, agentConfig, providerData);

      // Update call with comprehensive analysis results
      await pool.query(
        `UPDATE production_calls 
         SET analysis = $1, 
             analysis_status = 'completed',
             overall_score = $2,
             issues_found = $3,
             prompt_suggestions = $4,
             sentiment = $5,
             compliance_flags = $6,
             tool_calls = $7,
             updated_at = NOW()
         WHERE id = $8`,
        [
          JSON.stringify(analysis),
          analysis.overallScore,
          analysis.issues.length,
          JSON.stringify(analysis.promptSuggestions),
          analysis.sentiment?.overall || 'neutral',
          JSON.stringify(analysis.compliance?.flags || []),
          JSON.stringify(analysis.toolUsage?.toolsCalled || providerData.tool_calls || []),
          callId,
        ]
      );

      // Update monitoring session stats
      await pool.query(
        `UPDATE monitoring_sessions 
         SET total_calls = total_calls + 1, 
             last_call_at = NOW(),
             updated_at = NOW()
         WHERE agent_id = (SELECT agent_id FROM production_calls WHERE id = $1)`,
        [callId]
      );

      console.log(`[RealtimeAnalysis] Call ${callId} analysis completed`);
    } catch (error) {
      console.error(`[RealtimeAnalysis] Error processing call ${callId}:`, error);
      
      await pool.query(
        `UPDATE production_calls SET analysis_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [callId]
      );
    }
  }

  /**
   * Aggregate analysis across multiple calls for trend insights
   */
  async getAgentInsights(agentId: string, days: number = 7): Promise<{
    totalCalls: number;
    averageScore: number;
    commonIssues: { category: string; count: number }[];
    topSuggestions: PromptSuggestion[];
    scoreOverTime: { date: string; score: number; calls: number }[];
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Get call stats
    const statsResult = await pool.query(
      `SELECT 
         COUNT(*) as total_calls,
         AVG(overall_score) as avg_score
       FROM production_calls 
       WHERE agent_id = $1 AND created_at >= $2 AND analysis_status = 'completed'`,
      [agentId, since]
    );

    // Get common issues
    const issuesResult = await pool.query(
      `SELECT 
         issue->>'category' as category,
         COUNT(*) as count
       FROM production_calls,
         jsonb_array_elements(analysis->'issues') as issue
       WHERE agent_id = $1 AND created_at >= $2 AND analysis_status = 'completed'
       GROUP BY issue->>'category'
       ORDER BY count DESC
       LIMIT 10`,
      [agentId, since]
    );

    // Get score over time
    const timeResult = await pool.query(
      `SELECT 
         DATE(created_at) as date,
         AVG(overall_score) as score,
         COUNT(*) as calls
       FROM production_calls 
       WHERE agent_id = $1 AND created_at >= $2 AND analysis_status = 'completed'
       GROUP BY DATE(created_at)
       ORDER BY date`,
      [agentId, since]
    );

    // Get top suggestions (aggregated)
    const suggestionsResult = await pool.query(
      `SELECT prompt_suggestions
       FROM production_calls 
       WHERE agent_id = $1 AND created_at >= $2 
         AND analysis_status = 'completed'
         AND prompt_suggestions IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 20`,
      [agentId, since]
    );

    // Aggregate and dedupe suggestions
    const allSuggestions: PromptSuggestion[] = [];
    for (const row of suggestionsResult.rows) {
      if (row.prompt_suggestions) {
        allSuggestions.push(...(row.prompt_suggestions as PromptSuggestion[]));
      }
    }

    // Dedupe by suggestedChange
    const uniqueSuggestions = allSuggestions.reduce((acc, s) => {
      const key = s.suggestedChange;
      if (!acc.has(key)) {
        acc.set(key, s);
      }
      return acc;
    }, new Map<string, PromptSuggestion>());

    return {
      totalCalls: parseInt(statsResult.rows[0]?.total_calls || '0'),
      averageScore: parseFloat(statsResult.rows[0]?.avg_score || '0'),
      commonIssues: issuesResult.rows.map(r => ({
        category: r.category,
        count: parseInt(r.count),
      })),
      topSuggestions: Array.from(uniqueSuggestions.values()).slice(0, 5),
      scoreOverTime: timeResult.rows.map(r => ({
        date: r.date,
        score: parseFloat(r.score),
        calls: parseInt(r.calls),
      })),
    };
  }
}

export const realtimeAnalysisService = new RealtimeAnalysisService();
