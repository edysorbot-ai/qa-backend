export type TestRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionMode = 'standard' | 'batched' | 'workflow';

export interface TestRun {
  id: string;
  user_id: string;
  agent_id: string;
  name?: string;
  status: TestRunStatus;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  started_at?: Date;
  completed_at?: Date;
  config: TestRunConfig;
  execution_mode?: ExecutionMode;
  execution_plan?: any;
  workflow_id?: string;
  created_at: Date;
}

export interface TestRunConfig {
  tts_provider?: string;
  tts_voice?: string;
  parallel_execution?: boolean;
  max_concurrent?: number;
  timeout_ms?: number;
  execution_mode?: ExecutionMode;
  execution_plan?: any;
}

export interface CreateTestRunDTO {
  user_id: string;
  agent_id: string;
  name?: string;
  config?: TestRunConfig;
}

export interface UpdateTestRunDTO {
  status?: TestRunStatus;
  total_tests?: number;
  passed_tests?: number;
  failed_tests?: number;
  started_at?: Date;
  completed_at?: Date;
}
