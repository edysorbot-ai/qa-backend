/**
 * Tool Call Payload Validation Routes
 * 
 * Define expected schemas for agent tool calls and validate them during tests.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

// CRUD for tool schemas
router.post('/schemas', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, toolName, description, parameterSchema, expectedResponseSchema } = req.body;

    if (!agentId || !toolName || !parameterSchema) {
      return res.status(400).json({ success: false, error: 'agentId, toolName, and parameterSchema are required' });
    }

    const result = await pool.query(
      `INSERT INTO tool_call_schemas (user_id, agent_id, tool_name, description, parameter_schema, expected_response_schema)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, agentId, toolName, description, JSON.stringify(parameterSchema), expectedResponseSchema ? JSON.stringify(expectedResponseSchema) : null]
    );

    res.json({ success: true, schema: result.rows[0] });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/schemas/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const result = await pool.query(
      `SELECT * FROM tool_call_schemas WHERE agent_id = $1 AND user_id = $2 ORDER BY tool_name`,
      [req.params.agentId, userId]
    );
    res.json({ success: true, schemas: result.rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/schemas/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    await pool.query(`DELETE FROM tool_call_schemas WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Validate tool calls from a transcript
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, transcript, testResultId } = req.body;

    if (!agentId || !transcript) {
      return res.status(400).json({ success: false, error: 'agentId and transcript are required' });
    }

    // Get schemas for this agent
    const schemasQuery = await pool.query(
      `SELECT * FROM tool_call_schemas WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId]
    );

    if (schemasQuery.rows.length === 0) {
      return res.json({ success: true, validations: [], message: 'No tool schemas defined' });
    }

    // Extract tool calls from transcript using AI
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const schemaDescriptions = schemasQuery.rows.map(s => {
      const schema = typeof s.parameter_schema === 'string' ? JSON.parse(s.parameter_schema) : s.parameter_schema;
      return `Tool: "${s.tool_name}" - Expected params: ${JSON.stringify(schema)}`;
    }).join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract all tool/function calls from this conversation transcript. For each tool call found, validate it against the expected schema.

EXPECTED SCHEMAS:
${schemaDescriptions}

Return JSON:
{
  "toolCalls": [
    {
      "toolName": "name",
      "parametersSent": {...},
      "isValid": true/false,
      "validationErrors": ["error1", "error2"]
    }
  ],
  "summary": { "total": N, "valid": N, "invalid": N }
}`
        },
        { role: 'user', content: `TRANSCRIPT:\n${transcript}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"toolCalls":[],"summary":{"total":0,"valid":0,"invalid":0}}');

    // Store validation results
    for (const tc of result.toolCalls || []) {
      await pool.query(
        `INSERT INTO tool_call_validations (test_result_id, agent_id, tool_name, parameters_sent, is_valid, validation_errors)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [testResultId || null, agentId, tc.toolName, JSON.stringify(tc.parametersSent || {}), tc.isValid, JSON.stringify(tc.validationErrors || [])]
      );
    }

    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error(`[ToolValidation] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Item 21: Tool call success rate aggregation per agent / tool / time-range.
 * Returns total, valid, invalid, success rate, recent invalid samples.
 */
router.get('/stats/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.params;
    const days = Number((req.query.days as string) || '30');

    const agentOwn = await pool.query(
      `SELECT 1 FROM agents WHERE id = $1 AND user_id = $2`,
      [agentId, userId]
    );
    if (agentOwn.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'agent not found' });
    }

    const overall = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_valid = true)::int AS valid,
         COUNT(*) FILTER (WHERE is_valid = false)::int AS invalid
       FROM tool_call_validations
       WHERE agent_id = $1
         AND created_at >= NOW() - ($2 || ' days')::interval`,
      [agentId, days.toString()]
    );

    const perTool = await pool.query(
      `SELECT
         tool_name,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_valid = true)::int AS valid,
         COUNT(*) FILTER (WHERE is_valid = false)::int AS invalid,
         ROUND(
           (COUNT(*) FILTER (WHERE is_valid = true))::numeric * 100.0 /
           NULLIF(COUNT(*), 0),
           1
         )::float AS success_rate
       FROM tool_call_validations
       WHERE agent_id = $1
         AND created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY tool_name
       ORDER BY total DESC`,
      [agentId, days.toString()]
    );

    const recentFailures = await pool.query(
      `SELECT id, tool_name, parameters_sent, validation_errors, created_at
       FROM tool_call_validations
       WHERE agent_id = $1
         AND is_valid = false
         AND created_at >= NOW() - ($2 || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 20`,
      [agentId, days.toString()]
    );

    const o = overall.rows[0] || { total: 0, valid: 0, invalid: 0 };
    const successRate = o.total > 0 ? Math.round((o.valid * 1000) / o.total) / 10 : null;

    res.json({
      success: true,
      windowDays: days,
      overall: {
        total: o.total,
        valid: o.valid,
        invalid: o.invalid,
        successRate,
      },
      perTool: perTool.rows,
      recentFailures: recentFailures.rows,
    });
  } catch (error: any) {
    logger.error(`[ToolValidation] Stats error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
