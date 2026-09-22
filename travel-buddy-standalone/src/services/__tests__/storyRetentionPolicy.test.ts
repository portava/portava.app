/**
 * storyRetentionPolicy — the failure states, which are the point of the module.
 *
 * The owner's instruction, 2026-09-22: "Do not silently omit retention
 * information when the policy endpoint fails. Show an explicit unavailable
 * state. If no valid policy can be established, preserve the draft and offer
 * retry before accepting publication under undisclosed terms."
 *
 * Two properties carry that, and both are easy to regress into the shape this
 * module used to have:
 *
 *   1. A failure is REPORTED, not returned as an absence. A caller that gets
 *      `null` has no way to tell "no policy" from "policy says nothing", and
 *      the honest rendering of the second is silence.
 *   2. A failure is NOT CACHED. Retry is the remedy on offer; a cached failure
 *      makes the retry button a decoration and the composer permanently unable
 *      to publish for the rest of the process's life.
 *
 * There is also a property about what the module must NOT do: it must never
 * substitute the published 24/365/30 for a lookup that failed. That is tested
 * by asserting the failure result carries no numbers at all — if a fallback
 * were ever added, `status` would read 'ok' here and these tests would fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchStoryRetentionPolicy,
  _resetStoryRetentionPolicyCache,
  composerRetentionLine,
  retentionUnavailableLine,
  archiveRetentionLine,
  deleteRecoveryLine,
} from '../storyRetentionPolicy.ts';

// ── Harness ──────────────────────────────────────────────────────────────────
// The module takes its token reader and its fetch as injected dependencies, so
// this test needs neither a global nor a module stub. That seam exists because
// a static `apiToken` import drags supabase.ts -> SecureStoreAdapter ->
// react-native into the graph, which node:test cannot load (the repo's
// KNOWN_BROKEN list in scripts/run-node-tests.mjs is full of tests that hit
// exactly that wall). A publication gate whose failure states cannot be run is
// not a gate anyone can trust, so the dependency is passed in.

type FetchImpl = typeof fetch;

function deps(token: string | null, fetchImpl: FetchImpl) {
  return { token: async () => token, fetchImpl };
}

function okBody(over: Record<string, unknown> = {}): any {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      effective: {
        audienceWindowHours: 24,
        archiveRetentionDays: 365,
        deletedRecoveryDays: 30,
        engagementRetentionDays: 30,
        ...over,
      },
      published: {
        audienceWindowHours: 24,
        archiveRetentionDays: 365,
        deletedRecoveryDays: 30,
        engagementRetentionDays: 30,
      },
      divergences: [],
    }),
  };
}

// ── The failure is reported, never silently absent ───────────────────────────

test('no token is reported as unauthenticated, not as a missing policy', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  let called = 0;
  const r = await fetchStoryRetentionPolicy(
    deps(null, (async () => { called += 1; return okBody(); }) as any),
  );

  assert.equal(r.status, 'unavailable');
  assert.equal(r.status === 'unavailable' ? r.reason : null, 'unauthenticated');
  assert.equal(called, 0, 'must not call the endpoint without a bearer token');
});

test('a 500 is reported as server_error and carries no invented numbers', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  const r = await fetchStoryRetentionPolicy(
    deps('tok', (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any),
  );

  assert.equal(r.status, 'unavailable');
  assert.equal(r.status === 'unavailable' ? r.reason : null, 'server_error');
  // The published defaults must not leak in as a fallback. If they ever did,
  // `status` would be 'ok' and this assertion is what would catch it.
  assert.ok(!('policy' in r), 'a failed read must not produce a policy object');
});

test('a 401 is unauthenticated rather than a generic server error', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  const r = await fetchStoryRetentionPolicy(
    deps('tok', (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any),
  );
  assert.equal(r.status === 'unavailable' ? r.reason : null, 'unauthenticated');
});

test('a thrown fetch is reported as network, not as an exception escaping', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  const r = await fetchStoryRetentionPolicy(
    deps('tok', (async () => { throw new TypeError('Network request failed'); }) as any),
  );
  assert.equal(r.status, 'unavailable');
  assert.equal(r.status === 'unavailable' ? r.reason : null, 'network');
});

test('a body missing one window is malformed, not a partial policy', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  // deletedRecoveryDays arrives as a string — the shape a loosely typed server
  // or a JSON-through-a-proxy produces, and the one that renders
  // "restore for [object Object] days" if it is waved through.
  const r = await fetchStoryRetentionPolicy(
    deps('tok', (async () => okBody({ deletedRecoveryDays: '30' })) as any),
  );
  assert.equal(r.status, 'unavailable');
  assert.equal(r.status === 'unavailable' ? r.reason : null, 'malformed');
});

// ── The failure is not cached; the success is ────────────────────────────────

test('a failure does not poison the cache — the next call reaches the server again', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  let attempt = 0;
  const d = deps('tok', (async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError('Network request failed');
    return okBody();
  }) as any);

  const first = await fetchStoryRetentionPolicy(d);
  assert.equal(first.status, 'unavailable', 'precondition: the first attempt failed');

  // This is the retry the composer's button performs. If failures were cached,
  // it would return the same 'unavailable' without a second request, and the
  // user could never publish again in this process.
  const second = await fetchStoryRetentionPolicy(d);
  assert.equal(second.status, 'ok');
  assert.equal(attempt, 2, 'retry must issue a second request');
  assert.deepEqual(second.status === 'ok' ? second.policy : null, {
    audienceWindowHours: 24,
    archiveRetentionDays: 365,
    deletedRecoveryDays: 30,
    engagementRetentionDays: 30,
  });
});

test('a success is cached — the composer does not re-fetch on every open', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  let calls = 0;
  const d = deps('tok', (async () => { calls += 1; return okBody(); }) as any);

  const a = await fetchStoryRetentionPolicy(d);
  const b = await fetchStoryRetentionPolicy(d);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(calls, 1);
});

test('concurrent callers share one request', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  let calls = 0;
  const d = deps('tok', (async () => { calls += 1; return okBody(); }) as any);

  const [a, b] = await Promise.all([fetchStoryRetentionPolicy(d), fetchStoryRetentionPolicy(d)]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.equal(calls, 1);
});

test('the inflight slot is released after a failure so a retry is possible', async (t) => {
  t.after(() => { _resetStoryRetentionPolicyCache(); });
  _resetStoryRetentionPolicyCache();
  let calls = 0;
  const d = deps('tok', (async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('down');
    return okBody();
  }) as any);

  assert.equal((await fetchStoryRetentionPolicy(d)).status, 'unavailable');
  assert.equal((await fetchStoryRetentionPolicy(d)).status, 'unavailable');
  assert.equal((await fetchStoryRetentionPolicy(d)).status, 'ok');
  assert.equal(calls, 3, 'every retry reached the network');
});

// ── The copy says the deployment's numbers, not the module's ─────────────────

test('the copy is derived from the values supplied, not from constants', () => {
  const odd = {
    audienceWindowHours: 12,
    archiveRetentionDays: 90,
    deletedRecoveryDays: 7,
    engagementRetentionDays: 14,
  };
  // 90 days is rendered "3 months" by the magnitude helper, which is a
  // presentation choice; what matters here is that the number on screen is
  // derived from what the server sent and not from a constant.
  const composer = composerRetentionLine(odd);
  assert.ok(composer.includes('12 hours'), composer);
  assert.ok(composer.includes('3 months'), composer);
  assert.ok(!composer.includes('365'), 'must not print a window this deployment does not enforce');
  assert.ok(!composer.includes('a year'), composer);
  assert.ok(!composer.includes('24 hours'), composer);

  assert.ok(deleteRecoveryLine(odd).includes('7 days'), deleteRecoveryLine(odd));
  assert.ok(archiveRetentionLine(odd).includes('3 months'), archiveRetentionLine(odd));
  assert.ok(!archiveRetentionLine(odd).includes('a year'), archiveRetentionLine(odd));
});

test('the unavailable line states the hold and names no window', () => {
  for (const reason of ['unauthenticated', 'network', 'server_error', 'malformed'] as const) {
    const line = retentionUnavailableLine(reason);
    assert.ok(line.length > 0, `empty line for ${reason}`);
    // No number at all: naming a duration here would be the undisclosed-terms
    // failure wearing an apology.
    assert.ok(!/\d/.test(line), `${reason}: the unavailable line must not name a duration — ${line}`);
  }
});
