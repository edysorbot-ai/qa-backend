import { query } from '../db';
import { 
  AlertSettings, 
  CreateAlertSettingsDTO, 
  UpdateAlertSettingsDTO,
  EmailConfig
} from '../models/alertSettings.model';

export class AlertSettingsService {
  async findByUserId(userId: string): Promise<AlertSettings | null> {
    const result = await query(
      'SELECT * FROM alert_settings WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  async create(data: CreateAlertSettingsDTO): Promise<AlertSettings> {
    const result = await query(
      `INSERT INTO alert_settings (user_id, enabled, email_addresses, email_configs, notify_on_test_failure, notify_on_scheduled_failure)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.user_id,
        data.enabled ?? false,
        data.email_addresses ?? [],
        JSON.stringify(data.email_configs ?? []),
        data.notify_on_test_failure ?? true,
        data.notify_on_scheduled_failure ?? true
      ]
    );
    return result.rows[0];
  }

  async update(userId: string, data: UpdateAlertSettingsDTO): Promise<AlertSettings | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.enabled !== undefined) {
      fields.push(`enabled = $${paramCount++}`);
      values.push(data.enabled);
    }
    if (data.email_addresses !== undefined) {
      fields.push(`email_addresses = $${paramCount++}`);
      values.push(data.email_addresses);
    }
    if (data.email_configs !== undefined) {
      fields.push(`email_configs = $${paramCount++}`);
      values.push(JSON.stringify(data.email_configs));
    }
    if (data.notify_on_test_failure !== undefined) {
      fields.push(`notify_on_test_failure = $${paramCount++}`);
      values.push(data.notify_on_test_failure);
    }
    if (data.notify_on_scheduled_failure !== undefined) {
      fields.push(`notify_on_scheduled_failure = $${paramCount++}`);
      values.push(data.notify_on_scheduled_failure);
    }

    if (fields.length === 0) return this.findByUserId(userId);

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(userId);

    const result = await query(
      `UPDATE alert_settings SET ${fields.join(', ')} WHERE user_id = $${paramCount} RETURNING *`,
      values
    );
    return result.rows[0] || null;
  }

  async upsert(userId: string, data: UpdateAlertSettingsDTO): Promise<AlertSettings> {
    const existing = await this.findByUserId(userId);
    
    if (existing) {
      return this.update(userId, data) as Promise<AlertSettings>;
    }

    return this.create({
      user_id: userId,
      ...data
    });
  }

  // Add team member email to alert settings
  async addTeamMemberEmail(ownerUserId: string, email: string, name: string): Promise<void> {
    const settings = await this.findByUserId(ownerUserId);
    
    if (!settings) {
      // Create settings with the team member email
      await this.create({
        user_id: ownerUserId,
        enabled: false,
        email_configs: [{
          email: email.toLowerCase(),
          enabled: true,
          type: 'team_member',
          name
        }]
      });
      return;
    }

    // Check if email already exists
    const emailConfigs: EmailConfig[] = settings.email_configs || [];
    const emailExists = emailConfigs.some(
      (config) => config.email.toLowerCase() === email.toLowerCase()
    );

    if (!emailExists) {
      emailConfigs.push({
        email: email.toLowerCase(),
        enabled: true,
        type: 'team_member',
        name
      });
      await this.update(ownerUserId, { email_configs: emailConfigs });
    }
  }

  // Remove team member email from alert settings
  async removeTeamMemberEmail(ownerUserId: string, email: string): Promise<void> {
    const settings = await this.findByUserId(ownerUserId);
    
    if (!settings) return;

    const emailConfigs: EmailConfig[] = settings.email_configs || [];
    const filteredConfigs = emailConfigs.filter(
      (config) => config.email.toLowerCase() !== email.toLowerCase()
    );

    if (filteredConfigs.length !== emailConfigs.length) {
      await this.update(ownerUserId, { email_configs: filteredConfigs });
    }
  }

  async delete(userId: string): Promise<boolean> {
    const result = await query(
      'DELETE FROM alert_settings WHERE user_id = $1',
      [userId]
    );
    return result.rowCount ? result.rowCount > 0 : false;
  }

  async getEnabledAlertSettingsForUser(userId: string): Promise<AlertSettings | null> {
    const result = await query(
      `SELECT * FROM alert_settings WHERE user_id = $1 AND enabled = true`,
      [userId]
    );
    return result.rows[0] || null;
  }

  // Get enabled email addresses for notifications
  getEnabledEmails(settings: AlertSettings): string[] {
    const emailConfigs: EmailConfig[] = settings.email_configs || [];
    return emailConfigs
      .filter(config => config.enabled)
      .map(config => config.email);
  }
}

export const alertSettingsService = new AlertSettingsService();
