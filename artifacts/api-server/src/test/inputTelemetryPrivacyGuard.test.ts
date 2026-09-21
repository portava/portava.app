/**
 * §44 — the privacy guard's OBSERVABILITY, and the poison pill it used to be.
 *
 * WHAT THIS IS NOT. It is not §57's privacy-incident metric (G371). A fired
 * constraint is a NEAR MISS: the gate held and nothing leaked. An incident is a
 * leak that happened, and the serve log stores no account id, so "it happened
 * to someone" is not a fact it can hold. G371 is settled by production security
 * and audit logs, by someone with access to them, and nothing here may be
 * entered against it.
 *
 * WHAT IT IS. `recordTelemetryEvents` answered EVERY write failure
 * `retryable: true`, including a CHECK violation — which the function's own doc
 * comment already listed among the failures it binds. Two defects followed:
 *
 *   1. A poison pill. A row violating a CHECK can never be accepted, so the
 *      client retried it forever and every event queued behind it never landed.
 *   2. Privacy blindness. `iate_props_no_raw_text` fires only when a row
 *      reaching the database still carries one of migration 2950's thirteen
 *      forbidden keys — and the server REBUILDS every event from a per-name
 *      allow-list first, so the constraint firing means that allow-list and the
 *      database's list DISAGREE. Logged as a generic "write failed", it was
 *      indistinguishable from a network blip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  recordTelemetryEvents,
  forbiddenKeysPresent,
  FORBIDDEN_PROP_KEYS,
} from '../lib/inputAssistance/telemetry';

function row(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 'sess-1',
    request_id: null,
    event_name: 'suggestion_rendered',
    context: 'global_search',
    field_id: 'global_search',
    policy_version: 'v1',
    occurred_at: new Date().toISOString(),
    props: { count: 5 },
    ...overrides,
  } as any;
}

/** A db stand-in whose insert fails with the given PostgREST-shaped error. */
function failingDb(error: unknown) {
  return { from: () => ({ insert: async () => ({ error }) }) } as any;
}

function recorder() {
  const warns: any[] = [];
  const errors: any[] = [];
  return {
    warns,
    errors,
    log: {
      warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }),
      error: (obj: unknown, msg?: string) => errors.push({ obj, msg }),
    },
  };
}

test('a raw-text constraint violation is PERMANENT, not retryable', async () => {
  // MUTATION-PROOF: restore `return { recorded: 0, refusal: { retryable: true,
  // reason: 'write_failed' } }` for every error and this goes RED.
  const r = recorder();
  const out = await recordTelemetryEvents(
    failingDb({ code: '23514', constraint: 'iate_props_no_raw_text', message: 'violates check constraint' }),
    [row({ props: { count: 5, query: 'where is the secret bar' } })],
    r.log,
  );
  assert.ok('refusal' in out);
  assert.equal((out as any).refusal.retryable, false, 'a CHECK violation can never succeed on a retry');
  assert.equal((out as any).refusal.reason, 'forbidden_props_key');
});

