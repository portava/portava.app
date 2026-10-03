/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B22, probes SR0–SR2, SL0, SL1): the
 * cached `events.going_count` is never stated as measured outside routes/events.ts either.
 *
 * The counter drifts by design: DELETE /events/:id/rsvp leaves `going_count` alone when its recount read fails
 * (census-trust §30.8, "an unread count is not stamped"), so the row keeps the pre-leave count (SR1, the reach).
 * D-W11X2-160 recounted it live only inside routes/events.ts. Compass's group tool told the model "No candidates
 * satisfy the whole group's constraints right now." with `not_enough_capacity_for_group` over the cached count while a
 * seat was open (SR2), and GET /pulse/live served the cached count as `people_count`, "Full" and not joinable (SL1).
 * Each now recounts live (`liveEventCounters` / `readGoingRsvpsForEvents`, lib/eventRowReads.ts), and a live read that
 * fails is never turned into a capacity fact: the group tool says it could not check, /pulse/live serves no count and
 * no "Full" and names `event_rsvps` in `failedSources`, and Compass's candidate pool states no attendee count.
 *
 *   SR1  REACH (the verifier's): a going traveller leaves with the recount read failing → 200, nothing stamped
 *   SR0  CONTROL: group tool, the counter matches the rows (9 of 10) → the event is offered
 *   SR2  group tool over SR1's row (counter 10, 9 going) → the event is offered (the live count)
 *   SR3  group tool, the live going read FAILS → no capacity fact: never `not_enough_capacity_for_group`, and the
 *        answer says it could not check capacity
 *   SR4  group tool, counter 9 of 10 but 10 going live → not offered, `not_enough_capacity_for_group` (the live count)
 *   SL0  CONTROL: /pulse/live over 9 of 10 → 9, joinable, nothing named
 *   SL1  /pulse/live over SR1's row (counter 10, 9 going) → 9, joinable, no "Full"
 *   SL2  /pulse/live, the live going read FAILS → people_count null, no "Full", not said joinable, `event_rsvps` named
 *   SL3  /pulse/live, a saved event over a stale counter (10, 9 going) → 9, no "Full"; over a failed live read → null
 *   SL4  /pulse/live, an RSVP'd event over a stale counter (10, 9 going) → 9, joinable
 *   CH1  Compass's candidate pool: an event's attendees are the live count (cached 10, 9 going → 9)
 *   CH2  Compass's candidate pool, the live going read FAILS → no attendee count (never the cached 10)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { executeCompassTool } from "../compass/CompassTools.js";
import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER as CVIEWER, DB_ERR, type Call } from "./helpers/compassReadWorld.js";
import { world, eventsServer, stamps, EVENT, W1, ERR } from "./helpers/eventsWorld.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString();
const GOING = (n: number, ev = EVENT) => Array.from({ length: n }, (_, i) => ({ event_id: ev, user_id: i === 0 ? W1 : `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`, status: "going" }));

