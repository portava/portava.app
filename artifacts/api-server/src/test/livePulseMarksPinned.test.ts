/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's survivors V18–V25, fixtures PJ1, PJ2, PG1,
 * PB1, PA1, PC1, PP1, PK1): every GET /pulse/live mark round 21 added is pinned: an RSVP'd or saved event is never
 * "joinable" over an unread going count; a gem count with no number is never stated; five sections' unread names. Each
 * mutation dropping one survived the round-21 pins (livePulseUnreadSections LP0–LP10, staleGoingCounterReads SL*),
 * which never fail those reads. Harness: livePulseUnreadSections' own client and route mount.
 *
 *   PJ1 (V18) an RSVP'd event (Bob's), the live going read FAILS → not said joinable
 *   PJ2 (V19) a saved event (Bob's), the live going read FAILS → not said joinable
 *   PG1 (V20) the gem saves head count answers no count (and no error) → no count stated, the read named
 *   PB1 (V21) Alice is an approved buddy; her incoming-bookings read FAILS → buddy_bookings named
 *   PA1 (V22) citySlug=manila; the available-buddies read FAILS → rent_buddy_profiles named
 *   PC1 (V23) circles on; the trip presence read FAILS → circle_presence named
 *   PP1 (V24) gems on; the Compass profile read FAILS → compass_user_profiles named
 *   PK1 (V25) gems on, a preferred city; the Compass picks gem read FAILS → hidden_gems named
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString();
const EV = "ec000000-0000-4000-8000-000000000011";
const EV2 = "ec000000-0000-4000-8000-000000000012";
const TRIP = "dd000000-0000-4000-8000-000000000001";

type Read = { table: string; cols: string; eqs: Record<string, unknown>; ins: Record<string, unknown[]> };
interface World { tables: Record<string, any[]>; fail?: (r: Read) => boolean; reads?: Read[]; nullCount?: string }
function makeClient(w: World) {
  function builder(table: string, rows: any[], cols = "") {
    let filtered = rows.map((r) => ({ ...r }));
    const read: Read = { table, cols, eqs: {}, ins: {} };
    let counted = false;
    const settle = () => { w.reads?.push(read); return w.fail?.(read) ? { data: null, error: ERR } : null; };
    const b: any = {
      select: (c?: string, o?: { count?: string }) => { const nb = builder(table, filtered, c ?? ""); if (o?.count === "exact") nb.__counted(); return nb; },
      __counted: () => { counted = true; },
      eq: (col: string, val: any) => { read.eqs[col] = val; filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { read.ins[col] = vals; filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      gt: () => b, gte: () => b, lt: () => b, lte: () => b, not: () => b, ilike: () => b, like: () => b, or: () => b, order: () => b, limit: () => b, range: () => b, contains: () => b, overlaps: () => b,
      is: (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      maybeSingle: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(settle() ?? { data: [...filtered], error: null, ...(counted ? { count: w.nullCount === table ? null : filtered.length } : {}) }).then(res, rej),
    };
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === "valid-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    from: (table: string) => builder(table, w.tables[table] ?? []),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
async function get(w: World, path: string) {
  _setTestClient(makeClient(w) as any, true); invalidateFlagsCache?.();
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express(); app.use(express.json());
  app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
  app.use("/api", pulseRouter);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { headers: { Authorization: "Bearer valid-token" } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  } finally { await new Promise<void>((r) => server.close(() => r())); }
}

function liveWorld(): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "safe_return_enabled", enabled: true }, { flag: "hidden_gems_enabled", enabled: false }, { flag: "find_your_circle_enabled", enabled: false }],
    events: [
      { id: EV, host_id: ALICE, title: "Rooftop quiz", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count: 2, max_attendees: 10 },
      { id: EV2, host_id: BOB, title: "Night market", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count: 1, max_attendees: 10 },
    ],
    event_rsvps: [{ event_id: EV, user_id: BOB, status: "going" }, { event_id: EV, user_id: "u2", status: "going" }, { event_id: EV2, user_id: ALICE, status: "going" }],
    event_saves: [],
    trip_members: [{ trip_id: TRIP, user_id: ALICE, role: "owner" }],
    trips: [{ id: TRIP, title: "Lisbon run", destination_city: "Lisbon", start_date: in2h.slice(0, 10), end_date: in3days.slice(0, 10), status: "upcoming", visibility: "public", owner_id: ALICE }],
    trip_join_requests: [],
    safe_return_sessions: [],
    blocks: [],
  };
}
const live = (fail?: (r: Read) => boolean) => get({ tables: liveWorld(), fail }, "/api/pulse/live");
const named = (body: any) => (body.failedSources ?? []) as string[];


const EV3 = "ec000000-0000-4000-8000-000000000013";
const liveGoing = (r: Read) => r.table === "event_rsvps" && !("user_id" in r.eqs) && "event_id" in r.ins;
const flags = (sr: boolean, gems: boolean, circles: boolean) => [{ flag: "safe_return_enabled", enabled: sr }, { flag: "hidden_gems_enabled", enabled: gems }, { flag: "find_your_circle_enabled", enabled: circles }];
const item = (body: any, id: string) => (body.items as any[] ?? []).find((i: any) => i.item_id === id);
describe("census-discovery §119 (V18–V25): GET /pulse/live marks are pinned", () => {
  after(() => _setTestClient(null as any, false));
  it("PJ1 (V18) an RSVP'd event over a failed live going read → not joinable", async () => {
    const { body } = await live(liveGoing); const c = item(body, EV2);
    assert.ok(c, JSON.stringify(body)); assert.equal(c.is_joinable, false);
  });
  it("PJ2 (V19) a saved event over a failed live going read → not joinable", async () => {
    const t = liveWorld(); t.events.push({ id: EV3, host_id: BOB, title: "Harbour swim", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count: 3, max_attendees: 10 }); t.event_saves = [{ user_id: ALICE, event_id: EV3 }];
    const { body } = await get({ tables: t, fail: liveGoing }, "/api/pulse/live"); const c = item(body, EV3);
    assert.ok(c, JSON.stringify(body)); assert.equal(c.is_joinable, false);
  });
  it("PG1 (V20) the gem head count answers no count → no count, named", async () => {
    const GEM = "6e000000-0000-4000-8000-000000000001";
    const t = { ...liveWorld(), feature_flags: flags(false, true, false), hidden_gems: [{ id: GEM, name: "Secret courtyard", city: "Manila", category: "garden", save_count: 12, sensitivity_level: "public", status: "active", submitted_by: BOB }], hidden_gem_saves: [{ gem_id: GEM, user_id: "u1" }] };
    const { body } = await get({ tables: t, nullCount: "hidden_gem_saves" }, "/api/pulse/live?context=currentCity&citySlug=manila"); const c = item(body, GEM);
    assert.ok(c, JSON.stringify(body)); assert.equal(c.people_count, null); assert.ok(named(body).includes("hidden_gem_saves"));
  });
  it("PB1 (V21) the incoming-bookings read FAILS → buddy_bookings named", async () => {
    const t = { ...liveWorld(), rent_buddy_profiles: [{ id: "bp000000-0000-4000-8000-000000000001", user_id: ALICE, admin_status: "active", city: "Lisbon" }], buddy_bookings: [] };
    const { body } = await get({ tables: t, fail: (r) => r.table === "buddy_bookings" && "buddy_id" in r.eqs }, "/api/pulse/live");
    assert.ok(named(body).includes("buddy_bookings"), JSON.stringify(body));
  });
  it("PA1 (V22) the available-buddies read FAILS → rent_buddy_profiles named", async () => {
    const { body } = await get({ tables: { ...liveWorld(), rent_buddy_profiles: [] }, fail: (r) => r.table === "rent_buddy_profiles" && !("user_id" in r.eqs) && !("user_id" in r.ins) }, "/api/pulse/live?context=currentCity&citySlug=manila");
    assert.ok(named(body).includes("rent_buddy_profiles"), JSON.stringify(body));
  });
  it("PC1 (V23) the trip presence read FAILS → circle_presence named", async () => {
    const { body } = await get({ tables: { ...liveWorld(), feature_flags: flags(false, false, true), circle_presence: [] }, fail: (r) => r.table === "circle_presence" }, "/api/pulse/live");
    assert.ok(named(body).includes("circle_presence"), JSON.stringify(body));
  });
  it("PP1 (V24) the Compass profile read FAILS → compass_user_profiles named", async () => {
    const { body } = await get({ tables: { ...liveWorld(), feature_flags: flags(false, true, false) }, fail: (r) => r.table === "compass_user_profiles" }, "/api/pulse/live");
    assert.ok(named(body).includes("compass_user_profiles"), JSON.stringify(body));
  });
  it("PK1 (V25) the Compass picks gem read FAILS → hidden_gems named", async () => {
    const t = { ...liveWorld(), trips: [], trip_members: [], feature_flags: flags(false, true, false), compass_user_profiles: [{ user_id: ALICE, preferred_cities: ["Porto"], current_city: null }], hidden_gems: [] };
    const { body } = await get({ tables: t, fail: (r) => r.table === "hidden_gems" }, "/api/pulse/live?context=myPlans");
    assert.ok(named(body).includes("hidden_gems"), JSON.stringify(body));
  });
});
