/**
 * Trips spec §3.1 — the primary lifecycle, derived (census-trips TR35).
 *
 * TR35 has been W since the first census: "Seven states against thirteen:
 * BOOKED, PRE_DEPARTURE, TRAVELING vs IN_DESTINATION vs RETURNING, MEMORY,
 * DISRUPTED and ABANDONED have no representation, so the states that carry the
 * spec's operational meaning are exactly the missing ones."
 *
 * This file drives all thirteen — the clauses, their ORDER, and the rule that
 * a fact nobody read is not a fact that is false — and then drives the whole
 * thing through GET /trips/:tripId/lifecycle against tables production
 * actually has, with no feature flag anywhere in the fake database.
 *
 * Run: node --import tsx/esm --test src/test/tripLifecycle.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  deriveTripLifecycle,
  TRIP_LIFECYCLE_STATES,
  TRIP_FORWARD_LIFECYCLE,
  TRIP_ALTERNATIVE_LIFECYCLE,
  PRE_DEPARTURE_HOURS,
  type LifecycleInputs,
} from "../domain/trips/services/TripLifecycle.js";

// ── Part A: the derivation, clause by clause ───────────────────────────────

const at = (iso: string) => new Date(iso);

/** A trip in Lisbon, 12-15 September, read at 14:00 UTC on the 13th. */
const base = (o: Partial<LifecycleInputs> = {}): LifecycleInputs => ({
  now: at("2026-09-13T14:00:00Z"),
  timezone: "Europe/Lisbon",
  startDate: "2026-09-12",
  endDate: "2026-09-15",
  storedStatus: "active",
  title: "Lisbon",
  destinationCity: "Lisbon",
  confirmedBookings: 0,
  travelLegs: [],
  completedPlanItems: 0,
  recordedMemories: 0,
  activeDisruptions: 0,
  ...o,
});

describe("§3.1 the lifecycle vocabulary", () => {
  it("is thirteen states: nine forward, four alternative, none repeated", () => {
    assert.equal(TRIP_FORWARD_LIFECYCLE.length, 9);
    assert.equal(TRIP_ALTERNATIVE_LIFECYCLE.length, 4);
    assert.equal(TRIP_LIFECYCLE_STATES.length, 13);
    assert.equal(new Set(TRIP_LIFECYCLE_STATES).size, 13);
    // The spec's own words, in the spec's own order.
    assert.deepEqual([...TRIP_FORWARD_LIFECYCLE], [
      "IDEA", "PLANNING", "BOOKED", "PRE_DEPARTURE", "TRAVELING", "IN_DESTINATION", "RETURNING", "COMPLETED", "MEMORY",
    ]);
    assert.deepEqual([...TRIP_ALTERNATIVE_LIFECYCLE], ["DISRUPTED", "CANCELLED", "ABANDONED", "ARCHIVED"]);
  });

  it("every one of the thirteen is reachable from some input — a state no clause can name is vocabulary, not a state machine", () => {
    const reached = new Set<string>();
    const cases: Array<Partial<LifecycleInputs>> = [
      { storedStatus: "archived" },
      { storedStatus: "cancelled" },
      { activeDisruptions: 1 },
      { title: null },
      { startDate: null },
      { now: at("2026-09-01T12:00:00Z") },                                   // PLANNING, well before
      { now: at("2026-09-01T12:00:00Z"), confirmedBookings: 2 },             // BOOKED
      { now: at("2026-09-11T12:00:00Z") },                                   // PRE_DEPARTURE
      { travelLegs: [{ id: "L1", startsAt: "2026-09-13T13:00:00Z", endsAt: "2026-09-13T16:00:00Z" }] },  // TRAVELING
      { travelLegs: [
        { id: "L1", startsAt: "2026-09-12T08:00:00Z", endsAt: "2026-09-12T11:00:00Z" },
        { id: "L2", startsAt: "2026-09-13T09:00:00Z", endsAt: "2026-09-13T12:00:00Z" },
      ] },                                                                    // RETURNING
      {},                                                                     // IN_DESTINATION
      { now: at("2026-09-20T12:00:00Z"), confirmedBookings: 1 },              // COMPLETED
      { now: at("2026-09-20T12:00:00Z") },                                    // ABANDONED
      { now: at("2026-09-20T12:00:00Z"), recordedMemories: 3 },               // MEMORY
    ];
    for (const c of cases) reached.add(deriveTripLifecycle(base(c)).state);
    for (const s of TRIP_LIFECYCLE_STATES) assert.ok(reached.has(s), `no input reached ${s}`);
  });
});

