/**
 * check-db-triggers.test.ts
 *
 * End-to-end tests for the scripts/check-db-triggers.sh →
 * scripts/src/verify-db-triggers.mjs pipeline.
 *
 * Two complementary layers of testing:
 *
 * 1. Mock-curl suite (fast, offline)
 *    Intercepts curl via a fake binary in PATH to exercise exit-code and
 *    SQL-payload behaviour without a real database.  The fake binary captures
 *    the --data-raw payload to a file, allowing an assertion that
 *    block_saved_places_truncate is present in the SQL IN (...) filter — the
 *    exact regression the task calls out.
 *
 *    Also covers HTTP 401 / 403 responses (expired or revoked token) to
 *    confirm the script exits 1 with a clear diagnostic rather than silently
 *    passing.  The fake curl reads MOCK_HTTP_STATUS (default "200") so each
 *    test can inject any HTTP status without creating separate workspace
 *    fixtures.
 *
 * 2. Real-database integration suite
 *    Provisions a dedicated schema in the local PostgreSQL instance
 *    (postgresql://postgres@helium:5432/heliumdb), creates the four protection
 *    triggers, runs check-db-triggers.sh in TRIGGER_QUERY_MODE=psql mode, and
 *    asserts:
 *      - exit 0 when all four triggers are present
 *      - exit 1 after block_saved_places_truncate is dropped
 *    This validates the actual DB query path and the shell SQL, not just the
 *    Node.js verify script.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:
 *   pnpm --filter @workspace/scripts run test:db-triggers
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const CHECK_SCRIPT = resolve(
  new URL('../../scripts/check-db-triggers.sh', import.meta.url).pathname,
);

// Local PostgreSQL available in this environment (Replit helium instance).
const LOCAL_PSQL_URL = 'postgresql://postgres@helium:5432/heliumdb';

const ALL_FOUR_TRIGGERS = JSON.stringify([
  { trigger_name: 'enforce_default_collection_no_delete', event_object_table: 'collections' },
  { trigger_name: 'block_collections_truncate',           event_object_table: 'collections' },
  { trigger_name: 'block_collection_items_truncate',      event_object_table: 'collection_items' },
  { trigger_name: 'block_saved_places_truncate',          event_object_table: 'saved_places' },
]);

const MISSING_SAVED_PLACES_TRIGGER = JSON.stringify([
  { trigger_name: 'enforce_default_collection_no_delete', event_object_table: 'collections' },
  { trigger_name: 'block_collections_truncate',           event_object_table: 'collections' },
  { trigger_name: 'block_collection_items_truncate',      event_object_table: 'collection_items' },
  // block_saved_places_truncate intentionally omitted — simulates dropped trigger
]);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temp workspace with:
 *   <root>/artifacts/api-server/.env  — minimal env with a plausible SUPABASE_URL
 *   <root>/bin/curl                   — fake curl that:
 *                                         • captures --data-raw to $CURL_CAPTURE_FILE
 *                                         • returns MOCK_TRIGGER_RESPONSE as HTTP 200
 */
function makeWorkspace(
  base: string,
  name: string,
): { root: string; bin: string; captureFile: string } {
  const root = join(base, name);
  const envDir = join(root, 'artifacts', 'api-server');
  const bin = join(root, 'bin');
  const captureFile = join(root, 'curl-payload.json');

  mkdirSync(envDir, { recursive: true });
  mkdirSync(bin, { recursive: true });

  // Minimal .env — project ref extracted from this URL is "testproject".
  writeFileSync(
    join(envDir, '.env'),
    'SUPABASE_URL=https://testproject.supabase.co\n',
  );

  // Fake curl:
  //   • Iterate args to find the value immediately after --data-raw and write
  //     it to $CURL_CAPTURE_FILE so tests can inspect the exact SQL payload.
  //   • Emit the mock response body + HTTP status code on the last line, which
  //     is exactly the format check-db-triggers.sh expects:
  //       HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
  //       HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)
  const fakeCurl = join(bin, 'curl');
  writeFileSync(
    fakeCurl,
    [
      '#!/usr/bin/env bash',
      'CAPTURE_NEXT=0',
      'for arg in "$@"; do',
      '  if [[ "$CAPTURE_NEXT" == "1" ]]; then',
      '    if [[ -n "${CURL_CAPTURE_FILE:-}" ]]; then',
      '      printf "%s" "$arg" > "$CURL_CAPTURE_FILE"',
      '    fi',
      '    break',
      '  fi',
      '  if [[ "$arg" == "--data-raw" ]]; then',
      '    CAPTURE_NEXT=1',
      '  fi',
      'done',
      'printf "%s\\n${MOCK_HTTP_STATUS:-200}" "$MOCK_TRIGGER_RESPONSE"',
    ].join('\n') + '\n',
  );
  chmodSync(fakeCurl, 0o755);

  return { root, bin, captureFile };
}

