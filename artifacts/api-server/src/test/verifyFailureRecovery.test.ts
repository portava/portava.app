/**
 * VERIFICATION LANE V4 — failure recovery and fail-closed honesty on the
 * surfaces the last four build lanes added.
 *
 * The governing rule this file enforces, stated once: A SWALLOWED READ IS A
 * LIE. A `catch {}` or a `?? fallback` around a privacy, membership or kill
 * switch read turns "I cannot tell" into a definite answer — "not blocked",
 * "nothing dismissed", "no stop engaged" — and the caller cannot tell the two
 * apart. Every case below is one of those sites on a NEWLY BUILT surface,
 * asked the same three questions: what does the user see, is it distinguishable
 * from success, and is the degradation reported.
 *
 * WHAT IS EXERCISED HERE
 * ======================
 *   - the real `lib/discoveryDismissed.ts` reader
 *   - the real `lib/telegraphThreadWrite.ts` four-gate guard
 *   - the real `lib/featureFlags.ts` kill-switch reader
 *   - the real `lib/mediaPipeline.ts` upload gate
 *   - the real `routes/telegraphVoice.ts` send path, mounted in express over an
 *     in-memory PostgREST-shaped fake (same harness shape as
 *     `src/test/telegraphVoice.test.ts`)
 *
 * WHAT IS NOT EXERCISED, SAID PLAINLY
 * ===================================
 * `routes/discovery.ts`'s four serve paths are not driven over HTTP here — that
 * handler needs the whole Discovery assembly stood up, which
 * `src/test/discoveryCuratedSourceRefusal.test.ts` already does. What is
 * asserted instead is the FUNNEL: that `dismissGatedPlaces` hands
 * `getServiceClient()` straight to the reader, read from source, so the reader's
 * answer for a null client is the answer the route serves. That is a weaker
 * assertion than an end-to-end one and it is named as weaker rather than
 * dressed up.
 *
 * ── RED-FIRST RECORD (measured 2026-09-16, exit codes and test names verbatim) ─
 * Every assertion below was observed failing before the thing it guards. Two
 * were real defects; the rest were already correct and were proven by MUTATING
 * the source, watching red, and reverting. Each mutation's revert was confirmed
 * with `git diff --stat` before the next one.
 *
 * DEFECT 1 — `loadDismissedPlaceIds(null, userId)` answered `degraded: false`.
 *   RED, before the fix in lib/discoveryDismissed.ts (25 tests, 22 pass, 3 fail):
 *     not ok 1 - A1. a NULL service client reports degraded rather than an empty
 *                    dismissal list
 *       AssertionError  expected: true  actual: false
 *   The user-visible consequence: a viewer taps "Not interested", the server
 *   accepts the dismissal, and on a deployment where `getServiceClient()` is
 *   null every subsequent Discovery page is served UNFILTERED with an empty
 *   `failedSources` and `coverage: "full"`. The place they rejected comes back,
 *   and the envelope states positively that nothing went wrong. NOT
 *   distinguishable from success — which is the definition this lane works to.
 *   FIXED: `!userId` (complete) and `!sc` (degraded) are now separate answers.
 *
 * DEFECT 2 — `guardTelegraphThreadWrite` SKIPPED the `disable_messaging` kill
 *   switch entirely when `getServiceClient()` returned null (`if (flagSc && …)`).
 *   RED, before the fix in lib/telegraphThreadWrite.ts:
 *     not ok 1 - B1. the guard has an explicit refusal for a flag client it does
 *                    not have
 *       AssertionError  expected: 'function'  actual: 'undefined'
 *     not ok 2 - B2. a null flag client refuses; a present one does not
 *   The user-visible consequence: the operator pulls the emergency stop, the
 *   server cannot read the flags table at all, and messages keep being written —
 *   the stop disengages precisely when it is being reached for. Not
 *   distinguishable from success: the send returns 201.
 *   FIXED: `messagingStopUnknownRefusal` refuses with `degraded_unavailable`.
 *
 * PROVEN BY MUTATION (already correct — mutate, red, revert):
 *   M1  lib/featureFlags.ts `isKillSwitchEngaged`
 *       MUTATION: both `return true; // state unknown` → `return false`
 *       RED (25 tests, 19 pass, 6 fail):
 *         not ok 4 - B4. an UNREADABLE feature_flags table refuses the voice send
 *         not ok 5 - B5. a THROWING feature_flags read refuses the voice send
 *         not ok 1 - C1. an ERRORED flags read engages the stop
 *         not ok 2 - C2. a THROWING flags read engages the stop
 *         not ok 1 - D1. an unreadable feature_flags table engages the upload stop
 *         not ok 2 - D2. a THROWING feature_flags read engages the upload stop
 *       Reverted. One mutation reaches both kill switches and both doors, which
 *       is the point of them sharing a reader.
 *
 *   M2  lib/telegraphThreadWrite.ts — deleted the `if (oErr) { … }` roster block
 *       RED (25 tests, 24 pass, 1 fail):
 *         not ok 4 - E4. the roster read is error-bound, so an unreadable roster
 *                        cannot skip the block guard
 *       Reverted. SAID PLAINLY: E4 is a SOURCE assertion, not a behavioural one,
 *       and it is weaker for it. The runtime case cannot be reached through this
 *       route — `errorTable: "message_thread_members"` fails the MEMBERSHIP read
 *       first (E1), so the roster branch never runs with a healthy membership.
 *       Reaching it needs per-query failure injection the fake does not model.
 *
 *   M3  lib/discoveryDismissed.ts — `if (error) return { …, degraded: true }`
 *       replaced with a comment
 *       RED (25 tests, 24 pass, 1 fail):
 *         not ok 5 - A5. a THROWING rank_events read reports degraded
 *       A4 stayed GREEN, and that is worth recording rather than smoothing over:
 *       a SECOND guard, `if (!Array.isArray(data))`, catches the same errored
 *       read. Mutating BOTH turned A4 red:
 *         not ok 4 - A4. an errored rank_events read reports degraded
 *       Both reverted.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verifyFailureRecovery.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import { loadDismissedPlaceIds, DISMISSED_MAX_IDS } from "../lib/discoveryDismissed.js";
import { isKillSwitchEngaged, isFlagEnabled } from "../lib/featureFlags.js";
import { guardUploadRequest } from "../lib/mediaPipeline.js";
import * as threadWrite from "../lib/telegraphThreadWrite.js";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const GOOD_URL =
  "post-media/aaaaaaaa-0000-4000-8000-000000000001/voice/1700000000000.m4a";

function goodPayload(over: Record<string, unknown> = {}) {
  return {
    url: GOOD_URL,
    durationSeconds: 12,
    waveform: [0.1, 0.5, 0.9, 0.3],
    mimeType: "audio/mp4",
    sizeBytes: 98_304,
    ...over,
  };
}

/* ============================================================================
 * The fake. PostgREST-shaped, with one knob per read that can fail.
 * ==========================================================================*/

