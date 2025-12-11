export interface User {
  id: string;
  clerk_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  image_url?: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserDTO {
  clerk_id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  image_url?: string;
}

export interface UpdateUserDTO {
  email?: string;
  first_name?: string;
  last_name?: string;
  image_url?: string;
}
