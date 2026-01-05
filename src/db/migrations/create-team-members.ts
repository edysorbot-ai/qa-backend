import { pool } from '../index';

export const createTeamMembersTable = async () => {
  console.log('🔄 Running create team_members table migration...');
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        clerk_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(email)
      );
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(owner_user_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_members_clerk_id ON team_members(clerk_id);
    `);

    console.log('✅ team_members table created successfully');
  } catch (error) {
    console.error('❌ team_members migration failed:', error);
    throw error;
  }
};

// Run if executed directly
if (require.main === module) {
  createTeamMembersTable()
    .then(() => {
      console.log('Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