test('the privacy guard is reported LOUDLY and without the payload', async () => {
  const r = recorder();
  await recordTelemetryEvents(
    failingDb({ code: '23514', constraint: 'iate_props_no_raw_text' }),
    [row({ props: { count: 5, query: 'where is the secret bar', title: 'Secret Bar' } })],
    r.log,
  );

  assert.equal(r.errors.length, 1, 'it must reach the error channel, not be a warn among warns');
  const { obj, msg } = r.errors[0];
  assert.match(String(msg), /PRIVACY GUARD FIRED/);
  assert.equal(obj.constraint, 'iate_props_no_raw_text');

  // Which keys, never what was in them.
  assert.deepEqual(obj.forbiddenKeysPresent, ['query', 'title']);

  // THE ASSERTION THAT MATTERS: the offending VALUES must not appear anywhere
  // in the log line. Logging the blob to diagnose a raw-text leak would write
  // the raw text into the log — the harm the constraint prevents, moved
  // somewhere with weaker controls.
  const serialized = JSON.stringify(obj);
  assert.ok(!serialized.includes('secret bar'), 'the raw query must not reach the log');
  assert.ok(!serialized.includes('Secret Bar'), 'the raw title must not reach the log');
  // Carries no props FIELD. Asserted structurally rather than as a substring:
  // an earlier version of this test matched the string 'props' and failed on
  // the constraint's own NAME, `iate_props_no_raw_text`, which is a schema
  // identifier and not payload. A test that cries wolf on its own subject gets
  // relaxed by the next person rather than heeded.
  assert.ok(!('props' in obj), 'the props blob must not be logged at all');
  assert.deepEqual(
    Object.keys(obj).sort(),
    ['constraint', 'count', 'eventNames', 'forbiddenKeysPresent', 'sqlstate'],
    'the report shape is closed — a future field cannot quietly carry content',
  );
});

test('other permanent SQLSTATEs are also non-retryable, and named', async () => {
  for (const code of ['23502', '23505', '22001']) {
    const r = recorder();
    const out = await recordTelemetryEvents(failingDb({ code }), [row()], r.log);
    assert.ok('refusal' in out);
    assert.equal((out as any).refusal.retryable, false, `${code} must not be retried`);
    assert.equal((out as any).refusal.reason, `constraint_violation:${code}`);
  }
});

test('an UNKNOWN failure stays retryable — the default does not flip', async () => {
  // The fix must not turn every hiccup into a permanent refusal. A missing
  // table, a network fault or an unrecognised code is transient until proven
  // otherwise, and this is the control that keeps the change honest.
  const r = recorder();
  const out = await recordTelemetryEvents(
    failingDb({ code: 'PGRST205', message: 'relation does not exist' }),
    [row()],
    r.log,
  );
  assert.ok('refusal' in out);
  assert.equal((out as any).refusal.retryable, true, 'a missing table is still retryable');
  assert.equal((out as any).refusal.reason, 'write_failed');
  assert.equal(r.errors.length, 0, 'and it must NOT be reported as a privacy event');
});

test('a successful write is untouched by any of this', async () => {
  const ok = { from: () => ({ insert: async () => ({ error: null }) }) } as any;
  const out = await recordTelemetryEvents(ok, [row(), row()], recorder().log);
  assert.deepEqual(out, { recorded: 2 });
});

test('the forbidden-key list mirrors migration 2950 exactly', () => {
  // The list exists TWICE: once in the CHECK constraint, once in TypeScript so
  // the guard can NAME what fired it. A third hand-typed copy here would only
  // pin the two copies I wrote on the same day; it would go green while 2950
  // grew a key and the guard's report silently stopped mentioning it. So this
  // reads the migration and compares against what the database actually
  // enforces.
  const sql = readFileSync(
    new URL('../migrations/2950_input_assistance_telemetry_events.sql', import.meta.url),
    'utf8',
  );
  const clause = /CONSTRAINT iate_props_no_raw_text CHECK \(([\s\S]*?)\n  \),/.exec(sql);
  assert.ok(clause, 'iate_props_no_raw_text not found in 2950 — this test cannot check anything');
  const array = /props \?\| ARRAY\[([\s\S]*?)\]/.exec(clause[1]);
  assert.ok(array, "the constraint's forbidden-key ARRAY did not parse");
  const fromMigration = [...array[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

  assert.equal(fromMigration.length, 13, 'the migration should forbid thirteen keys');
  assert.deepEqual([...FORBIDDEN_PROP_KEYS].sort(), fromMigration);

  assert.deepEqual(forbiddenKeysPresent([row({ props: { count: 1, body: 'x', name: 'y' } })]), ['body', 'name']);
  assert.deepEqual(forbiddenKeysPresent([row()]), [], 'a clean row names nothing');
});
