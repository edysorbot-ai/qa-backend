/**
 * Multi-Language Testing Routes
 * 
 * Run test cases in multiple languages to validate agent's multilingual support.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { logger } from '../services/logger.service';

const router = Router();

const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ar', name: 'Arabic' },
  { code: 'zh', name: 'Chinese (Mandarin)' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
];

router.get('/languages', (_req: Request, res: Response) => {
  res.json({ success: true, languages: SUPPORTED_LANGUAGES });
});

/**
 * Translate test cases and run in target language
 */
router.post('/run', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { agentId, testCaseIds, targetLanguages } = req.body;

    if (!agentId || !testCaseIds?.length || !targetLanguages?.length) {
      return res.status(400).json({ success: false, error: 'agentId, testCaseIds, and targetLanguages are required' });
    }

    // Get test cases
    const testCasesQuery = await pool.query(
      `SELECT * FROM test_cases WHERE id = ANY($1) AND agent_id = $2`,
      [testCaseIds, agentId]
    );

    if (!testCasesQuery.rows.length) {
      return res.status(404).json({ success: false, error: 'No test cases found' });
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const results: any[] = [];

    for (const lang of targetLanguages) {
      const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === lang);
      if (!langInfo) continue;

      for (const tc of testCasesQuery.rows) {
        // Translate the test scenario
        const translateResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: `Translate the following test scenario to ${langInfo.name}. Keep the intent and meaning identical. Return only the translated text.` },
            { role: 'user', content: tc.scenario || tc.description || '' }
          ],
          temperature: 0.2,
        });

        const translatedScenario = translateResponse.choices[0]?.message?.content || '';

        // Translate expected outcomes
        let translatedExpected = '';
        if (tc.expected_outcome) {
          const expectedResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: `Translate to ${langInfo.name}. Keep intent identical. Return only translated text.` },
              { role: 'user', content: tc.expected_outcome }
            ],
            temperature: 0.2,
          });
          translatedExpected = expectedResponse.choices[0]?.message?.content || '';
        }

        results.push({
          originalTestCaseId: tc.id,
          language: lang,
          languageName: langInfo.name,
          originalScenario: tc.scenario || tc.description,
          translatedScenario,
          originalExpected: tc.expected_outcome,
          translatedExpected,
        });
      }
    }

    res.json({ success: true, translations: results, totalTranslations: results.length });
  } catch (error: any) {
    logger.error(`[MultiLang] Error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Detect code-switching in a transcript
 */
router.post('/detect-code-switching', async (req: Request, res: Response) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ success: false, error: 'transcript is required' });

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Analyze this transcript for code-switching (switching between languages mid-conversation).
Return JSON: { "detected": true/false, "languages": ["lang1", "lang2"], "instances": [{"text": "example", "from": "lang", "to": "lang", "turnIndex": N}], "consistency": "high|medium|low" }`
        },
        { role: 'user', content: transcript }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"detected":false}');
    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error(`[MultiLang] Code-switch detection error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
