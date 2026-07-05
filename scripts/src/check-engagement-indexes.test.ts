/**
 * check-engagement-indexes.test.ts
 *
 * Tests for the scripts/check-engagement-indexes.sh →
 * scripts/src/verify-db-engagement-indexes.mjs pipeline.
 *
 * Two complementary layers of testing:
 *
 * 1. Mock-curl suite (fast, offline)
 *    Intercepts curl via a fake binary in PATH to exercise exit-code and
 *    SQL-payload behaviour without a real database.  The fake binary captures
 *    the --data-raw payload to a file, allowing an assertion that all five
 *    engagement index names are present in the SQL IN (...) filter — catching
 *    regressions where an index name is silently dropped from the query.
 *
 *    Also covers the no-token skip path, HTTP 401/403 error responses, and
 *    malformed JSON — confirming the script exits with the correct code and
 *    message in each case.
 *
 * 2. Real-database integration suite (ENGAGEMENT_QUERY_MODE=psql)
 *    Provisions a dedicated schema in the local PostgreSQL instance
 *    (postgresql://postgres@helium:5432/heliumdb), creates the five indexes,
 *    runs check-engagement-indexes.sh in psql mode, and asserts:
 *      - exit 0 when all five indexes are present
 *      - exit 1 after one index is dropped
 *      - exit 0 after the index is re-created
 *    This validates the actual DB query path, not just the Node.js verify script.
 *
 * Uses Node.js built-in test runner (Node 20+).
 * Run:
 *   pnpm --filter @workspace/scripts run test:engagement-indexes
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
  new URL('../../scripts/check-engagement-indexes.sh', import.meta.url).pathname,
);

const LOCAL_PSQL_URL = 'postgresql://postgres@helium:5432/heliumdb';

const ALL_TEN_INDEXES = JSON.stringify([
  // migration 0106 — post-perspective (cursor-based pagination)
  { indexname: 'idx_posts_likes_post_created' },
  { indexname: 'idx_post_reactions_post_emoji_created' },
  { indexname: 'idx_comment_likes_comment_created' },
  { indexname: 'idx_highlight_likes_highlight_created' },
  { indexname: 'idx_memory_likes_memory_created' },
  // migration 0123 — user-perspective (profile pages + liked-by-me feed)
  { indexname: 'idx_posts_likes_user_created' },
  { indexname: 'idx_post_reactions_user_created' },
  { indexname: 'idx_comment_likes_user_created' },
  { indexname: 'idx_highlight_likes_user_created' },
  { indexname: 'idx_memory_likes_user_created' },
]);

const MISSING_ONE_INDEX = JSON.stringify([
  { indexname: 'idx_posts_likes_post_created' },
  { indexname: 'idx_post_reactions_post_emoji_created' },
  { indexname: 'idx_comment_likes_comment_created' },
  { indexname: 'idx_highlight_likes_highlight_created' },
  // idx_memory_likes_memory_created intentionally omitted
  { indexname: 'idx_posts_likes_user_created' },
  { indexname: 'idx_post_reactions_user_created' },
  { indexname: 'idx_comment_likes_user_created' },
  { indexname: 'idx_highlight_likes_user_created' },
  { indexname: 'idx_memory_likes_user_created' },
]);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temp workspace with:
 *   <root>/artifacts/api-server/.env  — minimal env with a plausible SUPABASE_URL
 *   <root>/bin/curl                   — fake curl that:
 *                                         • captures --data-raw to $CURL_CAPTURE_FILE
 *                                         • returns MOCK_INDEX_RESPONSE as the body
 *                                           followed by MOCK_HTTP_STATUS on the last line
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

  // Fake curl mirrors the format check-engagement-indexes.sh expects:
  //   HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
  //   HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)
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
      'printf "%s\\n${MOCK_HTTP_STATUS:-200}" "$MOCK_INDEX_RESPONSE"',
    ].join('\n') + '\n',
  );
  chmodSync(fakeCurl, 0o755);

  return { root, bin, captureFile };
}

function runCheck(opts: {
  root: string;
  bin: string;
  captureFile: string;
  indexResponse: string;
  /** HTTP status code the fake curl should return. Defaults to 200. */
  mockHttpStatus?: string;
  /** If true, omit SUPABASE_ACCESS_TOKEN so the no-token path is exercised. */
  noToken?: boolean;
}): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CHECK_ENGAGEMENT_WORKSPACE_ROOT: opts.root,
    MOCK_INDEX_RESPONSE: opts.indexResponse,
    CURL_CAPTURE_FILE: opts.captureFile,
    PATH: `${opts.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  if (!opts.noToken) {
    env['SUPABASE_ACCESS_TOKEN'] = 'test-token-not-used';
  } else {
    delete env['SUPABASE_ACCESS_TOKEN'];
    delete env['SUPABASE_PROJECT_TOKEN'];
  }
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

/** Run check-engagement-indexes.sh in psql mode against the local PostgreSQL. */
function runCheckPsql(schemaFilter: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bash', [CHECK_SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ENGAGEMENT_QUERY_MODE: 'psql',
      ENGAGEMENT_PSQL_URL: LOCAL_PSQL_URL,
      // Override the schema so the check targets the isolated test schema
      // instead of 'public', avoiding conflicts with production objects.
      ENGAGEMENT_SCHEMA_FILTER: schemaFilter,
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

describe('check-engagement-indexes.sh + verify-db-engagement-indexes.mjs pipeline (mock curl)', () => {
  let tmpBase: string;

  before(() => {
    tmpBase = join(tmpdir(), `engagement-indexes-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // ── no-token skip path ────────────────────────────────────────────────────
  // When neither SUPABASE_ACCESS_TOKEN nor SUPABASE_PROJECT_TOKEN is set the
  // script should exit 0 (skip) with a warning — it must never block a
  // developer who doesn't have Supabase credentials configured locally.

  test('exits 0 with a warning when no Supabase token is set', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'no-token');

    const result = runCheck({
      root,
      bin,
      captureFile,
      indexResponse: ALL_TEN_INDEXES,
      noToken: true,
    });

    assert.equal(
      result.status,
      0,
      `Expected exit 0 (skip) when no token is set but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('skipping') || combined.includes('No Supabase token') || combined.includes('⚠'),
      `Expected a warning/skip message when no token is set.\nCombined:\n${combined}`,
    );
  });

  // ── SQL query inspection ───────────────────────────────────────────────────
  // Guards against a regression in the shell script's SQL: if an index name
  // is removed from the IN (...) clause the check would silently stop querying
  // for it.  We capture the exact payload the script sends to curl and assert
  // every required index name is present in the WHERE clause.

  test('SQL sent to the API includes all ten engagement index names in the IN (...) filter', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'sql-inspection');

    runCheck({ root, bin, captureFile, indexResponse: ALL_TEN_INDEXES });

    assert.ok(
      existsSync(captureFile),
      `Expected fake curl to write the request payload to ${captureFile}`,
    );

    const payload = readFileSync(captureFile, 'utf8');

    const REQUIRED_IN_SQL = [
      // migration 0106 — post-perspective
      'idx_posts_likes_post_created',
      'idx_post_reactions_post_emoji_created',
      'idx_comment_likes_comment_created',
      'idx_highlight_likes_highlight_created',
      'idx_memory_likes_memory_created',
      // migration 0123 — user-perspective
      'idx_posts_likes_user_created',
      'idx_post_reactions_user_created',
      'idx_comment_likes_user_created',
      'idx_highlight_likes_user_created',
      'idx_memory_likes_user_created',
    ];

    for (const indexName of REQUIRED_IN_SQL) {
      assert.ok(
        payload.includes(indexName),
        `Expected the Supabase query payload to include "${indexName}" in the ` +
          `IN (...) filter, but it was absent.\nPayload: ${payload}`,
      );
    }
  });

  // ── green path ─────────────────────────────────────────────────────────────

  test('exits 0 when all ten indexes are present', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'all-present');

    const result = runCheck({ root, bin, captureFile, indexResponse: ALL_TEN_INDEXES });

    assert.equal(
      result.status,
      0,
      `Expected exit 0 when all indexes present but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('idx_memory_likes_memory_created'),
      `Expected "idx_memory_likes_memory_created" in success output.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('idx_memory_likes_user_created'),
      `Expected "idx_memory_likes_user_created" (migration 0123) in success output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── one index missing ──────────────────────────────────────────────────────

  test('exits 1 and names the missing index when idx_memory_likes_memory_created is absent', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'missing-one');

    const result = runCheck({ root, bin, captureFile, indexResponse: MISSING_ONE_INDEX });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 when an index is missing but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('idx_memory_likes_memory_created'),
      `Expected the missing index name in failure output.\nCombined:\n${combined}`,
    );
    assert.ok(
      combined.includes('MISSING'),
      `Expected "MISSING" keyword in failure output.\nCombined:\n${combined}`,
    );
  });

  // ── remediation hint ───────────────────────────────────────────────────────

  test('includes both migration file paths in the remediation hint when all indexes are absent', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'remediation-hint');

    const result = runCheck({ root, bin, captureFile, indexResponse: '[]' });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for empty index list but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('0106'),
      `Expected migration "0106" reference in remediation hint.\nCombined:\n${combined}`,
    );
    assert.ok(
      combined.includes('0123'),
      `Expected migration "0123" reference in remediation hint.\nCombined:\n${combined}`,
    );
  });

  // ── all indexes missing ────────────────────────────────────────────────────

  test('exits 1 when the response is an empty array (no indexes at all)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'empty-response');

    const result = runCheck({ root, bin, captureFile, indexResponse: '[]' });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for empty index list but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── malformed JSON ─────────────────────────────────────────────────────────

  test('exits 1 when the API response is not valid JSON', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'bad-json');

    const result = runCheck({ root, bin, captureFile, indexResponse: 'not-json' });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for malformed JSON response but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  // ── HTTP 401 (expired token) ───────────────────────────────────────────────

  test('exits 1 with an actionable message when the API returns HTTP 401 (expired token)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'http-401');
    const errorBody = JSON.stringify({ message: 'JWT expired' });

    const result = runCheck({
      root,
      bin,
      captureFile,
      indexResponse: errorBody,
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

  // ── HTTP 403 (revoked token) ───────────────────────────────────────────────

  test('exits 1 with an actionable message when the API returns HTTP 403 (revoked token)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'http-403');
    const errorBody = JSON.stringify({ message: 'Forbidden' });

    const result = runCheck({
      root,
      bin,
      captureFile,
      indexResponse: errorBody,
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
// Suite 2: real-database integration tests (ENGAGEMENT_QUERY_MODE=psql)
//
// Provisions a dedicated schema in the local PostgreSQL instance, creates all
// ten engagement indexes (five post-perspective from migration 0106 and five
// user-perspective from migration 0123), then exercises the full shell →
// Node.js pipeline against real DB state — confirming the SQL in
// check-engagement-indexes.sh correctly queries pg_indexes for both sets.
// ═══════════════════════════════════════════════════════════════════════════════

describe('check-engagement-indexes.sh — real PostgreSQL integration (ENGAGEMENT_QUERY_MODE=psql)', () => {
  const schema = `ei_test_${Date.now()}`;

  before(() => {
    // Create five minimal tables with both the post-scoped and user-scoped
    // columns so all ten indexes can be created.  Index bodies don't need to
    // match production — we only care that pg_indexes reports the correct
    // indexname values.
    psql(`
      CREATE SCHEMA ${schema};

      CREATE TABLE ${schema}.posts_likes        (id serial PRIMARY KEY, post_id int, user_id int, created_at timestamptz);
      CREATE TABLE ${schema}.post_reactions      (id serial PRIMARY KEY, post_id int, user_id int, emoji text, created_at timestamptz);
      CREATE TABLE ${schema}.comment_likes       (id serial PRIMARY KEY, comment_id int, user_id int, created_at timestamptz);
      CREATE TABLE ${schema}.highlight_likes     (id serial PRIMARY KEY, highlight_id int, user_id int, created_at timestamptz);
      CREATE TABLE ${schema}.memory_likes        (id serial PRIMARY KEY, memory_id int, user_id int, created_at timestamptz);

      -- migration 0106: post-perspective indexes
      CREATE INDEX idx_posts_likes_post_created
        ON ${schema}.posts_likes (post_id, created_at DESC);

      CREATE INDEX idx_post_reactions_post_emoji_created
        ON ${schema}.post_reactions (post_id, emoji, created_at DESC);

      CREATE INDEX idx_comment_likes_comment_created
        ON ${schema}.comment_likes (comment_id, created_at DESC);

      CREATE INDEX idx_highlight_likes_highlight_created
        ON ${schema}.highlight_likes (highlight_id, created_at DESC);

      CREATE INDEX idx_memory_likes_memory_created
        ON ${schema}.memory_likes (memory_id, created_at DESC);

      -- migration 0123: user-perspective indexes
      CREATE INDEX idx_posts_likes_user_created
        ON ${schema}.posts_likes (user_id, created_at DESC);

      CREATE INDEX idx_post_reactions_user_created
        ON ${schema}.post_reactions (user_id, created_at DESC);

      CREATE INDEX idx_comment_likes_user_created
        ON ${schema}.comment_likes (user_id, created_at DESC);

      CREATE INDEX idx_highlight_likes_user_created
        ON ${schema}.highlight_likes (user_id, created_at DESC);

      CREATE INDEX idx_memory_likes_user_created
        ON ${schema}.memory_likes (user_id, created_at DESC);
    `);
  });

  after(() => {
    try {
      psql(`DROP SCHEMA ${schema} CASCADE;`);
    } catch {
      // Non-fatal — test isolation is best-effort on cleanup.
    }
  });

  test('exits 0 when all ten indexes exist in the database', () => {
    const result = runCheckPsql(schema);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 with all ten indexes present but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('idx_memory_likes_memory_created'),
      `Expected confirmation of idx_memory_likes_memory_created in output.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('idx_memory_likes_user_created'),
      `Expected confirmation of idx_memory_likes_user_created (migration 0123) in output.\nStdout:\n${result.stdout}`,
    );
  });

  test('exits 1 after idx_memory_likes_memory_created (migration 0106) is dropped from the database', () => {
    psql(`DROP INDEX ${schema}.idx_memory_likes_memory_created;`);

    const result = runCheckPsql(schema);

    assert.equal(
      result.status,
      1,
      `Expected exit 1 after dropping idx_memory_likes_memory_created but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('idx_memory_likes_memory_created'),
      `Expected "idx_memory_likes_memory_created" to be named in the failure output.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('MISSING'),
      `Expected "MISSING" keyword in failure output.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  test('exits 0 again after idx_memory_likes_memory_created is re-created', () => {
    psql(`
      CREATE INDEX idx_memory_likes_memory_created
        ON ${schema}.memory_likes (memory_id, created_at DESC);
    `);

    const result = runCheckPsql(schema);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 after re-creating idx_memory_likes_memory_created but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('idx_memory_likes_memory_created'),
      `Expected confirmation of idx_memory_likes_memory_created in output.\nStdout:\n${result.stdout}`,
    );
  });

  // ── user-perspective regression test (migration 0123) ────────────────────────
  // Confirms that dropping a user-perspective index from migration 0123 is
  // detected — catching the specific regression this task guards against.

  test('exits 1 after idx_posts_likes_user_created (migration 0123) is dropped from the database', () => {
    psql(`DROP INDEX ${schema}.idx_posts_likes_user_created;`);

    const result = runCheckPsql(schema);

    assert.equal(
      result.status,
      1,
      `Expected exit 1 after dropping idx_posts_likes_user_created but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('idx_posts_likes_user_created'),
      `Expected "idx_posts_likes_user_created" to be named in the failure output.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      (result.stdout + result.stderr).includes('MISSING'),
      `Expected "MISSING" keyword in failure output.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
  });

  test('exits 0 again after idx_posts_likes_user_created is re-created', () => {
    psql(`
      CREATE INDEX idx_posts_likes_user_created
        ON ${schema}.posts_likes (user_id, created_at DESC);
    `);

    const result = runCheckPsql(schema);

    assert.equal(
      result.status,
      0,
      `Expected exit 0 after re-creating idx_posts_likes_user_created but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('idx_posts_likes_user_created'),
      `Expected confirmation of idx_posts_likes_user_created in output.\nStdout:\n${result.stdout}`,
    );
  });
});
