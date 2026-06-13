/**
 * Central LLM model identifiers used across services.
 * Override via environment variables to switch models without touching code.
 */

export const LLM_MODELS = {
  CHEAP: process.env.LLM_MODEL_CHEAP || 'gpt-4o-mini',
  DEFAULT: process.env.LLM_MODEL_DEFAULT || 'gpt-4o-mini',
  STRONG: process.env.LLM_MODEL_STRONG || 'gpt-4o',
  REASONING: process.env.LLM_MODEL_REASONING || 'gpt-4o',
  EMBEDDING: process.env.LLM_MODEL_EMBEDDING || 'text-embedding-3-small',
} as const;

export type LlmModelKey = keyof typeof LLM_MODELS;
