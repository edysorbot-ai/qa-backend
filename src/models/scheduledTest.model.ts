import { pool, queryWithRetry } from "../db";

export interface ScheduledTest {
  id: string;
  user_id: string;
  name: string;
  agent_id: string;
  agent_name: string;
  provider: string;
  integration_id?: string;
  external_agent_id?: string;
  batches: any; // JSON array of batches
  schedule_type: "once" | "daily" | "weekly";
  scheduled_time: string; // Time in HH:MM format
  scheduled_date?: string; // For "once" type - ISO date
  scheduled_days?: number[]; // For "weekly" type - 0-6 (Sun-Sat)
  timezone: string;
  // Schedule end options for recurring schedules (daily/weekly)
  ends_type: "never" | "on" | "after"; // When the schedule should end
  ends_on_date?: string; // End date for "on" type - ISO date
  ends_after_occurrences?: number; // Number of occurrences for "after" type
  completed_occurrences: number; // Track completed runs for "after" type
  enable_batching: boolean;
  enable_concurrency: boolean;
  concurrency_count: number;
  status: "active" | "paused" | "completed";
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export const ScheduledTestModel = {
  // Create scheduled tests table
  async createTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS scheduled_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        agent_name VARCHAR(255) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        integration_id UUID REFERENCES integrations(id) ON DELETE SET NULL,
        external_agent_id VARCHAR(255),
        batches JSONB NOT NULL,
        schedule_type VARCHAR(20) NOT NULL CHECK (schedule_type IN ('once', 'daily', 'weekly')),
        scheduled_time TIME NOT NULL,
        scheduled_date DATE,
        scheduled_days INTEGER[],
        timezone VARCHAR(50) DEFAULT 'UTC',
        ends_type VARCHAR(20) DEFAULT 'never' CHECK (ends_type IN ('never', 'on', 'after')),
        ends_on_date DATE,
        ends_after_occurrences INTEGER,
        completed_occurrences INTEGER DEFAULT 0,
        enable_batching BOOLEAN DEFAULT true,
        enable_concurrency BOOLEAN DEFAULT false,
        concurrency_count INTEGER DEFAULT 1,
        status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
        last_run_at TIMESTAMP WITH TIME ZONE,
        next_run_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_tests_user_id ON scheduled_tests(user_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tests_status ON scheduled_tests(status);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tests_next_run ON scheduled_tests(next_run_at);
    `;
    await pool.query(query);
  },

  // Create a new scheduled test
  async create(data: {
    userId: string;
    name: string;
    agentId: string;
    agentName: string;
    provider: string;
    integrationId?: string;
    externalAgentId?: string;
    batches: any[];
    scheduleType: "once" | "daily" | "weekly";
    scheduledTime: string;
    scheduledDate?: string;
    scheduledDays?: number[];
    timezone?: string;
    endsType?: "never" | "on" | "after";
    endsOnDate?: string;
    endsAfterOccurrences?: number;
    enableBatching?: boolean;
    enableConcurrency?: boolean;
    concurrencyCount?: number;
  }): Promise<ScheduledTest> {
    const nextRunAt = this.calculateNextRun(
      data.scheduleType,
      data.scheduledTime,
      data.scheduledDate,
      data.scheduledDays,
      data.timezone || "UTC",
      data.endsType,
      data.endsOnDate
    );

    const query = `
      INSERT INTO scheduled_tests (
        user_id, name, agent_id, agent_name, provider, integration_id, external_agent_id,
        batches, schedule_type, scheduled_time, scheduled_date, scheduled_days,
        timezone, ends_type, ends_on_date, ends_after_occurrences, completed_occurrences,
        enable_batching, enable_concurrency, concurrency_count, next_run_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *
    `;

    const result = await pool.query(query, [
      data.userId,
      data.name,
      data.agentId,
      data.agentName,
      data.provider,
      data.integrationId || null,
      data.externalAgentId || null,
      JSON.stringify(data.batches),
      data.scheduleType,
      data.scheduledTime,
      data.scheduledDate || null,
      data.scheduledDays || null,
      data.timezone || "UTC",
      data.endsType || "never",
      data.endsOnDate || null,
      data.endsAfterOccurrences || null,
      0, // completed_occurrences starts at 0
      data.enableBatching ?? true,
      data.enableConcurrency ?? false,
      data.concurrencyCount || 1,
      nextRunAt,
    ]);

    return this.formatScheduledTest(result.rows[0]);
  },

  // Get all scheduled tests for a user
  async findByUserId(userId: string): Promise<ScheduledTest[]> {
    const query = `
      SELECT * FROM scheduled_tests
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(query, [userId]);
    return result.rows.map(this.formatScheduledTest);
  },

  // Get a scheduled test by ID
  async findById(id: string, userId: string): Promise<ScheduledTest | null> {
    const query = `
      SELECT * FROM scheduled_tests
      WHERE id = $1 AND user_id = $2
    `;
    const result = await pool.query(query, [id, userId]);
    return result.rows[0] ? this.formatScheduledTest(result.rows[0]) : null;
  },

  // Get all active scheduled tests that are due to run
  async findDueTests(): Promise<ScheduledTest[]> {
    const query = `
      SELECT * FROM scheduled_tests
      WHERE status = 'active'
        AND next_run_at <= NOW()
      ORDER BY next_run_at ASC
    `;
    // Use retry logic for scheduler queries to handle Neon cold starts
    const result = await queryWithRetry(query);
    return result.rows.map(this.formatScheduledTest);
  },

  // Update scheduled test status
  async updateStatus(id: string, status: "active" | "paused" | "completed"): Promise<void> {
    const query = `
      UPDATE scheduled_tests
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `;
    await pool.query(query, [status, id]);
  },

  // Update last run and calculate next run
  async updateAfterRun(id: string): Promise<void> {
    // First get the scheduled test
    const getQuery = `SELECT * FROM scheduled_tests WHERE id = $1`;
    const result = await pool.query(getQuery, [id]);
    
    if (!result.rows[0]) return;

    const test = result.rows[0];
    let nextRunAt: Date | null = null;
    let newStatus = test.status;
    const newCompletedOccurrences = (test.completed_occurrences || 0) + 1;

    if (test.schedule_type === "once") {
      // One-time schedule is completed
      newStatus = "completed";
    } else {
      // Check if schedule should end for recurring schedules
      let shouldEnd = false;

      // Check "after X occurrences" end type
      if (test.ends_type === "after" && test.ends_after_occurrences) {
        if (newCompletedOccurrences >= test.ends_after_occurrences) {
          shouldEnd = true;
        }
      }

      // Check "on date" end type
      if (test.ends_type === "on" && test.ends_on_date) {
        const endDate = new Date(test.ends_on_date);
        endDate.setHours(23, 59, 59, 999); // End of the day
        if (new Date() > endDate) {
          shouldEnd = true;
        }
      }

      if (shouldEnd) {
        newStatus = "completed";
      } else {
        // Calculate next run for recurring schedules
        nextRunAt = this.calculateNextRun(
          test.schedule_type,
          test.scheduled_time,
          null,
          test.scheduled_days,
          test.timezone,
          test.ends_type,
          test.ends_on_date
        );
        
        // If no valid next run (e.g., end date has passed), mark as completed
        if (!nextRunAt) {
          newStatus = "completed";
        }
      }
    }

    const updateQuery = `
      UPDATE scheduled_tests
      SET last_run_at = NOW(),
          next_run_at = $1,
          status = $2,
          completed_occurrences = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
    `;
    await pool.query(updateQuery, [nextRunAt, newStatus, newCompletedOccurrences, id]);
  },

  // Delete a scheduled test
  async delete(id: string, userId: string): Promise<boolean> {
    const query = `
      DELETE FROM scheduled_tests
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `;
    const result = await pool.query(query, [id, userId]);
    return result.rowCount !== null && result.rowCount > 0;
  },

  // Update a scheduled test
  async update(
    id: string,
    userId: string,
    data: Partial<{
      name: string;
      scheduleType: "once" | "daily" | "weekly";
      scheduledTime: string;
      scheduledDate?: string;
      scheduledDays?: number[];
      timezone?: string;
      endsType?: "never" | "on" | "after";
      endsOnDate?: string;
      endsAfterOccurrences?: number;
      status: "active" | "paused" | "completed";
    }>
  ): Promise<ScheduledTest | null> {
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.scheduleType !== undefined) {
      updates.push(`schedule_type = $${paramCount++}`);
      values.push(data.scheduleType);
    }
    if (data.scheduledTime !== undefined) {
      updates.push(`scheduled_time = $${paramCount++}`);
      values.push(data.scheduledTime);
    }
    if (data.scheduledDate !== undefined) {
      updates.push(`scheduled_date = $${paramCount++}`);
      values.push(data.scheduledDate);
    }
    if (data.scheduledDays !== undefined) {
      updates.push(`scheduled_days = $${paramCount++}`);
      values.push(data.scheduledDays);
    }
    if (data.timezone !== undefined) {
      updates.push(`timezone = $${paramCount++}`);
      values.push(data.timezone);
    }
    if (data.endsType !== undefined) {
      updates.push(`ends_type = $${paramCount++}`);
      values.push(data.endsType);
      // Reset completed occurrences when changing end type
      updates.push(`completed_occurrences = 0`);
    }
    if (data.endsOnDate !== undefined) {
      updates.push(`ends_on_date = $${paramCount++}`);
      values.push(data.endsOnDate || null);
    }
    if (data.endsAfterOccurrences !== undefined) {
      updates.push(`ends_after_occurrences = $${paramCount++}`);
      values.push(data.endsAfterOccurrences || null);
    }
    if (data.status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(data.status);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    // Recalculate next_run_at if schedule changed
    if (data.scheduleType || data.scheduledTime || data.scheduledDate || data.scheduledDays || data.endsType || data.endsOnDate) {
      const getQuery = `SELECT * FROM scheduled_tests WHERE id = $1 AND user_id = $2`;
      const current = await pool.query(getQuery, [id, userId]);
      if (current.rows[0]) {
        const test = current.rows[0];
        const nextRunAt = this.calculateNextRun(
          data.scheduleType || test.schedule_type,
          data.scheduledTime || test.scheduled_time,
          data.scheduledDate || test.scheduled_date,
          data.scheduledDays || test.scheduled_days,
          data.timezone || test.timezone,
          data.endsType || test.ends_type,
          data.endsOnDate !== undefined ? data.endsOnDate : test.ends_on_date
        );
        updates.push(`next_run_at = $${paramCount++}`);
        values.push(nextRunAt);
      }
    }

    values.push(id, userId);

    const query = `
      UPDATE scheduled_tests
      SET ${updates.join(", ")}
      WHERE id = $${paramCount++} AND user_id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    return result.rows[0] ? this.formatScheduledTest(result.rows[0]) : null;
  },

  // Calculate the next run time
  calculateNextRun(
    scheduleType: "once" | "daily" | "weekly",
    scheduledTime: string,
    scheduledDate?: string | null,
    scheduledDays?: number[] | null,
    timezone: string = "UTC",
    endsType?: "never" | "on" | "after" | null,
    endsOnDate?: string | null
  ): Date | null {
    const [hours, minutes] = scheduledTime.split(":").map(Number);
    const now = new Date();

    // Helper to create a date in the user's timezone and convert to UTC
    const createDateInTimezone = (year: number, month: number, day: number, hour: number, minute: number): Date => {
      // Create an ISO string representing the time in the user's timezone
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
      
      // Get the offset for the target timezone
      const targetDate = new Date(dateStr);
      const utcDate = new Date(targetDate.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzDate = new Date(targetDate.toLocaleString('en-US', { timeZone: timezone }));
      const offset = utcDate.getTime() - tzDate.getTime();
      
      // Apply the offset to get the correct UTC time
      return new Date(targetDate.getTime() + offset);
    };

    // Helper to get current date/time in user's timezone
    const getNowInTimezone = (): { year: number; month: number; day: number; hours: number; minutes: number; dayOfWeek: number } => {
      const options: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short'
      };
      const formatter = new Intl.DateTimeFormat('en-US', options);
      const parts = formatter.formatToParts(now);
      
      const getValue = (type: string): string => parts.find(p => p.type === type)?.value || '0';
      const dayOfWeekMap: { [key: string]: number } = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
      
      return {
        year: parseInt(getValue('year')),
        month: parseInt(getValue('month')) - 1, // 0-indexed
        day: parseInt(getValue('day')),
        hours: parseInt(getValue('hour')),
        minutes: parseInt(getValue('minute')),
        dayOfWeek: dayOfWeekMap[getValue('weekday')] ?? 0
      };
    };

    // Helper to check if a date is valid (not past the end date)
    const isValidDate = (date: Date): boolean => {
      if (endsType === "on" && endsOnDate) {
        // Parse end date in user's timezone (end of day)
        const [endYear, endMonth, endDay] = endsOnDate.split('-').map(Number);
        const endDate = createDateInTimezone(endYear, endMonth - 1, endDay, 23, 59);
        return date <= endDate;
      }
      return true;
    };

    if (scheduleType === "once" && scheduledDate) {
      // Parse the scheduled date (YYYY-MM-DD format)
      const [year, month, day] = scheduledDate.split('-').map(Number);
      const runDate = createDateInTimezone(year, month - 1, day, hours, minutes);
      return runDate > now ? runDate : null;
    }

    if (scheduleType === "daily") {
      const nowInTz = getNowInTimezone();
      const currentTimeMinutes = nowInTz.hours * 60 + nowInTz.minutes;
      const scheduledMinutes = hours * 60 + minutes;
      
      // Check if we can schedule for today
      if (scheduledMinutes > currentTimeMinutes) {
        const todayRun = createDateInTimezone(nowInTz.year, nowInTz.month, nowInTz.day, hours, minutes);
        if (isValidDate(todayRun)) {
          return todayRun;
        }
      }
      
      // Schedule for tomorrow
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowInTz = getNowInTimezone();
      // Advance by one day from current timezone date
      const tomorrowRun = createDateInTimezone(nowInTz.year, nowInTz.month, nowInTz.day + 1, hours, minutes);
      if (isValidDate(tomorrowRun)) {
        return tomorrowRun;
      }
      return null; // End date has passed
    }

    if (scheduleType === "weekly" && scheduledDays && scheduledDays.length > 0) {
      const sortedDays = [...scheduledDays].sort((a, b) => a - b);
      const nowInTz = getNowInTimezone();
      const currentDay = nowInTz.dayOfWeek;
      const currentTimeMinutes = nowInTz.hours * 60 + nowInTz.minutes;
      const scheduledMinutes = hours * 60 + minutes;

      // Find the next scheduled day
      for (const day of sortedDays) {
        if (day > currentDay || (day === currentDay && scheduledMinutes > currentTimeMinutes)) {
          const daysUntil = day - currentDay;
          const nextRun = createDateInTimezone(nowInTz.year, nowInTz.month, nowInTz.day + daysUntil, hours, minutes);
          if (isValidDate(nextRun)) {
            return nextRun;
          }
        }
      }

      // Wrap to next week
      const daysUntil = 7 - currentDay + sortedDays[0];
      const nextRun = createDateInTimezone(nowInTz.year, nowInTz.month, nowInTz.day + daysUntil, hours, minutes);
      if (isValidDate(nextRun)) {
        return nextRun;
      }
      return null; // End date has passed
    }

    return null;
  },

  // Format database row to ScheduledTest interface
  formatScheduledTest(row: any): ScheduledTest {
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      provider: row.provider,
      integration_id: row.integration_id,
      external_agent_id: row.external_agent_id,
      batches: typeof row.batches === "string" ? JSON.parse(row.batches) : row.batches,
      schedule_type: row.schedule_type,
      scheduled_time: row.scheduled_time,
      scheduled_date: row.scheduled_date,
      scheduled_days: row.scheduled_days,
      timezone: row.timezone,
      ends_type: row.ends_type || "never",
      ends_on_date: row.ends_on_date,
      ends_after_occurrences: row.ends_after_occurrences,
      completed_occurrences: row.completed_occurrences || 0,
      enable_batching: row.enable_batching,
      enable_concurrency: row.enable_concurrency,
      concurrency_count: row.concurrency_count,
      status: row.status,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  },
};
