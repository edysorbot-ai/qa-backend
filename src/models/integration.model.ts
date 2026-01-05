export type Provider = 'elevenlabs' | 'retell' | 'vapi' | 'openai_realtime' | 'haptik' | 'custom';

export interface Integration {
  id: string;
  user_id: string;
  provider: Provider;
  api_key: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateIntegrationDTO {
  user_id: string;
  provider: Provider;
  api_key: string;
}

export interface UpdateIntegrationDTO {
  api_key?: string;
  is_active?: boolean;
}