interface FakeState {
  /** Table whose every read resolves with an `error` — supabase-js does not throw. */
  errorTable?: string;
  /** Table whose every read THROWS, which is the other way a read fails. */
  throwTable?: string;
  killSwitch?: boolean;
}

function makeClient(state: FakeState) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "disable_messaging", enabled: state.killSwitch === true },
      { flag: "disable_media_uploads", enabled: state.killSwitch === true },
    ],
    message_threads: [{ id: THREAD, is_e2ee: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
    ],
    blocks: [],
    messages: [],
    rank_events: [],
  };
  const inserted: any[] = [];
  const limits: number[] = [];

  function from(table: string) {
    if (state.throwTable === table) {
      throw new Error(`injected THROW on ${table}`);
    }
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const err = () =>
      state.errorTable === table
        ? { message: `injected failure on ${table}`, code: "XX000" }
        : null;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: "new-voice-1", ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      or() { return proxy; },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.map(String).includes(String(r[col])));
        return proxy;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return proxy;
      },
      limit(n: number) { limits.push(n); return proxy; },
      order() { return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      then(resolve2: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve2, reject);
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve2, reject);
        }
        return Promise.resolve({
          data: pendingInsert ? [pendingInsert] : rowsNow(),
          error: null,
        }).then(resolve2, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _inserted: inserted,
    _limits: limits,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: {
      getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }),
    },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: FakeState) {
  const c = makeClient(state);
  _setTestClient(c as any, true);
  return c;
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", telegraphVoiceRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/* ============================================================================
 * A. "Not interested" — the dismissal read, and the one input that was
 *    answered as a fact instead of as a failure.
 * ==========================================================================*/

describe('A. discoveryDismissed — a missing client is "we could not read", not "nothing dismissed"', () => {
  it("A1. a NULL service client reports degraded rather than an empty dismissal list", async () => {
    // The two are different sentences and the caller acts on them differently:
    // `degraded: false` with an empty set means "this viewer has dismissed
    // nothing", which the route serves as `coverage: "full"`. There is no
    // viewer-facing difference between that and a healthy page, which is what
    // makes it a lie rather than a bug.
    //
    // `userId === null` legitimately answers `degraded: false` — there is no
    // viewer to have dismissed anything, which is a COMPLETE answer. A null
    // client is not that. It is the one case where we have a viewer, they may
    // well have dismissals, and we cannot see them.
    const got = await loadDismissedPlaceIds(null, ALICE);
    assert.equal(
      got.degraded,
      true,
      "a missing service client is an UNREADABLE dismissal list, not an empty one",
    );
    assert.equal(got.ids.size, 0, "an unreadable list yields no ids to filter on");
  });

  it("A2. an anonymous caller is still NOT degraded — the fix must not blanket-report", async () => {
    // Guards the fix from the lazy shape. "Reports degraded on failure" is
    // satisfied by reporting degraded always, which would put
    // `coverage: "partial"` on every Discovery response and make the word
    // mean nothing. Anonymity is a complete answer and must stay one.
    for (const anon of [null, undefined, ""]) {
      const got = await loadDismissedPlaceIds(makeClient({}) as any, anon as any);
      assert.equal(got.degraded, false, `${JSON.stringify(anon)} is a complete answer, not a failed read`);
      assert.equal(got.ids.size, 0);
    }
    // …and a null client with an anonymous caller stays complete too: nothing
    // was going to be read for them either way.
    const both = await loadDismissedPlaceIds(null, null);
    assert.equal(both.degraded, false);
  });

  it("A3. a healthy read of an EMPTY table is complete, not degraded", async () => {
    const c = makeClient({});
    const got = await loadDismissedPlaceIds(c as any, ALICE);
    assert.equal(got.degraded, false, "an empty-but-READ list is a complete answer");
    assert.equal(c._limits.at(-1), DISMISSED_MAX_IDS, "the read stays bounded");
  });

  it("A4. an errored rank_events read reports degraded", async () => {
    const got = await loadDismissedPlaceIds(makeClient({ errorTable: "rank_events" }) as any, ALICE);
    assert.equal(got.degraded, true, "supabase-js RESOLVES on a DB error; binding it is the whole point");
  });

  it("A5. a THROWING rank_events read reports degraded", async () => {
    const got = await loadDismissedPlaceIds(makeClient({ throwTable: "rank_events" }) as any, ALICE);
    assert.equal(got.degraded, true, "the catch must report, not absorb");
  });

  it("A6. the route hands getServiceClient() straight to the reader, so A1 is what it serves", () => {
    // Named as the weaker assertion it is: this reads the funnel out of source
    // rather than driving the four serve paths. It is here because the reader's
    // answer for a null client is only interesting if the route can actually
    // pass one, and `dismissGatedPlaces` is the single place it could.
    const src = readFileSync(resolve(SRC_DIR, "routes/discovery.ts"), "utf8");
    assert.match(
      src,
      /loadDismissedPlaceIds\(\s*getServiceClient\(\)\s*,/,
      "dismissGatedPlaces must pass the service client through unguarded — a `?? client` here would hide A1",
    );
    // The degradation has to reach the envelope, or reporting it in the reader
    // changes nothing a caller can see.
    assert.match(
      src,
      /dismissed\.degraded[\s\S]{0,120}DISCOVERY_DISMISSED_SOURCE/,
      "a degraded dismissal read must append to failedSources",
    );
  });
});

/* ============================================================================
 * B. The messaging kill switch, and the input that skipped it entirely.
 * ==========================================================================*/

describe("B. disable_messaging — an unreadable stop must ENGAGE, never disengage", () => {
  it("B1. the guard has an explicit refusal for a flag client it does not have", () => {
    // `if (flagSc && await isKillSwitchEngaged(...))` reads as fail-closed and
    // is not: the `&&` short-circuits the whole gate away when the service
    // client is absent. Both operands are "we cannot read the stop", and only
    // one of them was treated that way.
    assert.equal(
      typeof (threadWrite as any).messagingStopUnknownRefusal,
      "function",
      "an unreadable messaging stop must refuse the write",
    );
  });

  it("B2. a null flag client refuses; a present one does not", () => {
    const fn = (threadWrite as any).messagingStopUnknownRefusal as (
      c: unknown,
    ) => { ok: false; code: string; message: string } | null;
    const refusal = fn(null);
    assert.ok(refusal, 'a null flag client must not read as "no stop engaged"');
    assert.equal(refusal!.ok, false);
    assert.equal(
      refusal!.code,
      "degraded_unavailable",
      "the honest code: we could not establish the stop's state, which is not the same as an operator engaging it",
    );
    assert.ok(
      refusal!.message.length > 0 && !/disabled/i.test(refusal!.message),
      "the message must not claim an operator disabled messaging — nobody did",
    );
    assert.equal(fn({}), null, "a usable flag client is not, by itself, a refusal");
    assert.deepEqual(fn(undefined), refusal, "undefined is the same unreadable state as null");
  });

  it("B3. an ENGAGED stop refuses the voice send", async () => {
    const c = useState({ killSwitch: true });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(c._inserted.length, 0, "nothing may be written past an engaged stop");
  });

  it("B4. an UNREADABLE feature_flags table refuses the voice send", async () => {
    // The case the whole doctrine exists for: the stop is reached for at the
    // exact moment the database is unhealthy, so "false on error" disengages it
    // when it matters most.
    const c = useState({ errorTable: "feature_flags" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(
      r.body.error,
      "feature_disabled",
      "an unreadable stop engages — this is the one place false-on-error is the UNSAFE default",
    );
    assert.equal(c._inserted.length, 0);
  });

  it("B5. a THROWING feature_flags read refuses the voice send", async () => {
    const c = useState({ throwTable: "feature_flags" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(c._inserted.length, 0);
  });

  it("B6. a healthy thread with no stop still writes — the fix is not a blanket refusal", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c._inserted.filter((i) => i.table === "messages").length, 1);
  });
});

/* ============================================================================
 * C. The flag readers themselves, as units.
 * ==========================================================================*/

describe("C. featureFlags — the polarity of the FAILURE, not of the flag", () => {
  const erroring = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }) };
  const throwing = { from: () => { throw new Error("connection reset"); } };
  const missing = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  const engaged = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: null }) }) }) }) };

  it("C1. an ERRORED flags read engages the stop", async () => {
    assert.equal(await isKillSwitchEngaged(erroring, "disable_messaging"), true);
    assert.equal(await isKillSwitchEngaged(erroring, "disable_media_uploads"), true);
  });

  it("C2. a THROWING flags read engages the stop", async () => {
    assert.equal(await isKillSwitchEngaged(throwing, "disable_messaging"), true);
  });

  it("C3. a MISSING row does NOT engage — an absent stop is not an outage", async () => {
    // Every flag nobody has created, including all of them on a freshly
    // restored CI project. Inverting this would turn a missing row into a
    // total outage, which is why the failure polarity is inverted instead of
    // the flag's.
    assert.equal(await isKillSwitchEngaged(missing, "disable_messaging"), false);
  });

  it("C4. an engaged row engages", async () => {
    assert.equal(await isKillSwitchEngaged(engaged, "disable_messaging"), true);
  });

  it("C5. isFlagEnabled has the OPPOSITE failure polarity, and that is correct for a capability", async () => {
    // Stated here so the two are never confused at a call site: a capability
    // gate stays OFF when unreadable; a stop ENGAGES when unreadable. Reading a
    // stop through isFlagEnabled is the unsafe default wearing the right name.
    assert.equal(await isFlagEnabled(erroring, "disable_messaging"), false);
    assert.equal(await isFlagEnabled(throwing, "disable_messaging"), false);
  });
});

