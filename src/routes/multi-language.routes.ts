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

/**
 * Item 15 (pronunciation): compare a target phrase against what the agent
 * actually said and flag potential pronunciation / spelling drift. Uses an
 * LLM judge because phoneme libraries are heavy and we want explainable
 * findings.
 */
router.post('/analyze-pronunciation', async (req: Request, res: Response) => {
  try {
    const { spokenText, expectedPhrases, language } = req.body || {};
    if (!spokenText || !Array.isArray(expectedPhrases) || expectedPhrases.length === 0) {
      return res.status(400).json({ success: false, error: 'spokenText and expectedPhrases[] are required' });
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const lang = SUPPORTED_LANGUAGES.find(l => l.code === language)?.name || 'English';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a linguistic QA judge. The agent was supposed to say (or correctly handle) the following phrases in ${lang}. The transcript captures what was actually spoken (already passed through STT, so some letters may be slightly wrong).

For each expected phrase, determine:
- found: did the phrase (or a close variant) appear in the spoken text?
- exact_match: did it appear letter-for-letter?
- variant: if not exact, what was actually said?
- likely_cause: if there's drift, is it 'pronunciation_drift', 'stt_error', 'agent_paraphrased', or 'missing'?
- severity: 'low' (cosmetic), 'medium' (understandable but inaccurate), 'high' (incorrect or misleading).

Return JSON: { "findings": [...], "overallScore": 0-100 }`,
        },
        {
          role: 'user',
          content: `SPOKEN TEXT:\n${spokenText}\n\nEXPECTED PHRASES:\n${expectedPhrases.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}`,
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"findings":[],"overallScore":0}');
    res.json({ success: true, language: lang, ...result });
  } catch (err: any) {
    logger.error(`[MultiLang] pronunciation error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
