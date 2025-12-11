export interface TestCase {
  id: string;
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  user_input: string;
  expected_intent?: string;
  expected_output?: string;
  variations: TestCaseVariation[];
  config_overrides: Record<string, any>;
  is_auto_generated: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TestCaseVariation {
  input: string;
  type: 'paraphrase' | 'accent' | 'noise' | 'interruption' | 'edge_case';
}

export interface CreateTestCaseDTO {
  agent_id: string;
  user_id: string;
  name: string;
  description?: string;
  user_input: string;
  expected_intent?: string;
  expected_output?: string;
  variations?: TestCaseVariation[];
  config_overrides?: Record<string, any>;
  is_auto_generated?: boolean;
}

export interface UpdateTestCaseDTO {
  name?: string;
  description?: string;
  user_input?: string;
  expected_intent?: string;
  expected_output?: string;
  variations?: TestCaseVariation[];
  config_overrides?: Record<string, any>;
}
