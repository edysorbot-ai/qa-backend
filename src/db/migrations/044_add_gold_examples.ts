import { Pool } from 'pg';

/**
 * Gold examples ("acceptable" + "unacceptable" reference conversations) per test case.
 *
 * gold_gate semantics on test_cases:
 *   - 'soft'   → execution allowed even without approved examples. If approved
 *                examples exist they are injected into the evaluator prompt; if
 *                not, the rubric alone is used. Default for auto-seeded /
 *                AI-generated cases (they already have strong rubrics).
 *   - 'strict' → execution is BLOCKED until BOTH acceptable + unacceptable
 *                examples are approved. Default for manually authored cases.
 *
 * created_via tracks origin so the gate can be assigned automatically.
 */
export async function up(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE test_cases
      ADD COLUMN IF NOT EXISTS gold_gate TEXT DEFAULT 'soft',
      ADD COLUMN IF NOT EXISTS created_via TEXT DEFAULT 'manual';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_case_gold_examples (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_case_id UUID NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('acceptable', 'unacceptable')),
      transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
      approved_by TEXT,
      approved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (test_case_id, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_gold_examples_test_case
      ON test_case_gold_examples(test_case_id);
    CREATE INDEX IF NOT EXISTS idx_gold_examples_status
      ON test_case_gold_examples(test_case_id, status);
  `);

  console.log('[Migration 044] test_case_gold_examples table + gate columns ready');
}

export async function down(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS test_case_gold_examples CASCADE;');
  await pool.query(`
    ALTER TABLE test_cases
      DROP COLUMN IF EXISTS gold_gate,
      DROP COLUMN IF EXISTS created_via;
  `);
}
