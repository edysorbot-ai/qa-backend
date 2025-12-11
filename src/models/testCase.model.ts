export interface TestCase {
  id: string;
  agent_id: string;
  user_id: string;
  name: string;
  scenario: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateTestCaseDTO {
  agent_id: string;
  user_id: string;
  name: string;
  scenario: string;
}

export interface UpdateTestCaseDTO {
  name?: string;
  scenario?: string;
}
