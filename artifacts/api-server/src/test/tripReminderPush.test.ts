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
import { runOnce } from "../lib/tripReminderScheduler.js";

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
      gte() { return b; }, lte() { return b; }, order() { return b; },
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
afterEach(() => { pushCalls = []; _setTestFetch(okFetch()); });

function baseState(tripId: string): FakeState {
  return {
    trips: [{
      id: tripId, title: "Lisbon Adventure", owner_id: OWNER_ID, status: "upcoming",
      reminder_retry_count: 0,
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
});
