/**
 * PII Redaction + Sensitive Data Detection (Items 26 & 28).
 *
 * Purpose:
 *   - Item 26: redact PII from transcripts BEFORE we send them to third-party
 *     LLM APIs (OpenAI) for evaluation / re-evaluation. The original text is
 *     never persisted in the redacted form; we only redact the *copy* sent
 *     over the wire.
 *   - Item 28: detect medical / PCI / sensitive data in caller turns so the
 *     evaluator can flag the agent if it echoed or processed such content.
 *
 * The function is deterministic and uses regex only — no extra LLM cost.
 * It is intentionally conservative: false positives in redaction are cheaper
 * than leaking PII. False negatives are addressed by also running the LLM
 * judge over the (already-redacted) transcript.
 */

export type PIIType =
  | 'email'
  | 'phone'
  | 'credit_card'
  | 'ssn'
  | 'iban'
  | 'ip_address'
  | 'date_of_birth';

export type SensitiveDataType =
  | 'medical_condition'
  | 'medication'
  | 'pci_card_number'
  | 'pci_cvv'
  | 'pci_expiry'
  | 'biometric_reference';

export interface RedactionMatch {
  type: PIIType;
  original: string;
  placeholder: string;
  start: number;
  end: number;
}

export interface SensitiveMatch {
  type: SensitiveDataType;
  match: string;
  start: number;
  end: number;
  // Whose turn the match was found in, if turn-level redaction is used.
  speaker?: 'agent' | 'caller' | 'unknown';
}

export interface RedactionResult {
  redacted: string;
  matches: RedactionMatch[];
  // map from placeholder -> original (used to re-inject after the LLM call,
  // never persisted to disk).
  reverse: Map<string, string>;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164-ish: optional +, 7-15 digits, allowing separators
const PHONE_RE = /\b(?:\+?\d{1,3}[\s\-.]?)?(?:\(?\d{2,4}\)?[\s\-.]?){2,4}\d{2,4}\b/g;
// 13-19 digits allowing spaces or dashes — restrict to typical card lengths
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
// US-style SSN
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// IBAN-ish (loose)
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// dd/mm/yyyy or yyyy-mm-dd dates close to "born" / "birth"
const DOB_RE = /\b(?:born\s+on\s+|date\s+of\s+birth[\s:]*|dob[\s:]*)(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/gi;

// Item 28 — medical / pharmaceutical mention list (conservative; uses
// dictionary + simple cues so we are explainable / auditable).
const MEDICAL_CUES = [
  'diabetes', 'hypertension', 'cancer', 'tumor', 'hiv', 'aids', 'pregnan',
  'depression', 'anxiety', 'bipolar', 'schizophren', 'autism', 'adhd',
  'asthma', 'epilep', 'covid', 'tuberculosis', 'arthritis', 'alzheimer',
  'dementia', 'parkinson', 'stroke',
];
const MEDICATION_CUES = [
  'insulin', 'metformin', 'aspirin', 'ibuprofen', 'paracetamol', 'amoxicillin',
  'prozac', 'xanax', 'adderall', 'oxycodone', 'morphine', 'codeine',
  'methadone', 'fentanyl', 'warfarin', 'lisinopril', 'atorvastatin',
];
const PCI_CVV_RE = /\b(?:cvv|cvc|security\s+code)[\s:]*\d{3,4}\b/gi;
const PCI_EXPIRY_RE = /\b(?:exp(?:iry)?|expires?)[\s:]*\d{1,2}\s*[\/\-]\s*\d{2,4}\b/gi;

function redactWithRegex(
  text: string,
  re: RegExp,
  type: PIIType,
  result: RedactionMatch[],
): void {
  let match: RegExpExecArray | null;
  // Reset lastIndex if RegExp is global.
  if (re.global) re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    result.push({
      type,
      original: match[0],
      placeholder: `[${type.toUpperCase()}_${result.length}]`,
      start: match.index,
      end: match.index + match[0].length,
    });
    if (!re.global) break;
  }
}

/**
 * Redact PII from text. Returns the redacted text + a reverse map.
 * The reverse map MUST NOT be persisted to disk — it is meant for
 * re-injecting placeholders in the LLM's response only.
 */
export function redactPII(text: string): RedactionResult {
  if (!text || typeof text !== 'string') {
    return { redacted: text || '', matches: [], reverse: new Map() };
  }

  const matches: RedactionMatch[] = [];

  // Order matters: redact the most-specific patterns first so a card number
  // isn't partially eaten by the generic phone matcher.
  redactWithRegex(text, EMAIL_RE, 'email', matches);
  redactWithRegex(text, CARD_RE, 'credit_card', matches);
  redactWithRegex(text, SSN_RE, 'ssn', matches);
  redactWithRegex(text, IBAN_RE, 'iban', matches);
  redactWithRegex(text, IP_RE, 'ip_address', matches);
  redactWithRegex(text, DOB_RE, 'date_of_birth', matches);
  redactWithRegex(text, PHONE_RE, 'phone', matches);

  // Sort matches by start desc so we can splice without recomputing offsets.
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let redacted = text;
  const reverse = new Map<string, string>();
  for (const m of sorted) {
    redacted = redacted.slice(0, m.start) + m.placeholder + redacted.slice(m.end);
    reverse.set(m.placeholder, m.original);
  }

  return { redacted, matches: matches.sort((a, b) => a.start - b.start), reverse };
}

/**
 * Item 28: detect medical / PCI / sensitive content. Detection only — does
 * NOT redact (because the evaluator needs to see WHAT was said to decide
 * whether the agent mishandled it).
 */
export function detectSensitiveData(text: string): SensitiveMatch[] {
  if (!text || typeof text !== 'string') return [];
  const matches: SensitiveMatch[] = [];
  const lower = text.toLowerCase();

  for (const cue of MEDICAL_CUES) {
    let idx = lower.indexOf(cue);
    while (idx !== -1) {
      matches.push({ type: 'medical_condition', match: text.slice(idx, idx + cue.length), start: idx, end: idx + cue.length });
      idx = lower.indexOf(cue, idx + cue.length);
    }
  }

  for (const cue of MEDICATION_CUES) {
    let idx = lower.indexOf(cue);
    while (idx !== -1) {
      matches.push({ type: 'medication', match: text.slice(idx, idx + cue.length), start: idx, end: idx + cue.length });
      idx = lower.indexOf(cue, idx + cue.length);
    }
  }

  // PCI: card number anywhere (also caught by CARD_RE in redactPII; here we
  // flag it as sensitive for the evaluator).
  CARD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_RE.exec(text)) !== null) {
    matches.push({ type: 'pci_card_number', match: m[0], start: m.index, end: m.index + m[0].length });
  }

  PCI_CVV_RE.lastIndex = 0;
  while ((m = PCI_CVV_RE.exec(text)) !== null) {
    matches.push({ type: 'pci_cvv', match: m[0], start: m.index, end: m.index + m[0].length });
  }

  PCI_EXPIRY_RE.lastIndex = 0;
  while ((m = PCI_EXPIRY_RE.exec(text)) !== null) {
    matches.push({ type: 'pci_expiry', match: m[0], start: m.index, end: m.index + m[0].length });
  }

  return matches.sort((a, b) => a.start - b.start);
}

