/**
 * TripReminderScheduler push tests — representative direct-push caller.
 *
 * Verifies the 24h trip reminder uses sendPushWithRetry so a transient Expo
 * outage enqueues rows on push_retry_queue (one per recipient) instead of
 * silently dropping the alert.
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

function makeFakeClient(state: FakeState) {
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
    const b: any = {
      select() { return b; },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        inserted[table].push(row);
        return b;
      },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      gte() { return b; }, lte() { return b; }, order() { return b; },
      then(onF: any, onR: any) {
        if (pendingInsert) return Promise.resolve({ data: pendingInsert, error: null }).then(onF, onR);
        const data = rowsFor(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data, error: null }).then(onF, onR);
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
    trips: [{ id: tripId, title: "Lisbon Adventure", owner_id: OWNER_ID, status: "upcoming" }],
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
});
