import { Provider } from './integration.model';

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
}
