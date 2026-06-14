/**
 * Data Capture Validation Service (deterministic)
 *
 * Compares what the user said vs what the agent confirmed back for
 * structured values (phone, date/time, currency, card, email, OTP, etc).
 *
 * No LLM - pure deterministic string extraction so values are always
 * grounded in the transcript and never hallucinated.
 *
 * Pipeline:
 *   1. AUDIO INPUT      = user turn verbatim
 *   2. ASR CAPTURE      = digit-normalised form of (1)
 *   3. LLM CONFIRMATION = digit-normalised form of agent's read-back
 *
 * Mismatch = (2) != (3) after normalisation.
 */

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
  fieldLabel: string;
  userSaid: string;
  asrCaptured: string;
  agentConfirmed: string;
  match: boolean;
  severity: 'critical' | 'major' | 'minor';
  userTurnIndex?: number;
  agentTurnIndex?: number;
  explanation: string;
}

export interface DataCaptureReport {
  fields: DataCaptureMismatch[];
  totalChecked: number;
  mismatchCount: number;
  validationScore: number;
}

interface Turn { role: string; content: string }

/* ------------------- digit expansion ------------------- */

const DIGITS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

/** Expand "triple X" / "double X" / spoken digit words into a digit string. */
function expandSpokenToDigits(text: string): string {
  if (!text) return '';
  let s = text.toLowerCase();
  // triple X
  s = s.replace(/\b(triple|treble)[\s-]+(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_m, _q, w) => (DIGITS[w] || '').repeat(3));
  // double X
  s = s.replace(/\b(double)[\s-]+(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_m, _q, w) => (DIGITS[w] || '').repeat(2));
  // word digits
  s = s.replace(/\b(zero|oh|nought|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (m) => DIGITS[m] || '');
  return s;
}

/** Extract all digit runs of length>=minLen. */
function extractDigitRuns(text: string, minLen = 4): string[] {
  const expanded = expandSpokenToDigits(text);
  const digitsOnly = expanded.replace(/[^\d\s]/g, ' ').replace(/\s+/g, ' ');
  // Collapse runs of "digit (whitespace digit)+" into a single number.
  // Repeating replace handles >2 spaced digits in a row.
  let compact = digitsOnly;
  let prev = '';
  while (prev !== compact) {
    prev = compact;
    compact = compact.replace(/(\d)\s+(\d)/g, '$1$2');
  }
  const runs: string[] = [];
  const re = /\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(compact))) {
    if (m[0].length >= minLen) runs.push(m[0]);
  }
  return runs;
}

function pickClosest(target: string, candidates: string[]): { value: string; distance: number } | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDist = levenshtein(target, best);
  for (let i = 1; i < candidates.length; i++) {
    const d = levenshtein(target, candidates[i]);
    if (d < bestDist) { best = candidates[i]; bestDist = d; }
  }
  return { value: best, distance: bestDist };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/* ------------------- field-specific extractors ------------------- */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/i;
const CURRENCY_RE = /(?:[$€£₹¥]\s*[\d,]+(?:\.\d+)?|\b[\d,]+(?:\.\d+)?\s*(?:dollars?|rupees?|usd|inr|rs|lakh|crore|million|billion|k)\b)/i;
const DATE_RE = /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?)\b/i;
const TIME_RE = /\b(?:\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)\b/i;

function classifyDigitRun(run: string, context: string): { type: FieldType; label: string; severity: 'critical' | 'major' | 'minor' } {
  const ctx = context.toLowerCase();
  if (/email/.test(ctx)) return { type: 'email', label: 'Email address', severity: 'critical' };
  if (/(card|cvv|cvc|expir)/.test(ctx)) return { type: 'card', label: 'Card number', severity: 'critical' };
  if (/(otp|verification|pin|code)/.test(ctx)) return { type: 'otp', label: 'OTP / verification code', severity: 'critical' };
  if (/(phone|mobile|cell|contact number|number to (?:reach|call))/.test(ctx)) return { type: 'phone', label: 'Customer phone number', severity: 'critical' };
  if (run.length >= 13 && run.length <= 19) return { type: 'card', label: 'Card number', severity: 'critical' };
  if (run.length >= 7 && run.length <= 15) return { type: 'phone', label: 'Phone number', severity: 'critical' };
  return { type: 'numeric', label: 'Numeric value', severity: 'minor' };
}

/* ------------------- main validator ------------------- */

const READBACK_WINDOW = 4;
const MATCH_TOLERANCE = 0; // exact match required for digit strings