function runCheck(opts: {
  root: string;
  bin: string;
  captureFile: string;
  triggerResponse: string;
  /** HTTP status code the fake curl should return. Defaults to 200. */
  mockHttpStatus?: string;
}): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Redirect workspace root to the temp directory with our fake .env.
    CHECK_TRIGGERS_WORKSPACE_ROOT: opts.root,
    // Dummy token so the script doesn't bail on missing credentials.
    SUPABASE_ACCESS_TOKEN: 'test-token-not-used',
    // JSON the fake curl will emit as the response body.
    MOCK_TRIGGER_RESPONSE: opts.triggerResponse,
    // File the fake curl writes its --data-raw payload to.
    CURL_CAPTURE_FILE: opts.captureFile,
    // Prepend our fake curl so it shadows the real one.
    PATH: `${opts.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  if (opts.mockHttpStatus !== undefined) {
    env['MOCK_HTTP_STATUS'] = opts.mockHttpStatus;
  }
  const r = spawnSync('bash', [CHECK_SCRIPT], {
    encoding: 'utf8',
    env,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Run check-db-triggers.sh in psql mode against the local PostgreSQL. */
function runCheckPsql(): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [CHECK_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TRIGGER_QUERY_MODE: 'psql',
      TRIGGER_PSQL_URL: LOCAL_PSQL_URL,
    },
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** Run a SQL statement against the local PostgreSQL test database. */
function psql(sql: string): void {
  const r = spawnSync('psql', [LOCAL_PSQL_URL, '-c', sql], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(
      `psql failed (exit ${r.status}):\n${r.stderr}\nSQL: ${sql}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: mock-curl tests (offline, fast)
// ═══════════════════════════════════════════════════════════════════════════════

