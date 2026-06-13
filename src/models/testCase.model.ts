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
  | 'prompt_injection_l4'       // L4: encoded / obfuscated payload (base64, hex, ROT13, unicode look-alikes)
  | 'prompt_injection_l5'       // L5: indirect / data-borne injection (commands hidden inside documents to summarize)
  | 'prompt_injection_l6'       // L6: context overflow (huge filler then trailing real instruction)
  | 'prompt_injection_l7'       // L7: multi-language bypass
  | 'system_prompt_extraction'  // Direct or indirect system-prompt extraction
  | 'jailbreak_attempt'         // Generic jailbreak attempt
  | 'jailbreak_fictional'       // Story / novel framing
  | 'jailbreak_hypothetical'    // Hypothetical / academic framing
  | 'jailbreak_continuation'    // "Complete this sentence…" continuation attack
  | 'jailbreak_negation'        // Opposite-day / negation trick
  | 'jailbreak_obfuscation'     // Character / token / spacing obfuscation
  | 'excessive_agency'          // Unauthorized real-world action / data-exfil via tool / SSRF / self-persistence
  | 'pii_handling'              // Test PII handling discipline
  | 'pii_exposure'              // Attempt to make the agent disclose third-party or own-account PII
  | 'unauthorized_access'       // Test for unauthorized data access
  | 'social_engineering'        // Authority / urgency / flattery / guilt pressure
  | 'toxic_content'             // Hate, profanity, slurs, NSFW, violence, self-harm — refuse / de-escalate
  | 'harmful_advice'            // Medical / legal / financial / weapons / cybercrime advice it must not give
  | 'adversarial_input'         // Confusing / paradoxical / contradictory inputs
  | 'data_exfiltration'         // Pull internal system prompt / training data / config / bulk records
  | 'medical_data_request'      // Attempt to extract or echo protected medical info
  | 'pci_data_request'          // Attempt to extract or echo payment card info
  | 'multi_agent_abuse'         // Orchestrator / sub-agent trust abuse
  | 'output_format_injection'   // Output-format injection to bypass downstream filters
  | 'code_generation_malware'   // Malware / backdoor / covert surveillance code generation
  | 'disinformation'            // Disinformation generation
  | 'stalking_assistance'       // Surveillance / stalking assistance
  | 'account_takeover'          // Account-takeover assistance
  | 'privilege_escalation'      // Privilege escalation via tool chaining
  | 'robustness'                // Hallucination, gaslighting, memory injection, DoS, malformed input
  | 'behavioral'                // Sycophancy, persona consistency, capitulation under pressure
  | 'compliance'                // GDPR / PCI / HIPAA general policy obligations
  | 'operational_failure'       // Hallucinated tool args, recursive loops, schema-change drift, context overload, bias
  | 'advanced_adversarial'      // Indirect injection via external content, cross-modal, payload splitting
  | 'performance_degradation'   // Latency / throughput stress, quality drift
  | 'security_generic';         // Generic / uncategorised security check

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