/**
 * Convenience wrapper: redact a list of conversation turns. Returns a new
 * array of turns with `content` redacted, plus an overall reverse map.
 */
export function redactConversationTurns<T extends { content: string }>(
  turns: T[],
): { turns: T[]; reverse: Map<string, string> } {
  const reverse = new Map<string, string>();
  const out = turns.map((t, i) => {
    const r = redactPII(t.content || '');
    for (const [k, v] of r.reverse) reverse.set(`${k}_t${i}`, v);
    return { ...t, content: r.redacted };
  });
  return { turns: out, reverse };
}

/**
 * Re-inject placeholders in an LLM response so downstream consumers see the
 * original text. Use ONLY for responses where the LLM might quote back
 * caller-supplied text verbatim (e.g. reevaluation reasoning that quotes
 * a customer turn).
 */
export function reinjectPII(text: string, reverse: Map<string, string>): string {
  let out = text;
  for (const [placeholder, original] of reverse) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

/**
 * Aggregate flags suitable for storing in metrics JSONB.
 */
export interface SensitiveDataFlags {
  hasMedicalContent: boolean;
  hasPCIContent: boolean;
  medicalCount: number;
  pciCount: number;
  // sample of up to 5 matches so the UI can show what triggered the flag
  samples: { type: SensitiveDataType; match: string }[];
}

export function buildSensitiveFlags(detections: SensitiveMatch[]): SensitiveDataFlags {
  const medical = detections.filter(d => d.type === 'medical_condition' || d.type === 'medication');
  const pci = detections.filter(d => d.type.startsWith('pci_') || d.type === 'pci_card_number');
  return {
    hasMedicalContent: medical.length > 0,
    hasPCIContent: pci.length > 0,
    medicalCount: medical.length,
    pciCount: pci.length,
    samples: [...medical, ...pci].slice(0, 5).map(d => ({ type: d.type, match: d.match })),
  };
}