describe("§3.1 the clauses, in order", () => {
  it("an explicit terminal act is first and is never recomputed away", () => {
    const busy = { activeDisruptions: 5, recordedMemories: 9, confirmedBookings: 4 };
    assert.equal(deriveTripLifecycle(base({ storedStatus: "archived", ...busy })).state, "ARCHIVED");
    assert.equal(deriveTripLifecycle(base({ storedStatus: "cancelled", ...busy })).state, "CANCELLED");
    assert.match(deriveTripLifecycle(base({ storedStatus: "cancelled" })).reason, /explicit user action/);
  });

  it("DISRUPTED overrides the forward chain while it lasts, and only while it lasts", () => {
    const inDestination = base({ travelLegs: [] });
    assert.equal(deriveTripLifecycle({ ...inDestination, activeDisruptions: 1 }).state, "DISRUPTED");
    assert.equal(deriveTripLifecycle(inDestination).state, "IN_DESTINATION");
    // It is an ALTERNATIVE state, not a terminal one: resolving it returns the
    // trip to the state the calendar and the facts already said.
    const after = deriveTripLifecycle({ ...inDestination, activeDisruptions: 0, now: at("2026-09-20T12:00:00Z"), confirmedBookings: 1 });
    assert.equal(after.state, "COMPLETED");
  });

  it("IDEA needs no dates and beats them: a trip with no subject is an IDEA whatever the calendar says", () => {
    assert.equal(deriveTripLifecycle(base({ title: null })).state, "IDEA");
    assert.equal(deriveTripLifecycle(base({ destinationCity: null })).state, "IDEA");
    assert.equal(deriveTripLifecycle(base({ title: null, now: at("2026-09-20T12:00:00Z") })).state, "IDEA");
    assert.equal(deriveTripLifecycle(base({ title: "Lisbon", destinationCity: "Lisbon", startDate: null })).state, "PLANNING");
  });

  it("before the start: PLANNING, then BOOKED once something is confirmed, then PRE_DEPARTURE once departure is near", () => {
    const far = { now: at("2026-08-01T12:00:00Z") };
    assert.equal(deriveTripLifecycle(base(far)).state, "PLANNING");
    assert.equal(deriveTripLifecycle(base({ ...far, confirmedBookings: 2 })).state, "BOOKED");
    // The window is the trip's first day when no leg carries a time …
    assert.equal(deriveTripLifecycle(base({ now: at("2026-09-11T12:00:00Z"), confirmedBookings: 2 })).state, "PRE_DEPARTURE");
    // … and the booked leg when one does, even with the first day further off.
    const byLeg = deriveTripLifecycle(base({
      ...far, confirmedBookings: 1,
      travelLegs: [{ id: "L1", startsAt: "2026-08-02T06:00:00Z", endsAt: "2026-08-02T09:00:00Z" }],
    }));
    assert.equal(byLeg.state, "PRE_DEPARTURE");
    assert.match(byLeg.reason, /outbound leg L1 departs within 48h/);
    assert.equal(byLeg.evidence.outboundLegId, "L1");
    assert.equal(PRE_DEPARTURE_HOURS, 48);
  });

  it("inside the dates: TRAVELING while the outbound leg is under way, RETURNING once the return leg departs, IN_DESTINATION otherwise", () => {
    const out = { id: "OUT", startsAt: "2026-09-12T08:00:00Z", endsAt: "2026-09-12T11:00:00Z" };
    const back = { id: "BACK", startsAt: "2026-09-13T09:00:00Z", endsAt: "2026-09-13T12:00:00Z" };
    const flying = deriveTripLifecycle(base({ now: at("2026-09-12T09:30:00Z"), travelLegs: [out, back] }));
    assert.equal(flying.state, "TRAVELING");
    assert.equal(flying.evidence.outboundLegId, "OUT");
    assert.equal(flying.evidence.returnLegId, "BACK");
    assert.equal(deriveTripLifecycle(base({ now: at("2026-09-12T15:00:00Z"), travelLegs: [out, back] })).state, "IN_DESTINATION");
    assert.equal(deriveTripLifecycle(base({ now: at("2026-09-13T10:00:00Z"), travelLegs: [out, back] })).state, "RETURNING");
    // A single leg is an outbound and never a return: one flight is not a round trip.
    assert.equal(deriveTripLifecycle(base({ now: at("2026-09-13T10:00:00Z"), travelLegs: [out] })).state, "IN_DESTINATION");
  });

  it("after the end: MEMORY beats ABANDONED beats COMPLETED, and each says which fact decided", () => {
    const over = { now: at("2026-09-20T12:00:00Z") };
    const memory = deriveTripLifecycle(base({ ...over, recordedMemories: 2, confirmedBookings: 1 }));
    assert.equal(memory.state, "MEMORY");
    assert.match(memory.reason, /memory\/memories recorded/);
    assert.equal(deriveTripLifecycle(base({ ...over, confirmedBookings: 0, completedPlanItems: 0 })).state, "ABANDONED");
    assert.equal(deriveTripLifecycle(base({ ...over, confirmedBookings: 1 })).state, "COMPLETED");
    assert.equal(deriveTripLifecycle(base({ ...over, completedPlanItems: 1 })).state, "COMPLETED");
  });

  it("an open-ended trip (no end date) is never past its end", () => {
    const open = base({ endDate: null, now: at("2027-01-01T12:00:00Z") });
    assert.equal(deriveTripLifecycle(open).state, "IN_DESTINATION");
  });
});

