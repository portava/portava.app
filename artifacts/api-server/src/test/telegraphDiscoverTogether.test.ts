/**
 * Telegraph §20 Discovery — "Discover Together; shared opportunity set from
 * availability, time and context".
 *
 * census-telegraph T266: "Sharing a discovery card is not 'Discover Together'.
 * No shared opportunity set exists; Telegraph reads neither availability nor
 * time context."
 *
 * WHAT THIS PINS. The three inputs, separately, and the failure direction of
 * each. An opportunity set is the kind of surface where every mistake looks
 * like a result: an unreadable availability table renders as "nobody is free",
 * a missing entitlement renders as "nobody is free", and an expired row renders
 * as somebody who is not. All three are different facts and the answer says
 * which one it is.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Availability read on a thread with no trip: the direct-thread test fails
 *     and this route would have invented an entitlement nothing granted.
 *   - The per-member crew re-verification dropped: the removed-crew test fails,
 *     and somebody who left a trip has their availability read for it.
 *   - `expires_at` not re-evaluated on the read: the stale test fails, and a
 *     stalled sweep puts a FREE NOW from yesterday into tonight's plan.
 *   - An unreadable availability table folded into an empty set: the degraded
 *     test fails, and "we could not look" renders as "nobody is free".
 *
 * Run: node --import tsx/esm --test src/test/telegraphDiscoverTogether.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import sharedContextRouter from "../routes/telegraphSharedContext.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const TRIP_THREAD = "dddddddd-0000-4000-8000-00000000000d";
const DM_THREAD = "dddddddd-0000-4000-8000-00000000000e";
const TRIP = "20000000-0000-4000-8000-000000000001";

const NOW = Date.now();
const hr = (n: number) => new Date(NOW + n * 3600_000).toISOString();

interface State {
  quick?: any[];
  /** Bob's trip_members row is removed, so the roster and the crew disagree. */
  bobLeftTrip?: boolean;
  /** The VIEWER's own crew row is removed, while they stay on the thread roster. */
  aliceLeftTrip?: boolean;
  availabilityError?: boolean;
  tripMembersError?: boolean;
  planStartsAt?: string;
}

