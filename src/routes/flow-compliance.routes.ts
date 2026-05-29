/**
 * Conversation Flow Compliance Routes
 * 
 * Define expected conversation flows as state machines (nodes + edges)
 * and validate test transcripts against them.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

interface FlowNode {
  id: string;
  label: string;
  type: 'start' | 'agent_step' | 'user_step' | 'decision' | 'end';
  description?: string;
  required?: boolean;
}

interface FlowEdge {
  from: string;
  to: string;
  condition?: string;
}

// CRUD for conversation flows
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, name, description, nodes, edges } = req.body;

    if (!agentId || !name || !nodes?.length) {
      return res.status(400).json({ success: false, error: 'agentId, name, and nodes are required' });
    }

    const result = await pool.query(
      `INSERT INTO conversation_flows (user_id, agent_id, name, description, nodes, edges)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, agentId, name, description, JSON.stringify(nodes), JSON.stringify(edges)]
    );

    res.json({ success: true, flow: result.rows[0] });
  } catch (error: any) {
    logger.error(`[Flows] Create error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await pool.query(
      `SELECT * FROM conversation_flows WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [req.params.agentId, userId]
    );
    res.json({ success: true, flows: result.rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { name, description, nodes, edges, is_active } = req.body;
    const result = await pool.query(
      `UPDATE conversation_flows SET name = COALESCE($1, name), description = COALESCE($2, description),
       nodes = COALESCE($3, nodes), edges = COALESCE($4, edges), is_active = COALESCE($5, is_active), updated_at = NOW()
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [name, description, nodes ? JSON.stringify(nodes) : null, edges ? JSON.stringify(edges) : null, is_active, req.params.id, userId]
    );
    res.json({ success: true, flow: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    await pool.query(`DELETE FROM conversation_flows WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Validate a transcript against a conversation flow
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { flowId, transcript, testResultId } = req.body;

    if (!flowId || !transcript) {
      return res.status(400).json({ success: false, error: 'flowId and transcript are required' });
    }

    const flowQuery = await pool.query(
      `SELECT * FROM conversation_flows WHERE id = $1 AND user_id = $2`,
      [flowId, userId]
    );

    if (flowQuery.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Flow not found' });
    }

    const flow = flowQuery.rows[0];
    const nodes: FlowNode[] = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes;
    const edges: FlowEdge[] = typeof flow.edges === 'string' ? JSON.parse(flow.edges) : flow.edges;

    // Use AI to map transcript turns to flow nodes
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const nodeDescriptions = nodes.map(n => `- ${n.id}: "${n.label}" (${n.type}${n.required ? ', REQUIRED' : ''})`).join('\n');
    const edgeDescriptions = edges.map(e => `- ${e.from} → ${e.to}${e.condition ? ` [if: ${e.condition}]` : ''}`).join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are analyzing a conversation transcript to determine which steps of a defined flow were followed.

FLOW NODES:
${nodeDescriptions}

FLOW EDGES (valid transitions):
${edgeDescriptions}

Return JSON:
{
  "pathTaken": ["node_id1", "node_id2", ...],
  "expectedPath": ["node_id1", "node_id2", ...],
  "complianceScore": 0-100,
  "deviations": [{"type": "skipped|unexpected|wrong_order", "nodeId": "id", "detail": "explanation"}]
}`
        },
        { role: 'user', content: `TRANSCRIPT:\n${transcript}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{}');

    // Store compliance result
    await pool.query(
      `INSERT INTO flow_compliance_results (test_result_id, flow_id, path_taken, expected_path, compliance_score, deviations)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [testResultId || null, flowId, JSON.stringify(result.pathTaken || []), JSON.stringify(result.expectedPath || []), result.complianceScore || 0, JSON.stringify(result.deviations || [])]
    );

    res.json({ success: true, ...result, flowName: flow.name });
  } catch (error: any) {
    logger.error(`[Flows] Validate error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
