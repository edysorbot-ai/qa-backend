/**
 * Realtime Analysis Service
 * 
 * Analyzes production calls in real-time against agent prompts.
 * Since there are no test cases, analysis is based on:
 * 1. Agent's system prompt and expected behaviors
 * 2. Conversation flow and quality
 * 3. Detecting incorrect/hallucinated information
 * 4. Identifying areas for prompt improvement
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
  };
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
   */
  async analyzeCall(
    callId: string,
    transcript: TranscriptTurn[],
    agentPrompt: string,
    agentConfig?: Record<string, any>
  ): Promise<AnalysisResult> {
    console.log(`[RealtimeAnalysis] Analyzing call ${callId}`);

    // Format transcript for analysis
    const transcriptText = transcript
      .map((turn, i) => `[${i + 1}] ${turn.role.toUpperCase()}: ${turn.content}`)
      .join('\n');

    const analysisPrompt = `You are an expert voice AI quality analyst. Analyze this production call against the agent's system prompt.

## AGENT'S SYSTEM PROMPT:
${agentPrompt || 'No system prompt provided'}

## AGENT CONFIGURATION:
${agentConfig ? JSON.stringify(agentConfig, null, 2) : 'No additional configuration'}

## CALL TRANSCRIPT:
${transcriptText}

## ANALYSIS REQUIREMENTS:
1. **Prompt Adherence**: Did the agent follow its instructions?
2. **Information Accuracy**: Did the agent provide correct information? Flag any hallucinations or errors.
3. **Conversation Quality**: Was the conversation natural and helpful?
4. **Goal Achievement**: Did the agent accomplish its intended purpose?
5. **Edge Case Handling**: How did the agent handle unexpected inputs?

## RESPOND IN THIS JSON FORMAT:
{
  "overallScore": <0-100>,
  "summary": "<2-3 sentence summary of the call quality>",
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "<category: hallucination, off-script, missed-info, poor-response, etc.>",
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
    "userSatisfaction": <0-100 based on user's responses>
  }
}

Be thorough but fair. Focus on actionable improvements.`;

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
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
      
      // Validate and normalize
      analysis.overallScore = Math.max(0, Math.min(100, analysis.overallScore || 50));
      analysis.issues = analysis.issues || [];
      analysis.strengths = analysis.strengths || [];
      analysis.promptSuggestions = analysis.promptSuggestions || [];
      analysis.metrics = {
        responseQuality: analysis.metrics?.responseQuality || 50,
        promptAdherence: analysis.metrics?.promptAdherence || 50,
        conversationFlow: analysis.metrics?.conversationFlow || 50,
        informationAccuracy: analysis.metrics?.informationAccuracy || 50,
        userSatisfaction: analysis.metrics?.userSatisfaction || 50,
      };

      console.log(`[RealtimeAnalysis] Call ${callId} analyzed: score=${analysis.overallScore}, issues=${analysis.issues.length}`);
      
      return analysis;
    } catch (error) {
      console.error(`[RealtimeAnalysis] Error analyzing call ${callId}:`, error);
      
      // Return default analysis on error
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
        },
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

      // Run analysis
      const analysis = await this.analyzeCall(callId, transcript, systemPrompt, agentConfig);

      // Update call with analysis results
      await pool.query(
        `UPDATE production_calls 
         SET analysis = $1, 
             analysis_status = 'completed',
             overall_score = $2,
             issues_found = $3,
             prompt_suggestions = $4,
             updated_at = NOW()
         WHERE id = $5`,
        [
          JSON.stringify(analysis),
          analysis.overallScore,
          analysis.issues.length,
          JSON.stringify(analysis.promptSuggestions),
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
