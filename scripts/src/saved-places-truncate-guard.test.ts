/**
 * saved-places-truncate-guard.test.ts
 *
 * Runtime smoke test that applies the TRUNCATE guard from the actual migration
 * file (artifacts/api-server/src/migrations/0074_protect_saved_places.sql)
 * and asserts that TRUNCATE saved_places raises SQLSTATE 23000.
 *
 * WHY this is distinct from check-db-triggers.test.ts
 * ─────────────────────────────────────────────────────
 * check-db-triggers.test.ts only verifies that the trigger *name* appears in
 * pg_trigger (catalog check).  A malformed EXECUTE FUNCTION reference or a
 * wrong ERRCODE in the trigger body passes the catalog check but silently
 * fails to protect data at runtime.
 *
 * This test loads the DDL for `prevent_saved_places_truncate()` and
 * `block_saved_places_truncate` directly from the migration file so that any
 * change to those objects (wrong ERRCODE, renamed function, etc.) is caught
 * here, not just in production.
 *
 * HOW the migration SQL is applied
 * ──────────────────────────────────
 * Migration 0074 references auth.users, discovery_places, and auth.uid() which
 * are Supabase-managed objects absent from the local helium test database.
 * Only the last section of the migration — everything after the
 * "── TRUNCATE guard ──" separator — is needed: the function body and the
 * trigger that calls it.  We extract that portion from the real migration file
 * at test runtime and apply it to an isolated schema containing a minimal
 * saved_places table (no FK constraints), using SET search_path so the
 * unqualified object names resolve correctly.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:
 *   pnpm --filter @workspace/scripts run test:truncate-guard
 *
 * Requires a local PostgreSQL instance at:
 *   postgresql://postgres@helium:5432/heliumdb
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where to run the DDL smoke test.
 *
 * Defaults to the Replit-local instance so `pnpm test:truncate-guard` keeps
 * working unchanged on a dev box. CI has no host called `helium`, so the
 * unwired workflow runs a postgres:16 service container and points
 * TRUNCATE_GUARD_DATABASE_URL at it.
 *
 * There is deliberately NO skip-when-unset branch. This test exists because a
 * catalog check cannot tell a working guard from a malformed one, so a silent
 * skip would restore exactly the blind spot it was written to close — the suite
 * would go green while proving nothing about whether saved_places is
 * protected. If the database is unreachable the test fails, loudly.
 */
const LOCAL_PSQL_URL =
  process.env['TRUNCATE_GUARD_DATABASE_URL']?.trim() ||
  'postgresql://postgres@helium:5432/heliumdb';

const MIGRATION_FILE = resolve(
  new URL(
    '../../artifacts/api-server/src/migrations/0074_protect_saved_places.sql',
    import.meta.url,
  ).pathname,
);

/**
 * Extract the TRUNCATE-guard section from migration 0074.
 *
 * The section starts at the "── TRUNCATE guard ──" banner comment and
 * contains exactly:
 *   • CREATE OR REPLACE FUNCTION prevent_saved_places_truncate()
 *   • DROP TRIGGER IF EXISTS ...
 *   • CREATE TRIGGER block_saved_places_truncate
 *
 * We stop before any trailing content so we don't accidentally include
 * unrelated DDL added in future migrations.
 */
function extractTruncateGuardDDL(): string {
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  const SEPARATOR = '-- ── TRUNCATE guard';
  const idx = sql.indexOf(SEPARATOR);
  assert.ok(
    idx !== -1,
    `Could not find the TRUNCATE guard section in ${MIGRATION_FILE}.\n` +
      `Expected a comment matching "${SEPARATOR}". ` +
      `Has the migration file been restructured?`,
  );
  return sql.slice(idx);
}