// ── the verifier's /pulse/live double, with `range`, `gt`, `or` and a per-read failure ─────────────────────────────
interface FakeState { events?: any[]; event_rsvps?: any[]; event_saves?: any[]; failRead?: (table: string, cols: string) => boolean }
function makeClient(state: FakeState = {}, callerUserId = ALICE_ID) {
  const db: Record<string, any[]> = { events: state.events ?? [], event_rsvps: state.event_rsvps ?? [], event_saves: state.event_saves ?? [] };
  function builder(table: string, rows: any[], cols = "") {
    let filtered = rows.map((r) => ({ ...r }));
    const fails = () => state.failRead?.(table, cols) === true;
    const b: any = {
      select: (c?: string) => builder(table, filtered, c ?? ""),
      eq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      gt: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] > val); return b; },
      gte: () => b, lt: () => b, lte: () => b, not: () => b, ilike: () => b, or: () => b, order: () => b, limit: () => b, range: () => b,
      is: (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      maybeSingle: () => Promise.resolve(fails() ? { data: null, error: DB_ERR } : { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(fails() ? { data: null, error: DB_ERR } : { data: filtered[0] ?? null, error: null }),
      then: (resolve: any, reject: any) => Promise.resolve(fails() ? { data: null, error: DB_ERR } : { data: [...filtered], error: null }).then(resolve, reject),
    };
    return b;
  }
  return {
    auth: { getUser: async (token: string) => (token === "valid-token" ? { data: { user: { id: callerUserId } }, error: null } : { data: null, error: { message: "invalid" } }) },
    from: (table: string) => builder(table, db[table] ?? []),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
async function live(state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express(); app.use(express.json()); app.use("/api", pulseRouter);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/pulse/live`, { headers: { Authorization: "Bearer valid-token" } });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const LEV = "ec000000-0000-4000-8000-000000000001";
const OTHER_HOST = "c3c3c3c3-cccc-cccc-cccc-000000000003";
const evRow = (going_count: number, host = ALICE_ID) => ({ id: LEV, host_id: host, title: "Rooftop quiz", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count, max_attendees: 10 });
const going9 = () => GOING(9, LEV).map((r, i) => ({ ...r, user_id: i === 0 ? BOB_ID : r.user_id }));
const liveGoingRead = (table: string, cols: string) => table === "event_rsvps" && cols.includes("user_id") && !cols.includes("status");
const card = (body: any) => (body.items as any[] ?? []).find((i: any) => i.item_id === LEV);

// ── Compass's group tool ──────────────────────────────────────────────────────────────────────────────────────────
const profile = { userId: CVIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], interests: ["music"] } as unknown as CompassProfile;
const eqCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "eq" && a[0] === col);
const inCall = (calls: Call[], col: string) => calls.some(([k, a]) => k === "in" && a[0] === col);
const GEV = "ee000000-0000-4000-a000-000000000777";
const gev = (going_count: number) => ({ id: GEV, title: "Jazz night", description: null, city: "Paris", country: "FR", starts_at: new Date(Date.now() + 86_400_000).toISOString(), category: "music", host_id: "ff000000-0000-4000-a000-000000000001", state: "open", visibility: "public", max_attendees: 10, going_count, age_min: null, verified_only: false });
function groupWorld(going_count: number, liveRows: number | "fail") {
  const rsvps = liveRows === "fail" ? [] : GOING(liveRows, GEV);
  return compassWorld({ answer: (t, calls) => {
    if (t === "events") return { data: [gev(going_count)], error: null };
    if (t === "event_rsvps") return liveRows === "fail" ? { data: null, error: DB_ERR } : ({ data: rsvps, error: null, count: rsvps.length } as any);
    if (t === "circles" && eqCall(calls, "owner_id")) return { data: [{ id: "c1", name: "Porto crew", owner_id: CVIEWER }], error: null };
    if (t === "circle_memberships") return { data: [], error: null };
    if (t === "profiles" && inCall(calls, "id")) return { data: [{ id: CVIEWER, interests: ["music"], date_of_birth: "1990-01-01" }], error: null };
    return undefined;
  } });
}
const group = async (going_count: number, liveRows: number | "fail") => (await executeCompassTool(groupWorld(going_count, liveRows).client as any, CVIEWER, profile, "get_group_recommendation", { circleName: "Porto crew", kind: "events", city: "Paris" })) as Record<string, any>;

describe("census-discovery §118 (B22): Compass's group tool never states a capacity fact over the cached going count", () => {
  after(() => _setTestClient(null as any, false));
  it("SR1 REACH: a going traveller leaves, the recount read FAILS → 200, going_count not stamped (row keeps 10 of 10)", async () => {
    const w = world({ ev: { state: "full", max_attendees: 10, capacity: 10, going_count: 10, waitlist_enabled: false }, rsvps: GOING(10),
      failOn: (c) => (c.table === "event_rsvps" && c.eq("status") === "going" && c.eq("user_id") === undefined ? ERR : null) });
    const s = await eventsServer();
    try {
      const r = await s.req("t-w1", "DELETE", `/events/${EVENT}/rsvp`);
      assert.equal(r.status, 200); assert.ok(w.writes.some((x) => x.table === "event_rsvps" && x.kind === "delete"));
      assert.deepEqual(stamps(w.writes, "going_count"), []);
    } finally { s.close(); }
  });
  it("SR0 CONTROL: counter 9 of 10, 9 going → the event is offered", async () => {
    const r = await group(9, 9);
    assert.equal((r.candidates ?? []).length, 1, JSON.stringify(r));
  });
  it("SR2 counter 10 left by SR1, 9 going → the event is offered (the live count, never the cached one)", async () => {
    const r = await group(10, 9);
    assert.equal((r.candidates ?? []).length, 1, JSON.stringify(r));
    assert.ok(!(r.groupConstraintsApplied ?? []).includes("not_enough_capacity_for_group"), JSON.stringify(r));
  });
  it("SR3 the live going read FAILS → no capacity fact, and the answer says capacity could not be checked", async () => {
    const r = await group(10, "fail");
    assert.ok(!(r.groupConstraintsApplied ?? []).includes("not_enough_capacity_for_group"), JSON.stringify(r));
    assert.ok((r.groupConstraintsApplied ?? []).includes("capacity_could_not_be_checked"), JSON.stringify(r));
    assert.ok(!/No candidates satisfy/.test(String(r.info)), JSON.stringify(r));
    assert.match(String(r.info), /could not|couldn't/i, JSON.stringify(r));
  });
  it("SR4 counter 9 of 10 but 10 going live → not offered: the group has no room (the live count)", async () => {
    const r = await group(9, 10);
    assert.equal((r.candidates ?? []).length, 0, JSON.stringify(r));
    assert.ok((r.groupConstraintsApplied ?? []).includes("not_enough_capacity_for_group"), JSON.stringify(r));
  });
});

describe("census-discovery §118 (B22): GET /api/pulse/live never serves the cached going count as measured", () => {
  after(() => _setTestClient(null as any, false));
  it("SL0 CONTROL: counter 9 of 10 → people_count 9, joinable, nothing named", async () => {
    const { body } = await live({ events: [evRow(9)], event_rsvps: going9() });
    const c = card(body);
    assert.ok(c, JSON.stringify(body)); assert.equal(c.people_count, 9); assert.equal(c.is_joinable, true);
    assert.equal(body.failedSources, undefined, JSON.stringify(body));
  });
  it("SL1 counter 10 left by SR1, 9 going → people_count 9, joinable, no 'Full'", async () => {
    const { body } = await live({ events: [evRow(10)], event_rsvps: going9() });
    const c = card(body);
    assert.deepEqual({ n: c?.people_count, j: c?.is_joinable, full: (c?.reason_labels ?? []).includes("Full") }, { n: 9, j: true, full: false }, JSON.stringify(body));
  });
  it("SL2 the live going read FAILS → no count, no 'Full', not said joinable, event_rsvps named", async () => {
    const { status, body } = await live({ events: [evRow(10)], event_rsvps: going9(), failRead: liveGoingRead });
    const c = card(body);
    assert.equal(status, 200);
    assert.ok(c, JSON.stringify(body));
    assert.deepEqual({ n: c.people_count, full: c.reason_labels.includes("Full"), j: c.is_joinable }, { n: null, full: false, j: false }, JSON.stringify(c));
    assert.ok((body.failedSources ?? []).includes("event_rsvps"), JSON.stringify(body));
  });
  it("SL3 a saved event over a stale counter → 9, no 'Full'; over a failed live read → no count, named", async () => {
    const st = (fail: boolean): FakeState => ({ events: [evRow(10, OTHER_HOST)], event_rsvps: going9(), event_saves: [{ user_id: ALICE_ID, event_id: LEV }], ...(fail ? { failRead: liveGoingRead } : {}) });
    const ok = card((await live(st(false))).body);
    assert.deepEqual({ n: ok?.people_count, full: (ok?.reason_labels ?? []).includes("Full"), rel: ok?.user_relationship }, { n: 9, full: false, rel: "saved" });
    const failed = await live(st(true));
    const c = card(failed.body);
    assert.deepEqual({ n: c?.people_count, full: (c?.reason_labels ?? []).includes("Full") }, { n: null, full: false }, JSON.stringify(failed.body));
    assert.ok((failed.body.failedSources ?? []).includes("event_rsvps"), JSON.stringify(failed.body));
  });
  it("SL4 an RSVP'd event over a stale counter (10, 9 going) → 9, joinable", async () => {
    const mine = { event_id: LEV, user_id: ALICE_ID, status: "going" };
    const { body } = await live({ events: [evRow(10, OTHER_HOST)], event_rsvps: [...GOING(8, LEV), mine] });
    const c = card(body);
    assert.deepEqual({ n: c?.people_count, j: c?.is_joinable, rel: c?.user_relationship }, { n: 9, j: true, rel: "joined" }, JSON.stringify(body));
  });
});

describe("census-discovery §118 (B22): Compass's candidate pool states the live attendee count or none", () => {
  const pool = async (liveRows: number | "fail") => {
    const rsvps = liveRows === "fail" ? [] : GOING(liveRows, "ee000000-0000-4000-a000-000000000001");
    const w = compassWorld({ answer: (t) => {
      if (t === "events") return { data: [{ id: "ee000000-0000-4000-a000-000000000001", host_id: "ff000000-0000-4000-a000-000000000001", title: "Jazz night", category: "music", starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: null, city: "Paris", max_attendees: 10, going_count: 10, visibility: "public", state: "open", location_lat: 48.85, location_lng: 2.35, location_name: "Club", cover_url: null, show_exact_location: true }], error: null };
      if (t === "event_rsvps") return liveRows === "fail" ? { data: null, error: DB_ERR } : ({ data: rsvps, error: null, count: rsvps.length } as any);
      return undefined;
    } });
    const items = await hydrateCompassItems(w.client as any, { ...profile, currentCity: null } as any);
    return items.find((i) => i.type === "event");
  };
  it("CH1 cached 10, 9 going → currentAttendees 9", async () => {
    const ev = await pool(9);
    assert.equal(ev?.currentAttendees, 9, JSON.stringify(ev));
  });
  it("CH2 the live going read FAILS → no attendee count, never the cached 10", async () => {
    const ev = await pool("fail");
    assert.ok(ev, "the event stays a candidate");
    assert.equal(ev?.currentAttendees, undefined, JSON.stringify(ev));
  });
});