function makeClient(state: State = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: false }],
    message_threads: [
      { id: TRIP_THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null },
      { id: DM_THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null },
    ],
    message_thread_members: [
      { thread_id: TRIP_THREAD, user_id: ALICE, left_at: null },
      { thread_id: TRIP_THREAD, user_id: BOB, left_at: null },
      { thread_id: DM_THREAD, user_id: ALICE, left_at: null },
      { thread_id: DM_THREAD, user_id: BOB, left_at: null },
    ],
    trip_members: [
      ...(state.aliceLeftTrip ? [] : [{ trip_id: TRIP, user_id: ALICE, role: "member", status: "accepted" }]),
      ...(state.bobLeftTrip ? [] : [{ trip_id: TRIP, user_id: BOB, role: "member", status: "accepted" }]),
    ],
    trips: [{ id: TRIP, owner_id: "someone-else", title: "Lisbon", start_date: null, end_date: null }],
    quick_availability_status: [...(state.quick ?? [])],
    // The shared-context resolvers read these; empty is fine except meetups.
    meetups: [
      {
        id: "meet-1",
        title: "Dinner",
        starts_at: state.planStartsAt ?? hr(3),
        ends_at: hr(6),
        status: "confirmed",
        creator_id: ALICE,
        updated_at: null,
        chat_thread_id: TRIP_THREAD,
      },
    ],
    meetup_invites: [
      { meetup_id: "meet-1", user_id: BOB, status: "going" },
      { meetup_id: "meet-1", user_id: ALICE, status: "going" },
    ],
  };

  const readTables: string[] = [];

  function from(table: string) {
    readTables.push(table);
    const preds: Array<(r: any) => boolean> = [];
    const shape: string[] = [];
    let _limit: number | null = null;
    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () => {
      if (table === "quick_availability_status" && state.availabilityError) {
        return { message: "availability read blew up", code: "XX000" };
      }
      if (table === "trip_members" && state.tripMembersError) {
        return { message: "trip_members unreadable", code: "XX000" };
      }
      return null;
    };
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { shape.push(`eq:${col}`); preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { shape.push(`neq:${col}`); preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { shape.push(`is:${col}`); preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { shape.push(`in:${col}`); preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      lte(col: string, val: any) { preds.push((r) => Date.parse(r[col]) <= Date.parse(val)); return proxy; },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
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
    _readTables: readTables,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

let server: any;
let base = "";

async function get(path: string, asUser: string) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", sharedContextRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  _setTestClient(null, false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("§20 Discover Together — a set from availability, time and context", () => {
  it("names the three inputs and its own time frame", async () => {
    _setTestClient(makeClient({ quick: [{ user_id: ALICE, status: "free_now", expires_at: hr(4) }] }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs.time.frame, "UTC", "an implied destination-local day would be wrong (T423)");
    assert.equal(r.body.inputs.time.hours, 12);
    assert.equal(r.body.source, "SHARED_CONTEXT");
    assert.ok("entitled" in r.body.inputs.availability);
  });

  it("admits a shared plan inside the window and says which inputs admitted it", async () => {
    _setTestClient(makeClient({
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: hr(4) },
        { user_id: BOB, status: "open_to_plans", expires_at: hr(8) },
      ],
    }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    const item = r.body.opportunities.find((o: any) => o.objectId === "meet-1");
    assert.ok(item, "a plan these two share, starting in three hours, is not in the set");
    assert.equal(item.admittedBy.context, true);
    assert.equal(item.admittedBy.time, true);
    assert.equal(item.admittedBy.availability, true);
    assert.deepEqual(item.availableParticipantIds, [ALICE, BOB].sort());
  });

  it("drops a plan outside the window", async () => {
    _setTestClient(makeClient({ planStartsAt: hr(100) }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.equal(r.body.opportunities.find((o: any) => o.objectId === "meet-1"), undefined);
  });

  it("a DIRECT thread gets NO availability, and the reason is named", async () => {
    const c = makeClient({ quick: [{ user_id: BOB, status: "free_now", expires_at: hr(4) }] });
    _setTestClient(c, true);
    const r = await get(`/threads/${DM_THREAD}/discover-together`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs.availability.entitled, false);
    assert.equal(r.body.inputs.availability.reason, "no_entitlement_on_this_thread_type");
    assert.deepEqual(r.body.inputs.availability.availableParticipantIds, []);

    // Not only the ANSWER: the question is never asked either. A route that
    // refused after reading everybody's availability would pass the assertions
    // above and still have read it.
    //
    // This does NOT pin the `ctx.tripId &&` short-circuit, and that was
    // measured rather than assumed: deleting that term changes neither the
    // answer nor this read, because `isAcceptedTripMember` cannot pass with a
    // null trip id — `requireTripMember` falls through to a `trips` lookup on
    // a null id and finds nothing. The term is a saved pair of reads on every
    // DM, not a gate, and the gate is the crew check.
    assert.equal(
      c._readTables.includes("quick_availability_status"),
      false,
      "a direct thread must not read anybody's availability at all",
    );
  });

  it("a member on the thread roster but NO LONGER CREW has their availability left out", async () => {
    // T319: the thread roster and the trip roster are not written in one
    // transaction, so a removed crew member is on the roster until a sync runs.
    _setTestClient(makeClient({
      bobLeftTrip: true,
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: hr(4) },
        { user_id: BOB, status: "free_now", expires_at: hr(4) },
      ],
    }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.deepEqual(r.body.inputs.availability.availableParticipantIds, [ALICE]);
  });

  it("a VIEWER who is on the roster but no longer CREW reads nobody's availability", async () => {
    // Added because a mutation did not land: deleting the viewer-side crew
    // check changed nothing, because every fixture had the viewer as accepted
    // crew and the only non-trip case short-circuits earlier. The gate was
    // untested, not redundant.
    const c = makeClient({
      aliceLeftTrip: true,
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: hr(4) },
        { user_id: BOB, status: "free_now", expires_at: hr(4) },
      ],
    });
    _setTestClient(c, true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs.availability.entitled, false);
    assert.deepEqual(r.body.inputs.availability.availableParticipantIds, []);
    assert.equal(
      c._readTables.includes("quick_availability_status"),
      false,
      "somebody who has left the trip must not be able to read the crew's availability through its thread",
    );
  });

  it("an EXPIRED availability row is not somebody who is free", async () => {
    _setTestClient(makeClient({
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: hr(4) },
        { user_id: BOB, status: "free_now", expires_at: hr(-1) },
      ],
    }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.deepEqual(r.body.inputs.availability.availableParticipantIds, [ALICE],
      "§4.3's expiry is re-evaluated on the read, so a stalled sweep cannot put yesterday into tonight");
  });

  it("BUSY is not availability", async () => {
    _setTestClient(makeClient({
      quick: [
        { user_id: ALICE, status: "free_now", expires_at: hr(4) },
        { user_id: BOB, status: "busy", expires_at: hr(4) },
      ],
    }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.deepEqual(r.body.inputs.availability.availableParticipantIds, [ALICE]);
  });

  it("an UNREADABLE availability table is reported, not rendered as 'nobody is free'", async () => {
    _setTestClient(makeClient({ availabilityError: true }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs.availability.entitled, false);
    assert.equal(r.body.incomplete, true);
  });

  it("an UNREADABLE crew roster drops the availability half and keeps the rest", async () => {
    // `requireTripMember` THROWS here rather than returning false. §17.1 records
    // what happens when that throw becomes "not a member": a whole crew is
    // evicted. It becomes neither that nor a 500.
    _setTestClient(makeClient({ tripMembersError: true }), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.inputs.availability.entitled, false);
    assert.equal(r.body.incomplete, true);
    assert.ok(Array.isArray(r.body.opportunities), "the context half is still an answer");
  });

  it("a non-member is refused", async () => {
    _setTestClient(makeClient(), true);
    const r = await get(`/threads/${TRIP_THREAD}/discover-together`, "cccccccc-0000-4000-8000-000000000003");
    assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
  });
});
