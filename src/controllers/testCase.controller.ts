import { Request, Response, NextFunction } from 'express';
import { testCaseService } from '../services/testCase.service';
import { userService } from '../services/user.service';
import { teamMemberService } from '../services/teamMember.service';
import { deductCreditsAfterSuccess, CreditRequest } from '../middleware/credits.middleware';

// Simple CSV parser that handles quoted fields with commas
function parseCSV(csvText: string): Record<string, string>[] {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) return []; // Need header + at least 1 row

  // Parse a single CSV line respecting quoted fields
  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const rows: Record<string, string>[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.every(v => !v)) continue; // skip empty rows
    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

export class TestCaseController {
  async getAll(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { agent_id } = req.query;

      let testCases;
      if (agent_id) {
        testCases = await testCaseService.findByAgentId(agent_id as string);
      } else {
        testCases = await testCaseService.findByUserId(effectiveUserId);
      }

      res.json({ testCases });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const testCase = await testCaseService.findById(id);
      
      if (!testCase) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ testCase });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { 
        agent_id, 
        name, 
        scenario, 
        expected_behavior,
        description,
        key_topic,
        test_type,
        category,
        priority,
        test_mode,
        // Persona fields
        persona_type,
        persona_traits,
        voice_accent,
        behavior_modifiers,
        // Security fields
        is_security_test,
        security_test_type,
        sensitive_data_types,
      } = req.body;

      if (!agent_id || !name || !scenario) {
        return res.status(400).json({ error: 'Agent ID, name, and scenario are required' });
      }

      if (!expected_behavior || expected_behavior.trim() === '') {
        return res.status(400).json({ error: 'Expected response is required' });
      }

      const testCase = await testCaseService.create({
        agent_id,
        user_id: effectiveUserId,
        name,
        description,
        scenario,
        expected_behavior,
        key_topic,
        test_type,
        category,
        priority,
        test_mode,
        // Persona fields
        persona_type,
        persona_traits,
        voice_accent,
        behavior_modifiers,
        // Security fields
        is_security_test,
        security_test_type,
        sensitive_data_types,
      });

      // Deduct credits after successful creation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Created test case: ${name}`,
        { testCaseId: testCase.id, agentId: agent_id }
      );

      res.status(201).json({ testCase });
    } catch (error) {
      next(error);
    }
  }

  async createBulk(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      
      // Get the effective user ID (owner's ID for team members)
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { test_cases } = req.body;

      if (!Array.isArray(test_cases) || test_cases.length === 0) {
        return res.status(400).json({ error: 'Test cases array is required' });
      }

      const testCasesWithUser = test_cases.map(tc => ({
        ...tc,
        user_id: effectiveUserId,
      }));

      const created = await testCaseService.createMany(testCasesWithUser);
      
      // Deduct credits after successful creation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Created ${created.length} test cases`,
        { testCaseIds: created.map(tc => tc.id), count: created.length }
      );

      res.status(201).json({ testCases: created });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { name, scenario } = req.body;

      const testCase = await testCaseService.update(id, {
        name,
        scenario,
      });
      
      if (!testCase) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ testCase });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const deleted = await testCaseService.delete(id);
      
      if (!deleted) {
        return res.status(404).json({ error: 'Test case not found' });
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/test-cases/csv-template
   * Returns a downloadable CSV template for importing test cases
   */
  async csvTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const csvContent = [
        'name,scenario,expected_behavior,category,priority',
        'Greeting Test,"User says hello and asks about services","Agent greets warmly and introduces available services",Happy Path,medium',
        'Error Handling,"User provides invalid input like random characters","Agent politely asks user to clarify or rephrase",Edge Cases,high',
        'Callback Request,"User asks to schedule a callback for later","Agent confirms callback request and asks for preferred time",Happy Path,medium',
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="test-cases-template.csv"');
      res.send(csvContent);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/test-cases/import-csv
   * Imports test cases from CSV text content
   * Body: { agent_id: string, csv_content: string }
   */
  async importCSV(req: Request, res: Response, next: NextFunction) {
    try {
      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);
      const effectiveUserId = await teamMemberService.getOwnerUserId(user.id);

      const { agent_id, csv_content } = req.body;

      if (!agent_id) {
        return res.status(400).json({ error: 'agent_id is required' });
      }
      if (!csv_content || typeof csv_content !== 'string') {
        return res.status(400).json({ error: 'csv_content is required and must be a string' });
      }

      const rows = parseCSV(csv_content);

      if (rows.length === 0) {
        return res.status(400).json({ error: 'CSV has no data rows. Please add test cases below the header row.' });
      }

      // Validate required columns exist
      const firstRow = rows[0];
      if (!('name' in firstRow) || !('scenario' in firstRow)) {
        return res.status(400).json({ 
          error: 'CSV must have at least "name" and "scenario" columns. Found columns: ' + Object.keys(firstRow).join(', ')
        });
      }

      // Validate and map rows
      const errors: string[] = [];
      const validTestCases = rows.map((row, idx) => {
        const rowNum = idx + 2; // +2 because 1-indexed + header row
        if (!row.name || !row.name.trim()) {
          errors.push(`Row ${rowNum}: "name" is required`);
          return null;
        }
        if (!row.scenario || !row.scenario.trim()) {
          errors.push(`Row ${rowNum}: "scenario" is required`);
          return null;
        }

        const priority = (row.priority || 'medium').toLowerCase();
        if (!['high', 'medium', 'low'].includes(priority)) {
          errors.push(`Row ${rowNum}: priority must be high, medium, or low (got "${row.priority}")`);
          return null;
        }

        return {
          agent_id,
          user_id: effectiveUserId,
          name: row.name.trim(),
          scenario: row.scenario.trim(),
          expected_behavior: (row.expected_behavior || row.expected_outcome || '').trim() || undefined,
          category: (row.category || 'Imported').trim(),
          priority: priority as 'high' | 'medium' | 'low',
        };
      }).filter(Boolean);

      if (errors.length > 0 && validTestCases.length === 0) {
        return res.status(400).json({ error: 'All rows had errors', details: errors });
      }

      const created = await testCaseService.createMany(validTestCases as any[]);

      // Deduct credits after successful creation
      await deductCreditsAfterSuccess(
        req as CreditRequest,
        `Imported ${created.length} test cases from CSV`,
        { testCaseIds: created.map(tc => tc.id), count: created.length }
      );

      res.status(201).json({ 
        testCases: created,
        imported: created.length,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const testCaseController = new TestCaseController();