export async function validateDataCapture(transcript: Turn[]): Promise<DataCaptureReport> {
  const fields: DataCaptureMismatch[] = [];
  if (!transcript || transcript.length === 0) {
    return { fields, totalChecked: 0, mismatchCount: 0, validationScore: 100 };
  }

  // Track which user-turn:value pairs we've already evaluated
  const seen = new Set<string>();

  for (let i = 0; i < transcript.length; i++) {
    const turn = transcript[i];
    if (turn.role !== 'user') continue;
    const userText = turn.content || '';
    if (!userText.trim()) continue;

    // Build the agent-context "what was asked just before" to help label fields
    const prevAgent = transcript.slice(Math.max(0, i - 2), i)
      .filter(t => t.role === 'agent')
      .map(t => t.content).join(' ');

    /* ----- numeric / phone / card / otp ----- */
    const userDigitRuns = extractDigitRuns(userText, 4);
    for (const run of userDigitRuns) {
      const key = `${i}:${run}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Look ahead for an agent read-back
      let agentTurnIdx: number | undefined;
      let agentValue = '';
      let bestDist = Infinity;
      for (let j = i + 1; j < Math.min(transcript.length, i + 1 + READBACK_WINDOW); j++) {
        if (transcript[j].role !== 'agent') continue;
        const agentRuns = extractDigitRuns(transcript[j].content || '', Math.max(4, run.length - 2));
        // Restrict to runs of similar length (within +/-2 of user value)
        const similar = agentRuns.filter(r => Math.abs(r.length - run.length) <= 2);
        const pick = pickClosest(run, similar);
        if (pick && pick.distance < bestDist) {
          bestDist = pick.distance;
          agentValue = pick.value;
          agentTurnIdx = j;
        }
      }

      // No read-back in window -> skip (only flag when we have a comparison)
      if (!agentValue) continue;

      const cls = classifyDigitRun(run, prevAgent + ' ' + userText);
      const match = bestDist <= MATCH_TOLERANCE;
      fields.push({
        fieldType: cls.type,
        fieldLabel: cls.label,
        userSaid: userText.trim(),
        asrCaptured: run,
        agentConfirmed: agentValue,
        match,
        severity: match ? 'minor' : cls.severity,
        userTurnIndex: i,
        agentTurnIndex: agentTurnIdx,
        explanation: match
          ? 'Agent read back the value correctly.'
          : `Mismatch: agent confirmed "${agentValue}" but user said "${run}" (edit distance ${bestDist}).`,
      });
    }

    /* ----- email ----- */
    const emailMatch = userText.match(EMAIL_RE);
    if (emailMatch) {
      const userEmail = emailMatch[0].toLowerCase();
      const key = `${i}:email:${userEmail}`;
      if (!seen.has(key)) {
        seen.add(key);
        let agentEmail = '';
        let agentTurnIdx: number | undefined;
        for (let j = i + 1; j < Math.min(transcript.length, i + 1 + READBACK_WINDOW); j++) {
          if (transcript[j].role !== 'agent') continue;
          const m = transcript[j].content?.match(EMAIL_RE);
          if (m) { agentEmail = m[0].toLowerCase(); agentTurnIdx = j; break; }
        }
        if (agentEmail) {
          const match = userEmail === agentEmail;
          fields.push({
            fieldType: 'email',
            fieldLabel: 'Email address',
            userSaid: userText.trim(),
            asrCaptured: userEmail,
            agentConfirmed: agentEmail,
            match,
            severity: match ? 'minor' : 'critical',
            userTurnIndex: i,
            agentTurnIndex: agentTurnIdx,
            explanation: match ? 'Agent confirmed the email correctly.' : 'Agent confirmed a different email address.',
          });
        }
      }
    }

    /* ----- currency / budget ----- */
    const currMatch = userText.match(CURRENCY_RE);
    if (currMatch) {
      const key = `${i}:curr:${currMatch[0]}`;
      if (!seen.has(key)) {
        seen.add(key);
        let agentCurr = '';
        let agentTurnIdx: number | undefined;
        for (let j = i + 1; j < Math.min(transcript.length, i + 1 + READBACK_WINDOW); j++) {
          if (transcript[j].role !== 'agent') continue;
          const m = transcript[j].content?.match(CURRENCY_RE);
          if (m) { agentCurr = m[0]; agentTurnIdx = j; break; }
        }
        if (agentCurr) {
          // Compare normalised numeric portion
          const userNum = (currMatch[0].match(/[\d,]+(?:\.\d+)?/) || [''])[0].replace(/,/g, '');
          const agentNum = (agentCurr.match(/[\d,]+(?:\.\d+)?/) || [''])[0].replace(/,/g, '');
          const match = !!userNum && userNum === agentNum;
          fields.push({
            fieldType: 'currency',
            fieldLabel: 'Currency amount',
            userSaid: userText.trim(),
            asrCaptured: currMatch[0],
            agentConfirmed: agentCurr,
            match,
            severity: match ? 'minor' : 'major',
            userTurnIndex: i,
            agentTurnIndex: agentTurnIdx,
            explanation: match ? 'Agent confirmed the amount correctly.' : `Agent confirmed "${agentNum}" but user said "${userNum}".`,
          });
        }
      }
    }

    /* ----- date / time ----- */
    for (const [re, type, label] of [
      [DATE_RE, 'date', 'Date'] as const,
      [TIME_RE, 'time', 'Time'] as const,
    ]) {
      const m = userText.match(re);
      if (!m) continue;
      const key = `${i}:${type}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let agentVal = '';
      let agentTurnIdx: number | undefined;
      for (let j = i + 1; j < Math.min(transcript.length, i + 1 + READBACK_WINDOW); j++) {
        if (transcript[j].role !== 'agent') continue;
        const mm = transcript[j].content?.match(re);
        if (mm) { agentVal = mm[0]; agentTurnIdx = j; break; }
      }
      if (agentVal) {
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[,.]/g, '');
        const match = norm(m[0]) === norm(agentVal);
        fields.push({
          fieldType: type as FieldType,
          fieldLabel: label,
          userSaid: userText.trim(),
          asrCaptured: m[0],
          agentConfirmed: agentVal,
          match,
          severity: match ? 'minor' : 'major',
          userTurnIndex: i,
          agentTurnIndex: agentTurnIdx,
          explanation: match ? `Agent confirmed the ${type} correctly.` : `Agent confirmed a different ${type}.`,
        });
      }
    }
  }

  const mismatchCount = fields.filter(f => !f.match).length;
  const totalChecked = fields.length;
  const validationScore = totalChecked > 0
    ? Math.round(((totalChecked - mismatchCount) / totalChecked) * 100)
    : 100;

  return { fields, totalChecked, mismatchCount, validationScore };
}
