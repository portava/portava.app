/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; sweep SW20, beside the round-20 verifier's B22): GET /api/pulse/live
 * names every read it could not make, so a section it could not read is never served as absent.
 *
 * Every section of the Live rail read its table with `const { data } = await …` and a `catch { /* non-fatal *\/ }`:
 * supabase-js RESOLVES a failed read as `{ data: null, error }`, so a failed hosted-events, RSVP, trips, saves or
 * Safe Return read became a section with nothing in it, and a rail whose every section failed was served as
 * `items: []`, which the client says as "No live plans right now". Block state that could not be read already emptied
 * the rail (fail-closed) and said nothing. Each failed read is now named in `failedSources` (the table read); a
 * healthy body gains no key.
 *
 * GET /api/pulse ranks a pool of events beside its posts and serves only the posts; its pool's capacity term is now the
 * live going count (B22), and a failed live read ranks without it.
 *
 *   LP0  CONTROL: every read healthy → items served, no `failedSources` key
 *   LP1  the block-state read FAILS → an empty rail (fail-closed, as before) that names `blocks`
 *   LP2  the hosted-events read FAILS → `events` named
 *   LP3  the viewer's own RSVP read FAILS → `event_rsvps` named
 *   LP4  the trip membership read FAILS → `trip_members` named
 *   LP5  the saved-events read FAILS → `event_saves` named
 *   LP6  the Safe Return read FAILS (flag on) → `safe_return_sessions` named
 *   LP7  a flag read FAILS → `feature_flags` named
 *   LP8  the join-request read FAILS → `trip_join_requests` named
 *   SP1  GET /api/pulse recounts its event pool's going RSVPs live (one read over the pool's events)
 *   SP2  GET /api/pulse with that read FAILING → 200, the same posts served
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
interface World { tables: Record<string, any[]>; fail?: (r: Read) => boolean; reads?: Read[] }
function makeClient(w: World) {
  function builder(table: string, rows: any[], cols = "") {
    let filtered = rows.map((r) => ({ ...r }));
    const read: Read = { table, cols, eqs: {}, ins: {} };
    const settle = () => { w.reads?.push(read); return w.fail?.(read) ? { data: null, error: ERR } : null; };
    const b: any = {
      select: (c?: string) => builder(table, filtered, c ?? ""),
      eq: (col: string, val: any) => { read.eqs[col] = val; filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { read.ins[col] = vals; filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      gt: () => b, gte: () => b, lt: () => b, lte: () => b, not: () => b, ilike: () => b, like: () => b, or: () => b, order: () => b, limit: () => b, range: () => b, contains: () => b, overlaps: () => b,
      is: (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      maybeSingle: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(settle() ?? { data: [...filtered], error: null }).then(res, rej),
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

describe("census-discovery §118 (SW20): GET /api/pulse/live names every read it could not make", () => {
  after(() => _setTestClient(null as any, false));
  it("LP0 CONTROL: every read healthy → items served, no failedSources key", async () => {
    const { status, body } = await live();
    assert.equal(status, 200);
    assert.ok((body.items as any[]).some((i) => i.item_id === EV), JSON.stringify(body));
    assert.ok((body.items as any[]).some((i) => i.item_id === TRIP), JSON.stringify(body));
    assert.equal("failedSources" in body, false, JSON.stringify(body));
  });
  it("LP1 the block-state read FAILS → an empty rail that names blocks", async () => {
    const { status, body } = await live((r) => r.table === "blocks");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
    assert.ok(named(body).includes("blocks"), JSON.stringify(body));
  });
  it("LP2 the hosted-events read FAILS → events named", async () => {
    const { body } = await live((r) => r.table === "events" && r.eqs.host_id === ALICE);
    assert.ok(named(body).includes("events"), JSON.stringify(body));
  });
  it("LP3 the viewer's own RSVP read FAILS → event_rsvps named", async () => {
    const { body } = await live((r) => r.table === "event_rsvps" && r.eqs.user_id === ALICE);
    assert.ok(named(body).includes("event_rsvps"), JSON.stringify(body));
  });
  it("LP4 the trip membership read FAILS → trip_members named", async () => {
    const { body } = await live((r) => r.table === "trip_members");
    assert.ok(named(body).includes("trip_members"), JSON.stringify(body));
  });
  it("LP5 the saved-events read FAILS → event_saves named", async () => {
    const { body } = await live((r) => r.table === "event_saves");
    assert.ok(named(body).includes("event_saves"), JSON.stringify(body));
  });
  it("LP6 the Safe Return read FAILS (flag on) → safe_return_sessions named", async () => {
    const { body } = await live((r) => r.table === "safe_return_sessions");
    assert.ok(named(body).includes("safe_return_sessions"), JSON.stringify(body));
  });
  it("LP7 a flag read FAILS → feature_flags named", async () => {
    const { body } = await live((r) => r.table === "feature_flags");
    assert.ok(named(body).includes("feature_flags"), JSON.stringify(body));
  });
  it("LP8 the join-request read FAILS → trip_join_requests named", async () => {
    const { body } = await live((r) => r.table === "trip_join_requests");
    assert.ok(named(body).includes("trip_join_requests"), JSON.stringify(body));
  });
});

function feedWorld(): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    posts: [{ id: "post-1", author_id: BOB, status: "active", visibility: "public", post_status: "published", created_at: new Date().toISOString(), caption: "hi", location_city: "Manila", media_urls: [], trip_id: null, pulse_geo_tags: null, post_media: [], profiles: { id: BOB, username: "bob", full_name: "Bob", avatar_url: null } }],
    events: [{ id: EV2, host_id: BOB, title: "Night market", category: "food", starts_at: in2h, city: "Manila", max_attendees: 10, going_count: 10, tags: [], state: "open", visibility: "public" }],
    event_rsvps: [{ event_id: EV2, user_id: ALICE, status: "going" }],
    compass_profiles: [{ user_id: ALICE, current_city: "Manila", persona_type: "explorer", travel_intensity: "moderate", active_trip_id: null, vibe_tags: [] }],
    user_location_state: [{ user_id: ALICE, city: "Manila", country: "Philippines" }],
    blocks: [],
  };
}
const liveGoingRead = (r: Read) => r.table === "event_rsvps" && r.eqs.status === "going" && Array.isArray(r.ins.event_id);

describe("census-discovery §118 (B22): GET /api/pulse ranks its event pool on the live going count", () => {
  after(() => _setTestClient(null as any, false));
  it("SP1 the pool's going RSVPs are read live, over the pool's events", async () => {
    const reads: Read[] = [];
    const { status } = await get({ tables: feedWorld(), reads }, "/api/pulse");
    assert.equal(status, 200);
    const r = reads.find(liveGoingRead);
    assert.ok(r, JSON.stringify(reads.filter((x) => x.table === "event_rsvps")));
    assert.deepEqual(r!.ins.event_id, [EV2]);
  });
  it("SP2 that read FAILING → 200, the same posts served", async () => {
    const healthy = await get({ tables: feedWorld() }, "/api/pulse");
    const failed = await get({ tables: feedWorld(), fail: liveGoingRead }, "/api/pulse");
    assert.equal(failed.status, 200);
    assert.deepEqual((failed.body.posts ?? []).map((p: any) => p.id), (healthy.body.posts ?? []).map((p: any) => p.id));
  });
});