/** Run SQL against the local PostgreSQL test database and return all output. */
function psql(sql: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('psql', [LOCAL_PSQL_URL, '-c', sql], {
    encoding: 'utf8',
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Like psql() but throws on non-zero exit — used in before/after hooks. */
function psqlOrThrow(sql: string): void {
  const r = psql(sql);
  if (r.status !== 0) {
    throw new Error(
      `psql failed (exit ${r.status}):\n${r.stderr}\nSQL: ${sql}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Smoke test suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('saved_places TRUNCATE guard — migration DDL runtime smoke test', () => {
  // Unique schema per run so parallel invocations and leftover state cannot
  // interfere.
  const schema = `sp_truncate_smoke_${Date.now()}`;

  // The guard DDL read from the actual migration file — this is what we apply.
  let guardDDL: string;

  before(() => {
    // Read the TRUNCATE guard DDL directly from migration 0074.
    // If this assertion throws the test run fails immediately with a clear
    // message rather than silently falling back to a hand-crafted copy.
    guardDDL = extractTruncateGuardDDL();

    // 1. Create an isolated schema.
    // 2. Create a minimal saved_places table with no FK constraints (the FKs
    //    reference auth.users and discovery_places which don't exist in the
    //    local helium DB; they are irrelevant to the TRUNCATE guard).
    // 3. Apply the TRUNCATE guard DDL from the real migration using
    //    SET search_path so the unqualified names resolve into our schema.
    // 4. Seed one row so the DELETE test has something to delete.
    psqlOrThrow(`
      CREATE SCHEMA "${schema}";

      CREATE TABLE "${schema}".saved_places (
        id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id  uuid NOT NULL,
        place_id uuid NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, place_id)
      );
    `);

    // Apply the function + trigger directly from the migration file, with
    // search_path pointed at the test schema so the unqualified object names
    // land in the right place.
    psqlOrThrow(`
      SET search_path = "${schema}";
      ${guardDDL}
    `);

    // Seed one row so the DELETE test has data to remove.
    psqlOrThrow(`
      INSERT INTO "${schema}".saved_places (user_id, place_id)
        VALUES (gen_random_uuid(), gen_random_uuid());
    `);
  });

  after(() => {
    try {
      psqlOrThrow(`DROP SCHEMA "${schema}" CASCADE;`);
    } catch {
      // Non-fatal — best-effort cleanup.
    }
  });

  // ── main guard test ─────────────────────────────────────────────────────────
  // Uses a PL/pgSQL DO block to assert the SQLSTATE at the language level so
  // the assertion is independent of psql verbosity settings or output format.

  test('TRUNCATE saved_places is blocked with SQLSTATE 23000 (integrity_constraint_violation)', () => {
    // The DO block:
    //   • Issues TRUNCATE against the table equipped with the migration trigger.
    //   • WHEN integrity_constraint_violation (SQLSTATE 23000) — trigger fired
    //     with the correct error class: pass.
    //   • WHEN others — trigger fired but with a different SQLSTATE: fail with
    //     the actual SQLSTATE so the developer can see what changed.
    //   • No exception raised — TRUNCATE silently succeeded: fail.
    const result = psql(`
      SET search_path = "${schema}";
      DO $$
      DECLARE
        triggered boolean := false;
      BEGIN
        BEGIN
          TRUNCATE saved_places;
          -- Reaching here means the trigger did not fire.
          RAISE EXCEPTION
            'TRUNCATE succeeded without raising an exception. '
            'The block_saved_places_truncate trigger is missing or malformed. '
            'Check migration 0074_protect_saved_places.sql.';
        EXCEPTION
          WHEN integrity_constraint_violation THEN
            -- SQLSTATE 23000: exactly what the migration specifies.
            triggered := true;
          WHEN others THEN
            RAISE EXCEPTION
              'TRUNCATE was blocked but raised unexpected SQLSTATE % (%). '
              'Expected integrity_constraint_violation (23000) as set by '
              'USING ERRCODE = ''23000'' in prevent_saved_places_truncate().',
              SQLSTATE, SQLERRM;
        END;

        IF NOT triggered THEN
          RAISE EXCEPTION
            'Assertion failure: integrity_constraint_violation branch not reached.';
        END IF;
      END;
      $$;
    `);

    assert.equal(
      result.status,
      0,
      `Expected the DO block to succeed (migration trigger fires with SQLSTATE 23000) ` +
        `but psql exited ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── DELETE is not blocked ───────────────────────────────────────────────────

  test('DELETE FROM saved_places is NOT blocked by the TRUNCATE guard', () => {
    // Re-seed in case a previous TRUNCATE was attempted and failed (leaving the
    // original row intact) — ensures there is always a row to delete.
    psqlOrThrow(`
      INSERT INTO "${schema}".saved_places (user_id, place_id)
        VALUES (gen_random_uuid(), gen_random_uuid())
        ON CONFLICT DO NOTHING;
    `);

    const result = psql(`DELETE FROM "${schema}".saved_places;`);

    assert.equal(
      result.status,
      0,
      `Expected DELETE to succeed (the TRUNCATE guard must not block row-level deletes) ` +
        `but psql exited ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── idempotent re-apply ─────────────────────────────────────────────────────
  // Verifies that running the migration guard DDL a second time (CREATE OR
  // REPLACE + DROP/CREATE trigger) does not break the guard — this mirrors a
  // migration that is re-applied after a failed deployment.

  test('TRUNCATE is still blocked after the migration DDL is re-applied (idempotent re-run)', () => {
    // Re-apply the exact guard DDL from the migration file a second time.
    psqlOrThrow(`
      SET search_path = "${schema}";
      ${guardDDL}
    `);

    const result = psql(`
      SET search_path = "${schema}";
      DO $$
      BEGIN
        BEGIN
          TRUNCATE saved_places;
          RAISE EXCEPTION
            'TRUNCATE succeeded after re-apply — trigger no longer blocking.';
        EXCEPTION
          WHEN integrity_constraint_violation THEN
            NULL; -- SQLSTATE 23000: correct.
          WHEN others THEN
            RAISE EXCEPTION
              'TRUNCATE blocked but wrong SQLSTATE % (%) after re-apply; expected 23000.',
              SQLSTATE, SQLERRM;
        END;
      END;
      $$;
    `);

    assert.equal(
      result.status,
      0,
      `Expected the guard to still fire with SQLSTATE 23000 after re-applying migration DDL ` +
        `but psql exited ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });
});
