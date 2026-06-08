/**
 * Routes for Items 29 & 30:
 *   - POST /api/recommendations/sanitize-prompt   { text }
 *       -> verdict + findings + redactedText (Item 29)
 *   - POST /api/recommendations/sanitize-response { text, systemPromptHint? }
 *       -> verdict + findings + redactedText (Item 29)
 *   - POST /api/recommendations/llm-change         { currentPrompt, fromModel, toModel, agentName?, agentDomain? }
 *       -> adjustments[] (Item 30)
 */

import { Router, Request, Response } from 'express';
import { sanitizePrompt, sanitizeResponse } from '../services/prompt-sanitizer.service';
import { promptSuggestionService } from '../services/prompt-suggestion.service';
import { logger } from '../services/logger.service';

const router = Router();

router.post('/sanitize-prompt', async (req: Request, res: Response) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'text is required' });
    }
    const result = sanitizePrompt(text);
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error(`[Recommendations] sanitize-prompt error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sanitize-response', async (req: Request, res: Response) => {
  try {
    const { text, systemPromptHint } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'text is required' });
    }
    const result = sanitizeResponse(text, { systemPromptHint });
    res.json({ success: true, ...result });
  } catch (err: any) {
    logger.error(`[Recommendations] sanitize-response error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/llm-change', async (req: Request, res: Response) => {
  try {
    const { currentPrompt, fromModel, toModel, agentName, agentDomain } = req.body || {};
    if (typeof currentPrompt !== 'string' || !currentPrompt.trim()) {
      return res.status(400).json({ success: false, error: 'currentPrompt is required' });
    }
    if (typeof fromModel !== 'string' || typeof toModel !== 'string') {
      return res.status(400).json({ success: false, error: 'fromModel and toModel are required' });
    }
    if (fromModel === toModel) {
      return res.json({ success: true, adjustments: [], note: 'fromModel and toModel are identical' });
    }
    const adjustments = await promptSuggestionService.suggestPromptReadjustmentForLLMChange({
      currentPrompt,
      fromModel,
      toModel,
      agentName,
      agentDomain,
    });
    res.json({ success: true, fromModel, toModel, adjustments });
  } catch (err: any) {
    logger.error(`[Recommendations] llm-change error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
