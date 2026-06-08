import { Request, Response, NextFunction } from 'express';
import { goldExampleService, GoldKind, GoldTurn } from '../services/goldExample.service';
import { goldExampleGeneratorService } from '../services/gold-example-generator.service';
import { testCaseService } from '../services/testCase.service';
import { agentService } from '../services/agent.service';
import { userService } from '../services/user.service';

function isValidKind(k: any): k is GoldKind {
  return k === 'acceptable' || k === 'unacceptable';
}

function sanitizeTranscript(input: any): GoldTurn[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((t: any) => ({
      speaker: t?.speaker === 'agent' ? 'agent' as const : 'user' as const,
      content: typeof t?.content === 'string' ? t.content.trim() : '',
      ...(typeof t?.note === 'string' && t.note.trim() ? { note: t.note.trim() } : {}),
    }))
    .filter(t => t.content.length > 0);
}

export class GoldExampleController {
  /** GET /api/test-cases/:id/gold-examples */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const tc = await testCaseService.findById(id);
      if (!tc) return res.status(404).json({ error: 'Test case not found' });
      const examples = await goldExampleService.listByTestCase(id);
      const bothApproved = examples.filter(e => e.status === 'approved').length >= 2;
      res.json({
        testCaseId: id,
        gold_gate: (tc as any).gold_gate || 'soft',
        runnable: ((tc as any).gold_gate || 'soft') === 'soft' || bothApproved,
        examples,
      });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/test-cases/:id/gold-examples/generate
   *  Body: { kind?: 'acceptable' | 'unacceptable' | 'both' (default 'both') }
   *  Drafts examples via gpt-4o-mini. Does NOT approve them.
   */
  async generate(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const kindParam = (req.body?.kind || 'both') as string;

      const tc = await testCaseService.findById(id);
      if (!tc) return res.status(404).json({ error: 'Test case not found' });

      // Optional agent prompt for tone/domain context.
      let agentPrompt: string | null = null;
      if (tc.agent_id) {
        const agent = await agentService.findById(tc.agent_id);
        agentPrompt = (agent as any)?.prompt || null;
      }

      const results: Record<string, any> = {};

      if (kindParam === 'both' || kindParam === 'acceptable') {
        const turns = await goldExampleGeneratorService.generateOne(tc, agentPrompt, 'acceptable');
        const saved = await goldExampleService.upsertDraft(id, 'acceptable', turns);
        results.acceptable = saved;
      }
      if (kindParam === 'both' || kindParam === 'unacceptable') {
        const turns = await goldExampleGeneratorService.generateOne(tc, agentPrompt, 'unacceptable');
        const saved = await goldExampleService.upsertDraft(id, 'unacceptable', turns);
        results.unacceptable = saved;
      }

      res.json({ testCaseId: id, generated: results });
    } catch (err) {
      next(err);
    }
  }

  /** PUT /api/test-cases/:id/gold-examples/:kind
   *  Body: { transcript: GoldTurn[], notes?: string }
   *  Saves an edited draft. Resets status back to 'draft' if it was approved.
   */
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, kind } = req.params;
      if (!isValidKind(kind)) return res.status(400).json({ error: 'kind must be acceptable or unacceptable' });

      const transcript = sanitizeTranscript(req.body?.transcript);
      if (transcript.length < 2) {
        return res.status(400).json({ error: 'transcript must have at least 2 turns' });
      }
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;

      const tc = await testCaseService.findById(id);
      if (!tc) return res.status(404).json({ error: 'Test case not found' });

      const saved = await goldExampleService.upsertDraft(id, kind, transcript, notes);
      res.json({ example: saved });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/test-cases/:id/gold-examples/:kind/approve */
  async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, kind } = req.params;
      if (!isValidKind(kind)) return res.status(400).json({ error: 'kind must be acceptable or unacceptable' });

      const clerkUser = (req as any).auth;
      const user = await userService.findOrCreateByClerkId(clerkUser.userId);

      const existing = await goldExampleService.listByTestCase(id);
      const target = existing.find(e => e.kind === kind);
      if (!target) {
        return res.status(404).json({ error: 'No draft to approve. Generate one first.' });
      }

      const saved = await goldExampleService.approve(id, kind, user.id);
      res.json({ example: saved });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/test-cases/:id/gold-examples/:kind/unapprove */
  async unapprove(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, kind } = req.params;
      if (!isValidKind(kind)) return res.status(400).json({ error: 'kind must be acceptable or unacceptable' });
      const saved = await goldExampleService.unapprove(id, kind);
      res.json({ example: saved });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/test-cases/:id/gold-examples/:kind */
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const { id, kind } = req.params;
      if (!isValidKind(kind)) return res.status(400).json({ error: 'kind must be acceptable or unacceptable' });
      const ok = await goldExampleService.delete(id, kind);
      res.json({ deleted: ok });
    } catch (err) {
      next(err);
    }
  }
}

export const goldExampleController = new GoldExampleController();
