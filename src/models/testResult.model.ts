export type TestResultStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface ConversationTurn {
  role: 'user' | 'agent';
  text: string;
  audio_url?: string;
  timestamp: number;
  latency_ms?: number;
}

export interface TestResultMetrics {
  intent_accuracy?: number;
  script_adherence?: number;
  response_latency_ms?: number;
  audio_clarity?: number;
  silence_ratio?: number;
  overlap_detected?: boolean;
  hallucination_detected?: boolean;
}

export interface TestResult {
  id: string;
  test_run_id: string;
  test_case_id: string;
  status: TestResultStatus;
  user_audio_url?: string;
  agent_audio_url?: string;
  user_transcript?: string;
  agent_transcript?: string;
  detected_intent?: string;
  intent_match: boolean;
  output_match: boolean;
  latency_ms?: number;
  conversation_turns: ConversationTurn[];
  metrics: TestResultMetrics;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
  created_at: Date;
}

export interface CreateTestResultDTO {
  test_run_id: string;
  test_case_id: string;
}

export interface UpdateTestResultDTO {
  status?: TestResultStatus;
  user_audio_url?: string;
  agent_audio_url?: string;
  user_transcript?: string;
  agent_transcript?: string;
  detected_intent?: string;
  intent_match?: boolean;
  output_match?: boolean;
  latency_ms?: number;
  conversation_turns?: ConversationTurn[];
  metrics?: TestResultMetrics;
  error_message?: string;
  started_at?: Date;
  completed_at?: Date;
}
