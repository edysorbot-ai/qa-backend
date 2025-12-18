export interface ConfigVersion {
  id: string;
  agent_id: string;
  version_number: number;
  config: Record<string, any>;
  config_hash: string;
  created_at: string;
}

export interface CreateConfigVersionDTO {
  agent_id: string;
  config: Record<string, any>;
}
