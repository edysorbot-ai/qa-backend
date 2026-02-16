export type Provider = 'elevenlabs' | 'retell' | 'vapi' | 'openai_realtime' | 'haptik' | 'custom' | 'bolna' | 'livekit';

export interface Integration {
  id: string;
  user_id: string;
  provider: Provider;
  api_key: string;
  base_url: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateIntegrationDTO {
  user_id: string;
  provider: Provider;
  api_key: string;
  base_url?: string | null;
}

export interface UpdateIntegrationDTO {
  api_key?: string;
  base_url?: string | null;
  is_active?: boolean;
}
