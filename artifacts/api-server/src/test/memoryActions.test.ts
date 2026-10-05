/**
 * §14 Executable Memories — GET /memories/:id/actions and
 * GET /memories/:id/actions/:action, over the real router and a table-backed
 * fake. Census H16 / H107 / H108 / H259.
 *
 * WHAT THESE TESTS HOLD
 *   - Every operational fact on a compiled action is read NOW from the system
 *     that owns it: the catalog's current row (a merged place followed to its
 *     successor, a closed place refused), a live source or an honest unknown,
 *     the traveller's current trips, and the Temporal Freedom Engine's windows.
 *     The Memory contributes which place and when — nothing else.
 *   - §14's fusion is a juxtaposition: `merged: false`, and
 *     `may_state_current_status` comes from the live half alone.
 *   - A failed read is never "no place", "no trips" or "no saves".
 *   - A viewer who may not read the Memory gets the same 404 as a missing one,
 *     and a non-owner is never handed a venue the owner's precision or a
 *     protected Hidden Gem withholds.
 *   - Nothing is written. The store is compared before and after every call.
 *
 * Run: node --import tsx/esm --test src/test/memoryActions.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoryActionsRouter from "../routes/memoryActions.js";
import { _setMemoryActionDeps, type MemoryActionDeps } from "../services/memory/memoryActionService.js";
import type { TripWindowsRead } from "../domain/trips/services/TripFreedomConsumers.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREWMATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const MEM_CATALOG = "10000000-0000-4000-8000-000000000001";
const MEM_CLOSED = "10000000-0000-4000-8000-000000000002";
const MEM_MERGED = "10000000-0000-4000-8000-000000000003";
const MEM_NO_PLACE = "10000000-0000-4000-8000-000000000004";
const MEM_PRIVATE = "10000000-0000-4000-8000-000000000005";
const MEM_GEM = "10000000-0000-4000-8000-000000000006";
const MEM_PROVIDER_ID = "10000000-0000-4000-8000-000000000007";
const MEM_CANONICAL = "10000000-0000-4000-8000-000000000008";

const PLACE_OPEN = "20000000-0000-4000-8000-000000000001";
const PLACE_CLOSED = "20000000-0000-4000-8000-000000000002";
const PLACE_OLD = "20000000-0000-4000-8000-000000000003";
const PLACE_SUCCESSOR = "20000000-0000-4000-8000-000000000004";
const PLACE_GEM = "20000000-0000-4000-8000-000000000005";
const PLACE_SAVED_OPEN = "20000000-0000-4000-8000-000000000006";
const PLACE_SAVED_CLOSED = "20000000-0000-4000-8000-000000000007";
const PLACE_SAVED_DONE = "20000000-0000-4000-8000-000000000008";
const PLACE_CANON = "20000000-0000-4000-8000-000000000009";
const CANON_LOC = "30000000-0000-4000-8000-000000000001";

const OLD_TRIP = "40000000-0000-4000-8000-000000000001";
const TOKYO_TRIP = "40000000-0000-4000-8000-000000000002";
const PARIS_TRIP = "40000000-0000-4000-8000-000000000003";
const DONE_TRIP = "40000000-0000-4000-8000-000000000004";
const FOREIGN_TRIP = "40000000-0000-4000-8000-000000000005";
const CANCELLED_TRIP = "40000000-0000-4000-8000-000000000006";
const REMOVED_TRIP = "40000000-0000-4000-8000-000000000007";

function memory(id: string, extra: Record<string, unknown>) {
  return {
    id, owner_id: OWNER, title: "Ramen night", visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: OLD_TRIP, place_id: null, canonical_location_id: null, location_city: "Tokyo", location_country: "Japan",
    location_lat: 35.6595, location_lng: 139.7005, starts_at: "2026-03-03T11:00:00.000Z", ends_at: null,
    state: "published", created_at: "2026-03-03T12:00:00.000Z", ...extra,
  };
}

function place(id: string, extra: Record<string, unknown>) {
  return {
    id, name: "Ichiran Shibuya", primary_category: "food", latitude: 35.661, longitude: 139.701,
    address: "1-22-7 Jinnan", city: "Tokyo", country_code: "JP", status: "active", merged_into_place_id: null,
    canonical_location_id: null, ...extra,
  };
}

function tables(): Record<string, any[]> {
  return {
    memories: [
      memory(MEM_CATALOG, { place_id: PLACE_OPEN }),
      memory(MEM_CLOSED, { place_id: PLACE_CLOSED }),
      memory(MEM_MERGED, { place_id: PLACE_OLD }),
      memory(MEM_NO_PLACE, { place_id: null, trip_id: null }),
      memory(MEM_PRIVATE, { place_id: PLACE_OPEN, visibility: "only_me" }),
      memory(MEM_GEM, { place_id: PLACE_GEM }),
      memory(MEM_PROVIDER_ID, { place_id: "fsq:4b0588f1f964a520" }),
      memory(MEM_CANONICAL, { place_id: "osm:node/123", canonical_location_id: CANON_LOC }),
      // The owner has already been to PLACE_SAVED_DONE: a Memory there.
      memory("10000000-0000-4000-8000-000000000099", { place_id: PLACE_SAVED_DONE, trip_id: null }),
    ],
    places: [
      place(PLACE_OPEN, {}),
      place(PLACE_CLOSED, { name: "Gone Bar", status: "closed" }),
      place(PLACE_OLD, { name: "Old Name Cafe", status: "duplicate", merged_into_place_id: PLACE_SUCCESSOR }),
      place(PLACE_SUCCESSOR, { name: "New Name Cafe", address: "2-1 Dogenzaka", latitude: 35.658, longitude: 139.698 }),
      place(PLACE_GEM, { name: "Secret Garden", latitude: 35.7, longitude: 139.75 }),
      place(PLACE_SAVED_OPEN, { name: "Tsukiji Outer Market" }),
      place(PLACE_SAVED_CLOSED, { name: "Closed Izakaya", status: "closed" }),
      place(PLACE_SAVED_DONE, { name: "Already Been" }),
      place(PLACE_CANON, { name: "Canonical Sushi", canonical_location_id: CANON_LOC, status: "temporarily_closed" }),
    ],
    hidden_gems: [
      { canonical_place_id: PLACE_GEM, sensitivity_level: "protected", status: "active", city: "Tokyo",
        latitude: 35.7, longitude: 139.75, approx_latitude: null, approx_longitude: null },
    ],
    trips: [
      { id: OLD_TRIP, owner_id: OWNER, title: "Tokyo 2026", destination_city: "Tokyo", destination_country: "Japan",
        start_date: "2026-03-01", end_date: "2026-03-08", status: "completed" },
      { id: TOKYO_TRIP, owner_id: OWNER, title: "Back to Tokyo", destination_city: "tokyo", destination_country: "Japan",
        start_date: "2026-11-01", end_date: "2026-11-09", status: "upcoming" },
      { id: PARIS_TRIP, owner_id: FRIEND, title: "Paris", destination_city: "Paris", destination_country: "France",
        start_date: "2026-10-20", end_date: "2026-10-25", status: "planning" },
      { id: DONE_TRIP, owner_id: OWNER, title: "Lisbon", destination_city: "Lisbon", destination_country: "Portugal",
        start_date: "2026-01-01", end_date: "2026-01-05", status: "completed" },
      { id: FOREIGN_TRIP, owner_id: STRANGER, title: "Not yours", destination_city: "Tokyo", destination_country: "Japan",
        start_date: "2026-11-01", end_date: "2026-11-05", status: "upcoming" },
      // Dates still ahead, status says it is not happening: not a current plan.
      { id: CANCELLED_TRIP, owner_id: OWNER, title: "Called off", destination_city: "Tokyo", destination_country: "Japan",
        start_date: "2026-12-01", end_date: "2026-12-05", status: "cancelled" },
      { id: REMOVED_TRIP, owner_id: STRANGER, title: "Removed from", destination_city: "Tokyo", destination_country: "Japan",
        start_date: "2026-11-10", end_date: "2026-11-12", status: "upcoming" },
    ],
    trip_members: [
      { trip_id: PARIS_TRIP, user_id: OWNER, role: "member", status: "accepted" },
      // An invitation never accepted (legacy row: no status) — the ROLE alone excludes it.
      { trip_id: FOREIGN_TRIP, user_id: OWNER, role: "invited", status: null },
      // A member who was removed — the STATUS alone excludes it.
      { trip_id: REMOVED_TRIP, user_id: OWNER, role: "member", status: "removed" },
    ],
    trip_saved_places: [
      { trip_id: OLD_TRIP, user_id: OWNER, place_id: PLACE_SAVED_OPEN, place_name: "Tsukiji Outer Market", saved_at: "2026-02-20T00:00:00.000Z" },
      { trip_id: OLD_TRIP, user_id: OWNER, place_id: PLACE_SAVED_CLOSED, place_name: "Closed Izakaya", saved_at: "2026-02-21T00:00:00.000Z" },
      { trip_id: OLD_TRIP, user_id: OWNER, place_id: PLACE_SAVED_DONE, place_name: "Already Been", saved_at: "2026-02-22T00:00:00.000Z" },
      { trip_id: OLD_TRIP, user_id: OWNER, place_id: "osm:node/999", place_name: "A Street Stall", saved_at: "2026-02-23T00:00:00.000Z" },
      { trip_id: OLD_TRIP, user_id: CREWMATE, place_id: PLACE_OPEN, place_name: "Crewmate's pick", saved_at: "2026-02-24T00:00:00.000Z" },
    ],
    memory_saves: [{ memory_id: MEM_CATALOG, user_id: FRIEND }],
    blocks: [{ blocker_id: OWNER, blocked_id: STRANGER }],
    feature_flags: [],
    user_follows: [], circle_memberships: [],
  };
}

function makeClient(store: Record<string, any[]>, failReads: Set<string>, failInReads: Set<string>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let usedIn = false;
    let single = false;
    let isWrite = false;
    let limitN: number | null = null;
    const obj: any = {
      select() { return obj; },
      insert() { isWrite = true; return obj; },
      update() { isWrite = true; return obj; },
      upsert() { isWrite = true; return obj; },
      delete() { isWrite = true; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { usedIn = true; const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      order() { return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (isWrite) {
        // The routes under test are read-only. A write is a defect, made loud.
        throw new Error(`unexpected write to ${table}`);
      }
      if (failReads.has(table) || (usedIn && failInReads.has(table))) return { data: null, error: { message: `${table} unavailable` } };
      let rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function windowsRead(): TripWindowsRead {
  return {
    ok: true,
    projection: {
      tripId: TOKYO_TRIP,
      decisionId: "dec-1",
      reading: "§7.3: windows are lower bounds",
      windows: [
        // In the past: never offered.
        { id: "w-past", position: "between", beginsAt: iso(NOW - 6 * 3600e3), endsAt: iso(NOW - 3600e3), durationMinutes: 300, confidence: "MEDIUM", certified: false },
        // Too short to do anything in.
        { id: "w-short", position: "between", beginsAt: iso(NOW + 3600e3), endsAt: iso(NOW + 3600e3 + 30 * 60e3), durationMinutes: 30, confidence: "MEDIUM", certified: false },
        { id: "w-late", position: "between", beginsAt: iso(NOW + 48 * 3600e3), endsAt: iso(NOW + 52 * 3600e3), durationMinutes: 240, confidence: "LOW", certified: false },
        { id: "w-soon", position: "before_first", beginsAt: iso(NOW + 24 * 3600e3), endsAt: iso(NOW + 27 * 3600e3), durationMinutes: 180, confidence: "MEDIUM", certified: false },
      ],
    },
  } as unknown as TripWindowsRead;
}

interface App { baseUrl: string; store: Record<string, any[]>; calls: { live: string[]; windows: string[] }; close: () => Promise<void> }

async function startApp(opts: { failReads?: string[]; failInReads?: string[]; deps?: Partial<MemoryActionDeps>; mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  const store = tables();
  opts.mutate?.(store);
  const calls = { live: [] as string[], windows: [] as string[] };
  _setTestClient(makeClient(store, new Set(opts.failReads ?? []), new Set(opts.failInReads ?? [])) as any, true);
  _setMemoryActionDeps({
    liveStatus: async (name) => { calls.live.push(name); return { openNow: true, venueName: name, source: "foursquare", checkedAt: iso(NOW) }; },
    tripWindows: async (_sc, tripId) => { calls.windows.push(tripId); return windowsRead(); },
    ...(opts.deps ?? {}),
  });
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoryActionsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, store, calls,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(app: App, path: string, actor: string) {
  const before = JSON.stringify(app.store);
  const res = await fetch(app.baseUrl + path, { headers: { Authorization: `Bearer ${actor}`, connection: "close" } });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  assert.equal(JSON.stringify(app.store), before, `${path} wrote to the store — every action route is read-only`);
  return { status: res.status, body };
}

const byAction = (menu: any) => Object.fromEntries((menu.actions as any[]).map((a) => [a.action, a]));

let app: App | null = null;
afterEach(async () => { _setMemoryActionDeps(null); if (app) { await app.close(); app = null; } });

describe("GET /memories/:id/actions — the menu, judged against the world now", () => {
  it("offers the venue actions on a place the catalog still serves, and refuses the three it does not build by name", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const m = byAction(r.body.menu);
    for (const a of ["DO_AGAIN", "TAKE_ME_BACK", "ADD_TO_TRIP", "VIEW_PLACE", "BRING_FORWARD_SAVED"]) {
      assert.equal(m[a].available, true, `${a} should be offered: ${JSON.stringify(m[a])}`);
    }
    assert.deepEqual([m.SAVE_EXPERIENCE.available, m.SAVE_EXPERIENCE.reason], [false, "OWN_MEMORY"]);
    assert.deepEqual([m.BOOK_AGAIN.available, m.BOOK_AGAIN.reason], [false, "NO_ELIGIBLE_PROVIDER"]);
    assert.deepEqual([m.NEW_TRIP_WITH_CREW.available, m.NEW_TRIP_WITH_CREW.reason], [false, "CONSUMER_UNAVAILABLE"]);
    assert.deepEqual([m.USE_AS_INSPIRATION.available, m.USE_AS_INSPIRATION.reason], [false, "CONSUMER_UNAVAILABLE"]);
    assert.equal(r.body.menu.actions.length, 9, "§14's eight plus §12's VIEW_PLACE");
    assert.equal(r.body.menu.place.id, PLACE_OPEN);
  });

  it("refuses every venue action on a place the catalog says has CLOSED — the Memory being there once does not reopen it", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CLOSED}/actions`, OWNER);
    assert.equal(r.status, 200);
    const m = byAction(r.body.menu);
    for (const a of ["DO_AGAIN", "TAKE_ME_BACK", "ADD_TO_TRIP", "VIEW_PLACE"]) {
      assert.deepEqual([m[a].available, m[a].reason], [false, "PLACE_CLOSED"], a);
    }
    assert.equal(r.body.menu.place, null);
  });

  it("follows a merged place to the row that exists now", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_MERGED}/actions`, OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.body.menu.place.id, PLACE_SUCCESSOR);
    assert.equal(r.body.menu.place.name, "New Name Cafe");
  });

  it("an unreadable catalog is PLACE_UNREADABLE — never 'not in the catalog'", async () => {
    app = await startApp({ failReads: ["places"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, OWNER);
    assert.equal(r.status, 200);
    const m = byAction(r.body.menu);
    assert.equal(m.DO_AGAIN.reason, "PLACE_UNREADABLE");
    assert.equal(m.TAKE_ME_BACK.reason, "PLACE_UNREADABLE",
      "an unreadable catalog must not fall back to the Memory's own coordinate as if there were no place");
  });

  it("a Memory the viewer may not read is the same 404 as a missing one, for a stranger and for a blocked viewer", async () => {
    app = await startApp();
    const priv = await get(app, `/api/memories/${MEM_PRIVATE}/actions`, FRIEND);
    assert.equal(priv.status, 404);
    const blocked = await get(app, `/api/memories/${MEM_CATALOG}/actions`, STRANGER);
    assert.equal(blocked.status, 404);
    const missing = await get(app, `/api/memories/10000000-0000-4000-8000-0000000000ff/actions`, OWNER);
    assert.equal(missing.status, 404);
  });

  it("an unreadable Memory is 503, not 404", async () => {
    app = await startApp({ failReads: ["memories"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, OWNER);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("an unreadable blocks table withholds the Memory from a non-owner", async () => {
    app = await startApp({ failReads: ["blocks"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, FRIEND);
    assert.equal(r.status, 404);
  });

  it("a non-owner gets SAVE_EXPERIENCE with their saved state, and never BRING_FORWARD_SAVED", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, FRIEND);
    assert.equal(r.status, 200);
    const m = byAction(r.body.menu);
    assert.equal(m.SAVE_EXPERIENCE.available, true);
    assert.equal(m.SAVE_EXPERIENCE.message, "Saved");
    assert.deepEqual([m.BRING_FORWARD_SAVED.available, m.BRING_FORWARD_SAVED.reason], [false, "OWNER_ONLY"]);
    assert.equal(m.DO_AGAIN.available, true, "a public Memory at an unprotected place may be acted on by a reader");
  });

  it("withholds a protected Hidden Gem's venue from a non-owner — and from nobody's own Memory", async () => {
    app = await startApp();
    const stranger = await get(app, `/api/memories/${MEM_GEM}/actions`, FRIEND);
    const m = byAction(stranger.body.menu);
    for (const a of ["DO_AGAIN", "TAKE_ME_BACK", "ADD_TO_TRIP", "VIEW_PLACE"]) {
      assert.equal(m[a].reason, "PLACE_WITHHELD", a);
    }
    assert.equal(stranger.body.menu.place, null, "the menu must not name the protected place either");
    const own = await get(app, `/api/memories/${MEM_GEM}/actions`, OWNER);
    assert.equal(byAction(own.body.menu).DO_AGAIN.available, true);
  });

  it("an unreadable hidden_gems table withholds the venue from a non-owner (fail closed)", async () => {
    app = await startApp({ failReads: ["hidden_gems"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions`, FRIEND);
    assert.equal(byAction(r.body.menu).DO_AGAIN.reason, "PLACE_WITHHELD");
  });

  it("withholds the venue from a non-owner when the owner's precision is coarser than the venue", async () => {
    app = await startApp({
      mutate: (s) => {
        s.feature_flags.push({ flag: "memory_location_precision_enabled", enabled: true });
        s.memories.find((m) => m.id === MEM_CATALOG).location_precision = "city";
      },
    });
    const friend = await get(app, `/api/memories/${MEM_CATALOG}/actions`, FRIEND);
    assert.equal(byAction(friend.body.menu).ADD_TO_TRIP.reason, "PLACE_WITHHELD");
    const own = await get(app, `/api/memories/${MEM_CATALOG}/actions`, OWNER);
    assert.equal(byAction(own.body.menu).ADD_TO_TRIP.available, true, "the owner's own precision never withholds from the owner");
  });

  it("a provider id the catalog cannot resolve is PLACE_NOT_IN_CATALOG; the owner may still be taken back to their own coordinate", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_PROVIDER_ID}/actions`, OWNER);
    const m = byAction(r.body.menu);
    assert.equal(m.DO_AGAIN.reason, "PLACE_NOT_IN_CATALOG");
    assert.equal(m.TAKE_ME_BACK.available, true);
    const friend = await get(app, `/api/memories/${MEM_PROVIDER_ID}/actions`, FRIEND);
    assert.equal(byAction(friend.body.menu).TAKE_ME_BACK.reason, "PLACE_NOT_IN_CATALOG",
      "a non-owner is never navigated to the Memory's raw coordinate");
  });

  it("resolves a Memory by its canonical location when its place id is a provider id, and carries the catalog's caution", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CANONICAL}/actions`, OWNER);
    const m = byAction(r.body.menu);
    assert.equal(r.body.menu.place.id, PLACE_CANON);
    assert.equal(m.DO_AGAIN.available, true);
    assert.equal(m.DO_AGAIN.caution, "TEMPORARILY_CLOSED");
  });

  it("NO_PLACE_REFERENCE is distinct from not-in-catalog", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_NO_PLACE}/actions`, OWNER);
    const m = byAction(r.body.menu);
    assert.equal(m.DO_AGAIN.reason, "NO_PLACE_REFERENCE");
    assert.equal(m.BRING_FORWARD_SAVED.reason, "NO_PRIOR_TRIP");
  });
});

describe("GET /memories/:id/actions/DO_AGAIN — compiled through the current world and the Temporal Freedom Engine", () => {
  it("compiles a plan on the trip going THERE, with the engine's future windows, a live reading and an unmerged fusion", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body.compiled;
    assert.equal(p.action, "DO_AGAIN");
    assert.equal(p.place.id, PLACE_OPEN);
    assert.equal(p.tripChoice.state, "chosen");
    assert.equal(p.tripChoice.trip.id, TOKYO_TRIP, "the upcoming trip to the place's city, matched case-insensitively");
    const candidateIds = p.tripChoice.candidates.map((t: any) => t.id).sort();
    assert.deepEqual(candidateIds, [PARIS_TRIP, TOKYO_TRIP].sort(),
      "completed and cancelled trips, a trip the viewer was only invited to, and one they were removed from are not current plans");
    assert.deepEqual(app.calls.windows, [TOKYO_TRIP], "the Temporal Freedom Engine is consulted for the chosen trip");
    assert.equal(p.freedom.consulted, true);
    assert.deepEqual(p.freedom.windows.map((w: any) => w.id), ["w-soon", "w-late"],
      "past and too-short windows are not offered; the rest are earliest first");
    assert.equal(p.fusion.merged, false);
    assert.equal(p.fusion.historical.truth_class, "historical");
    assert.equal(p.fusion.historical.establishes_current_status, false);
    assert.equal(p.fusion.current.available, true);
    assert.equal(p.fusion.may_state_current_status, true);
    assert.deepEqual(app.calls.live, ["Ichiran Shibuya"], "the live source is asked about the CURRENT catalog name");
    assert.equal(p.addToTrip.id, PLACE_OPEN);
    assert.equal(p.navigation.kind, "catalog_place");
  });

  it("with no live reading it says nothing about now: current unavailable, may_state_current_status false", async () => {
    app = await startApp({ deps: { liveStatus: async () => null } });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    const f = r.body.compiled.fusion;
    assert.equal(f.current.available, false);
    assert.equal(f.may_state_current_status, false);
    assert.equal(f.historical.establishes_current_status, false);
  });

  it("compiles the merged place's successor, never the row the Memory remembers", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_MERGED}/actions/DO_AGAIN`, OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.body.compiled.addToTrip.id, PLACE_SUCCESSOR);
    assert.equal(r.body.compiled.addToTrip.name, "New Name Cafe");
    assert.deepEqual(r.body.compiled.followedMerges, [PLACE_OLD]);
    assert.equal(r.body.compiled.navigation.address, "2-1 Dogenzaka");
  });

  it("a trip going elsewhere is offered, never chosen silently, and the engine is not consulted", async () => {
    app = await startApp({ mutate: (s) => { s.trips = s.trips.filter((t) => t.id !== TOKYO_TRIP); } });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    assert.equal(r.body.compiled.tripChoice.state, "none_matching");
    assert.equal(r.body.compiled.freedom.consulted, false);
    assert.deepEqual(app.calls.windows, []);
  });

  it("an explicitly chosen trip of the viewer's is used; one that is not theirs is refused", async () => {
    app = await startApp();
    const chosen = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN?tripId=${PARIS_TRIP}`, OWNER);
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.compiled.tripChoice.trip.id, PARIS_TRIP);
    const foreign = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN?tripId=${FOREIGN_TRIP}`, OWNER);
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.reason, "trip_not_eligible");
    const past = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN?tripId=${DONE_TRIP}`, OWNER);
    assert.equal(past.status, 409, "a completed trip is not a current plan");
  });

  it("unreadable trips are 'unreadable', not 'no trips'; and a requested trip that cannot be verified is 503", async () => {
    app = await startApp({ failReads: ["trip_members"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    assert.equal(r.status, 200);
    assert.equal(r.body.compiled.tripChoice.state, "unreadable");
    assert.equal(r.body.compiled.freedom.consulted, false);
    const req = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN?tripId=${TOKYO_TRIP}`, OWNER);
    assert.equal(req.status, 503);
  });

  it("an engine that refuses (its gate is off) is reported as not consulted, with the engine's own words", async () => {
    app = await startApp({ deps: { tripWindows: async () => ({ ok: false, info: "Freedom windows are not enabled: gate off" }) } });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.compiled.freedom, { consulted: false, tripId: TOKYO_TRIP, info: "Freedom windows are not enabled: gate off" });
  });

  it("refuses a closed place (409 PLACE_CLOSED) and an unreadable catalog (503)", async () => {
    app = await startApp();
    const closed = await get(app, `/api/memories/${MEM_CLOSED}/actions/DO_AGAIN`, OWNER);
    assert.equal(closed.status, 409);
    assert.equal(closed.body.reason, "PLACE_CLOSED");
    await app.close();
    app = await startApp({ failReads: ["places"] });
    const unreadable = await get(app, `/api/memories/${MEM_CATALOG}/actions/DO_AGAIN`, OWNER);
    assert.equal(unreadable.status, 503);
  });
});

describe("ADD_TO_TRIP and TAKE_ME_BACK compiles", () => {
  it("ADD_TO_TRIP hands back the CURRENT place in the trip write path's shape, never the Memory's coordinate", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_MERGED}/actions/ADD_TO_TRIP`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.compiled.addToTrip, {
      id: PLACE_SUCCESSOR, name: "New Name Cafe", category: "food", type: null,
      address: "2-1 Dogenzaka, Tokyo", lat: 35.658, lng: 139.698,
    });
  });

  it("TAKE_ME_BACK for the owner with no catalog place is their own coordinate, marked historical", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_PROVIDER_ID}/actions/TAKE_ME_BACK`, OWNER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.compiled.navigation, {
      kind: "memory_location", placeId: null, label: "Tokyo, Japan", address: null, lat: 35.6595, lng: 139.7005, historical: true,
    });
  });

  it("TAKE_ME_BACK never hands a non-owner the Memory's raw coordinate", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_PROVIDER_ID}/actions/TAKE_ME_BACK`, FRIEND);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "PLACE_NOT_IN_CATALOG");
  });

  it("TAKE_ME_BACK to a catalog place goes where the catalog says it is now", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/TAKE_ME_BACK`, FRIEND);
    assert.equal(r.status, 200);
    assert.equal(r.body.compiled.navigation.kind, "catalog_place");
    assert.equal(r.body.compiled.navigation.historical, false);
    assert.equal(r.body.compiled.navigation.lat, 35.661);
  });
});

describe("BRING_FORWARD_SAVED — the owner's own saves from the earlier trip, judged now", () => {
  it("brings forward what is still open and unvisited, and says why each other save stays behind", async () => {
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/BRING_FORWARD_SAVED`, OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.compiled;
    assert.deepEqual(c.items.map((i: any) => i.addToTrip.id), [PLACE_SAVED_OPEN]);
    assert.deepEqual(
      c.leftBehind.map((l: any) => [l.placeName, l.reason]),
      [["Closed Izakaya", "PLACE_CLOSED"], ["Already Been", "ALREADY_EXPERIENCED"], ["A Street Stall", "PLACE_NOT_IN_CATALOG"]],
    );
    assert.ok(!JSON.stringify(c).includes("Crewmate's pick"), "a crewmate's save is not this person's to bring forward");
  });

  it("is the owner's only (403), and an unreadable saved list is 503 — not an empty list", async () => {
    app = await startApp();
    const friend = await get(app, `/api/memories/${MEM_CATALOG}/actions/BRING_FORWARD_SAVED`, FRIEND);
    assert.equal(friend.status, 403);
    await app.close();
    app = await startApp({ failReads: ["trip_saved_places"] });
    const r = await get(app, `/api/memories/${MEM_CATALOG}/actions/BRING_FORWARD_SAVED`, OWNER);
    assert.equal(r.status, 503);
  });

  it("an unreadable experienced-set or catalog is 503 — a save cannot be judged 'not yet done' or 'still open' without it", async () => {
    // `memories` is read twice: the Memory itself (by id) and the experienced
    // set (by `.in("place_id", …)`). Only the second is failed here.
    app = await startApp({ failInReads: ["memories"] });
    const experienced = await get(app, `/api/memories/${MEM_CATALOG}/actions/BRING_FORWARD_SAVED`, OWNER);
    assert.equal(experienced.status, 503);
    await app.close();
    app = await startApp({ failInReads: ["places"] });
    const catalog = await get(app, `/api/memories/${MEM_CATALOG}/actions/BRING_FORWARD_SAVED`, OWNER);
    assert.equal(catalog.status, 503);
  });
});

describe("declared and refused by name", () => {
  it("BOOK_AGAIN, NEW_TRIP_WITH_CREW and USE_AS_INSPIRATION compile to the menu's own reason", async () => {
    app = await startApp();
    const book = await get(app, `/api/memories/${MEM_CATALOG}/actions/BOOK_AGAIN`, OWNER);
    assert.deepEqual([book.status, book.body.reason], [409, "NO_ELIGIBLE_PROVIDER"]);
    const crew = await get(app, `/api/memories/${MEM_CATALOG}/actions/NEW_TRIP_WITH_CREW`, OWNER);
    assert.deepEqual([crew.status, crew.body.reason], [409, "CONSUMER_UNAVAILABLE"]);
    const unknown = await get(app, `/api/memories/${MEM_CATALOG}/actions/FLY_ME_THERE`, OWNER);
    assert.equal(unknown.status, 400);
  });
});
