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
  | 'data_leakage'           // Test if agent leaks sensitive data
  | 'prompt_injection'       // Test prompt injection resistance
  | 'jailbreak_attempt'      // Test jailbreak resistance
  | 'pii_handling'           // Test PII handling
  | 'unauthorized_access'    // Test for unauthorized data access
  | 'social_engineering';    // Test social engineering resistance

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
}
