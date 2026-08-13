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

// ── per-sub-check passing fixtures ─────────────────────────────────────────
// Each verifier script expects a specific shape from the Supabase Management API.
// These fixtures provide minimal "all present" data for each verifier so the
// "exits 0" mock-curl test can satisfy every sub-check with the correct shape.

const PASSING_SCHEMA_RESPONSE = JSON.stringify([
  { check_type: 'table',  name: 'profile_emergency_contacts', detail: 'true' },
  { check_type: 'policy', name: 'pec_own', detail: 'SELECT' },
  { check_type: 'policy', name: 'pec_svc', detail: 'ALL' },
]);

const PASSING_SAFE_RETURN_RESPONSE = JSON.stringify([
  { check_type: 'table',  name: 'safe_return_sessions', detail: 'true' },
  { check_type: 'policy', name: 'srs_own', detail: 'ALL' },
]);

const PASSING_PUSH_TOKENS_RESPONSE = JSON.stringify([
  { check_type: 'table',  name: 'notification_devices', detail: 'true' },
  { check_type: 'policy', name: 'nd_own', detail: 'ALL' },
]);

const PASSING_RENT_BUDDY_RESPONSE = JSON.stringify([
  { check_type: 'table_global_controls', name: 'rent_buddy_global_controls', detail: 'true' },
  { check_type: 'col_global_controls',   name: 'all_bookings_paused',    detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'applications_paused',    detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'cash_balance_paused',    detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'nightlife_paused',       detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'force_full_in_app',      detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'force_public_meetup',    detail: 'boolean' },
  { check_type: 'col_global_controls',   name: 'force_delayed_posting',  detail: 'boolean' },
  { check_type: 'table_city_rollouts',   name: 'rent_buddy_city_rollouts', detail: 'true' },
  { check_type: 'policy',                name: 'rb_rollout_public_read', detail: 'SELECT' },
  { check_type: 'policy',                name: 'rb_rollout_svc',         detail: 'ALL' },
  { check_type: 'feature_flag',          name: 'rent_buddy_enabled',     detail: 'true' },
  { check_type: 'live_city_count',       name: '3',                      detail: 'public_mvp,beta_testing' },
]);

const PASSING_INVITE_LINK_FUNCS_RESPONSE = JSON.stringify([
  { check_type: 'function', name: 'claim_invite_link_slot' },
  { check_type: 'function', name: 'release_invite_link_slot' },
  { check_type: 'table',    name: 'trip_invite_link_attempts' },
  { check_type: 'function', name: 'claim_invite_link_slot_for_user' },
  { check_type: 'function', name: 'reconcile_invite_link_slots' },
  { check_type: 'function', name: 'cleanup_stale_invite_link_attempts' },
]);

// All 6 beta-flag rows required by verify-db-beta-flags.mjs (seeded by
// migration 0117_beta_feature_flags.sql; city_launch_mode left the set when
// 2087_retire_city_launch_mode.sql retired it).
const ALL_SIX_BETA_FLAGS = JSON.stringify([
  { flag: 'disable_signups',              enabled: 'false' },
  { flag: 'disable_posting',             enabled: 'false' },
  { flag: 'disable_messaging',           enabled: 'false' },
  { flag: 'disable_rent_buddy_booking',  enabled: 'false' },
  { flag: 'invite_only_beta',            enabled: 'false' },
  { flag: 'compass_ai_enabled',          enabled: 'true' },
]);

