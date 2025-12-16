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
  batch_compatible?: boolean;
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
  batch_compatible?: boolean;
}

export interface UpdateTestCaseDTO {
  name?: string;
  description?: string;
  scenario?: string;
  expected_behavior?: string;
  key_topic?: string;
  test_type?: string;
  batch_compatible?: boolean;
}