describe('check-db-triggers.sh + verify-db-triggers.mjs pipeline (mock curl)', () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `db-triggers-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ── SQL query inspection ───────────────────────────────────────────────────
  // Guards against a regression in the shell script's SQL: if a trigger name
  // is removed from the IN (...) clause, the check would silently stop querying
  // for it.  We capture the exact payload the script sends to curl and assert
  // every required trigger name is in the WHERE clause.

  test('SQL sent to the API includes block_saved_places_truncate in the IN (...) filter', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'sql-inspection');

    runCheck({ root, bin, captureFile, triggerResponse: ALL_FOUR_TRIGGERS });

    assert.ok(
      existsSync(captureFile),
      `Expected fake curl to write the request payload to ${captureFile}`,
    );

    const payload = readFileSync(captureFile, 'utf8');

    const REQUIRED_IN_SQL = [
      'enforce_default_collection_no_delete',
      'block_collections_truncate',
      'block_collection_items_truncate',
      'block_saved_places_truncate',
    ];

    for (const triggerName of REQUIRED_IN_SQL) {
      assert.ok(
        payload.includes(triggerName),
        `Expected the Supabase query payload to include "${triggerName}" in the ` +
          `IN (...) filter, but it was absent.\nPayload: ${payload}`,
      );
    }
  });

  // ── green path ─────────────────────────────────────────────────────────────

  test('exits 0 when all four triggers are present (including block_saved_places_truncate)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'all-present');

    const result = runCheck({ root, bin, captureFile, triggerResponse: ALL_FOUR_TRIGGERS });

    assert.equal(
      result.status,
      0,
      `Expected exit 0 when all triggers present but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('block_saved_places_truncate'),
      `Expected "block_saved_places_truncate" in success output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── missing block_saved_places_truncate ─────────────────────────────────────

  test('exits 1 when block_saved_places_truncate is absent from the database', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'missing-saved-places');

    const result = runCheck({ root, bin, captureFile, triggerResponse: MISSING_SAVED_PLACES_TRIGGER });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 when block_saved_places_truncate is missing but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('block_saved_places_truncate'),
      `Expected "block_saved_places_truncate" to appear in the failure output.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('MISSING'),
      `Expected "MISSING" in failure output.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── missing any trigger still fails ─────────────────────────────────────────

  test('exits 1 when the response is an empty array (no triggers at all)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'empty-response');

    const result = runCheck({ root, bin, captureFile, triggerResponse: '[]' });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for empty trigger list but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── malformed API response ───────────────────────────────────────────────────

  test('exits 1 when the API response is not valid JSON', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'bad-json');

    const result = runCheck({ root, bin, captureFile, triggerResponse: 'not-json' });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for malformed JSON response but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── expired / revoked token (HTTP 401 / 403) ─────────────────────────────────
  // The Supabase Management API returns 401 for an expired token and 403 for a
  // token that has been revoked or lacks permissions.  The script must exit 1
  // with a message that includes the HTTP status code and tells the operator
  // which token variable to check.

  test('exits 1 with an actionable message when the API returns HTTP 401 (expired token)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'http-401');
    const errorBody = JSON.stringify({ message: 'JWT expired' });

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: errorBody,
      mockHttpStatus: '401',
    });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for HTTP 401 but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('401'),
      `Expected "401" in output for expired-token case.\nCombined:\n${combined}`,
    );
    assert.ok(
      combined.includes('Verify'),
      `Expected "Verify" guidance in output for expired-token case.\nCombined:\n${combined}`,
    );
  });

  test('exits 1 with an actionable message when the API returns HTTP 403 (revoked token)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'http-403');
    const errorBody = JSON.stringify({ message: 'Forbidden' });

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: errorBody,
      mockHttpStatus: '403',
    });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for HTTP 403 but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('403'),
      `Expected "403" in output for revoked-token case.\nCombined:\n${combined}`,
    );
    assert.ok(
      combined.includes('Verify'),
      `Expected "Verify" guidance in output for revoked-token case.\nCombined:\n${combined}`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: real-database integration tests (TRIGGER_QUERY_MODE=psql)
//
// Provisions a dedicated schema in the local PostgreSQL instance, creates the
// four required protection triggers, then exercises the full shell → Node.js
// pipeline against real DB state — confirming the actual SQL in
// check-db-triggers.sh correctly queries pg_trigger.
// ═══════════════════════════════════════════════════════════════════════════════

describe('check-db-triggers.sh — real PostgreSQL integration (TRIGGER_QUERY_MODE=psql)', () => {
  // Unique schema name so parallel test runs and leftover state don't interfere.
  const schema = `dbt_test_${Date.now()}`;

  before(() => {
    // Create an isolated schema with the four tables and trigger functions
    // needed to host the protection triggers.  The trigger bodies are no-ops
    // because we only care about the trigger names being present in pg_trigger,
    // not about their runtime behaviour.
    psql(`
      CREATE SCHEMA ${schema};

      CREATE TABLE ${schema}.collections        (id serial PRIMARY KEY);
      CREATE TABLE ${schema}.collection_items   (id serial PRIMARY KEY);
      CREATE TABLE ${schema}.saved_places       (id serial PRIMARY KEY);

      CREATE FUNCTION ${schema}.block_truncate()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'blocked by test trigger'; END;
        $$;

      CREATE TRIGGER enforce_default_collection_no_delete
        BEFORE DELETE ON ${schema}.collections
        FOR EACH ROW EXECUTE FUNCTION ${schema}.block_truncate();

      CREATE TRIGGER block_collections_truncate
        BEFORE TRUNCATE ON ${schema}.collections
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.block_truncate();

      CREATE TRIGGER block_collection_items_truncate
        BEFORE TRUNCATE ON ${schema}.collection_items
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.block_truncate();

      CREATE TRIGGER block_saved_places_truncate
        BEFORE TRUNCATE ON ${schema}.saved_places
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.block_truncate();
    `);
  });

  after(() => {
    // Drop the entire schema (CASCADE removes tables, functions, triggers).
    try {
      psql(`DROP SCHEMA ${schema} CASCADE;`);
    } catch {
      // Non-fatal — test isolation is best-effort on cleanup.
    }
  });

  test('exits 0 when all four triggers exist in the database', () => {
    const result = runCheckPsql();

    assert.equal(
      result.status,
      0,
      `Expected exit 0 with all four triggers present but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('block_saved_places_truncate'),
      `Expected confirmation of block_saved_places_truncate in output.\nStdout:\n${result.stdout}`,
    );
  });

  test('exits 1 after block_saved_places_truncate is dropped from the database', () => {
    // Drop the trigger from the real table — this simulates a missed migration.
    psql(`DROP TRIGGER block_saved_places_truncate ON ${schema}.saved_places;`);

    const result = runCheckPsql();

    assert.equal(
      result.status,
      1,
      `Expected exit 1 after dropping block_saved_places_truncate but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('block_saved_places_truncate'),
      `Expected "block_saved_places_truncate" to be named in the failure output.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('MISSING'),
      `Expected "MISSING" keyword in failure output.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  test('exits 0 again after block_saved_places_truncate is re-created', () => {
    // Re-create the trigger — simulates applying the missing migration.
    psql(`
      CREATE TRIGGER block_saved_places_truncate
        BEFORE TRUNCATE ON ${schema}.saved_places
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.block_truncate();
    `);

    const result = runCheckPsql();

    assert.equal(
      result.status,
      0,
      `Expected exit 0 after re-creating block_saved_places_truncate but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('block_saved_places_truncate'),
      `Expected confirmation of block_saved_places_truncate in output.\nStdout:\n${result.stdout}`,
    );
  });
});