describe("§3.1 a fact that was not read is not a fact that is false", () => {
  it("an unread bookings count cannot make a past trip ABANDONED, and `unread` names it", () => {
    const over = base({ now: at("2026-09-20T12:00:00Z"), confirmedBookings: null, completedPlanItems: null, recordedMemories: null });
    const d = deriveTripLifecycle(over);
    assert.equal(d.state, "COMPLETED");
    assert.deepEqual([...d.unread], ["recordedMemories", "confirmedBookings", "completedPlanItems"]);
  });

  it("an unread disruption register cannot rule DISRUPTED out silently", () => {
    const d = deriveTripLifecycle(base({ activeDisruptions: null }));
    assert.equal(d.state, "IN_DESTINATION");
    assert.ok(d.unread.includes("activeDisruptions"));
  });

  it("a caller that read nothing but the trips row still gets a lawful answer over the calendar", () => {
    const d = deriveTripLifecycle(base({
      confirmedBookings: null, travelLegs: null, completedPlanItems: null, recordedMemories: null, activeDisruptions: null,
    }));
    assert.equal(d.state, "IN_DESTINATION");
    assert.ok(d.unread.includes("travelLegs"));
    assert.ok(TRIP_LIFECYCLE_STATES.includes(d.state));
  });
});

describe("§3.1 the day is counted in the trip's zone", () => {
  it("the same instant is inside the trip in Auckland and before it in Los Angeles", () => {
    const instant = at("2026-09-12T00:30:00Z"); // 12:30 on the 12th in Auckland, 17:30 on the 11th in LA
    const nz = deriveTripLifecycle(base({ now: instant, timezone: "Pacific/Auckland" }));
    const la = deriveTripLifecycle(base({ now: instant, timezone: "America/Los_Angeles" }));
    assert.equal(nz.evidence.localDate, "2026-09-12");
    assert.equal(la.evidence.localDate, "2026-09-11");
    assert.equal(nz.state, "IN_DESTINATION");
    assert.equal(la.state, "PRE_DEPARTURE");
  });
});

// ── Part B: through GET /trips/:tripId/lifecycle ───────────────────────────

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const STRANGER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa35";

type Row = Record<string, any>;

