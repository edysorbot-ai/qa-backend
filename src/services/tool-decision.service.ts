import { pool } from '../db';

/**
 * Tool Decision Trace Service
 * 
 * Tracks and analyzes tool/function selection decisions made by AI agents
 * during conversations. Provides enterprise-grade audit trails for compliance.
 */

// Interfaces
export interface AlternativeConsidered {
  tool: string;
  reason: string;
  confidence?: number;
}

export interface DecisionFactor {
  factor: string;
  weight: number;
  contribution: string;
}

export interface ToolDecision {
  id?: string;
  testResultId: string;
  turnNumber: number;
  timestamp?: Date;
  availableTools: string[];
  selectedTool: string | null;
  selectionReason: string;
  alternativesConsidered: AlternativeConsidered[];
  decisionFactors: DecisionFactor[];
  inputContext: string;
  confidence: number;
}

export interface ToolDecisionTrace {
  testResultId: string;
  agentId: string;
  decisions: ToolDecision[];
  totalToolCalls: number;
  uniqueToolsUsed: string[];
  averageConfidence: number;
  lowConfidenceDecisions: ToolDecision[];
}

export interface ToolUsageAnalytics {
  totalDecisions: number;
  toolUsageBreakdown: { tool: string; count: number; percentage: number }[];
  averageConfidence: number;
  lowConfidenceDecisions: ToolDecision[];
  decisionsByTurn: { turnNumber: number; count: number }[];
}

/**
 * Store a tool decision record
 */
export async function storeToolDecision(decision: ToolDecision): Promise<string> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO tool_decisions (
        test_result_id,
        turn_number,
        available_tools,
        selected_tool,
        selection_reason,
        alternatives_considered,
        decision_factors,
        input_context,
        confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        decision.testResultId,
        decision.turnNumber,
        JSON.stringify(decision.availableTools),
        decision.selectedTool,
        decision.selectionReason,
        JSON.stringify(decision.alternativesConsidered),
        JSON.stringify(decision.decisionFactors),
        decision.inputContext,
        decision.confidence
      ]
    );
    
    return result.rows[0].id;
  } finally {
    client.release();
  }
}

/**
 * Store multiple tool decisions in a batch
 */
export async function storeToolDecisions(decisions: ToolDecision[]): Promise<string[]> {
  if (decisions.length === 0) return [];
  
  const client = await pool.connect();
  const ids: string[] = [];
  
  try {
    await client.query('BEGIN');
    
    for (const decision of decisions) {
      const result = await client.query(
        `INSERT INTO tool_decisions (
          test_result_id,
          turn_number,
          available_tools,
          selected_tool,
          selection_reason,
          alternatives_considered,
          decision_factors,
          input_context,
          confidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
        [
          decision.testResultId,
          decision.turnNumber,
          JSON.stringify(decision.availableTools),
          decision.selectedTool,
          decision.selectionReason,
          JSON.stringify(decision.alternativesConsidered),
          JSON.stringify(decision.decisionFactors),
          decision.inputContext,
          decision.confidence
        ]
      );
      ids.push(result.rows[0].id);
    }
    
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get all tool decisions for a test result
 */
export async function getToolDecisions(testResultId: string): Promise<ToolDecision[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT 
        id,
        test_result_id as "testResultId",
        turn_number as "turnNumber",
        available_tools as "availableTools",
        selected_tool as "selectedTool",
        selection_reason as "selectionReason",
        alternatives_considered as "alternativesConsidered",
        decision_factors as "decisionFactors",
        input_context as "inputContext",
        confidence,
        created_at as "timestamp"
      FROM tool_decisions 
      WHERE test_result_id = $1 
      ORDER BY turn_number ASC`,
      [testResultId]
    );
    
    return result.rows.map(row => ({
      ...row,
      availableTools: row.availableTools || [],
      alternativesConsidered: row.alternativesConsidered || [],
      decisionFactors: row.decisionFactors || [],
      confidence: parseFloat(row.confidence) || 0
    }));
  } finally {
    client.release();
  }
}

/**
 * Get tool decision trace with analytics for a test result
 */
export async function getToolDecisionTrace(testResultId: string): Promise<ToolDecisionTrace | null> {
  const client = await pool.connect();
  
  try {
    // Get test result info
    const testResult = await client.query(
      `SELECT agent_id as "agentId" FROM test_results WHERE id = $1`,
      [testResultId]
    );
    
    if (testResult.rows.length === 0) {
      return null;
    }
    
    const agentId = testResult.rows[0].agentId;
    
    // Get all decisions
    const decisions = await getToolDecisions(testResultId);
    
    if (decisions.length === 0) {
      return {
        testResultId,
        agentId,
        decisions: [],
        totalToolCalls: 0,
        uniqueToolsUsed: [],
        averageConfidence: 0,
        lowConfidenceDecisions: []
      };
    }
    
    // Calculate analytics
    const toolsUsed = decisions
      .filter(d => d.selectedTool)
      .map(d => d.selectedTool as string);
    
    const uniqueToolsUsed = [...new Set(toolsUsed)];
    
    const totalConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0);
    const averageConfidence = decisions.length > 0 ? totalConfidence / decisions.length : 0;
    
    // Low confidence threshold: 0.7
    const lowConfidenceDecisions = decisions.filter(d => d.confidence < 0.7);
    
    return {
      testResultId,
      agentId,
      decisions,
      totalToolCalls: toolsUsed.length,
      uniqueToolsUsed,
      averageConfidence: Math.round(averageConfidence * 100) / 100,
      lowConfidenceDecisions
    };
  } finally {
    client.release();
  }
}

