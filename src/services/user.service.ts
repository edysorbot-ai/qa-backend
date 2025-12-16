import { query } from '../db';
import { User, CreateUserDTO, UpdateUserDTO } from '../models/user.model';

export class UserService {
  async findByClerkId(clerkId: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE clerk_id = $1',
      [clerkId]
    );
    return result.rows[0] || null;
  }

  async findById(id: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  async create(data: CreateUserDTO): Promise<User> {
    const result = await query(
      `INSERT INTO users (clerk_id, email, first_name, last_name, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.clerk_id, data.email, data.first_name, data.last_name, data.image_url]
    );
    return result.rows[0];
  }

  async update(id: string, data: UpdateUserDTO): Promise<User | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.email !== undefined) {
      fields.push(`email = $${paramCount++}`);
      values.push(data.email);
    }
    if (data.first_name !== undefined) {
      fields.push(`first_name = $${paramCount++}`);
      values.push(data.first_name);
    }
    if (data.last_name !== undefined) {
      fields.push(`last_name = $${paramCount++}`);
      values.push(data.last_name);
    }
    if (data.image_url !== undefined) {
      fields.push(`image_url = $${paramCount++}`);
      values.push(data.image_url);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async upsertFromClerk(clerkUser: any): Promise<User> {
    const existing = await this.findByClerkId(clerkUser.id);
    
    if (existing) {
      return this.update(existing.id, {
        email: clerkUser.emailAddresses?.[0]?.emailAddress,
        first_name: clerkUser.firstName,
        last_name: clerkUser.lastName,
        image_url: clerkUser.imageUrl,
      }) as Promise<User>;
    }

    return this.create({
      clerk_id: clerkUser.id,
      email: clerkUser.emailAddresses?.[0]?.emailAddress,
      first_name: clerkUser.firstName,
      last_name: clerkUser.lastName,
      image_url: clerkUser.imageUrl,
    });
  }

  // Find user by clerk ID or create a minimal user record
  async findOrCreateByClerkId(clerkId: string): Promise<User> {
    const existing = await this.findByClerkId(clerkId);
    
    if (existing) {
      return existing;
    }

    // Create a minimal user record - can be enriched later via webhook
    return this.create({
      clerk_id: clerkId,
      email: `${clerkId}@placeholder.com`, // Will be updated via webhook or sync
      first_name: undefined,
      last_name: undefined,
      image_url: undefined,
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const userService = new UserService();
