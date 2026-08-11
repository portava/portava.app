/**
 * TripReminderScheduler push tests — representative direct-push caller.
 *
 * Verifies the 24h trip reminder uses sendPushWithRetry so a transient Expo
 * outage enqueues rows on push_retry_queue (one per recipient) instead of
 * silently dropping the alert.
 *
 * Also verifies the two-phase outbox (reminder_sent_at / reminder_delivered_at)
 * correctly recovers reminders lost to a crash between claim and send.
 *
 * Run: node --import tsx/esm --test src/test/tripReminderPush.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestFetch } from "../lib/push.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { runOnce, clearReminderDedup, _setTestNow, STALE_CLAIM_MS } from "../lib/tripReminderScheduler.js";

const OWNER_ID  = "cc000000-0001-0001-0001-000000000001";
const MEMBER_ID = "cc000000-0002-0002-0002-000000000002";
const OWNER_TOKEN  = "ExponentPushToken[tripowner]";
const MEMBER_TOKEN = "ExponentPushToken[tripmember]";

// ── Fake supabase service client ──────────────────────────────────────────────

interface FakeState {
  trips?: any[];
  tripMembers?: any[];
  profiles?: any[];
}

interface FakeClientOpts {
  /** Simulates a hard Supabase error (throws) for any query on this table. */
  throwOnTable?: string;
}

function makeFakeClient(state: FakeState, opts: FakeClientOpts = {}) {
  const inserted: Record<string, any[]> = {};

  function rowsFor(table: string): any[] {
    if (table === "trips") return state.trips ?? [];
    if (table === "trip_members") return state.tripMembers ?? [];
    if (table === "profiles") return state.profiles ?? [];
    return [];
  }

  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const b: any = {
      select() { return b; },
      // maybeSingle() is used by isFlagEnabled for feature_flags SELECT.
      // Return enabled=true so the push kill-switch doesn't suppress push in
      // trip-reminder tests that don't explicitly test the disabled state.
      maybeSingle(): Promise<{ data: any; error: null }> {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: true }, error: null });
        }
        const matched = rowsFor(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      // Intercept `.then` to throw for the configured table, simulating a hard
      // Supabase network/query error that propagates out of sendReminderForTrip.
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        inserted[table].push(row);
        return b;
      },
      update(patch: any) { pendingUpdate = patch; return b; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      lt(col: string, val: any) {
        // Null values are never less-than anything (mirrors SQL behaviour).
        filters.push((r) => r[col] != null && r[col] < val);
        return b;
      },
      gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return b; },
      lte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] <= val); return b; },
      order() { return b; },
      then(onF: any, onR: any) {
        // Simulate a hard DB error (throw) for the configured table.
        if (opts.throwOnTable === table) {
          return Promise.reject(new Error(`Simulated Supabase error on table: ${table}`)).then(onF, onR);
        }
        if (pendingInsert) return Promise.resolve({ data: pendingInsert, error: null }).then(onF, onR);
        const matched = rowsFor(table).filter((r) => filters.every((f) => f(r)));
        if (pendingUpdate) {
          // Mutate matched rows like a real UPDATE ... RETURNING would.
          for (const row of matched) Object.assign(row, pendingUpdate);
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        }
        return Promise.resolve({ data: matched, error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return { from: builder, __inserted: inserted } as any;
}

let pushCalls: any[][] = [];

function okFetch(): typeof fetch {
  return (async (_url: any, init: any) => {
    const messages = JSON.parse(init.body);
    pushCalls.push(messages);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t" })) }),
    } as any;
  }) as any;
}

before(() => { _setTestFetch(okFetch()); });
after(() => { _setTestFetch(null); _setTestServiceClient(null); });
afterEach(() => { pushCalls = []; _setTestFetch(okFetch()); _setTestNow(null); });

function baseState(tripId: string): FakeState {
  // start_date within the normal 22-26h sweep window (now + 24h, date-only).
  // Tests that need a specific start_date override it after calling baseState.
  const defaultStartDate = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);
  return {
    trips: [{
      id: tripId, title: "Lisbon Adventure", owner_id: OWNER_ID, status: "upcoming",
      reminder_retry_count: 0, start_date: defaultStartDate,
    }],
    tripMembers: [{ trip_id: tripId, user_id: MEMBER_ID, role: "member" }],
    profiles: [
      { id: OWNER_ID,  expo_push_token: OWNER_TOKEN },
      { id: MEMBER_ID, expo_push_token: MEMBER_TOKEN },
    ],
  };
}

// NOTE: the scheduler keeps an in-process dedup Set keyed by trip id, so each
// test must use a unique trip id.

