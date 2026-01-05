/**
 * Test mode determines whether a test case should be executed via voice or chat API
 * - 'voice': Requires real voice testing (e.g., interruption handling, voice quality)
 * - 'chat': Can be tested via text-based chat API (e.g., happy path, basic flows)
 * - 'auto': AI will determine the best mode based on test case analysis
 */
export type TestMode = 'voice' | 'chat' | 'auto';

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
  test_mode?: TestMode;  // Whether to test via voice or chat
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
}
