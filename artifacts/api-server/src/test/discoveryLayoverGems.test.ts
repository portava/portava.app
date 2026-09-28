/**
 * census-discovery A13 / A14, §56 — the Layover-mode Discovery paths read the
 * CERTIFIED snapshot, and nothing else, for their minutes and their universe.
 *
 *   Layover `:66`  "All surfaces consume the same certified LayoverSnapshot /
 *                   RecommendationContract; no duplicate time-budget logic"
 *   Layover `:753` "Discovery: Only show experiences from certified action
 *                   universe in Layover mode"
 *
 * `GET /hidden-gems/layover-safe` is what the layover dashboard's
 * `LayoverDiscoveryCard` calls. It used to take the window from
 * `?availableMinutes=`. This suite pins, with controlled data:
 *
 *   1. MINUTES   a traveller in a live layover is filtered on the snapshot's
 *                `usableMinutes`; the query figure can neither widen nor narrow
 *                it. A caller in NO layover keeps the stated hypothetical, and
 *                gets exactly the body they got before.
 *   2. FAIL CLOSED an unreadable `layover_sessions` / `airport_profiles` is a
 *                `503 degraded_unavailable` — never the query figure, never a
 *                list. A certified window with no minutes is an empty 200, never
 *                "no filter" and never a 400 blaming the client.
 *   3. REVOCATION the window is re-read on every request: a window that shrank,
 *                a session that decertified (the traveller will stay airside)
 *                and a session that ENDED each change the NEXT answer. No cache
 *                keeps serving the first one. Both directions.
 *   4. CROSS-VIEWER one traveller's layover never gates, nor ungates, another's.
 *   5. RETRIES   the same request twice gives the same served set.
 *   6. LAYOVER MODE with `layover_discovery_mode_enabled` on, a certified caller
 *                sees only the certified action universe — the same gate the
 *                three `/discovery` surfaces use, fed THIS request's snapshot —
 *                and every withheld gem is named with its state.
 *
 * And the same revocation property on `GET /discovery/community`, which the
 * earlier suites gated but never asked twice.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryLayoverGems.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import discoveryRouter, {
  _setTestDbPlacesOverride, _clearTestCompassCache, _injectTestCacheEntry, _clearTestCacheEntry, type DiscoveryPlace,
} from "../routes/discovery.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { LAYOVER_DISCOVERY_MODE_FLAG, certifiedLayoverSnapshot } from "../services/airport/LayoverSnapshot.js";
import { CERTIFIED_MINUTES_SOURCE, LAYOVER_WINDOW_UNREADABLE_MESSAGE } from "../lib/discoveryLayoverGems.js";
import { airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

// No network: nothing here should leave the process.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("Network blocked in test environment"); }) as typeof globalThis.fetch;

const A_TOKEN = "layover-gems-viewer-a";
const B_TOKEN = "layover-gems-viewer-b";
const A_ID = "aaaa0000-0000-4000-8000-0000000000a1";
const B_ID = "bbbb0000-0000-4000-8000-0000000000b2";
const SESSION_A = "5e550000-0000-4000-8000-00000000a14a";
const CITY = "Taoyuan";

// TPE is at (25.0797, 121.2342). Every gem is ~300 m away and public.
const G_QUICK = "9e000000-0000-4000-8000-000000000001"; // minimum 60 — fits any window this suite builds
const G_MID   = "9e000000-0000-4000-8000-000000000002"; // minimum set per test, between two windows
const G_HUGE  = "9e000000-0000-4000-8000-000000000003"; // minimum far above every certified window
const G_UNSAFE = "9e000000-0000-4000-8000-000000000004"; // not layover-safe at all

function gemRow(id: string, minimum: number | null, over: Record<string, unknown> = {}) {
  return {
    id, name: `gem ${id.slice(-1)}`, category: "viewpoint", city: CITY, country: "Taiwan",
    neighborhood: null, description: null,
    latitude: 25.081, longitude: 121.236, approx_latitude: 25.08, approx_longitude: 121.24,
    vibe_tags: [], price_range: "free", safety_notes: null, best_time_to_go: null, local_etiquette: null,
    layover_safe: true, minimum_layover_minutes: minimum,
    sensitivity_level: "public", verification_level: "community", status: "active",
    submitted_by: null, guide_verified_by: null, save_count: 0, visit_count: 0, report_count: 0,
    image_url: null, canonical_place_id: null, source_type: null, moderation_status: "approved",
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/** A live layover for A at TPE, departing `hours` from the REAL clock (the route cannot be given a nowMs). */
function sessionFor(hours: number, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return sessionRow({
    id: SESSION_A, user_id: A_ID, airport_id: "airport-tpe",
    arrival_time: new Date(now - 20 * 60_000).toISOString(),
    departure_time: new Date(now + hours * 3_600_000).toISOString(),
    layover_minutes: Math.round(hours * 60) + 20, wants_to_leave: true, status: "active",
    ...over,
  });
}