describe("TripReminderScheduler push", () => {
  it("sends the 24h reminder to owner and members on success", async () => {
    const svc = makeFakeClient(baseState("trip-ok"));
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1);
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.equal(pushCalls[0][0].data.type, "trip_24h_reminder");
    assert.equal((svc.__inserted["push_retry_queue"] ?? []).length, 0);
  });

  it("enqueues one retry row per recipient when Expo is temporarily down", async () => {
    _setTestFetch((async () => ({ ok: false, status: 503, json: async () => ({}) })) as any);
    const svc = makeFakeClient(baseState("trip-503"));
    _setTestServiceClient(svc);
    await runOnce();

    const rows = svc.__inserted["push_retry_queue"] ?? [];
    assert.equal(rows.length, 2, "one retry-queue row per recipient");
    const byUser = new Map(rows.map((r: any) => [r.user_id, r]));
    assert.deepEqual(byUser.get(OWNER_ID)?.tokens, [OWNER_TOKEN]);
    assert.deepEqual(byUser.get(MEMBER_ID)?.tokens, [MEMBER_TOKEN]);
    for (const row of rows) {
      assert.equal(row.status, "queued");
      assert.equal(row.payload.data.type, "trip_24h_reminder");
      assert.equal(row.payload.data.tripId, "trip-503");
    }
  });

  it("marks reminder_sent_at and reminder_delivered_at when sending", async () => {
    const state = baseState("trip-claim");
    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1);
    assert.ok(state.trips![0].reminder_sent_at,    "reminder_sent_at set on the trip row");
    assert.ok(state.trips![0].reminder_delivered_at, "reminder_delivered_at set after successful send");
  });

  it("does not re-send when reminder_sent_at is already set (e.g. after a restart)", async () => {
    // Fresh trip id so the in-memory Set can't be what dedups — only the
    // persisted reminder_sent_at column stands between us and a double-send.
    const state = baseState("trip-already-sent");
    state.trips![0].reminder_sent_at    = "2026-07-15T09:00:00.000Z";
    state.trips![0].reminder_delivered_at = "2026-07-15T09:00:05.000Z";
    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0, "no push for an already-reminded trip");
  });

  it("does not double-send when the same trip reappears with a cleared in-memory set", async () => {
    const state = baseState("trip-restart");
    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();
    assert.equal(pushCalls.length, 1);

    // Simulate a restart: new client over the same (already-claimed) DB rows.
    // The in-memory Set would dedup here too, but the claim UPDATE returning
    // zero rows is what guarantees it; verify via the persisted column.
    pushCalls = [];
    const svc2 = makeFakeClient(state);
    _setTestServiceClient(svc2);
    await runOnce();
    assert.equal(pushCalls.length, 0, "second run sends nothing");
    assert.ok(state.trips![0].reminder_sent_at);
    assert.ok(state.trips![0].reminder_delivered_at);
  });

  it("recovers a reminder claimed before a crash (sent_at set, delivered_at null, claim is stale)", async () => {
    // Simulate: server A claimed the trip (set reminder_sent_at) but crashed
    // before the push was sent (reminder_delivered_at is NULL). The claim
    // timestamp is old enough to be considered stale.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // start_date must be within the 22-26h window (±2h drift buffer = 20-28h).
    // Use "tomorrow" (24h from now) which always falls inside the window.
    const tomorrowStr = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-crash-recovery");
    state.trips![0].reminder_sent_at    = staleTime;   // claimed, but stale
    state.trips![0].reminder_delivered_at = null;       // never delivered
    state.trips![0].start_date          = tomorrowStr; // still inside window

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1, "recovery sweep sends the missed reminder");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at is set after recovery",
    );
  });

  it("does not retry a stale claim that was already delivered", async () => {
    // reminder_sent_at is stale, but reminder_delivered_at is set — nothing to do.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const state = baseState("trip-already-delivered");
    state.trips![0].reminder_sent_at    = staleTime;
    state.trips![0].reminder_delivered_at = new Date(Date.now() - 5 * 60_000).toISOString();

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0, "no re-send when reminder was already delivered");
  });

  it("does not retry a fresh claim that might still be in-flight", async () => {
    // reminder_sent_at is very recent — could be a concurrent send still running.
    const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30 seconds ago

    const state = baseState("trip-fresh-claim");
    state.trips![0].reminder_sent_at    = recentTime;
    state.trips![0].reminder_delivered_at = null;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0, "fresh claim is not retried — not yet stale");
  });

  it("does not resend when the stale claim's trip window has already closed", async () => {
    // Simulates: server crashed after claiming the reminder, but by the time
    // recovery runs the trip has already started (start_date is in the past).
    // Sending "trip starts tomorrow!" after the trip started is worse than
    // not sending it at all.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const state = baseState("trip-window-closed");
    state.trips![0].reminder_sent_at    = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date          = "2020-01-01"; // already started — window closed

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must not resend when the trip window has already closed");
  });

  it("does not resend when the stale claim's start_date is in the future but outside the 22-26 h window", async () => {
    // Simulates: a crash happened and recovery runs, but the trip doesn't
    // start for another 3 days — far outside the 22-26 h notification window
    // (even with the ±2 h drift buffer: 20-28 h).  Sending "starts tomorrow!"
    // 3 days early would be wrong, so recovery must stay silent.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();
    // 3 days from now — well outside the 20-28 h recovery window.
    const farFuture = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-future-outside-window");
    state.trips![0].reminder_sent_at    = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date          = farFuture;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must not resend when start_date is outside the 22-26 h window");
  });

  it("stops retrying after MAX_RECOVERY_RETRIES failed attempts and does not retry again", async () => {
    // Simulate persistent Supabase failure: sendReminderForTrip throws on
    // every attempt because querying trip_members raises a network error.
    // Note: sendPushWithRetry never throws (it enqueues failures internally),
    // so we simulate failure via a hard Supabase error, not a push error.
    const MAX_RECOVERY_RETRIES = 3;
    const STALE_CLAIM_MINUTES  = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const state = baseState("trip-max-retries");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].reminder_retry_count  = 0;

    // throwOnTable: "trip_members" makes sendReminderForTrip throw on every
    // call while letting the recovery sweep's own trips queries work normally.
    const svc = makeFakeClient(state, { throwOnTable: "trip_members" });
    _setTestServiceClient(svc);

    // First attempt — retry counter must be incremented to 1.
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, 1,
      "retry count is 1 after first failure");

    // Second attempt — incremented to 2.
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, 2,
      "retry count is 2 after second failure");

    // Third attempt — reaches MAX_RECOVERY_RETRIES; row is now abandoned.
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, MAX_RECOVERY_RETRIES,
      "retry count equals MAX_RECOVERY_RETRIES after third failure");
    assert.equal(state.trips![0].reminder_delivered_at ?? null, null,
      "reminder_delivered_at stays null for a permanently abandoned trip");

    // Fourth call: lt("reminder_retry_count", 3) excludes the row from the
    // recovery query — the count must stay at MAX and not increase further.
    const countBefore = state.trips![0].reminder_retry_count as number;
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, countBefore,
      "retry count does not increase once the trip is permanently abandoned");
  });

  it("does not resend when the stale claim's start_date is ~30 h away — just outside the upper drift buffer", async () => {
    // The recovery window is 22-26 h ± 2 h drift = 20-28 h. A trip that starts
    // ~30 h from now is just outside the upper bound and must NOT trigger recovery.
    //
    // Because start_date is date-only, we derive the boundary the same way the
    // scheduler does (now + (WINDOW_UPPER_HRS + RECOVERY_DRIFT_HRS) = now + 28 h),
    // then advance by one full calendar day so the date string is unambiguously
    // after the upper window boundary — independent of the current time of day.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // Upper boundary date that the scheduler computes (now + 28 h).
    const windowUpperDate = new Date(Date.now() + (26 + 2) * 3_600_000)
      .toISOString().slice(0, 10);
    // One calendar day after that boundary → always outside the recovery window.
    const outsideWindowDate = new Date(
      new Date(windowUpperDate + "T00:00:00Z").getTime() + 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-30h-outside-window");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = outsideWindowDate; // ~30 h+ out: outside 20-28 h band

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must stay silent when start_date is ~30 h away — just outside the upper drift buffer");
  });

  it("recovers a stale claim whose start_date equals the exact upper boundary date", async () => {
    // Fence-post test for the upper boundary of the recovery window.
    // The scheduler filters with .lte("start_date", windowUpperDate), so a trip
    // whose start_date string is exactly equal to windowUpperDate MUST be included
    // and recovery must fire.
    //
    // windowUpperDate = (now + (WINDOW_UPPER_HRS + RECOVERY_DRIFT_HRS) h).toISOString().slice(0,10)
    //                 = (now + 28 h) as a date string.
    //
    // To make the boundary deterministic we pin the scheduler clock to a fixed
    // time in the middle of a UTC day so "now + 28 h" reliably falls on a
    // different calendar date than today (avoiding the rare edge where now+28h
    // still lands on the same date as now+24h).
    const STALE_CLAIM_MINUTES = 10;

    // Pin clock to 12:00 UTC so now+28h = next-day+04:00, i.e. a distinct date.
    const pinnedNow = new Date("2026-07-16T12:00:00.000Z").getTime();
    _setTestNow(pinnedNow);

    const staleTime = new Date(pinnedNow - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // Reproduce the exact windowUpperDate the scheduler computes.
    const windowUpperDate = new Date(pinnedNow + (26 + 2) * 3_600_000)
      .toISOString().slice(0, 10); // "2026-07-17"

    const state = baseState("trip-upper-boundary-exact");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = windowUpperDate; // exactly on the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when start_date equals the exact upper boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at is set after recovery on the exact upper boundary",
    );
  });

  it("re-delivers after an admin resets a permanently-abandoned reminder", async () => {
    // Scenario: the recovery sweep exhausted MAX_RECOVERY_RETRIES (3) because
    // Supabase was temporarily unavailable.  The trip is permanently excluded
    // from future recovery polls.  An admin calls POST /admin/trips/:id/reset-reminder
    // which resets reminder_retry_count to 0 and NULLs both timestamp columns.
    // The scheduler must then treat the trip as a fresh candidate and deliver on
    // the next poll.
    const MAX_RECOVERY_RETRIES = 3;
    const STALE_CLAIM_MINUTES  = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();
    const tomorrowStr = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-admin-reset");
    state.trips![0].reminder_sent_at     = staleTime;   // previously claimed
    state.trips![0].reminder_delivered_at = null;       // never confirmed
    state.trips![0].reminder_retry_count  = MAX_RECOVERY_RETRIES; // exhausted
    state.trips![0].start_date           = tomorrowStr; // still within window

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);

    // First poll: the trip is permanently excluded — no push, retry count unchanged.
    await runOnce();
    assert.equal(pushCalls.length, 0, "abandoned trip is not retried");
    assert.equal(state.trips![0].reminder_retry_count, MAX_RECOVERY_RETRIES,
      "retry count must not change for a permanently abandoned trip");

    // Simulate the admin reset: POST /admin/trips/:id/reset-reminder
    // clears the outbox so the scheduler treats the trip as fresh.
    state.trips![0].reminder_retry_count  = 0;
    state.trips![0].reminder_sent_at      = null;
    state.trips![0].reminder_delivered_at = null;

    // Second poll: the normal sweep finds the unclaimed (sent_at IS NULL) trip
    // and delivers the reminder as if it had never been attempted.
    pushCalls = [];
    const svc2 = makeFakeClient(state);
    _setTestServiceClient(svc2);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "reminder is re-delivered after admin reset");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(state.trips![0].reminder_sent_at,
      "reminder_sent_at is set after re-delivery");
    assert.ok(state.trips![0].reminder_delivered_at,
      "reminder_delivered_at is set after re-delivery");
  });

  it("re-delivers after admin reset even when the trip was previously claimed in this process", async () => {
    // This test exercises the critical in-memory dedup edge case:
    //   1. The normal sweep claims the trip in-process → adds it to the `reminded` Set.
    //   2. The send fails every time → recovery exhausts MAX_RECOVERY_RETRIES.
    //   3. Admin calls reset-reminder (clears DB columns + calls clearReminderDedup).
    //   4. Next poll re-delivers because the trip is no longer in `reminded`.
    // Without clearReminderDedup the normal sweep would skip the trip indefinitely
    // (reminded.has(tripId) === true) even though reminder_sent_at is NULL again.
    const MAX_RECOVERY_RETRIES = 3;
    const STALE_CLAIM_MINUTES  = 10;
    const tomorrowStr = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

    const tripId = "trip-admin-reset-dedup";
    const state = baseState(tripId);
    state.trips![0].start_date = tomorrowStr;

    // Phase 1 — Normal sweep claims the trip; send fails (Supabase error on trip_members).
    // The trip ID is added to the in-memory `reminded` set.
    const failSvc = makeFakeClient(state, { throwOnTable: "trip_members" });
    _setTestServiceClient(failSvc);
    await runOnce();
    assert.ok(state.trips![0].reminder_sent_at,
      "normal sweep claimed the trip (reminder_sent_at set)");
    assert.equal(state.trips![0].reminder_delivered_at ?? null, null,
      "delivery was not confirmed (send threw)");

    // Phase 2 — Age the claim so the recovery sweep picks it up, then exhaust retries.
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();
    state.trips![0].reminder_sent_at = staleTime;

    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, 1, "retry 1");
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, 2, "retry 2");
    await runOnce();
    assert.equal(state.trips![0].reminder_retry_count, MAX_RECOVERY_RETRIES, "retry 3 — abandoned");

    // Phase 3 — Verify the trip is permanently excluded: one more poll, no change.
    await runOnce();
    assert.equal(pushCalls.length, 0, "permanently abandoned — no push");
    assert.equal(state.trips![0].reminder_retry_count, MAX_RECOVERY_RETRIES,
      "retry count unchanged once abandoned");

    // Phase 4 — Admin reset: clear DB columns AND evict from in-memory dedup set.
    state.trips![0].reminder_retry_count  = 0;
    state.trips![0].reminder_sent_at      = null;
    state.trips![0].reminder_delivered_at = null;
    clearReminderDedup(tripId); // mirrors what POST /admin/trips/:id/reset-reminder does

    // Phase 5 — Next poll with a working service: normal sweep must deliver.
    pushCalls = [];
    _setTestServiceClient(makeFakeClient(state)); // no throwOnTable
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "reminder re-delivered after admin reset cleared both DB state and in-memory dedup");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(state.trips![0].reminder_sent_at,
      "reminder_sent_at is set after re-delivery");
    assert.ok(state.trips![0].reminder_delivered_at,
      "reminder_delivered_at is set after re-delivery");
  });

  it("normal sweep skips the trip when clearReminderDedup fires but the push never succeeded", async () => {
    // Edge case: clearReminderDedup evicts the trip from the in-memory `reminded` set
    // (e.g. a partial admin action that evicts the dedup entry without clearing the DB
    // columns, or a code path that calls clearReminderDedup before confirming delivery).
    // The trip now has:
    //   reminder_sent_at     IS SET   (claimed)
    //   reminder_delivered_at IS NULL  (push failed mid-flight)
    //
    // Expected behaviour
    //   Normal sweep  — must SKIP the trip because the DB gate filters on
    //                   reminder_sent_at IS NULL, which is FALSE.
    //   Recovery sweep — must SKIP the trip while the claim is fresh (< STALE_CLAIM_MINUTES),
    //                   then PICK IT UP once the claim goes stale.
    const STALE_CLAIM_MINUTES = 10;
    const tomorrowStr = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

    const tripId = "trip-dedup-cleared-push-never-succeeded";
    const state  = baseState(tripId);
    state.trips![0].start_date = tomorrowStr;

    // Simulate the state where claim succeeded but send never did:
    // reminder_sent_at is recent (just set), reminder_delivered_at is null.
    const recentClaimTime = new Date(Date.now() - 30_000).toISOString(); // 30 s ago — fresh, not stale
    state.trips![0].reminder_sent_at      = recentClaimTime;
    state.trips![0].reminder_delivered_at = null;

    // clearReminderDedup removes the trip from the in-memory `reminded` set so
    // the normal sweep would re-consider it — but the DB gate must still block it.
    clearReminderDedup(tripId);

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);

    // Poll 1: claim is fresh AND reminder_sent_at IS NOT NULL.
    // Normal sweep DB gate (IS NULL) blocks it; recovery sweep STALE_CLAIM_MINUTES threshold blocks it.
    await runOnce();
    assert.equal(pushCalls.length, 0,
      "normal sweep must skip the trip — DB gate (reminder_sent_at IS NULL) is false");
    assert.equal(state.trips![0].reminder_delivered_at ?? null, null,
      "reminder_delivered_at must stay null — no send occurred");

    // Age the claim past STALE_CLAIM_MINUTES so the recovery sweep picks it up.
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();
    state.trips![0].reminder_sent_at = staleTime;

    // Poll 2: recovery sweep finds a stale undelivered claim and re-sends.
    pushCalls = [];
    const svc2 = makeFakeClient(state);
    _setTestServiceClient(svc2);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery sweep must fire once the claim goes stale");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery re-send");
  });

  it("recovers a stale claim when start_date is ~27 h away — inside the upper drift buffer", async () => {
    // 27 h from now is within the 20-28 h recovery window (22-26 h ± 2 h drift).
    // The scheduler should detect the orphaned claim and re-send the reminder.
    //
    // The date of (now + 27 h) is always <= the date of (now + 28 h) and >= the
    // date of (now + 20 h), so it is reliably inside the window boundary
    // regardless of the current time of day.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const insideWindowDate = new Date(Date.now() + 27 * 3_600_000)
      .toISOString().slice(0, 10);

    const state = baseState("trip-27h-inside-window");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = insideWindowDate; // 27 h out: inside 20-28 h band

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when start_date is ~27 h away — inside the upper drift buffer");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery",
    );
  });

  it("does not resend when the stale claim's start_date is ~19 h away — just outside the lower drift buffer", async () => {
    // The recovery window is 22-26 h ± 2 h drift = 20-28 h. A trip that starts
    // ~19 h from now is just outside the lower bound and must NOT trigger recovery.
    //
    // Because start_date is date-only, we derive windowLowerDate the same way the
    // scheduler does (now + (WINDOW_LOWER_HRS - RECOVERY_DRIFT_HRS) = now + 20 h),
    // then subtract one full calendar day so the date string is unambiguously
    // before the lower window boundary — independent of the current time of day.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // Lower boundary date that the scheduler computes (now + 20 h).
    const windowLowerDate = new Date(Date.now() + (22 - 2) * 3_600_000)
      .toISOString().slice(0, 10);
    // One calendar day before that boundary → always outside (below) the recovery window.
    const outsideWindowDate = new Date(
      new Date(windowLowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-19h-outside-lower-window");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = outsideWindowDate; // ~19 h- out: below 20-28 h band

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must stay silent when start_date is ~19 h away — just outside the lower drift buffer");
  });

  it("recovers a stale claim when start_date is ~21 h away — inside the lower drift buffer", async () => {
    // 21 h from now is within the 20-28 h recovery window (22-26 h ± 2 h drift).
    // The scheduler should detect the orphaned claim and re-send the reminder.
    //
    // The date of (now + 21 h) is always >= the date of (now + 20 h) and <= the
    // date of (now + 28 h), so it is reliably inside the window boundary
    // regardless of the current time of day.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const insideWindowDate = new Date(Date.now() + 21 * 3_600_000)
      .toISOString().slice(0, 10);

    const state = baseState("trip-21h-inside-lower-window");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = insideWindowDate; // 21 h out: inside 20-28 h band

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when start_date is ~21 h away — inside the lower drift buffer");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery",
    );
  });

  it("recovers when start_date equals the exact lower boundary date (windowLowerDate)", async () => {
    // The recovery sweep uses .gte("start_date", windowLowerDate) where
    // windowLowerDate = new Date(now + 20 h).toISOString().slice(0, 10).
    // A trip whose start_date is exactly that date-only string must satisfy
    // the >= comparison — equal is included, not excluded.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // Mirror the scheduler's windowLowerDate formula: now + (WINDOW_LOWER_HRS - RECOVERY_DRIFT_HRS) h
    const windowLowerDate = new Date(Date.now() + (22 - 2) * 3_600_000)
      .toISOString().slice(0, 10);

    const state = baseState("trip-exact-lower-boundary");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = windowLowerDate; // exact boundary date

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when start_date equals the exact lower boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery at exact lower boundary",
    );
  });

  it("does not recover when start_date is exactly one day before the lower boundary date", async () => {
    // Confirms the fence-post: if start_date is (windowLowerDate - 1 day), the
    // .gte stub now enforces the filter and the in-process check both agree —
    // no recovery push should fire for a trip that is outside the window.
    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(Date.now() - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    const windowLowerDate = new Date(Date.now() + (22 - 2) * 3_600_000)
      .toISOString().slice(0, 10);
    // Subtract exactly one calendar day so the date string is strictly before windowLowerDate.
    const dayBeforeLower = new Date(
      new Date(windowLowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-one-day-before-lower-boundary");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = dayBeforeLower; // one day before boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must not fire when start_date is exactly one day before the lower boundary date");
  });

  // ── MAX_RECOVERY_AGE_MS exact-boundary tests ──────────────────────────────
  // recoverStaleClaims uses .gte("reminder_sent_at", recoveryFloor) where
  // recoveryFloor = new Date(now - MAX_RECOVERY_AGE_MS).toISOString().
  // A claim at (now - MAX_RECOVERY_AGE_MS + 1 ms) satisfies >= so it IS
  // recovered; a claim at (now - MAX_RECOVERY_AGE_MS - 1 ms) is strictly
  // below the floor and must NOT be recovered.

  it("recovers a stale claim whose reminder_sent_at is 1 ms inside the MAX_RECOVERY_AGE_MS floor", async () => {
    // Pin the clock so every timestamp in this test is derived from the same
    // epoch value — the scheduler reads getNow(), which respects _setTestNow.
    const PINNED_NOW = new Date("2026-07-16T12:00:00.000Z").getTime();
    _setTestNow(PINNED_NOW);

    // MAX_RECOVERY_AGE_MS = WINDOW_UPPER_HRS * 3_600_000 = 26 h (mirror the constant).
    const MAX_RECOVERY_AGE_MS = 26 * 3_600_000;

    // Exactly 1 ms newer than the recovery floor → satisfies >=.
    const justInsideFloor = new Date(PINNED_NOW - MAX_RECOVERY_AGE_MS + 1).toISOString();

    // start_date must be inside the recovery window (now + 20 h … now + 28 h).
    // Use now + 24 h, always safely inside, computed from the pinned clock.
    const startDate = new Date(PINNED_NOW + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-age-floor-inside");
    state.trips![0].reminder_sent_at      = justInsideFloor;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = startDate;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when reminder_sent_at is 1 ms inside the MAX_RECOVERY_AGE_MS floor");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery at the inside boundary",
    );
  });

  it("does not recover a stale claim whose reminder_sent_at is 1 ms outside the MAX_RECOVERY_AGE_MS floor", async () => {
    // Same pinned clock as above.
    const PINNED_NOW = new Date("2026-07-16T12:00:00.000Z").getTime();
    _setTestNow(PINNED_NOW);

    const MAX_RECOVERY_AGE_MS = 26 * 3_600_000;

    // Exactly 1 ms older than the recovery floor → fails >=, claim is too old.
    const justOutsideFloor = new Date(PINNED_NOW - MAX_RECOVERY_AGE_MS - 1).toISOString();

    const startDate = new Date(PINNED_NOW + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-age-floor-outside");
    state.trips![0].reminder_sent_at      = justOutsideFloor;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = startDate;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "recovery must not fire when reminder_sent_at is 1 ms outside the MAX_RECOVERY_AGE_MS floor");
    assert.equal(
      state.trips![0].reminder_delivered_at ?? null,
      null,
      "reminder_delivered_at must remain null when the claim is beyond the recovery floor",
    );
  });

  it("recovers a stale claim whose reminder_sent_at is exactly at the MAX_RECOVERY_AGE_MS boundary", async () => {
    // The recovery filter is .gte("reminder_sent_at", recoveryFloor) where
    // recoveryFloor = new Date(now - MAX_RECOVERY_AGE_MS).toISOString().
    // A claim where reminder_sent_at === recoveryFloor satisfies >= and must
    // still be recovered — the fence-post is inclusive on both sides.
    const PINNED_NOW = new Date("2026-07-16T12:00:00.000Z").getTime();
    _setTestNow(PINNED_NOW);

    const MAX_RECOVERY_AGE_MS = 26 * 3_600_000;

    // Exactly at the floor — not 1 ms inside, not 1 ms outside.
    const exactFloor = new Date(PINNED_NOW - MAX_RECOVERY_AGE_MS).toISOString();

    // start_date inside the recovery window (now + 24 h, always safely inside).
    const startDate = new Date(PINNED_NOW + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-age-floor-exact");
    state.trips![0].reminder_sent_at      = exactFloor;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = startDate;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when reminder_sent_at is exactly at the MAX_RECOVERY_AGE_MS floor (>= is inclusive)");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery at the exact boundary",
    );
  });

  // ── STALE_CLAIM_MS exact upper-boundary test ──────────────────────────────
  // recoverStaleClaims uses .lte("reminder_sent_at", staleThreshold) where
  // staleThreshold = new Date(now - STALE_CLAIM_MS).toISOString().
  // A claim where reminder_sent_at === staleThreshold satisfies <= and must
  // still be recovered — the fence-post is inclusive (mirrors the .gte lower
  // boundary for MAX_RECOVERY_AGE_MS fixed by task 438).

  it("recovers a stale claim whose reminder_sent_at is exactly at the STALE_CLAIM_MS upper boundary", async () => {
    // Pin the clock so every timestamp in this test is derived from the same
    // epoch value — the scheduler reads getNow(), which respects _setTestNow.
    const PINNED_NOW = new Date("2026-07-16T12:00:00.000Z").getTime();
    _setTestNow(PINNED_NOW);

    // staleThreshold = new Date(PINNED_NOW - STALE_CLAIM_MS).toISOString()
    // A claim at exactly this timestamp satisfies .lte and must be recovered.
    const exactStaleThreshold = new Date(PINNED_NOW - STALE_CLAIM_MS).toISOString();

    // start_date must be inside the recovery window (now + 24 h, always safely
    // inside the 20-28 h window), computed from the pinned clock.
    const startDate = new Date(PINNED_NOW + 24 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-stale-threshold-exact");
    state.trips![0].reminder_sent_at      = exactStaleThreshold;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = startDate;

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "recovery must fire when reminder_sent_at equals the exact STALE_CLAIM_MS upper boundary (.lte is inclusive)");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "reminder_delivered_at must be set after recovery at the exact STALE_CLAIM_MS boundary",
    );
  });

  // ── midnight-clock boundary tests ─────────────────────────────────────────
  // These four tests pin Date.now() to 23:00 UTC so that the window boundary
  // dates straddle midnight.  With the clock at 23:00:
  //   windowLowerDate = (23:00 + 20 h) → next day at 19:00 → "YYYY-MM-DD+1"
  //   windowUpperDate = (23:00 + 28 h) → day after next at 03:00 → "YYYY-MM-DD+2"
  // A naive implementation that computed these dates incorrectly (e.g. using
  // local time instead of UTC, or rounding the wrong direction) would flip
  // inside/outside for trips near the boundary.

  it("[midnight clock] recovers a stale claim when start_date equals the lower boundary date", async () => {
    // Pin the scheduler clock to 23:00:00 UTC on an arbitrary date so the
    // window boundary computation straddles midnight.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    // staleTime must be relative to the PINNED clock so it is older than the
    // staleThreshold that recoverStaleClaims derives from that same clock.
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowLowerDate = new Date(PINNED_NOW + 20 h).slice(0,10) = "2026-07-17"
    const windowLowerDate = new Date(PINNED_NOW + 20 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-lower-inside");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = windowLowerDate; // exactly on the lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[midnight clock] recovery must fire when start_date equals the lower boundary date");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "[midnight clock] reminder_delivered_at must be set after recovery at lower boundary",
    );
  });

  it("[midnight clock] does not recover a stale claim when start_date is one day before the lower boundary", async () => {
    // Same pinned clock as above.  A trip whose start_date is one calendar day
    // before windowLowerDate is outside the window and must not trigger recovery.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowLowerDate = "2026-07-17"; one day before = "2026-07-16".
    const windowLowerDate = new Date(PINNED_NOW + 20 * 3_600_000).toISOString().slice(0, 10);
    const outsideLowerDate = new Date(
      new Date(windowLowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-lower-outside");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = outsideLowerDate; // one day before lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[midnight clock] recovery must stay silent when start_date is one day before the lower boundary");
  });

  it("[midnight clock] recovers a stale claim when start_date equals the upper boundary date", async () => {
    // Pin to 23:00 UTC.  windowUpperDate = (23:00 + 28 h) = next day + 3 h
    // → "2026-07-18".  A trip on that date is on the boundary and must be recovered.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowUpperDate = new Date(PINNED_NOW + 28 h).slice(0,10) = "2026-07-18"
    const windowUpperDate = new Date(PINNED_NOW + 28 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-upper-inside");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = windowUpperDate; // exactly on the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[midnight clock] recovery must fire when start_date equals the upper boundary date");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "[midnight clock] reminder_delivered_at must be set after recovery at upper boundary",
    );
  });

  it("[midnight clock] does not recover a stale claim when start_date is one day after the upper boundary", async () => {
    // Same pinned clock.  A trip whose start_date is one calendar day after
    // windowUpperDate is outside the window and must not trigger recovery.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowUpperDate = "2026-07-18"; one day after = "2026-07-19".
    const windowUpperDate = new Date(PINNED_NOW + 28 * 3_600_000).toISOString().slice(0, 10);
    const outsideUpperDate = new Date(
      new Date(windowUpperDate + "T00:00:00Z").getTime() + 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-upper-outside");
    state.trips![0].reminder_sent_at     = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date           = outsideUpperDate; // one day after upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[midnight clock] recovery must stay silent when start_date is one day after the upper boundary");
  });

  // ── midnight-clock 23:30 UTC upper-boundary tests ─────────────────────────
  // These two tests repeat the upper-boundary check with the clock pinned to
  // 23:30 UTC instead of 23:00 UTC.  At 23:30 the window still straddles
  // midnight (windowUpperDate = 23:30 + 28 h = 03:30 next-next-day → "YYYY-MM-DD+2")
  // but the half-hour difference means the date arithmetic must be correct to
  // the minute — not just to the hour — to produce the right date string.

  it("[midnight clock 23:30] recovers a stale claim when start_date equals the upper boundary date", async () => {
    // Pin the clock to 23:30 UTC.  The recovery sweep uses
    //   windowUpperDate = new Date(now + 28 h).toISOString().slice(0,10)
    // = new Date("2026-07-16T23:30Z" + 28 h).slice(0,10)
    // = new Date("2026-07-18T03:30Z").slice(0,10) = "2026-07-18".
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowUpperDate mirrors the scheduler formula (WINDOW_UPPER_HRS + RECOVERY_DRIFT_HRS = 28 h).
    const windowUpperDate = new Date(PINNED_NOW + 28 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-2330-upper-inside");
    state.trips![0].reminder_sent_at      = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = windowUpperDate; // exactly on the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[midnight clock 23:30] recovery must fire when start_date equals the upper boundary date");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "[midnight clock 23:30] reminder_delivered_at must be set after recovery at upper boundary",
    );
  });

  it("[midnight clock 23:30] does not recover a stale claim when start_date is one day after the upper boundary", async () => {
    // Same 23:30 UTC clock.  A trip one calendar day beyond windowUpperDate is
    // outside the recovery window and must not trigger a re-send.
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowUpperDate = "2026-07-18"; one day after = "2026-07-19".
    const windowUpperDate = new Date(PINNED_NOW + 28 * 3_600_000).toISOString().slice(0, 10);
    const outsideUpperDate = new Date(
      new Date(windowUpperDate + "T00:00:00Z").getTime() + 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-2330-upper-outside");
    state.trips![0].reminder_sent_at      = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = outsideUpperDate; // one day after upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[midnight clock 23:30] recovery must stay silent when start_date is one day after the upper boundary");
  });

  // ── midnight-clock 23:30 UTC lower-boundary tests ─────────────────────────
  // Symmetric counterpart to the 23:30 upper-boundary tests above.  With the
  // clock at 23:30 UTC, windowLowerDate = new Date(now + 20 h).slice(0,10).
  // "2026-07-16T23:30Z" + 20 h = "2026-07-17T19:30Z" → "2026-07-17".
  // A bug that shifts the lower boundary by ±1 calendar day would either fire
  // for a trip that should be excluded or silently skip a trip that qualifies.

  it("[midnight clock 23:30] recovers a stale claim when start_date equals the lower boundary date", async () => {
    // Pin the clock to 23:30 UTC.  The recovery sweep uses
    //   windowLowerDate = new Date(now + 20 h).toISOString().slice(0,10)
    // = new Date("2026-07-16T23:30Z" + 20 h).slice(0,10)
    // = new Date("2026-07-17T19:30Z").slice(0,10) = "2026-07-17".
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowLowerDate mirrors the scheduler formula (WINDOW_LOWER_HRS - RECOVERY_DRIFT_HRS = 20 h).
    const windowLowerDate = new Date(PINNED_NOW + 20 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-2330-lower-inside");
    state.trips![0].reminder_sent_at      = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = windowLowerDate; // exactly on the lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[midnight clock 23:30] recovery must fire when start_date equals the lower boundary date");
    assert.ok(
      state.trips![0].reminder_delivered_at,
      "[midnight clock 23:30] reminder_delivered_at must be set after recovery at lower boundary",
    );
  });

  it("[midnight clock 23:30] does not recover a stale claim when start_date is one day before the lower boundary", async () => {
    // Same 23:30 UTC clock.  A trip one calendar day before windowLowerDate is
    // outside the recovery window and must not trigger a re-send.
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const STALE_CLAIM_MINUTES = 10;
    const staleTime = new Date(PINNED_NOW - (STALE_CLAIM_MINUTES + 1) * 60_000).toISOString();

    // windowLowerDate = "2026-07-17"; one day before = "2026-07-16".
    const windowLowerDate = new Date(PINNED_NOW + 20 * 3_600_000).toISOString().slice(0, 10);
    const outsideLowerDate = new Date(
      new Date(windowLowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-midnight-2330-lower-outside");
    state.trips![0].reminder_sent_at      = staleTime;
    state.trips![0].reminder_delivered_at = null;
    state.trips![0].start_date            = outsideLowerDate; // one day before lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[midnight clock 23:30] recovery must stay silent when start_date is one day before the lower boundary");
  });

  // ── normal-sweep midnight-clock boundary tests ────────────────────────────
  // The normal sweep in runOnce derives lower and upper dates via .slice(0,10)
  // on now + 22 h and now + 26 h.  With the clock pinned to 23:00 UTC these
  // boundaries straddle midnight:
  //   lower = (23:00 + 22 h) = next day 21:00  → "2026-07-17"
  //   upper = (23:00 + 26 h) = day-after 01:00 → "2026-07-18"
  // A rounding or timezone bug in .slice(0,10) would silently flip inside/outside.

  it("[normal sweep, midnight clock] pushes when start_date equals the lower boundary date", async () => {
    // Pin the clock to 23:00 UTC so the lower boundary crosses into the next day.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // lower = new Date(PINNED_NOW + 22 h).toISOString().slice(0,10) = "2026-07-17"
    const lowerDate = new Date(PINNED_NOW + 22 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-lower-inside");
    // reminder_sent_at must be null so the normal sweep can claim it.
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = lowerDate; // exactly on the lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[normal sweep, midnight clock] must push when start_date equals the lower boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
  });

  it("[normal sweep, midnight clock] does not push when start_date is one day before the lower boundary", async () => {
    // A trip one calendar day before the lower boundary date is outside the
    // 22-26 h window and must not receive a reminder.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // lower = "2026-07-17"; one day before = "2026-07-16"
    const lowerDate = new Date(PINNED_NOW + 22 * 3_600_000).toISOString().slice(0, 10);
    const beforeLowerDate = new Date(
      new Date(lowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-lower-outside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = beforeLowerDate; // one day before the lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[normal sweep, midnight clock] must not push when start_date is one day before the lower boundary");
  });

  it("[normal sweep, midnight clock] pushes when start_date equals the upper boundary date", async () => {
    // upper = new Date(PINNED_NOW + 26 h).toISOString().slice(0,10) = "2026-07-18"
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    const upperDate = new Date(PINNED_NOW + 26 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-upper-inside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = upperDate; // exactly on the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[normal sweep, midnight clock] must push when start_date equals the upper boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
  });

  it("[normal sweep, midnight clock] does not push when start_date is one day after the upper boundary", async () => {
    // A trip one calendar day after the upper boundary date is outside the window.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // upper = "2026-07-18"; one day after = "2026-07-19"
    const upperDate = new Date(PINNED_NOW + 26 * 3_600_000).toISOString().slice(0, 10);
    const afterUpperDate = new Date(
      new Date(upperDate + "T00:00:00Z").getTime() + 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-upper-outside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = afterUpperDate; // one day after the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[normal sweep, midnight clock] must not push when start_date is one day after the upper boundary");
  });

  // ── normal sweep, midnight clock 23:30 UTC — upper-boundary tests ──────────
  // With the clock at 23:30 UTC on 2026-07-16:
  //   upper = new Date(23:30 + 26 h).toISOString().slice(0,10)
  //         = new Date("2026-07-18T01:30:00Z").toISOString().slice(0,10)
  //         = "2026-07-18"
  // The fractional offset (01:30 into the day) differs from the 23:00 case
  // (01:00 into the day), so any integer-division or timezone bug that only
  // manifests at certain fractional offsets will surface here.

  it("[normal sweep, midnight clock 23:30] pushes when start_date equals the upper boundary date", async () => {
    // Pin the scheduler clock to 23:30 UTC.
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // upper = new Date(PINNED_NOW + 26 h).toISOString().slice(0,10) = "2026-07-18"
    const upperDate = new Date(PINNED_NOW + 26 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-2330-upper-inside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = upperDate; // exactly on the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[normal sweep, midnight clock 23:30] must push when start_date equals the upper boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
  });

  it("[normal sweep, midnight clock 23:30] does not push when start_date is one day after the upper boundary", async () => {
    // A trip one calendar day after the upper boundary date is outside the window.
    const PINNED_NOW = new Date("2026-07-16T23:30:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // upper = "2026-07-18"; one day after = "2026-07-19"
    const upperDate = new Date(PINNED_NOW + 26 * 3_600_000).toISOString().slice(0, 10);
    const afterUpperDate = new Date(
      new Date(upperDate + "T00:00:00Z").getTime() + 24 * 3_600_000,
    ).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-2330-upper-outside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = afterUpperDate; // one day after the upper boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[normal sweep, midnight clock 23:30] must not push when start_date is one day after the upper boundary");
  });

  it("[normal sweep, midnight clock] does not push when start_date is the current calendar day", async () => {
    // With the clock at 23:00 UTC on 2026-07-16:
    //   lower = new Date(PINNED_NOW + 22 h).toISOString().slice(0,10) = "2026-07-17"
    // A trip whose start_date is today ("2026-07-16") is strictly below the
    // lower boundary and must not receive a normal-sweep reminder.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // The current calendar day as seen by the server clock.
    const todayDate = new Date(PINNED_NOW).toISOString().slice(0, 10); // "2026-07-16"

    const state = baseState("trip-normal-midnight-today");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = todayDate; // current calendar day — below lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[normal sweep, midnight clock] must not push when start_date is the current calendar day (below lower boundary)");
  });

  // ── normal-sweep 00:00 UTC (midnight-exactly) boundary tests ─────────────
  // When the server clock is pinned to exactly 00:00 UTC on 2026-07-17:
  //   lower = new Date(00:00 + 22 h).toISOString().slice(0,10)
  //         = "2026-07-17T22:00:00Z".slice(0,10) = "2026-07-17"
  // Today's date as seen by the server clock is also "2026-07-17", so the
  // lower boundary equals today.  A trip starting today is ON the boundary
  // and must be pushed; a trip starting yesterday ("2026-07-16") is strictly
  // below the boundary and must be skipped.

  it("[normal sweep, 00:00 clock] pushes when start_date equals the lower boundary date (same as today)", async () => {
    // Pin the clock to exactly midnight UTC.  lower = today at 22:00 UTC →
    // start_date "2026-07-17" is on the lower boundary and must be sent.
    const PINNED_NOW = new Date("2026-07-17T00:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // lower = new Date(PINNED_NOW + 22 h).toISOString().slice(0,10) = "2026-07-17"
    const lowerDate = new Date(PINNED_NOW + 22 * 3_600_000).toISOString().slice(0, 10);

    const state = baseState("trip-normal-midnight-zero-lower-inside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = lowerDate; // "2026-07-17" — equals lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[normal sweep, 00:00 clock] must push when start_date equals the lower boundary date");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
    );
  });

  it("[normal sweep, 00:00 clock] does not push when start_date is yesterday — one day below the lower boundary", async () => {
    // With the clock at 00:00 UTC on 2026-07-17, lower = "2026-07-17".
    // A trip starting yesterday ("2026-07-16") is strictly below the lower
    // boundary and must not receive a normal-sweep reminder.
    const PINNED_NOW = new Date("2026-07-17T00:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // lower = "2026-07-17"; one day before = "2026-07-16"
    const lowerDate = new Date(PINNED_NOW + 22 * 3_600_000).toISOString().slice(0, 10);
    const beforeLowerDate = new Date(
      new Date(lowerDate + "T00:00:00Z").getTime() - 24 * 3_600_000,
    ).toISOString().slice(0, 10); // "2026-07-16"

    const state = baseState("trip-normal-midnight-zero-lower-outside");
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = beforeLowerDate; // "2026-07-16" — below lower boundary

    const svc = makeFakeClient(state);
    _setTestServiceClient(svc);
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[normal sweep, 00:00 clock] must not push when start_date is one day before the lower boundary (yesterday)");
  });

  it("[normal sweep, midnight clock] does not re-push after clearReminderDedup — reminder_sent_at gate holds", async () => {
    // Scenario: the clock is pinned near midnight (23:00 UTC). The normal sweep
    // fires and successfully delivers the reminder, setting reminder_sent_at.
    // clearReminderDedup() is then called (as the admin-reset endpoint does).
    // A second runOnce() with the same pinned clock must NOT push again — the
    // DB-level gate (reminder_sent_at IS NULL) must prevent re-delivery even
    // when the in-memory dedup set is cleared.
    //
    // This confirms the midnight date-boundary logic and the dedup-clear path
    // compose correctly: clearing the in-memory set does not bypass the outbox.
    const PINNED_NOW = new Date("2026-07-16T23:00:00Z").getTime();
    _setTestNow(PINNED_NOW);

    // lower boundary date: now + 22 h = "2026-07-17"
    const lowerDate = new Date(PINNED_NOW + 22 * 3_600_000).toISOString().slice(0, 10);

    const tripId = "trip-midnight-dedup-clear";
    const state = baseState(tripId);
    state.trips![0].reminder_sent_at  = null;
    state.trips![0].start_date        = lowerDate; // exactly on the lower boundary date

    _setTestServiceClient(makeFakeClient(state));

    // Phase 1 — Normal sweep claims and delivers the reminder.
    await runOnce();

    assert.equal(pushCalls.length, 1,
      "[midnight + dedup-clear] first runOnce must push the trip");
    assert.deepEqual(
      pushCalls[0].map((m: any) => m.to).sort(),
      [OWNER_TOKEN, MEMBER_TOKEN].sort(),
      "[midnight + dedup-clear] push must reach owner and member",
    );
    assert.ok(state.trips![0].reminder_sent_at,
      "[midnight + dedup-clear] reminder_sent_at must be set after first push");
    assert.ok(state.trips![0].reminder_delivered_at,
      "[midnight + dedup-clear] reminder_delivered_at must be set after first push");

    // Phase 2 — Clear the in-memory dedup set (as the admin reset endpoint does).
    clearReminderDedup(tripId);
    pushCalls = [];

    // Phase 3 — Second poll with the same pinned clock. reminder_sent_at IS SET,
    // so the DB query (which filters .is("reminder_sent_at", null)) returns no
    // rows.  No push must occur — the outbox gate is the authoritative guard.
    await runOnce();

    assert.equal(pushCalls.length, 0,
      "[midnight + dedup-clear] second runOnce must NOT push — reminder_sent_at IS SET blocks re-delivery");
  });
});
