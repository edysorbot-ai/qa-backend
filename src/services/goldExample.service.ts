import { query } from '../db';

export type GoldKind = 'acceptable' | 'unacceptable';
export type GoldStatus = 'draft' | 'approved';

export interface GoldTurn {
  speaker: 'user' | 'agent';
  content: string;
  note?: string;
}

export interface GoldExample {
  id: string;
  test_case_id: string;
  kind: GoldKind;
  transcript: GoldTurn[];
  notes: string | null;
  status: GoldStatus;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToExample(row: any): GoldExample {
  const transcript = Array.isArray(row.transcript)
    ? row.transcript
    : (typeof row.transcript === 'string' ? JSON.parse(row.transcript) : []);
  return {
    id: row.id,
    test_case_id: row.test_case_id,
    kind: row.kind,
    transcript,
    notes: row.notes ?? null,
    status: row.status,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class GoldExampleService {
  async listByTestCase(testCaseId: string): Promise<GoldExample[]> {
    const r = await query(
      `SELECT * FROM test_case_gold_examples WHERE test_case_id = $1 ORDER BY kind`,
      [testCaseId],
    );
    return r.rows.map(rowToExample);
  }

  async listByTestCaseIds(testCaseIds: string[]): Promise<Map<string, GoldExample[]>> {
    const map = new Map<string, GoldExample[]>();
    if (testCaseIds.length === 0) return map;
    const r = await query(
      `SELECT * FROM test_case_gold_examples WHERE test_case_id = ANY($1::uuid[])`,
      [testCaseIds],
    );
    for (const row of r.rows) {
      const e = rowToExample(row);
      const arr = map.get(e.test_case_id) || [];
      arr.push(e);
      map.set(e.test_case_id, arr);
    }
    return map;
  }

  async upsertDraft(
    testCaseId: string,
    kind: GoldKind,
    transcript: GoldTurn[],
    notes?: string | null,
  ): Promise<GoldExample> {
    const r = await query(
      `INSERT INTO test_case_gold_examples (test_case_id, kind, transcript, notes, status)
       VALUES ($1, $2, $3::jsonb, $4, 'draft')
       ON CONFLICT (test_case_id, kind)
       DO UPDATE SET transcript = EXCLUDED.transcript,
                     notes      = EXCLUDED.notes,
                     status     = 'draft',
                     approved_by = NULL,
                     approved_at = NULL,
                     updated_at = NOW()
       RETURNING *`,
      [testCaseId, kind, JSON.stringify(transcript), notes ?? null],
    );
    return rowToExample(r.rows[0]);
  }

  async updateTranscript(
    testCaseId: string,
    kind: GoldKind,
    transcript: GoldTurn[],
    notes?: string | null,
  ): Promise<GoldExample | null> {
    const r = await query(
      `UPDATE test_case_gold_examples
         SET transcript = $3::jsonb,
             notes      = COALESCE($4, notes),
             status     = 'draft',
             approved_by = NULL,
             approved_at = NULL,
             updated_at = NOW()
       WHERE test_case_id = $1 AND kind = $2
       RETURNING *`,
      [testCaseId, kind, JSON.stringify(transcript), notes ?? null],
    );
    return r.rows[0] ? rowToExample(r.rows[0]) : null;
  }

  async approve(testCaseId: string, kind: GoldKind, userId: string): Promise<GoldExample | null> {
    const r = await query(
      `UPDATE test_case_gold_examples
         SET status = 'approved',
             approved_by = $3,
             approved_at = NOW(),
             updated_at = NOW()
       WHERE test_case_id = $1 AND kind = $2
       RETURNING *`,
      [testCaseId, kind, userId],
    );
    return r.rows[0] ? rowToExample(r.rows[0]) : null;
  }

  async unapprove(testCaseId: string, kind: GoldKind): Promise<GoldExample | null> {
    const r = await query(
      `UPDATE test_case_gold_examples
         SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = NOW()
       WHERE test_case_id = $1 AND kind = $2
       RETURNING *`,
      [testCaseId, kind],
    );
    return r.rows[0] ? rowToExample(r.rows[0]) : null;
  }

  async delete(testCaseId: string, kind: GoldKind): Promise<boolean> {
    const r = await query(
      `DELETE FROM test_case_gold_examples WHERE test_case_id = $1 AND kind = $2`,
      [testCaseId, kind],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Both kinds approved for this test case. */
  async hasBothApproved(testCaseId: string): Promise<boolean> {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM test_case_gold_examples
        WHERE test_case_id = $1 AND status = 'approved'`,
      [testCaseId],
    );
    return (r.rows[0]?.n ?? 0) >= 2;
  }
}

export const goldExampleService = new GoldExampleService();
