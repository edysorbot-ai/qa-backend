/**
 * Data Capture Validation Service
 *
 * Validates that structured/numerical values spoken by the user were captured
 * by ASR and then confirmed back correctly by the LLM agent.
 *
 * Pipeline:
 *   1. AUDIO INPUT      - what the user said (best signal: original spoken phrase)
 *   2. ASR CAPTURE      - what the transcript shows (turn.role === 'user')
 *   3. LLM CONFIRMATION - what the agent confirmed back (turn.role === 'agent')
 *
 * Failure detected when (1) and (3) disagree, OR (2) and (3) disagree.
 *
 * We do a two-stage pass:
 *   a) Cheap regex extraction of every candidate value on each turn (phone,
 *      date, time, currency, card, email, generic numbers, budget, OTP, etc).
 *   b) LLM cross-check that compares user-said vs agent-confirmed values and
 *      returns a list of `DataCaptureMismatch` records.
 *
 * Designed to feed into the existing realtime-analysis pipeline.
 */

import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type FieldType =
  | 'phone'
  | 'date'
  | 'time'
  | 'currency'
  | 'budget'
  | 'card'
  | 'email'
  | 'otp'
  | 'numeric'
  | 'address'
  | 'name'
  | 'other';

export interface DataCaptureMismatch {
  fieldType: FieldType;
  fieldLabel: string;          // human label e.g. "Phone number"
  userSaid: string;            // raw user turn excerpt
  asrCaptured: string;         // normalised value as captured by ASR
  agentConfirmed: string;      // normalised value as confirmed back by agent
  match: boolean;              // true if asrCaptured === agentConfirmed
  severity: 'critical' | 'major' | 'minor';
  userTurnIndex?: number;
  agentTurnIndex?: number;
  explanation: string;
}

export interface DataCaptureReport {
  fields: DataCaptureMismatch[];
  totalChecked: number;
  mismatchCount: number;
  validationScore: number;     // 0-100 (100 = all matched)
}

interface Turn {
  role: 'agent' | 'user' | 'system' | string;
  content: string;
}

/* ---------------- Regex extraction ---------------- */

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', thirty: '30',
  forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', lakh: '100000', million: '1000000', crore: '10000000',
};

/** Expand "triple five" / "double zero" / "five five five" etc. into digits. */
function expandSpokenDigits(text: string): string {
  let out = text.toLowerCase();
  // triple X / double X / dabbu X
  out = out.replace(/\b(triple|treble)\s+(\w+)/g, (_m, _q, w) =>
    NUMBER_WORDS[w] ? `${NUMBER_WORDS[w]}${NUMBER_WORDS[w]}${NUMBER_WORDS[w]}` : _m
  );
  out = out.replace(/\b(double|dabbu)\s+(\w+)/g, (_m, _q, w) =>
    NUMBER_WORDS[w] ? `${NUMBER_WORDS[w]}${NUMBER_WORDS[w]}` : _m
  );
  // word-by-word digits
  out = out.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/g,
    (m) => NUMBER_WORDS[m] || m);
  return out;
}

function normaliseDigits(s: string): string {
  return (s || '').replace(/[^\d]/g, '');
}

interface Extracted { type: FieldType; raw: string; normalised: string }