/* ============================================================================
 * D. disable_media_uploads on the voice upload door.
 * ==========================================================================*/

describe("D. disable_media_uploads — the voice upload shares the stop AND the bucket", () => {
  it("D1. an unreadable feature_flags table engages the upload stop", async () => {
    const erroring = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "down" } }) }) }) }),
    };
    const g = await guardUploadRequest(erroring, ALICE);
    assert.equal(g.ok, false);
    assert.equal(
      (g as any).failure.code,
      "feature_disabled",
      "reading this stop through isFlagEnabled would disengage it on an outage",
    );
  });

  it("D2. a THROWING feature_flags read engages the upload stop", async () => {
    const throwing = { from: () => { throw new Error("connection reset"); } };
    const g = await guardUploadRequest(throwing, ALICE);
    assert.equal(g.ok, false);
    assert.equal((g as any).failure.code, "feature_disabled");
  });

  it("D3. the voice upload door uses the SHARED gate, not a private copy", () => {
    // A second upload endpoint with its own rate-limit bucket would let an
    // abusive client double its budget by alternating endpoints, and a second
    // kill-switch read would be a second thing to remember to engage.
    const src = readFileSync(resolve(SRC_DIR, "routes/telegraphVoice.ts"), "utf8");
    assert.match(src, /guardUploadRequest\(sc, user\.id\)/, "the voice upload must go through the shared gate");
    assert.doesNotMatch(
      src,
      /isKillSwitchEngaged|isFlagEnabled/,
      "the route must not read a flag directly — that is a second stop to engage",
    );
  });

  it("D4. an unconfigured service client refuses the upload rather than skipping the stop", () => {
    // The posture the SEND door was missing. Stated as a source assertion
    // because standing a fake Storage bucket up would test the fake.
    const src = readFileSync(resolve(SRC_DIR, "routes/telegraphVoice.ts"), "utf8");
    assert.match(
      src,
      /const sc = getServiceClient\(\);\s*\n\s*if \(!sc\) \{[\s\S]{0,160}server_not_configured/,
      "no service client must refuse, not proceed unguarded",
    );
  });
});