function makeClient(tables: Record<string, Row[]>, failing: ReadonlySet<string> = new Set()) {
  const db = tables;
  return {
    db,
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "stranger-token") return { data: { user: { id: STRANGER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const fail = failing.has(table);
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return chain; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
        is: (col: string, val: any) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
        order: () => chain, limit: () => chain, gte: () => chain, gt: () => chain, not: () => chain, or: () => chain,
        maybeSingle: async () => (fail ? { data: null, error: { message: `${table} unreadable` } } : { data: rowsNow()[0] ?? null, error: null }),
        single: async () => (fail ? { data: null, error: { message: `${table} unreadable` } } : { data: rowsNow()[0] ?? null, error: null }),
        then: (onF: any, onR: any) =>
          Promise.resolve(fail ? { data: null, error: { message: `${table} unreadable` } } : { data: rowsNow(), error: null }).then(onF, onR),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

/** YYYY-MM-DD, `days` from today in UTC — the endpoint reads the real clock. */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function tables(o: {
  reservations?: Row[]; plans?: Row[]; memories?: Row[]; sessions?: Row[];
  start?: string; end?: string; status?: string;
} = {}): Record<string, Row[]> {
  return {
    trips: [{
      id: TRIP_ID, owner_id: OWNER_ID, title: "Lisbon", destination_city: "Lisbon",
      start_date: o.start ?? day(-1), end_date: o.end ?? day(3),
      status: o.status ?? "active", timezone: "UTC", visibility: "private",
    }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
    ],
    // Deliberately EMPTY: nothing here is behind a feature flag.
    feature_flags: [],
    trip_reservations: o.reservations ?? [],
    trip_plan_items: o.plans ?? [],
    passport_memories: o.memories ?? [],
    safe_return_sessions: o.sessions ?? [],
  };
}

let server: Server; let port = 0;
function install(t: Record<string, Row[]>, failing?: ReadonlySet<string>) {
  const c = makeClient(t, failing);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}
async function get(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("TR35 — GET /trips/:tripId/lifecycle, ungated, over tables production has", () => {
  before(() => new Promise<void>((resolve) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  it("the owner gets the state, the reason, and the thirteen-state vocabulary — with no feature flag in the database", async () => {
    install(tables());
    const r = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lifecycle, "IN_DESTINATION");
    assert.equal(r.body.storedStatus, "active");
    assert.equal(r.body.states.length, 13);
    assert.ok(String(r.body.reason).length > 10);
    assert.deepEqual(r.body.unread, []);
  });

  it("the derived state and the stored status are different vocabularies, and both are served", async () => {
    install(tables({ start: day(-10), end: day(-5), reservations: [{ id: "r1", trip_id: TRIP_ID, type: "stay", status: "confirmed", starts_at: null, ends_at: null }] }));
    const r = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(r.body.lifecycle, "COMPLETED");
    assert.equal(r.body.storedStatus, "completed");
    const memories = install(tables({
      start: day(-10), end: day(-5),
      reservations: [{ id: "r1", trip_id: TRIP_ID, type: "stay", status: "confirmed", starts_at: null, ends_at: null }],
      memories: [{ id: "m1", trip_id: TRIP_ID }],
    }));
    assert.ok(memories.db.passport_memories!.length === 1);
    const r2 = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(r2.body.lifecycle, "MEMORY", "the stored status is still 'completed'; MEMORY is only in the derived vocabulary");
    assert.equal(r2.body.storedStatus, "completed");
  });

  it("only confirmed flight/transport reservations are legs: a confirmed STAY under way is not TRAVELING", async () => {
    const now = new Date();
    const legWindow = { starts_at: new Date(now.getTime() - 3_600_000).toISOString(), ends_at: new Date(now.getTime() + 3_600_000).toISOString() };
    install(tables({ reservations: [{ id: "s1", trip_id: TRIP_ID, type: "stay", status: "confirmed", ...legWindow }] }));
    assert.equal((await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token")).body.lifecycle, "IN_DESTINATION");
    install(tables({ reservations: [{ id: "f1", trip_id: TRIP_ID, type: "flight", status: "confirmed", ...legWindow }] }));
    const flying = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(flying.body.lifecycle, "TRAVELING");
    assert.equal(flying.body.evidence.outboundLegId, "f1");
  });

  it("a Safe Return NEEDS_HELP makes the trip DISRUPTED for the crew only when its owner asked the crew to be told", async () => {
    const shared = { id: "s1", trip_id: TRIP_ID, user_id: MEMBER_ID, status: "missed", escalation_level: 2, closed_at: null, notify_trip_crew_enabled: true };
    install(tables({ sessions: [shared] }));
    assert.equal((await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token")).body.lifecycle, "DISRUPTED");

    const private_ = { ...shared, notify_trip_crew_enabled: false };
    install(tables({ sessions: [private_] }));
    const hidden = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(hidden.body.lifecycle, "IN_DESTINATION", "an un-shared alarm must not become a word the whole crew can read");
    // …and the member whose session it is still sees their own.
    assert.equal((await get(`/trips/${TRIP_ID}/lifecycle`, "member-token")).body.lifecycle, "DISRUPTED");
  });

  it("a failed reservations read leaves the fact unread and the answer falls back to the calendar rather than refusing", async () => {
    install(tables({ start: day(-10), end: day(-5) }), new Set(["trip_reservations"]));
    const r = await get(`/trips/${TRIP_ID}/lifecycle`, "owner-token");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lifecycle, "COMPLETED", "not ABANDONED — nobody read the bookings");
    assert.ok(r.body.unread.includes("confirmedBookings"));
    // `unread` names facts a clause ON THIS PATH needed, not every fact that
    // happens to be missing: a trip that is over never asks about its legs.
    assert.ok(!r.body.unread.includes("travelLegs"));
  });

  it("a non-member is refused by name, and an unauthenticated caller by the router", async () => {
    install(tables());
    const r = await get(`/trips/${TRIP_ID}/lifecycle`, "stranger-token");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.reason, "TRIP_AUTH_NOT_CREW");
    assert.equal((await get(`/trips/${TRIP_ID}/lifecycle`, "bad-token")).status, 401);
  });
});
