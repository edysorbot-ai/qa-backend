/**
 * Test Case Archetypes (Layer 1 of the two-layer test generator).
 *
 * Each archetype is a deterministic, hand-authored skeleton: it defines the
 * test category, key topic, priority, persona/security flags, and a templated
 * expected behavior. The LLM (Layer 2) only fills in domain-specific slots
 * (user utterances, injected invalid values, topic noun, etc.) at runtime.
 *
 * This guarantees coverage is predictable and reproducible: regardless of how
 * creative the LLM is, every generated batch will include the same set of
 * structural test types (interruption, silence, change-of-mind, OOS, etc.).
 *
 * IMPORTANT: This module is additive. The existing AI-only flow in
 * agentController.generateTestCases is untouched.
 */

export type ArchetypeSlot =
  | 'topic_noun'           // a domain noun, e.g. "booking", "appointment", "order"
  | 'valid_value_example'  // a valid example a real user might provide
  | 'invalid_value'        // an obviously invalid value (e.g. "Feb 31st")
  | 'opening_user_turn'    // a realistic opening line from the caller
  | 'mid_flow_user_turn'   // a realistic mid-conversation user turn
  | 'distractor_question'  // an out-of-scope question to attempt
  | 'second_intent';       // a competing intent to inject in same turn

export interface ArchetypeDefinition {
  /** Stable archetype id (kept in DB as part of test case name for traceability). */
  id: string;
  /** Human-readable archetype name (becomes the test_case.name prefix). */
  label: string;
  /** Fixed category column. */
  category: string;
  /** Fixed key_topic column (logical grouping for batching). */
  key_topic: string;
  /** Fixed priority. */
  priority: 'high' | 'medium' | 'low';
  /** Persona type to persist on the test case. */
  persona_type?: string;
  /** Behavior modifier tags. */
  behavior_modifiers?: string[];
  /** Mark as security test (drives security scoring path). */
  is_security_test?: boolean;
  security_test_type?: string;
  /**
   * Templated scenario text. Slots are referenced as {{slot_name}} and
   * will be filled by the LLM in Layer 2.
   */
  scenario_template: string;
  /**
   * Templated expected behavior. Slots are the SAME tokens as the scenario;
   * the LLM is told to use consistent values across both fields.
   */
  expected_behavior_template: string;
  /** Slots that MUST be filled by the LLM. */
  required_slots: ArchetypeSlot[];
}

/**
 * The catalog. Order is preserved when batching so users see a stable list.
 * To add a new archetype, append to this array - no other files need updating.
 */