/* ============================================================================
 * E. The other three gates in the Telegraph write guard.
 * ==========================================================================*/

describe("E. the write guard's remaining gates report rather than guess", () => {
  it("E1. an unreadable MEMBERSHIP row refuses with degraded_unavailable, not forbidden", async () => {
    // "You are not a member" and "we could not check" are different sentences.
    // The first tells a member of the thread they have been removed from it.
    const c = useState({ errorTable: "message_thread_members" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "degraded_unavailable");
    assert.notEqual(r.body.error, "forbidden", "an unreadable membership must not be reported as a refusal on the merits");
    assert.equal(c._inserted.length, 0);
  });

  it("E2. an unreadable THREAD META row refuses rather than assuming not-E2EE", async () => {
    // `(meta as any)?.is_e2ee === true` is false for BOTH "not encrypted" and
    // "could not read". Binding metaErr is what keeps a plaintext envelope out
    // of a thread whose whole promise is that we never hold one.
    const c = useState({ errorTable: "message_threads" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(c._inserted.length, 0);
  });

  it("E3. an unreadable BLOCKS table denies — the guard never runs blind", async () => {
    const c = useState({ errorTable: "blocks" });
    const r = await post(`/threads/${THREAD}/voice`, ALICE, { payload: goodPayload() });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(c._inserted.length, 0, "an unreadable blocks table must not deliver");
  });

  it("E4. the roster read is error-bound, so an unreadable roster cannot skip the block guard", () => {
    // The specific way a fail-closed guard becomes unreachable: `((others) ?? [])`
    // on an errored read yields an EMPTY roster, `otherMemberIds.length === 1`
    // is false, and the 1:1 block guard is never consulted. The thread reads as
    // a group. `routes/messaging.ts` records the day that shipped.
    const src = readFileSync(resolve(SRC_DIR, "lib/telegraphThreadWrite.ts"), "utf8");
    assert.match(
      src,
      /error: oErr[\s\S]{0,400}if \(oErr\)[\s\S]{0,200}degraded_unavailable/,
      "the roster read must bind and check its error before the block guard",
    );
  });
});