/** A stop A put in their own layover plan, naming `placeId`, with the terms THEY stated. */
function stopRow(placeId: string, travelMin: number, durationMin: number) {
  return {
    id: `stop-${placeId}`, session_id: SESSION_A, title: placeId, stop_order: 0,
    duration_min: durationMin, travel_min: travelMin, place_id: placeId,
    recommendation_id: null, lat: null, lng: null, location_label: null,
    inside_airport: false, source: "user",
  };
}

// ── a supabase-js stand-in: table-backed, MUTABLE between requests ───────────
//
// Mutability is the point: the revocation cases change the world between two
// requests and ask again. Failures RESOLVE with `{ data: null, error }`, which
// is what supabase-js does; a fake that threw would test a different client.
type World = Record<string, any[]>;
let world: World = {};
let errorTables = new Set<string>();
/** Reads per table since the last reset — how "certified once per request" is observed. */
let reads: Record<string, number> = {};

function buildClient() {
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    const cmp = (col: string, f: (a: any) => boolean) => preds.push((r) => r[col] === undefined || (r[col] !== null && f(r[col])));
    const b: any = {
      select() { return b; },
      insert() { return b; }, update() { return b; }, delete() { return b; }, upsert() { return b; },
      eq(col: string, v: any) { preds.push((r) => r[col] === v); return b; },
      neq(col: string, v: any) { preds.push((r) => r[col] !== v); return b; },
      in(col: string, vs: any[]) { preds.push((r) => vs.includes(r[col])); return b; },
      is(col: string, v: any) { preds.push((r) => (r[col] ?? null) === v); return b; },
      gt(col: string, v: any) { cmp(col, (a) => a > v); return b; },
      gte(col: string, v: any) { cmp(col, (a) => a >= v); return b; },
      lt(col: string, v: any) { cmp(col, (a) => a < v); return b; },
      lte(col: string, v: any) { cmp(col, (a) => a <= v); return b; },
      ilike(col: string, v: string) {
        const needle = String(v).replace(/%/g, "").toLowerCase();
        preds.push((r) => typeof r[col] === "string" && r[col].toLowerCase().includes(needle));
        return b;
      },
      like() { return b; }, not() { return b; }, or() { return b; },
      contains() { return b; }, overlaps() { return b; },
      order() { return b; }, range() { return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return one(); }, single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };
    const rows = () => {
      const out = (world[table] ?? []).filter((r) => preds.every((p) => p(r)));
      return limitN === null ? out : out.slice(0, limitN);
    };
    async function list() {
      reads[table] = (reads[table] ?? 0) + 1;
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      return { data: rows(), error: null, count: rows().length };
    }
    async function one() {
      reads[table] = (reads[table] ?? 0) + 1;
      if (errorTables.has(table)) return { data: null, error: { message: `${table} unavailable` } };
      return { data: rows()[0] ?? null, error: null };
    }
    return b;
  }
  return {
    auth: {
      getUser: async (token: string) =>
        token === A_TOKEN ? { data: { user: { id: A_ID } }, error: null }
        : token === B_TOKEN ? { data: { user: { id: B_ID } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
  };
}

const client = buildClient();

function gemsWorld(over: { modeOn?: boolean; session?: any | null; stops?: any[]; gems?: any[] } = {}): World {
  return {
    feature_flags: [
      { flag: "hidden_gems_enabled", enabled: true },
      { flag: "hidden_gems_layover_enabled", enabled: true },
      ...(over.modeOn ? [{ flag: LAYOVER_DISCOVERY_MODE_FLAG, enabled: true }] : []),
    ],
    hidden_gems: over.gems ?? [gemRow(G_QUICK, 60), gemRow(G_HUGE, 100_000), gemRow(G_UNSAFE, 30, { layover_safe: false })],
    layover_sessions: over.session === null ? [] : [over.session ?? sessionFor(9)],
    airport_profiles: [airportRow()],
    layover_plan_stops: over.stops ?? [],
  };
}

/** The window the Layover domain certifies for A right now, read through the same door the route uses. */
async function certifiedMinutesForA(): Promise<number> {
  const r = await certifiedLayoverSnapshot(client as any, A_ID);
  assert.ok(r.ok, `fixture: A must have a certified snapshot (${JSON.stringify(r)})`);
  return r.snapshot.usableMinutes;
}

let server: http.Server;
let base = "";

function get(path: string, token: string | null = A_TOKEN): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const gemIds = (body: any) => ((body?.gems ?? []) as any[]).map((g) => g.id).sort();
const SAFE = "/api/hidden-gems/layover-safe";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", hiddenGemsRouter);
  app.use("/api", discoveryRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

after(() => {
  server.close();
  globalThis.fetch = _originalFetch;
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  _setTestDbPlacesOverride(null);
});

beforeEach(() => {
  world = gemsWorld();
  errorTables = new Set();
  reads = {};
  invalidateServeLogFlagCache();
  invalidateFlagsCache();
  invalidateDiscoveryEngineModeCache();
  _clearTestCompassCache();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 A13/A14 — GET /hidden-gems/layover-safe reads the CERTIFIED window", () => {
  it("in a live layover, the query figure cannot WIDEN the window", async () => {
    const certified = await certifiedMinutesForA();
    assert.ok(certified > 60 && certified < 100_000, `fixture: the certified window (${certified}) must sit between the two gems`);
    const r = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), [G_QUICK], "a gem whose minimum exceeds the certified window was served on the client's say-so");
    assert.ok(Math.abs(r.body.availableMinutes - certified) <= 1, `echoed ${r.body.availableMinutes}, certified ${certified}`);
    assert.equal(r.body.minutesSource, CERTIFIED_MINUTES_SOURCE);
    assert.match(String(r.body.snapshotId ?? ""), /.+/, "a certified serve names the snapshot it was certified against");
  });

  it("in a live layover, the query figure cannot NARROW it either, and is not required", async () => {
    const narrow = await get(`${SAFE}?availableMinutes=1&city=${CITY}`);
    const none = await get(`${SAFE}?city=${CITY}`);
    assert.equal(narrow.status, 200);
    assert.equal(none.status, 200, "a certified caller was refused for omitting a figure the server does not use");
    assert.deepEqual(gemIds(narrow.body), [G_QUICK]);
    assert.deepEqual(gemIds(none.body), [G_QUICK]);
  });

  it("NOT in a layover (anonymous): the stated hypothetical, and the body it always had", async () => {
    const r = await get(`${SAFE}?availableMinutes=90&city=${CITY}`, null);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), [G_QUICK]);
    assert.deepEqual(Object.keys(r.body).sort(), ["availableMinutes", "gems", "total"], "a stated serve grew a key");
    assert.equal(r.body.availableMinutes, 90);
  });

  it("NOT in a layover: a missing figure is still the client's 400", async () => {
    const r = await get(`${SAFE}?city=${CITY}`, B_TOKEN);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("CROSS-VIEWER: A's layover neither gates B nor lends B its window", async () => {
    const b = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`, B_TOKEN);
    assert.equal(b.status, 200);
    assert.deepEqual(gemIds(b.body), [G_HUGE, G_QUICK].sort(), "B (no layover) was filtered on A's certified window");
    assert.equal(b.body.minutesSource, undefined, "B was served as if certified");
    const a = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`, A_TOKEN);
    assert.deepEqual(gemIds(a.body), [G_QUICK], "B's request changed what A is served");
  });

  it("FAIL CLOSED: an unreadable layover_sessions withholds — never the query figure", async () => {
    errorTables = new Set(["layover_sessions"]);
    const r = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, LAYOVER_WINDOW_UNREADABLE_MESSAGE);
    assert.equal(r.body.gems, undefined, "a refusal shipped gems");
  });

  it("FAIL CLOSED: an unreadable airport_profiles withholds — no default-buffer window", async () => {
    errorTables = new Set(["airport_profiles"]);
    const r = await get(`${SAFE}?availableMinutes=90&city=${CITY}`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a certified window with no usable minutes is an EMPTY 200 — not 'no filter', not a 400", async () => {
    world.layover_sessions = [sessionFor(0.25)];
    const certified = await certifiedMinutesForA();
    assert.ok(certified < 1, `fixture: this session must certify no usable minutes (got ${certified})`);
    const r = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), []);
    assert.equal(r.body.minutesSource, CERTIFIED_MINUTES_SOURCE);
  });

  it("RETRY: the same certified request twice serves the same set", async () => {
    const one = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    const two = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.deepEqual(gemIds(one.body), gemIds(two.body));
    assert.ok(Math.abs(one.body.availableMinutes - two.body.availableMinutes) <= 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 A14 — REVOCATION: every request re-reads the certified window", () => {
  it("a window that SHRINKS between two requests withholds on the next one", async () => {
    world.layover_sessions = [sessionFor(9)];
    const wide = await certifiedMinutesForA();
    world.layover_sessions = [sessionFor(5)];
    const narrow = await certifiedMinutesForA();
    assert.ok(wide - narrow >= 60, `fixture: the two windows must be apart (${wide} vs ${narrow})`);
    world.hidden_gems.push(gemRow(G_MID, narrow + Math.floor((wide - narrow) / 2)));

    world.layover_sessions = [sessionFor(9)];
    const first = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(first.body), [G_MID, G_QUICK].sort(), "the wide window must admit the mid gem");

    world.layover_sessions = [sessionFor(5)];
    const second = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(second.body), [G_QUICK], "the first window was served again after it shrank");

    // …and back: the direction is not one-way.
    world.layover_sessions = [sessionFor(9)];
    const third = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(third.body), [G_MID, G_QUICK].sort(), "a widened window was not re-read");
  });

  it("a session that ENDS between two requests stops being Layover mode on the next one", async () => {
    const first = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.equal(first.body.minutesSource, CERTIFIED_MINUTES_SOURCE);
    world.layover_sessions[0].status = "completed";
    const second = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`);
    assert.equal(second.status, 200);
    assert.equal(second.body.minutesSource, undefined, "an ended layover was still certified");
    assert.deepEqual(gemIds(second.body), [G_HUGE, G_QUICK].sort(), "an ended layover is an answer, not a withholding");
  });

  it("a session read that FAILS between two requests withholds on the next one", async () => {
    const first = await get(`${SAFE}?city=${CITY}`);
    assert.equal(first.status, 200);
    errorTables = new Set(["layover_sessions"]);
    const second = await get(`${SAFE}?city=${CITY}`);
    assert.equal(second.status, 503, "a cached certification kept serving after the session became unreadable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 A14 — Layover mode ON: only the certified action universe", () => {
  it("a gem nobody has measured is withheld and NAMED, never quietly served", async () => {
    world = gemsWorld({ modeOn: true });
    const r = await get(`${SAFE}?city=${CITY}`);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), [], "an unmeasured gem reached a traveller in Layover mode");
    assert.equal(r.body.layover?.active, true);
    const excluded = new Map<string, any>(((r.body.layover?.excluded ?? []) as any[]).map((e) => [e.id, e]));
    assert.equal(excluded.get(G_QUICK)?.state, "UNMEASURED");
  });

  it("POSITIVE CONTROL: the traveller's own stated stop admits exactly that gem", async () => {
    world = gemsWorld({ modeOn: true, stops: [stopRow(G_QUICK, 20, 60)] });
    const r = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(r.body), [G_QUICK]);
  });

  it("DECERTIFIED between two requests (the traveller will stay airside): CLOSED on the next", async () => {
    world = gemsWorld({ modeOn: true, stops: [stopRow(G_QUICK, 20, 60)] });
    const first = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(first.body), [G_QUICK]);
    world.layover_sessions[0].wants_to_leave = false;
    const second = await get(`${SAFE}?city=${CITY}`);
    assert.equal(second.status, 200);
    assert.deepEqual(gemIds(second.body), [], "a decertified layover kept its admitted gem");
    const e = ((second.body.layover?.excluded ?? []) as any[]).find((x) => x.id === G_QUICK);
    assert.equal(e?.state, "CLOSED");
    assert.equal(second.body.layover?.landsideOpen, false);
  });

  it("an unreadable plan-stop read refuses — it is not an empty universe", async () => {
    world = gemsWorld({ modeOn: true, stops: [stopRow(G_QUICK, 20, 60)] });
    errorTables = new Set(["layover_plan_stops"]);
    const r = await get(`${SAFE}?city=${CITY}`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.gems, undefined);
  });

  it("ONE certification per request: the gate is handed the window's snapshot, not a second read", async () => {
    world = gemsWorld({ modeOn: true, stops: [stopRow(G_QUICK, 20, 60)] });
    reads = {};
    const r = await get(`${SAFE}?city=${CITY}`);
    assert.deepEqual(gemIds(r.body), [G_QUICK]);
    assert.equal(reads.layover_sessions, 1, `layover_sessions was read ${reads.layover_sessions} times for one request`);
  });

  it("mode ON does nothing to a caller in no layover", async () => {
    world = gemsWorld({ modeOn: true });
    const r = await get(`${SAFE}?availableMinutes=999999&city=${CITY}`, B_TOKEN);
    assert.deepEqual(gemIds(r.body), [G_HUGE, G_QUICK].sort());
    assert.equal(r.body.layover, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("§56 A14 — GET /hidden-gems?layoverSafe=1 takes its minutes from the same place", () => {
  const LIST = `/api/hidden-gems?layoverSafe=1&city=${CITY}`;

  it("certified: the query figure cannot widen the window", async () => {
    const r = await get(`${LIST}&availableMinutes=999999`);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), [G_QUICK]);
    assert.equal(r.body.minutesSource, CERTIFIED_MINUTES_SOURCE);
  });

  it("not in a layover: the stated hypothetical, unchanged", async () => {
    const r = await get(`${LIST}&availableMinutes=90`, null);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), [G_QUICK]);
    assert.equal(r.body.minutesSource, undefined);
  });

  it("FAIL CLOSED: an unreadable layover_sessions withholds", async () => {
    errorTables = new Set(["layover_sessions"]);
    const r = await get(`${LIST}&availableMinutes=999999`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a certified window with no usable minutes admits nothing — never 'no filter'", async () => {
    world.layover_sessions = [sessionFor(0.25)];
    const r = await get(`${LIST}&availableMinutes=999999`);
    assert.equal(r.status, 200);
    assert.deepEqual(gemIds(r.body), []);
  });

  it("without layoverSafe=1 nothing about a layover is read or applied", async () => {
    errorTables = new Set(["layover_sessions"]);
    const r = await get(`/api/hidden-gems?city=${CITY}`);
    assert.equal(r.status, 200, "an ordinary gem list depended on the layover read");
    assert.deepEqual(gemIds(r.body), [G_HUGE, G_QUICK, G_UNSAFE].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /discovery/community — the gate §37/§38 built, asked TWICE.
function placeRow(id: string) {
  return {
    id, city: CITY, name: id, place_type: "traveler_pick", category: "food",
    neighborhood: null, blurb: null, image_url: null, submitted_by: null,
    saved_count: 0, tag: null, note: null, rating: null, source: "traveler",
    status: "active", verified: false, created_at: "2026-09-01T00:00:00.000Z",
    lat: 25.08, lng: 121.235, profiles: null,
  };
}
const P_FITS = "cafe0000-0000-4000-8000-000000000001";
const P_OTHER = "cafe0000-0000-4000-8000-000000000002";
const COMMUNITY = `/api/discovery/community?city=${encodeURIComponent(CITY)}`;
const itemIds = (body: any) => ((body?.items ?? []) as any[]).map((i) => i.id).sort();

describe("§56 A14 — GET /discovery/community: revocation and cross-viewer", () => {
  function communityWorld(): World {
    return {
      feature_flags: [{ flag: LAYOVER_DISCOVERY_MODE_FLAG, enabled: true }],
      discovery_places: [placeRow(P_FITS), placeRow(P_OTHER)],
      layover_sessions: [sessionFor(9)],
      airport_profiles: [airportRow()],
      layover_plan_stops: [stopRow(P_FITS, 20, 60)],
    };
  }

  it("the admitted place is withheld on the NEXT request once the window no longer fits it", async () => {
    world = communityWorld();
    const first = await get(COMMUNITY);
    assert.deepEqual(itemIds(first.body), [P_FITS]);
    world.layover_sessions = [sessionFor(2)];
    const second = await get(COMMUNITY);
    assert.equal(second.status, 200);
    assert.deepEqual(itemIds(second.body), [], "the first certification kept serving after the window shrank");
    const e = ((second.body.layover?.excluded ?? []) as any[]).find((x) => x.id === P_FITS);
    assert.ok(e && (e.state === "BLOCKED" || e.state === "CLOSED"), `withheld with ${JSON.stringify(e)}`);
  });

  it("RETRY: the same request twice serves the same set", async () => {
    world = communityWorld();
    const one = await get(COMMUNITY);
    const two = await get(COMMUNITY);
    assert.deepEqual(itemIds(one.body), itemIds(two.body));
    assert.deepEqual(itemIds(one.body), [P_FITS]);
  });

  it("GET /discovery on a CACHE-A hit: the cached page is re-gated against the NEW window", async () => {
    const DB_FITS = "d0000000-0000-4000-8000-000000000001";
    const CACHE_KEY = "taoyuan:food:10";
    const place = (uuid: string): DiscoveryPlace => ({
      id: `db/${uuid}`, name: uuid, category: "food", type: "traveler_pick",
      description: null, distanceKm: 1, lat: 25.08, lng: 121.235, tags: [],
      address: CITY, website: null, phone: null, openingHours: null,
      rating: null, isOpenNow: null, savedCount: 0,
    } as DiscoveryPlace);
    world = { ...communityWorld(), layover_plan_stops: [stopRow(DB_FITS, 20, 60)] };
    const url = `/api/discovery?destination=${encodeURIComponent(CITY)}&lat=25.08&lng=121.235&radiusKm=10&category=food`;
    try {
      _setTestDbPlacesOverride(async () => [place(DB_FITS)]);
      _injectTestCacheEntry(CACHE_KEY, []);
      const first = await get(url);
      assert.equal(first.body?.cached, true, "fixture: the first request must be a cache-A hit");
      assert.deepEqual(((first.body?.places ?? []) as any[]).map((p) => p.id), [`db/${DB_FITS}`]);
      world.layover_sessions = [sessionFor(2)];
      _injectTestCacheEntry(CACHE_KEY, []);
      const second = await get(url);
      assert.equal(second.body?.cached, true, "fixture: the second request must be a cache-A hit too");
      assert.deepEqual(((second.body?.places ?? []) as any[]).map((p) => p.id), [], "a cached page outlived the certification it was gated on");
    } finally {
      _setTestDbPlacesOverride(null);
      _clearTestCacheEntry(CACHE_KEY);
    }
  });

  it("CROSS-VIEWER: A's layover does not gate B", async () => {
    world = communityWorld();
    const b = await get(COMMUNITY, B_TOKEN);
    assert.equal(b.status, 200);
    assert.deepEqual(itemIds(b.body), [P_FITS, P_OTHER].sort());
    assert.equal(b.body.layover, undefined);
  });
});