// Two flags present, four missing — verifier must exit 1.
const PARTIAL_BETA_FLAGS = JSON.stringify([
  { flag: 'disable_signups', enabled: 'false' },
  { flag: 'disable_posting', enabled: 'false' },
  // remaining 4 intentionally omitted
]);

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temp workspace with:
 *   <root>/artifacts/api-server/.env  — minimal env with a plausible SUPABASE_URL
 *   <root>/bin/curl                   — fake curl that:
 *                                         • appends --data-raw to $CURL_CAPTURE_FILE
 *                                           (one payload per line, append not overwrite)
 *                                         • routes the response body via per-check env
 *                                           vars keyed on unique SQL keywords in the
 *                                           --data-raw payload, falling back to
 *                                           MOCK_TRIGGER_RESPONSE when no override is set
 *                                         • returns the chosen body + HTTP status code
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
  //   • Iterate args to find the value immediately after --data-raw.
  //   • APPEND it to $CURL_CAPTURE_FILE (one payload per line) so tests can
  //     inspect any invocation's payload regardless of call order.
  //   • Route to a per-check env var based on unique SQL keywords present in
  //     the --data-raw payload:
  //       disable_signups           → MOCK_BETA_FLAGS_RESPONSE
  //       trip_invite_link_attempts → MOCK_INVITE_LINK_FUNCS_RESPONSE
  //       rent_buddy_global_controls→ MOCK_RENT_BUDDY_RESPONSE
  //       notification_devices      → MOCK_PUSH_TOKENS_RESPONSE
  //       safe_return_sessions      → MOCK_SAFE_RETURN_RESPONSE
  //       profile_emergency_contacts→ MOCK_SCHEMA_RESPONSE
  //       (anything else)           → MOCK_TRIGGER_RESPONSE
  //   • Emit the chosen body + HTTP status code on the last line, which is
  //     exactly the format check-db-triggers.sh expects:
  //       HTTP_BODY=$(printf "%s" "$RESPONSE" | head -n -1)
  //       HTTP_CODE=$(printf "%s" "$RESPONSE" | tail -n 1)
  const fakeCurl = join(bin, 'curl');
  writeFileSync(
    fakeCurl,
    [
      '#!/usr/bin/env bash',
      'DATA_RAW=""',
      'CAPTURE_NEXT=0',
      'for arg in "$@"; do',
      '  if [[ "$CAPTURE_NEXT" == "1" ]]; then',
      '    DATA_RAW="$arg"',
      '    if [[ -n "${CURL_CAPTURE_FILE:-}" ]]; then',
      '      printf "%s\\n" "$arg" >> "$CURL_CAPTURE_FILE"',
      '    fi',
      '    break',
      '  fi',
      '  if [[ "$arg" == "--data-raw" ]]; then',
      '    CAPTURE_NEXT=1',
      '  fi',
      'done',
      // Route response based on SQL keyword in --data-raw
      'if [[ "$DATA_RAW" == *"disable_signups"* && -n "${MOCK_BETA_FLAGS_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_BETA_FLAGS_RESPONSE"',
      'elif [[ "$DATA_RAW" == *"trip_invite_link_attempts"* && -n "${MOCK_INVITE_LINK_FUNCS_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_INVITE_LINK_FUNCS_RESPONSE"',
      'elif [[ "$DATA_RAW" == *"rent_buddy_global_controls"* && -n "${MOCK_RENT_BUDDY_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_RENT_BUDDY_RESPONSE"',
      'elif [[ "$DATA_RAW" == *"notification_devices"* && -n "${MOCK_PUSH_TOKENS_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_PUSH_TOKENS_RESPONSE"',
      'elif [[ "$DATA_RAW" == *"safe_return_sessions"* && -n "${MOCK_SAFE_RETURN_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_SAFE_RETURN_RESPONSE"',
      'elif [[ "$DATA_RAW" == *"profile_emergency_contacts"* && -n "${MOCK_SCHEMA_RESPONSE:-}" ]]; then',
      '  RESPONSE="$MOCK_SCHEMA_RESPONSE"',
      'else',
      '  RESPONSE="$MOCK_TRIGGER_RESPONSE"',
      'fi',
      'printf "%s\\n${MOCK_HTTP_STATUS:-200}" "$RESPONSE"',
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
  /**
   * Per-sub-check response overrides.  When set the fake curl returns the
   * given JSON for requests whose --data-raw payload contains the check's
   * unique SQL keyword, instead of falling back to triggerResponse.
   */
  schemaResponse?: string;
  safeReturnResponse?: string;
  pushTokensResponse?: string;
  rentBuddyResponse?: string;
  inviteLinkFuncsResponse?: string;
  betaFlagsResponse?: string;
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
  if (opts.schemaResponse !== undefined) {
    env['MOCK_SCHEMA_RESPONSE'] = opts.schemaResponse;
  }
  if (opts.safeReturnResponse !== undefined) {
    env['MOCK_SAFE_RETURN_RESPONSE'] = opts.safeReturnResponse;
  }
  if (opts.pushTokensResponse !== undefined) {
    env['MOCK_PUSH_TOKENS_RESPONSE'] = opts.pushTokensResponse;
  }
  if (opts.rentBuddyResponse !== undefined) {
    env['MOCK_RENT_BUDDY_RESPONSE'] = opts.rentBuddyResponse;
  }
  if (opts.inviteLinkFuncsResponse !== undefined) {
    env['MOCK_INVITE_LINK_FUNCS_RESPONSE'] = opts.inviteLinkFuncsResponse;
  }
  if (opts.betaFlagsResponse !== undefined) {
    env['MOCK_BETA_FLAGS_RESPONSE'] = opts.betaFlagsResponse;
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
  // Provides per-check fixture responses for every sub-check that runs after
  // the triggers check (schema, safe_return, push_tokens, rent_buddy,
  // invite_link_funcs, beta_flags).  Without these overrides the fake curl
  // would return trigger-shaped rows to every sub-check verifier, causing
  // each to exit 1 with a shape mismatch.

  test('exits 0 when all four triggers are present (including block_saved_places_truncate)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'all-present');

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: ALL_FOUR_TRIGGERS,
      schemaResponse: PASSING_SCHEMA_RESPONSE,
      safeReturnResponse: PASSING_SAFE_RETURN_RESPONSE,
      pushTokensResponse: PASSING_PUSH_TOKENS_RESPONSE,
      rentBuddyResponse: PASSING_RENT_BUDDY_RESPONSE,
      inviteLinkFuncsResponse: PASSING_INVITE_LINK_FUNCS_RESPONSE,
      betaFlagsResponse: ALL_SIX_BETA_FLAGS,
    });

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

  // ── beta kill-switch flags (migration 0117) ───────────────────────────────
  // The fake curl routes requests whose --data-raw contains "disable_signups"
  // to MOCK_BETA_FLAGS_RESPONSE.  These tests pass all other sub-check fixtures
  // so the script reaches the beta-flags verifier; only the beta-flags response
  // is varied between cases.

  test('beta-flags: exits 0 when all 7 kill-switch / feature-gate flag rows are present', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'beta-flags-all-present');

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: ALL_FOUR_TRIGGERS,
      schemaResponse: PASSING_SCHEMA_RESPONSE,
      safeReturnResponse: PASSING_SAFE_RETURN_RESPONSE,
      pushTokensResponse: PASSING_PUSH_TOKENS_RESPONSE,
      rentBuddyResponse: PASSING_RENT_BUDDY_RESPONSE,
      inviteLinkFuncsResponse: PASSING_INVITE_LINK_FUNCS_RESPONSE,
      betaFlagsResponse: ALL_SIX_BETA_FLAGS,
    });

    assert.equal(
      result.status,
      0,
      `Expected exit 0 when all 7 beta flags present but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('disable_signups'),
      `Expected "disable_signups" in success output.\nStdout:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes('compass_ai_enabled'),
      `Expected "compass_ai_enabled" in success output.\nStdout:\n${result.stdout}`,
    );
  });

  test('beta-flags: exits 1 when only some flag rows are present (migration 0117 partially applied)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'beta-flags-partial');

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: ALL_FOUR_TRIGGERS,
      schemaResponse: PASSING_SCHEMA_RESPONSE,
      safeReturnResponse: PASSING_SAFE_RETURN_RESPONSE,
      pushTokensResponse: PASSING_PUSH_TOKENS_RESPONSE,
      rentBuddyResponse: PASSING_RENT_BUDDY_RESPONSE,
      inviteLinkFuncsResponse: PASSING_INVITE_LINK_FUNCS_RESPONSE,
      betaFlagsResponse: PARTIAL_BETA_FLAGS,
    });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 when beta flags are missing but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('MISSING'),
      `Expected "MISSING" in failure output.\nCombined:\n${combined}`,
    );
    // At least one of the four absent flags should be named in the output.
    assert.ok(
      combined.includes('disable_messaging') ||
      combined.includes('disable_rent_buddy_booking') ||
      combined.includes('invite_only_beta') ||
      combined.includes('compass_ai_enabled'),
      `Expected at least one missing flag name in failure output.\nCombined:\n${combined}`,
    );
  });

  test('beta-flags: exits 1 when feature_flags table has no beta-flag rows (empty response)', () => {
    const { root, bin, captureFile } = makeWorkspace(tmpBase, 'beta-flags-empty');

    const result = runCheck({
      root,
      bin,
      captureFile,
      triggerResponse: ALL_FOUR_TRIGGERS,
      schemaResponse: PASSING_SCHEMA_RESPONSE,
      safeReturnResponse: PASSING_SAFE_RETURN_RESPONSE,
      pushTokensResponse: PASSING_PUSH_TOKENS_RESPONSE,
      rentBuddyResponse: PASSING_RENT_BUDDY_RESPONSE,
      inviteLinkFuncsResponse: PASSING_INVITE_LINK_FUNCS_RESPONSE,
      betaFlagsResponse: '[]',
    });

    assert.equal(
      result.status,
      1,
      `Expected exit 1 for empty beta-flags response but got ${result.status}.\n` +
        `Stdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('MISSING'),
      `Expected "MISSING" in failure output for empty beta-flags.\nCombined:\n${combined}`,
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
