import { Provider } from './integration.model';

export type AgentLifecycleStage = 'development' | 'qa' | 'uat' | 'production';

export interface Agent {
  id: string;
  user_id: string;
  integration_id: string;
  external_agent_id?: string;
  name: string;
  provider: Provider;
  prompt?: string;
  intents: string[];
  config: Record<string, any>;
  status: 'active' | 'inactive' | 'error';
  /** Item 17: maturity tier that gates eval policy. */
  lifecycle_stage?: AgentLifecycleStage;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentDTO {
  user_id: string;
  integration_id: string;
  external_agent_id?: string;
  name: string;
  provider: Provider;
  prompt?: string;
  intents?: string[];
  config?: Record<string, any>;
}

export interface UpdateAgentDTO {
  name?: string;
  prompt?: string;
  intents?: string[];
  config?: Record<string, any>;
  status?: 'active' | 'inactive' | 'error';
  lifecycle_stage?: AgentLifecycleStage;
}
