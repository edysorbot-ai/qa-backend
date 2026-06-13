/**
 * Cost Optimization Advisor Routes
 * 
 * Analyzes test results for token usage patterns and suggests
 * prompt compression, provider alternatives, and cost reduction strategies.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId is required' });
    }

    // Get agent info and recent test results
    const agentQuery = await pool.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
    if (!agentQuery.rows.length) return res.status(404).json({ success: false, error: 'Agent not found' });
    const agent = agentQuery.rows[0];

    const resultsQuery = await pool.query(
      `SELECT metrics, transcript FROM test_results WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [agentId]
    );

    const systemPrompt = agent.prompt || agent.system_prompt || agent.config?.systemPrompt || '';
    const avgTranscriptLength = resultsQuery.rows.reduce((sum: number, r: any) => {
      const t = r.transcript || '';
      return sum + (typeof t === 'string' ? t.length : JSON.stringify(t).length);
    }, 0) / Math.max(resultsQuery.rows.length, 1);

    // Estimate tokens (rough: 4 chars per token)
    const promptTokens = Math.ceil(systemPrompt.length / 4);
    const avgConversationTokens = Math.ceil(avgTranscriptLength / 4);

    // Provider cost comparison (per 1M tokens)
    const providers = [
      { name: 'GPT-4o', inputCost: 2.50, outputCost: 10.00 },
      { name: 'GPT-4o-mini', inputCost: 0.15, outputCost: 0.60 },
      { name: 'Claude 3.5 Sonnet', inputCost: 3.00, outputCost: 15.00 },
      { name: 'Claude 3.5 Haiku', inputCost: 0.80, outputCost: 4.00 },
      { name: 'Gemini 1.5 Flash', inputCost: 0.075, outputCost: 0.30 },
      { name: 'Deepseek V3', inputCost: 0.27, outputCost: 1.10 },
    ];

    const costPerCall = providers.map(p => ({
      provider: p.name,
      estimatedCostPer1000Calls: Number((((promptTokens + avgConversationTokens) * p.inputCost + avgConversationTokens * p.outputCost) / 1000).toFixed(4)),
    }));

    // Generate optimization suggestions
    const suggestions: string[] = [];
    if (promptTokens > 500) suggestions.push(`System prompt is ${promptTokens} tokens. Consider compressing repetitive instructions or moving examples to few-shot format.`);
    if (promptTokens > 1000) suggestions.push('Your prompt exceeds 1000 tokens. Use numbered instructions instead of prose to reduce by ~30%.');
    if (avgConversationTokens > 2000) suggestions.push('Average conversations are long. Consider adding early-exit conditions or reducing verbosity instructions.');
    if (!systemPrompt.includes('concise') && !systemPrompt.includes('brief')) suggestions.push('Add "Be concise in responses" to reduce output tokens by 20-40%.');

    res.json({
      success: true,
      analysis: {
        promptTokens,
        avgConversationTokens,
        totalTokensPerCall: promptTokens + avgConversationTokens * 2,
        costComparison: costPerCall.sort((a, b) => a.estimatedCostPer1000Calls - b.estimatedCostPer1000Calls),
        suggestions,
        testResultsAnalyzed: resultsQuery.rows.length,
      }
    });
  } catch (error: any) {
    logger.error(`[CostAdvisor] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