/**
 * Get tool usage analytics for an agent
 */
export async function getAgentToolUsageAnalytics(agentId: string): Promise<ToolUsageAnalytics> {
  const client = await pool.connect();
  
  try {
    // Get all tool decisions for this agent's test results
    const result = await client.query(
      `SELECT 
        td.id,
        td.test_result_id as "testResultId",
        td.turn_number as "turnNumber",
        td.available_tools as "availableTools",
        td.selected_tool as "selectedTool",
        td.selection_reason as "selectionReason",
        td.alternatives_considered as "alternativesConsidered",
        td.decision_factors as "decisionFactors",
        td.input_context as "inputContext",
        td.confidence,
        td.created_at as "timestamp"
      FROM tool_decisions td
      JOIN test_results tr ON td.test_result_id = tr.id
      WHERE tr.agent_id = $1
      ORDER BY td.created_at DESC`,
      [agentId]
    );
    
    const decisions: ToolDecision[] = result.rows.map(row => ({
      ...row,
      availableTools: row.availableTools || [],
      alternativesConsidered: row.alternativesConsidered || [],
      decisionFactors: row.decisionFactors || [],
      confidence: parseFloat(row.confidence) || 0
    }));
    
    if (decisions.length === 0) {
      return {
        totalDecisions: 0,
        toolUsageBreakdown: [],
        averageConfidence: 0,
        lowConfidenceDecisions: [],
        decisionsByTurn: []
      };
    }
    
    // Calculate tool usage breakdown
    const toolCounts: Record<string, number> = {};
    decisions.forEach(d => {
      if (d.selectedTool) {
        toolCounts[d.selectedTool] = (toolCounts[d.selectedTool] || 0) + 1;
      }
    });
    
    const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
    
    const toolUsageBreakdown = Object.entries(toolCounts)
      .map(([tool, count]) => ({
        tool,
        count,
        percentage: Math.round((count / totalToolCalls) * 100)
      }))
      .sort((a, b) => b.count - a.count);
    
    // Calculate decisions by turn
    const turnCounts: Record<number, number> = {};
    decisions.forEach(d => {
      turnCounts[d.turnNumber] = (turnCounts[d.turnNumber] || 0) + 1;
    });
    
    const decisionsByTurn = Object.entries(turnCounts)
      .map(([turnNumber, count]) => ({
        turnNumber: parseInt(turnNumber),
        count
      }))
      .sort((a, b) => a.turnNumber - b.turnNumber);
    
    // Calculate average confidence
    const totalConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0);
    const averageConfidence = Math.round((totalConfidence / decisions.length) * 100) / 100;
    
    // Get low confidence decisions (< 0.7)
    const lowConfidenceDecisions = decisions
      .filter(d => d.confidence < 0.7)
      .slice(0, 10); // Limit to 10 most recent
    
    return {
      totalDecisions: decisions.length,
      toolUsageBreakdown,
      averageConfidence,
      lowConfidenceDecisions,
      decisionsByTurn
    };
  } finally {
    client.release();
  }
}

/**
 * Parse tool decisions from LLM response
 * This is used when the agent provides structured decision data
 */
export function parseToolDecisionFromLLM(
  testResultId: string,
  turnNumber: number,
  inputContext: string,
  llmResponse: {
    selected_tool: string | null;
    selection_reason: string;
    alternatives_considered?: Array<{ tool: string; reason: string }>;
    confidence?: number;
    available_tools?: string[];
  }
): ToolDecision {
  return {
    testResultId,
    turnNumber,
    availableTools: llmResponse.available_tools || [],
    selectedTool: llmResponse.selected_tool,
    selectionReason: llmResponse.selection_reason || 'No reason provided',
    alternativesConsidered: (llmResponse.alternatives_considered || []).map(alt => ({
      tool: alt.tool,
      reason: alt.reason,
      confidence: undefined
    })),
    decisionFactors: [],
    inputContext,
    confidence: llmResponse.confidence ?? 0.5
  };
}

/**
 * Generate audit export for tool decisions
 */
export async function generateToolDecisionAudit(
  testResultId: string,
  auditorNotes?: string
): Promise<object> {
  const trace = await getToolDecisionTrace(testResultId);
  
  if (!trace) {
    throw new Error('Test result not found');
  }
  
  return {
    audit_id: `ADT-${Date.now()}`,
    test_result_id: testResultId,
    agent_id: trace.agentId,
    generated_at: new Date().toISOString(),
    summary: {
      total_decisions: trace.totalToolCalls,
      unique_tools_used: trace.uniqueToolsUsed,
      average_confidence: trace.averageConfidence,
      low_confidence_count: trace.lowConfidenceDecisions.length
    },
    tool_decisions: trace.decisions.map(d => ({
      turn: d.turnNumber,
      tool: d.selectedTool,
      reason: d.selectionReason,
      alternatives_rejected: d.alternativesConsidered.map(a => a.tool),
      confidence: d.confidence,
      input_context: d.inputContext
    })),
    auditor_notes: auditorNotes || '',
    compliance_flags: trace.lowConfidenceDecisions.length > 0 
      ? ['LOW_CONFIDENCE_DECISIONS_DETECTED'] 
      : []
  };
}

/**
 * Delete tool decisions for a test result
 */
export async function deleteToolDecisions(testResultId: string): Promise<number> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'DELETE FROM tool_decisions WHERE test_result_id = $1',
      [testResultId]
    );
    return result.rowCount || 0;
  } finally {
    client.release();
  }
}
