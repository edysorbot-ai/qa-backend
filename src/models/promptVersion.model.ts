export interface PromptVersion {
  id: string;
  agent_id: string;
  version_number: number;
  prompt: string;
  prompt_hash: string;
  created_at: Date;
}

export interface CreatePromptVersionDTO {
  agent_id: string;
  prompt: string;
}