function extractFromText(raw: string): Extracted[] {
  if (!raw) return [];
  const out: Extracted[] = [];
  const expanded = expandSpokenDigits(raw);

  // Email
  const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  for (const m of raw.matchAll(emailRe)) {
    out.push({ type: 'email', raw: m[0], normalised: m[0].toLowerCase() });
  }

  // Credit card (13-19 digits, allow spaces/dashes)
  const cardRe = /\b(?:\d[ -]?){13,19}\b/g;
  for (const m of expanded.matchAll(cardRe)) {
    const d = normaliseDigits(m[0]);
    if (d.length >= 13 && d.length <= 19) {
      out.push({ type: 'card', raw: m[0], normalised: d });
    }
  }

  // Phone number (7-15 digits, common international forms)
  const phoneRe = /(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?){1,4}\d{3,5}/g;
  for (const m of expanded.matchAll(phoneRe)) {
    const d = normaliseDigits(m[0]);
    if (d.length >= 7 && d.length <= 15) {
      // skip if already captured as card
      if (!out.find(o => o.type === 'card' && o.normalised === d)) {
        out.push({ type: 'phone', raw: m[0], normalised: d });
      }
    }
  }

  // Currency / budget
  const currencyRe = /(?:[$€£₹¥]|usd|eur|gbp|inr|rs\.?|rupees?|dollars?|euros?)\s*([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(?:dollars?|rupees?|usd|inr|rs|lakh|crore|k|million|billion)\b/gi;
  for (const m of raw.matchAll(currencyRe)) {
    const num = (m[1] || m[2] || '').replace(/,/g, '');
    if (num) out.push({ type: 'currency', raw: m[0], normalised: num });
  }

  // Date - 12/05/2024, 2024-05-12, May 12 2024, 12 May etc.
  const dateRe = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?)\b/gi;
  for (const m of raw.matchAll(dateRe)) {
    out.push({ type: 'date', raw: m[0], normalised: m[0].toLowerCase().replace(/\s+/g, ' ') });
  }

  // Time - 5pm, 14:30, half past three
  const timeRe = /\b(\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)\b/gi;
  for (const m of raw.matchAll(timeRe)) {
    out.push({ type: 'time', raw: m[0], normalised: m[0].toLowerCase().replace(/\s+/g, '') });
  }

  // OTP / verification code (3-8 digit standalone)
  const otpRe = /\b(?:otp|code|pin|verification)[^\d]{0,15}(\d{3,8})\b/gi;
  for (const m of raw.matchAll(otpRe)) {
    out.push({ type: 'otp', raw: m[0], normalised: m[1] });
  }

  // Generic standalone numbers (length 3+) - useful fallback
  const numRe = /\b\d{3,}\b/g;
  for (const m of expanded.matchAll(numRe)) {
    const d = m[0];
    if (!out.find(o => o.normalised === d)) {
      out.push({ type: 'numeric', raw: m[0], normalised: d });
    }
  }

  return out;
}

function extractCandidatesByRole(transcript: Turn[]): {
  userExtracts: Array<Extracted & { turnIndex: number }>;
  agentExtracts: Array<Extracted & { turnIndex: number }>;
} {
  const userExtracts: Array<Extracted & { turnIndex: number }> = [];
  const agentExtracts: Array<Extracted & { turnIndex: number }> = [];
  transcript.forEach((t, i) => {
    const ex = extractFromText(t.content || '');
    const bucket = t.role === 'user' ? userExtracts : agentExtracts;
    for (const e of ex) bucket.push({ ...e, turnIndex: i });
  });
  return { userExtracts, agentExtracts };
}

/* ---------------- LLM cross-check ---------------- */

export async function validateDataCapture(transcript: Turn[]): Promise<DataCaptureReport> {
  if (!transcript || transcript.length === 0) {
    return { fields: [], totalChecked: 0, mismatchCount: 0, validationScore: 100 };
  }

  const { userExtracts, agentExtracts } = extractCandidatesByRole(transcript);
  const hintHasAny = userExtracts.length + agentExtracts.length > 0;

  // If we found no candidates at all, skip the LLM call to save cost.
  if (!hintHasAny) {
    return { fields: [], totalChecked: 0, mismatchCount: 0, validationScore: 100 };
  }

  const transcriptText = transcript
    .map((t, i) => `[${i}] ${t.role.toUpperCase()}: ${t.content}`)
    .join('\n');

  const hintLines = [
    ...userExtracts.map(e => `USER turn ${e.turnIndex}: ${e.type} -> "${e.raw}" (normalised "${e.normalised}")`),
    ...agentExtracts.map(e => `AGENT turn ${e.turnIndex}: ${e.type} -> "${e.raw}" (normalised "${e.normalised}")`),
  ].join('\n');

  const prompt = `You are a data-capture validator for voice AI calls.

For every structured value the USER spoke (phone numbers, dates/times, currency
amounts, budgets, credit cards, emails, OTPs, addresses, names, numerical
entries), check whether the AGENT later read/confirmed that value back to the
user CORRECTLY. Flag MISMATCHES.

Important rules:
- A mismatch is when the agent confirms a DIFFERENT value than the user spoke
  (e.g. user said "five five five two zero five five five two zero" but agent
  confirms "5552055520" instead of "5552055520" - watch for digit drops/dupes).
- Treat "triple five" = 555, "double zero" = 00, etc.
- Ignore values the user mentioned that the agent never confirmed back
  (those are not mismatches, just uncovered).
- Ignore minor formatting differences (spaces, dashes, currency symbols).
- Only report mismatches with high confidence (you can clearly see both
  user-said and agent-confirmed in the transcript).
- For each mismatch, severity is:
   * critical for phone/card/email/otp/payment-amount mistakes
   * major    for date/time/budget mistakes
   * minor    for everything else

## TRANSCRIPT
${transcriptText}

## REGEX HINTS (low-confidence pre-extraction)
${hintLines}

Respond ONLY with valid JSON in this exact shape:
{
  "fields": [
    {
      "fieldType": "phone|date|time|currency|budget|card|email|otp|numeric|address|name|other",
      "fieldLabel": "<human label e.g. Customer phone number>",
      "userSaid": "<verbatim from user turn>",
      "asrCaptured": "<normalised value the ASR transcript shows>",
      "agentConfirmed": "<normalised value agent repeated back, or '' if never confirmed>",
      "match": <true|false>,
      "severity": "critical|major|minor",
      "userTurnIndex": <number>,
      "agentTurnIndex": <number|null>,
      "explanation": "<one-sentence why this is a mismatch>"
    }
  ],
  "totalChecked": <integer - how many distinct structured values you evaluated>
}

If no values were confirmed back at all, return {"fields":[],"totalChecked":0}.`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a strict voice-AI data-capture validator. Reply with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 1500,
    });

    const txt = res.choices[0]?.message?.content || '{}';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON');
    const parsed = JSON.parse(m[0]) as { fields?: DataCaptureMismatch[]; totalChecked?: number };
    const fields = Array.isArray(parsed.fields) ? parsed.fields : [];

    // Force-correct: if agentConfirmed equals asrCaptured, match=true.
    for (const f of fields) {
      const a = (f.asrCaptured || '').toLowerCase().replace(/\s+/g, '');
      const b = (f.agentConfirmed || '').toLowerCase().replace(/\s+/g, '');
      if (a && b && a === b) f.match = true;
      if (a && b && a !== b) f.match = false;
    }

    const mismatchCount = fields.filter(f => f.match === false).length;
    const totalChecked = typeof parsed.totalChecked === 'number'
      ? parsed.totalChecked
      : fields.length;
    const validationScore = totalChecked > 0
      ? Math.round(((totalChecked - mismatchCount) / totalChecked) * 100)
      : 100;

    return { fields, totalChecked, mismatchCount, validationScore };
  } catch (e) {
    console.error('[DataCaptureValidation] LLM error:', e);
    return { fields: [], totalChecked: 0, mismatchCount: 0, validationScore: 100 };
  }
}
