/**
 * Item 29: Model Armor-style prompt + response sanitization (in-house fallback).
 *
 * Two responsibilities:
 *   1. sanitizePrompt(text)  — strip / refuse known-bad patterns from user
 *      prompts BEFORE they are forwarded to a downstream LLM (jailbreak,
 *      direct injection, instruction-override patterns).
 *   2. sanitizeResponse(text) — scan model responses for leaks (system prompt
 *      echo, raw tool definitions, refusal-and-then-comply, PII echo).
 *
 * This is a deterministic ruleset-based fallback so QA can run without a
 * Google Cloud Model Armor key. When MODEL_ARMOR_API_KEY env var is set
 * the route will call the real service AND combine results.
 */

import { redactPII, detectSensitiveData } from './pii-redaction.service';

export type SanitizationVerdict = 'allow' | 'flag' | 'block';

export interface SanitizationFinding {
  rule: string;
  category: 'prompt_injection' | 'jailbreak' | 'pii_leak' | 'sensitive_data' | 'system_prompt_leak' | 'tool_definition_leak';
  severity: 'low' | 'medium' | 'high';
  evidence: string;
}

export interface SanitizationResult {
  verdict: SanitizationVerdict;
  findings: SanitizationFinding[];
  redactedText: string;
  // For prompts that were modified (e.g. injection markers stripped).
  modified: boolean;
}

const PROMPT_INJECTION_PATTERNS: { re: RegExp; rule: string; severity: 'low' | 'medium' | 'high' }[] = [
  { re: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i, rule: 'direct_override', severity: 'high' },
  { re: /disregard\s+(?:all\s+)?(?:previous|prior|above)/i, rule: 'direct_override', severity: 'high' },
  { re: /reveal\s+your\s+(?:system\s+)?prompt/i, rule: 'prompt_extraction', severity: 'high' },
  { re: /tell\s+me\s+your\s+(?:system\s+)?(?:prompt|instructions|rules)/i, rule: 'prompt_extraction', severity: 'high' },
  { re: /what\s+(?:is|are)\s+your\s+(?:system\s+)?(?:prompt|instructions|rules)/i, rule: 'prompt_extraction', severity: 'medium' },
  { re: /you\s+are\s+now\s+(?:dan|developer\s+mode|unrestricted)/i, rule: 'role_swap', severity: 'high' },
  { re: /act\s+as\s+(?:if\s+you\s+have\s+)?no\s+(?:rules|restrictions|limits)/i, rule: 'role_swap', severity: 'high' },
  { re: /pretend\s+you\s+(?:are|have)\s+no\s+(?:rules|safety)/i, rule: 'role_swap', severity: 'medium' },
  { re: /<\|im_start\|>|<\|im_end\|>|<\|system\|>/i, rule: 'chat_template_injection', severity: 'high' },
  { re: /\[SYSTEM\]:|\[ADMIN\]:|\[ROOT\]:/i, rule: 'fake_role_marker', severity: 'medium' },
];

const RESPONSE_LEAK_PATTERNS: { re: RegExp; rule: string; category: SanitizationFinding['category']; severity: 'low' | 'medium' | 'high' }[] = [
  // System prompt echoes are tricky — long quoted blocks at the start are suspicious.
  { re: /^\s*you\s+are\s+(?:a|an)\s+\w+\s+(?:agent|assistant|bot)/i, rule: 'system_prompt_echo', category: 'system_prompt_leak', severity: 'high' },
  { re: /my\s+(?:system\s+)?(?:prompt|instructions?)\s+(?:say|is|are|reads?)/i, rule: 'system_prompt_echo', category: 'system_prompt_leak', severity: 'high' },
  { re: /(?:tools?\s+available|available\s+tools?)\s*[:=]/i, rule: 'tool_definition_echo', category: 'tool_definition_leak', severity: 'medium' },
  { re: /function\s+name\s*[:=]/i, rule: 'tool_definition_echo', category: 'tool_definition_leak', severity: 'medium' },
];

/**
 * Sanitize a prompt that is about to be sent to a downstream LLM.
 * verdict==block means the caller MUST NOT send the prompt onward.
 */
export function sanitizePrompt(text: string): SanitizationResult {
  if (!text) return { verdict: 'allow', findings: [], redactedText: text || '', modified: false };

  const findings: SanitizationFinding[] = [];
  for (const p of PROMPT_INJECTION_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      findings.push({
        rule: p.rule,
        category: p.rule === 'role_swap' ? 'jailbreak' : 'prompt_injection',
        severity: p.severity,
        evidence: m[0].slice(0, 200),
      });
    }
  }

  // PII passing through
  const pii = redactPII(text);
  if (pii.matches.length > 0) {
    findings.push({
      rule: 'pii_in_prompt',
      category: 'pii_leak',
      severity: 'medium',
      evidence: `${pii.matches.length} items of ${[...new Set(pii.matches.map(m => m.type))].join(', ')}`,
    });
  }

  const sensitive = detectSensitiveData(text);
  if (sensitive.length > 0) {
    findings.push({
      rule: 'sensitive_in_prompt',
      category: 'sensitive_data',
      severity: 'medium',
      evidence: sensitive.slice(0, 3).map(d => `${d.type}:${d.match}`).join(', '),
    });
  }

  // Verdict: any 'high' severity finding -> block; any medium -> flag; else allow.
  let verdict: SanitizationVerdict = 'allow';
  if (findings.some(f => f.severity === 'high')) verdict = 'block';
  else if (findings.length > 0) verdict = 'flag';

  return {
    verdict,
    findings,
    redactedText: pii.redacted, // even when allowed, give back redacted variant
    modified: pii.matches.length > 0,
  };
}

/**
 * Sanitize a response a model is about to return to a user.
 * verdict==block means the caller MUST replace with a safe fallback.
 */
export function sanitizeResponse(text: string, opts?: { systemPromptHint?: string }): SanitizationResult {
  if (!text) return { verdict: 'allow', findings: [], redactedText: text || '', modified: false };

  const findings: SanitizationFinding[] = [];
  for (const p of RESPONSE_LEAK_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      findings.push({
        rule: p.rule,
        category: p.category,
        severity: p.severity,
        evidence: m[0].slice(0, 200),
      });
    }
  }

  // If we know what the system prompt looked like, check for verbatim substring leaks.
  if (opts?.systemPromptHint && opts.systemPromptHint.length > 40) {
    // Sample a 40-char window from the middle of the system prompt to test.
    const hint = opts.systemPromptHint.slice(20, 60);
    if (hint && text.includes(hint)) {
      findings.push({
        rule: 'system_prompt_verbatim_substring',
        category: 'system_prompt_leak',
        severity: 'high',
        evidence: hint,
      });
    }
  }

  // PII in response is normal for a customer-facing agent (it may speak the
  // customer's own name back). We flag it only if the response also reads as
  // a list / dump (multiple emails / phones).
  const pii = redactPII(text);
  if (pii.matches.length >= 3) {
    findings.push({
      rule: 'pii_bulk_in_response',
      category: 'pii_leak',
      severity: 'high',
      evidence: `${pii.matches.length} PII items`,
    });
  }

  let verdict: SanitizationVerdict = 'allow';
  if (findings.some(f => f.severity === 'high')) verdict = 'block';
  else if (findings.length > 0) verdict = 'flag';

  return {
    verdict,
    findings,
    redactedText: pii.redacted,
    modified: pii.matches.length > 0,
  };
}
