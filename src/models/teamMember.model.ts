export interface TeamMember {
  id: string;
  owner_user_id: string;  // The main account that created this team member
  email: string;
  clerk_id?: string;      // Clerk user ID once they sign up
  name: string;
  status: 'pending' | 'active';  // pending until they first login
  created_at: Date;
  updated_at: Date;
}

export interface CreateTeamMemberDTO {
  owner_user_id: string;
  email: string;
  name: string;
  password: string;  // Temporary password sent to their email
}

export interface TeamMemberWithOwner extends TeamMember {
  owner_email?: string;
  owner_name?: string;
}
