/**
 * Test mode determines whether a test case should be executed via voice or chat API
 * - 'voice': Requires real voice testing (e.g., interruption handling, voice quality)
 * - 'chat': Can be tested via text-based chat API (e.g., happy path, basic flows)
 * - 'auto': AI will determine the best mode based on test case analysis
 */
export type TestMode = 'voice' | 'chat' | 'auto';

/**
 * Persona types for diverse personality testing
 */
export type PersonaType = 
  | 'neutral'      // Standard professional caller
  | 'angry'        // Frustrated, upset customer
  | 'confused'     // Uncertain, needs clarification
  | 'impatient'    // Wants quick answers, interrupts
  | 'elderly'      // Slower pace, may need repetition
  | 'technical'    // Tech-savvy, uses jargon
  | 'rambling'     // Goes off-topic, verbose
  | 'suspicious'   // Skeptical, questions everything
  | 'friendly'     // Warm, cooperative
  | 'rushed';      // In a hurry, brief responses

/**
 * Voice accents for accent testing
 */
export type VoiceAccent = 
  | 'american'
  | 'british' 
  | 'australian'
  | 'indian'
  | 'spanish'
  | 'french'
  | 'german'
  | 'chinese'
  | 'japanese'
  | 'neutral';

/**
 * Behavior modifiers for test personas
 */
export type BehaviorModifier = 
  | 'interrupts_frequently'
  | 'long_pauses'
  | 'background_noise'
  | 'mumbles'
  | 'repeats_self'
  | 'changes_topic'
  | 'gives_partial_info'
  | 'asks_many_questions'
  | 'mono_syllabic'
  | 'emotional';

/**
 * Security test types
 */
export type SecurityTestType =
  | 'data_leakage'              // Test if agent leaks sensitive data
  | 'prompt_injection'          // Generic prompt injection resistance
  | 'prompt_injection_l1'       // L1: direct instruction override ("ignore previous rules")
  | 'prompt_injection_l2'       // L2: role / persona reframing ("you are now DAN…")
  | 'prompt_injection_l3'       // L3: indirect / multi-turn / context smuggling
  | 'jailbreak_attempt'         // Generic jailbreak attempt
  | 'pii_handling'              // Test PII handling discipline
  | 'pii_exposure'              // Attempt to make the agent disclose third-party PII
  | 'unauthorized_access'       // Test for unauthorized data access
  | 'social_engineering'        // Test social engineering resistance
  | 'toxic_content'             // Hate, profanity, slurs — agent must refuse / de-escalate
  | 'harmful_advice'            // Medical / legal / financial advice it must not give
  | 'adversarial_input'         // Confusing / paradoxical / contradictory inputs
  | 'data_exfiltration'         // Pull internal system prompt / training data / config
  | 'medical_data_request'      // Attempt to extract or echo protected medical info
  | 'pci_data_request';         // Attempt to extract or echo payment card info

export interface TestCase {
  id: string;
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  scenario: string;
  expected_behavior?: string;
  key_topic?: string;
  test_type?: string;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  batch_compatible?: boolean;
  test_mode?: TestMode;
  // Persona fields
  persona_type?: PersonaType;
  persona_traits?: string[];
  voice_accent?: VoiceAccent;
  behavior_modifiers?: BehaviorModifier[];
  // Security fields
  is_security_test?: boolean;
  security_test_type?: SecurityTestType;
  sensitive_data_types?: string[];
  // Gold-example governance
  gold_gate?: 'soft' | 'strict';
  created_via?: 'manual' | 'auto_seed' | 'ai_generated' | 'csv_import' | 'template' | 'archetype';
  // Free-text discussion / spec / reference link the author can attach to a
  // test case so reviewers can open the context that motivated it (e.g. the
  // rude-customer reference clip).
  reference_link?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTestCaseDTO {
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  scenario: string;
  expected_behavior?: string;
  key_topic?: string;
  test_type?: string;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  batch_compatible?: boolean;
  test_mode?: TestMode;
  // Persona fields
  persona_type?: PersonaType;
  persona_traits?: string[];
  voice_accent?: VoiceAccent;
  behavior_modifiers?: BehaviorModifier[];
  // Security fields
  is_security_test?: boolean;
  security_test_type?: SecurityTestType;
  sensitive_data_types?: string[];
  // Gold-example governance
  gold_gate?: 'soft' | 'strict';
  created_via?: 'manual' | 'auto_seed' | 'ai_generated' | 'csv_import' | 'template' | 'archetype';
  reference_link?: string;
}

export interface UpdateTestCaseDTO {
  name?: string;
  description?: string;
  scenario?: string;
  expected_behavior?: string;
  key_topic?: string;
  test_type?: string;
  category?: string;
  priority?: 'high' | 'medium' | 'low';
  batch_compatible?: boolean;
  test_mode?: TestMode;
  // Persona fields
  persona_type?: PersonaType;
  persona_traits?: string[];
  voice_accent?: VoiceAccent;
  behavior_modifiers?: BehaviorModifier[];
  // Security fields
  is_security_test?: boolean;
  security_test_type?: SecurityTestType;
  sensitive_data_types?: string[];
  // Gold-example governance
  gold_gate?: 'soft' | 'strict';
  reference_link?: string;
}
