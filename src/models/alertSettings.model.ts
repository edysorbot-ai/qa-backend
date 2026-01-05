export interface EmailConfig {
  email: string;
  enabled: boolean;
  type: 'account' | 'team_member';
  name?: string;
}

export interface AlertSettings {
  id: string;
  user_id: string;
  enabled: boolean;
  email_addresses: string[];
  email_configs: EmailConfig[];
  notify_on_test_failure: boolean;
  notify_on_scheduled_failure: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAlertSettingsDTO {
  user_id: string;
  enabled?: boolean;
  email_addresses?: string[];
  email_configs?: EmailConfig[];
  notify_on_test_failure?: boolean;
  notify_on_scheduled_failure?: boolean;
}

export interface UpdateAlertSettingsDTO {
  enabled?: boolean;
  email_addresses?: string[];
  email_configs?: EmailConfig[];
  notify_on_test_failure?: boolean;
  notify_on_scheduled_failure?: boolean;
}

export interface FailedTestAlertPayload {
  testRunId: string;
  testRunName: string;
  agentId: string;
  agentName: string;
  provider: string;
  isScheduledRun: boolean;
  failedTests: Array<{
    testCaseId: string;
    testCaseName: string;
    scenario: string;
    category: string;
    expectedOutcome: string;
    actualResponse?: string;
    errorMessage?: string;
    status: string;
  }>;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  timestamp: Date;
}
