/**
 * Archetype-based test case generator (Layer 2 of the two-layer flow).
 *
 * Pipeline:
 *  1. Take a list of archetype IDs (default = full catalog).
 *  2. Make ONE LLM call that fills slots for ALL archetypes at once.
 *  3. Substitute filled slots into the deterministic templates.
 *  4. Return GeneratedTestCase[] in the EXACT same shape as the existing
 *     ai-only generator service, so the caller code path is identical.
 *
 * Design properties:
 *  - The LLM never decides the test category, key_topic, priority, persona,
 *    or scoring rubric. Those come from the archetype definition.
 *  - If the LLM call fails or returns malformed JSON, we fall back to
 *    generic slot values so the archetype still produces a runnable test.
 *  - Token use is small: slot-filling per archetype is typically < 80 tokens.
 */

import OpenAI from 'openai';
import { config } from '../config';
import {
  TEST_ARCHETYPES,
  ArchetypeDefinition,
  ArchetypeSlot,
  findArchetype,
} from '../data/test-archetypes';

export interface ArchetypeGeneratedTestCase {
  id: string;
  archetype_id: string;
  name: string;
  scenario: string;
  category: string;
  keyTopic: string;
  expectedOutcome: string;
  priority: 'high' | 'medium' | 'low';
  persona_type?: string;
  behavior_modifiers?: string[];
  is_security_test?: boolean;
  security_test_type?: string;
}

export interface ArchetypeGenerationResult {
  archetypesUsed: string[];
  testCases: ArchetypeGeneratedTestCase[];
}

/** Generic fallback values used when the LLM call fails. */
const FALLBACK_SLOTS: Record<ArchetypeSlot, string> = {
  topic_noun: 'request',
  valid_value_example: 'a normal valid input',
  invalid_value: 'an obviously invalid value',
  opening_user_turn: 'Hi, I need some help.',
  mid_flow_user_turn: 'Actually, can we change that?',
  distractor_question: 'By the way, what time is it in Tokyo right now?',
  second_intent: 'and also, can you cancel my last order?',
};

export class ArchetypeTestCaseGeneratorService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      organization: config.openai.orgId,
    });
  }

  /**
   * Main entry. Generates one test case per requested archetype.
   *
   * @param agentName  Used only as context for the LLM.
   * @param agentPrompt  Agent system prompt - given to the LLM as context.
   * @param archetypeIds  Subset of archetypes to use. Defaults to full catalog.
   */
  async generateFromArchetypes(
    agentName: string,
    agentPrompt: string,
    archetypeIds?: string[],
  ): Promise<ArchetypeGenerationResult> {
    const requested =
      archetypeIds && archetypeIds.length > 0
        ? (archetypeIds
            .map((id) => findArchetype(id))
            .filter(Boolean) as ArchetypeDefinition[])
        : TEST_ARCHETYPES;

    if (requested.length === 0) {
      return { archetypesUsed: [], testCases: [] };
    }

    const slotsByArchetype = await this.fillSlotsForAll(
      agentName,
      agentPrompt,
      requested,
    );

    const now = Date.now();
    const testCases: ArchetypeGeneratedTestCase[] = requested.map(
      (arch, idx) => {
        const filled = slotsByArchetype[arch.id] || {};
        const scenario = this.substitute(arch.scenario_template, arch, filled);
        const expectedOutcome = this.substitute(
          arch.expected_behavior_template,
          arch,
          filled,
        );
        return {
          id: `tc-arch-${now}-${idx}`,
          archetype_id: arch.id,
          name: this.buildName(arch, filled),
          scenario,
          category: arch.category,
          keyTopic: arch.key_topic,
          expectedOutcome,
          priority: arch.priority,
          persona_type: arch.persona_type,
          behavior_modifiers: arch.behavior_modifiers,
          is_security_test: arch.is_security_test,
          security_test_type: arch.security_test_type,
        };
      },
    );

    return {
      archetypesUsed: requested.map((a) => a.id),
      testCases,
    };
  }

  /**
   * Single LLM call that returns a map of archetype_id -> filled slot values.
   * On any failure (network, parse, schema mismatch) we return {} and the
   * caller substitutes FALLBACK_SLOTS.
   */
  private async fillSlotsForAll(
    agentName: string,
    agentPrompt: string,
    archetypes: ArchetypeDefinition[],
  ): Promise<Record<string, Partial<Record<ArchetypeSlot, string>>>> {
    const schema = archetypes
      .map((a) => {
        const slots = a.required_slots.length
          ? a.required_slots.join(', ')
          : '(no slots required)';
        return `- ${a.id} (${a.label}): slots = [${slots}]`;
      })
      .join('\n');

    const systemPrompt =
      'You are filling in domain-specific values for pre-defined test case archetypes. ' +
      'You do NOT choose categories, scoring, or test types - those are fixed. ' +
      'You ONLY produce short, realistic strings for the requested slots, grounded in the agent below. ' +
      'Return STRICT JSON: { "<archetype_id>": { "<slot>": "<value>", ... }, ... }. ' +
      'Each value is a short natural string (max ~25 words). No code fences, no commentary.';

    const userPrompt =
      `Agent name: ${agentName}\n\n` +
      `Agent system prompt:\n${agentPrompt || '(none)'}\n\n` +
      `Archetypes and required slots:\n${schema}\n\n` +
      `Slot meanings:\n` +
      `- topic_noun: a domain noun the agent handles (e.g. "booking", "appointment", "order", "support ticket")\n` +
      `- valid_value_example: a realistic valid value a caller would provide\n` +
      `- invalid_value: a clearly invalid value of the same shape (e.g. "Feb 31st", a number where text is needed)\n` +
      `- opening_user_turn: a realistic first thing the caller says (one sentence)\n` +
      `- mid_flow_user_turn: a realistic mid-conversation user line\n` +
      `- distractor_question: an out-of-scope question the caller might try\n` +
      `- second_intent: a competing intent (different from opening_user_turn) packed into the same turn\n\n` +
      `Respond with ONLY the JSON object.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5,
        response_format: { type: 'json_object' },
      });
      const raw = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, Partial<Record<ArchetypeSlot, string>>>;
      }
      return {};
    } catch (_err) {
      // Swallow - caller falls back to FALLBACK_SLOTS.
      return {};
    }
  }

  /**
   * Substitute {{slot}} tokens in the template. Missing slots fall back to
   * the generic FALLBACK_SLOTS so a template never renders with raw braces.
   */
  private substitute(
    template: string,
    arch: ArchetypeDefinition,
    filled: Partial<Record<ArchetypeSlot, string>>,
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, slot: string) => {
      const key = slot as ArchetypeSlot;
      const value =
        (filled[key] && String(filled[key]).trim()) ||
        FALLBACK_SLOTS[key] ||
        slot;
      return value;
    });
  }

  /** Build a readable test case name: "<label> - <topic if present>". */
  private buildName(
    arch: ArchetypeDefinition,
    filled: Partial<Record<ArchetypeSlot, string>>,
  ): string {
    const topic = filled.topic_noun || '';
    return topic ? `${arch.label} (${topic})` : arch.label;
  }
}

export const archetypeTestCaseGeneratorService =
  new ArchetypeTestCaseGeneratorService();
