/**
 * Custom Evaluation Rubrics Routes
 * 
 * Allows users to define custom scoring criteria for their agents.
 * Criteria types: boolean, numeric_threshold, text_match, compliance
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

interface RubricCriteria {
  id: string;
  name: string;
  description: string;
  type: 'boolean' | 'numeric_threshold' | 'text_contains' | 'compliance';
  weight: number; // 1-10
  config: {
    // For boolean: question to evaluate (e.g., "Did the agent mention the return policy?")
    question?: string;
    // For numeric_threshold: min/max values
    minValue?: number;
    maxValue?: number;
    // For text_contains: keywords that must appear
    keywords?: string[];
    matchAll?: boolean;
    // For compliance: regulatory requirement
    requirement?: string;
  };
}

/**
 * Create a rubric for an agent
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, name, criteria } = req.body;

    if (!agentId || !name || !criteria?.length) {
      return res.status(400).json({ success: false, error: 'agentId, name, and criteria are required' });
    }

    const result = await pool.query(
      `INSERT INTO evaluation_rubrics (user_id, agent_id, name, criteria)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, agentId, name, JSON.stringify(criteria)]
    );

    res.json({ success: true, rubric: result.rows[0] });
  } catch (error: any) {
    logger.error(`[Rubrics] Create error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get rubrics for an agent
 */
router.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.params;

    const result = await pool.query(
      `SELECT * FROM evaluation_rubrics WHERE agent_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [agentId, userId]
    );

    res.json({ success: true, rubrics: result.rows });
  } catch (error: any) {
    logger.error(`[Rubrics] List error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a rubric
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { id } = req.params;
    const { name, criteria, is_active } = req.body;

    const result = await pool.query(
      `UPDATE evaluation_rubrics SET name = COALESCE($1, name), criteria = COALESCE($2, criteria), 
       is_active = COALESCE($3, is_active), updated_at = NOW()
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [name, criteria ? JSON.stringify(criteria) : null, is_active, id, userId]
    );

    res.json({ success: true, rubric: result.rows[0] });
  } catch (error: any) {
    logger.error(`[Rubrics] Update error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a rubric
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    await pool.query(`DELETE FROM evaluation_rubrics WHERE id = $1 AND user_id = $2`, [req.params.id, userId]);
    res.json({ success: true });
  } catch (error: any) {
    logger.error(`[Rubrics] Delete error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Evaluate a transcript against custom rubrics
 */
router.post('/evaluate', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, transcript } = req.body;

    if (!agentId || !transcript) {
      return res.status(400).json({ success: false, error: 'agentId and transcript are required' });
    }

    // Get active rubrics
    const rubricsQuery = await pool.query(
      `SELECT * FROM evaluation_rubrics WHERE agent_id = $1 AND user_id = $2 AND is_active = true`,
      [agentId, userId]
    );

    if (rubricsQuery.rows.length === 0) {
      return res.json({ success: true, results: [], message: 'No active rubrics' });
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const rubricResults = [];

    for (const rubric of rubricsQuery.rows) {
      const criteria = typeof rubric.criteria === 'string' ? JSON.parse(rubric.criteria) : rubric.criteria;

      // Evaluate each criterion using AI
      const criteriaEvals = criteria.map((c: RubricCriteria) => {
        return `- "${c.name}" (${c.type}, weight: ${c.weight}/10): ${c.description}${c.config?.question ? ` Question: ${c.config.question}` : ''}${c.config?.keywords ? ` Must contain: ${c.config.keywords.join(', ')}` : ''}`;
      }).join('\n');

      const evalResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a QA evaluator using a custom rubric. Evaluate the transcript against each criterion.
Return JSON: { "scores": [{ "criteriaId": "id", "passed": true/false, "score": 0-100, "evidence": "brief quote from transcript" }], "totalScore": 0-100 }`
          },
          {
            role: 'user',
            content: `RUBRIC: ${rubric.name}\nCRITERIA:\n${criteriaEvals}\n\nTRANSCRIPT:\n${transcript}`
          }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const evalResult = JSON.parse(evalResponse.choices[0]?.message?.content || '{"scores":[],"totalScore":0}');
      rubricResults.push({
        rubricId: rubric.id,
        rubricName: rubric.name,
        ...evalResult,
      });
    }

    res.json({ success: true, results: rubricResults });
  } catch (error: any) {
    logger.error(`[Rubrics] Evaluate error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