export const TEST_ARCHETYPES: ArchetypeDefinition[] = [
  {
    id: 'happy_path_minimal',
    label: 'Happy path - minimal viable info',
    category: 'Happy Path',
    key_topic: 'Core Flow',
    priority: 'high',
    persona_type: 'cooperative',
    scenario_template:
      'A cooperative caller asks the agent to help with {{topic_noun}} and provides only the minimum information needed (e.g. "{{opening_user_turn}}"). They answer follow-up questions concisely and accept the first valid option offered.',
    expected_behavior_template:
      'Agent greets, gathers the required fields for {{topic_noun}} in a logical order, confirms the captured values, and completes the flow without asking redundant questions.',
    required_slots: ['topic_noun', 'opening_user_turn'],
  },
  {
    id: 'happy_path_verbose',
    label: 'Happy path - verbose caller',
    category: 'Happy Path',
    key_topic: 'Core Flow',
    priority: 'medium',
    persona_type: 'verbose',
    behavior_modifiers: ['verbose'],
    scenario_template:
      'A verbose, friendly caller opens with a long sentence packing several details at once: "{{opening_user_turn}}". They volunteer information the agent has not asked for yet.',
    expected_behavior_template:
      'Agent extracts the relevant fields for {{topic_noun}} from the long opening turn instead of asking for them again, acknowledges details already provided, and only asks for what is still missing.',
    required_slots: ['topic_noun', 'opening_user_turn'],
  },
  {
    id: 'change_mind_mid_flow',
    label: 'Caller changes mind mid-flow',
    category: 'Edge Case',
    key_topic: 'Context Switching',
    priority: 'high',
    persona_type: 'indecisive',
    behavior_modifiers: ['changes_topic'],
    scenario_template:
      'Caller starts a {{topic_noun}} flow normally, then mid-way switches the value: "{{mid_flow_user_turn}}". Tests whether the agent updates its captured state instead of stacking conflicting values.',
    expected_behavior_template:
      'Agent recognizes the updated value supersedes the previous one, confirms the new value with the caller, and continues the {{topic_noun}} flow with the corrected state.',
    required_slots: ['topic_noun', 'mid_flow_user_turn'],
  },
  {
    id: 'provides_invalid_data',
    label: 'Caller provides invalid value',
    category: 'Error Handling',
    key_topic: 'Input Validation',
    priority: 'high',
    persona_type: 'neutral',
    scenario_template:
      'Caller provides a clearly invalid value during the {{topic_noun}} flow (e.g. "{{invalid_value}}"). Tests input validation and graceful re-prompting.',
    expected_behavior_template:
      'Agent detects the value is invalid, explains briefly why (without blaming the caller), and asks for a corrected value. Agent does NOT silently accept the bad value or hallucinate a normalization.',
    required_slots: ['topic_noun', 'invalid_value'],
  },
  {
    id: 'out_of_scope_question',
    label: 'Out-of-scope question',
    category: 'Boundary',
    key_topic: 'Scope Handling',
    priority: 'high',
    persona_type: 'curious',
    behavior_modifiers: ['changes_topic'],
    scenario_template:
      'Mid-flow, the caller asks something the agent is not designed to handle: "{{distractor_question}}". Tests that the agent stays in scope without hallucinating an answer.',
    expected_behavior_template:
      'Agent politely declines to answer the out-of-scope question, does not fabricate an answer, and steers the conversation back to {{topic_noun}}.',
    required_slots: ['topic_noun', 'distractor_question'],
  },
  {
    id: 'multiple_intents_one_turn',
    label: 'Multiple intents in one turn',
    category: 'Edge Case',
    key_topic: 'Intent Disambiguation',
    priority: 'medium',
    persona_type: 'verbose',
    scenario_template:
      'Caller packs two competing intents into a single turn: "{{opening_user_turn}}" combined with "{{second_intent}}". Tests intent disambiguation.',
    expected_behavior_template:
      'Agent identifies both intents, acknowledges them, and either handles the higher-priority one first while parking the other, or asks which the caller wants to address first. Agent does NOT silently drop one of the intents.',
    required_slots: ['opening_user_turn', 'second_intent'],
  },
  {
    id: 'silence_after_greeting',
    label: 'Silence after agent greeting',
    category: 'Edge Case',
    key_topic: 'Silence Handling',
    priority: 'high',
    persona_type: 'silent',
    behavior_modifiers: ['long_pauses'],
    scenario_template:
      'After the agent greets, the caller stays silent for ~5 seconds, then says a very short utterance like "uh, hi". Tests silence-timeout and warm re-prompting.',
    expected_behavior_template:
      'Agent waits a reasonable amount of time, then re-prompts with a warm, non-accusatory question (e.g. "Are you still there?" or "How can I help you today?"). It does NOT immediately end the call or assume disconnection.',
    required_slots: [],
  },
  {
    id: 'unclear_speech_mumble',
    label: 'Unclear / mumbled speech',
    category: 'Error Handling',
    key_topic: 'Speech Recognition',
    priority: 'medium',
    persona_type: 'unclear',
    behavior_modifiers: ['unclear_speech'],
    scenario_template:
      'Caller speaks unclearly or mumbles a key value during the {{topic_noun}} flow. The transcript looks like "I want to {{topic_noun}} for, um, [unintelligible]".',
    expected_behavior_template:
      'Agent asks the caller to repeat or spell the unclear value (politely, once), and does NOT guess or fabricate a value. If the caller cannot clarify after 2 attempts, the agent offers an alternative (text confirmation, callback, human handoff).',
    required_slots: ['topic_noun'],
  },
  {
    id: 'negative_confirmation_flip',
    label: 'Yes-then-no confirmation flip',
    category: 'Edge Case',
    key_topic: 'Confirmation Handling',
    priority: 'medium',
    persona_type: 'indecisive',
    scenario_template:
      'Caller initially confirms ("yes, that\'s right") then immediately retracts ("actually, no, wait — {{mid_flow_user_turn}}"). Tests that the agent does NOT commit/submit on the first yes.',
    expected_behavior_template:
      'Agent treats the second statement as the source of truth, rolls back any tentative commit, reconfirms the corrected value, and only finalizes after an explicit second yes.',
    required_slots: ['mid_flow_user_turn'],
  },
  {
    id: 'asks_to_repeat',
    label: 'Caller asks agent to repeat',
    category: 'Error Handling',
    key_topic: 'Repetition Handling',
    priority: 'low',
    persona_type: 'neutral',
    scenario_template:
      'Caller asks the agent to repeat itself ("Sorry, can you say that again?", "I didn\'t catch that"). Tests that the agent restates clearly without sounding robotic.',
    expected_behavior_template:
      'Agent restates the previous turn naturally (not a verbatim replay), optionally slows down or rephrases, and resumes the {{topic_noun}} flow from the same point.',
    required_slots: ['topic_noun'],
  },
  {
    id: 'background_noise',
    label: 'High background noise during answer',
    category: 'Boundary',
    key_topic: 'Audio Quality',
    priority: 'low',
    persona_type: 'neutral',
    behavior_modifiers: ['unclear_speech'],
    scenario_template:
      'Caller provides a key value during the {{topic_noun}} flow but with significant background noise (transcript shows partial / garbled text). Tests robustness to low-quality audio.',
    expected_behavior_template:
      'Agent recognizes the input is low-confidence, asks the caller to confirm or repeat in a quieter environment, and does NOT silently accept a garbled value.',
    required_slots: ['topic_noun'],
  },
  {
    id: 'early_hangup_intent',
    label: 'Caller signals intent to hang up early',
    category: 'Boundary',
    key_topic: 'Conversation Closing',
    priority: 'medium',
    persona_type: 'impatient',
    scenario_template:
      'Mid-flow, the caller says they need to go: "I gotta run, can we do this quickly?" or "Just give me the short version". Tests that the agent compresses the flow gracefully.',
    expected_behavior_template:
      'Agent acknowledges the time pressure, skips optional steps for {{topic_noun}}, asks only for required fields, and either completes quickly or offers a callback / SMS continuation.',
    required_slots: ['topic_noun'],
  },
];

/** Return archetype by id, or undefined. */
export function findArchetype(id: string): ArchetypeDefinition | undefined {
  return TEST_ARCHETYPES.find((a) => a.id === id);
}

/** All archetype ids in catalog order. */
export function allArchetypeIds(): string[] {
  return TEST_ARCHETYPES.map((a) => a.id);
}
