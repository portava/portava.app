/**
 * Neighborhood Match v1 tests
 *
 * Covers:
 * - lib: fetchCityAreas OSM path (mapping + name dedupe) and grid fallback (<3 areas)
 * - lib: computeAreas normalization (max area = 100), quiet inversion,
 *        assignment distance cap, sample_size + confidence
 * - lib: rankAreas — sleepVsPlay 'away' prefers the quiet area, factor
 *        contributions, low-confidence caveat
 * - routes: GET /cities/neighborhoods (flag gate, cache serve, no_data)
 *           PUT /trips/:tripId/area-preferences (membership, merge upsert)
 *           POST /trips/:tripId/neighborhood-match (flag + membership gates,
 *             missing coords, ranked output, compassPick, disclaimer,
 *             fetch failure → 200 { areas: [], reason: 'no_data' })
 *           POST /trips/:tripId/location-check (good_fit / moderate /
 *             consider_alternatives / insufficient_data, membership gate)
 *
 * No real network: Overpass is stubbed via _setTestFetch.
 *
 * Run: node --import tsx/esm --test src/test/neighborhoodMatch.test.ts
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import {
  fetchCityAreas,
  fetchCityPois,
  computeAreas,
  rankAreas,
  centerOfGravity,
  _setTestFetch,
  type AreaSeed,
  type CityPoi,
  type ComputedArea,
} from "../lib/neighborhoodMatch.js";

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------
const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const CITY = "Paris";
const CITY_LAT = 48.85;
const CITY_LNG = 2.35;

// ---------------------------------------------------------------------------
// Fake Supabase client (imitates tripsExpansion.test.ts)
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    trips:                 tables.trips                 ?? { rows: [] },
    trip_members:          tables.trip_members          ?? { rows: [] },
    feature_flags:         tables.feature_flags         ?? { rows: [{ flag: "stamp_system_v2_enabled", enabled: true }] },
    neighborhood_areas:    tables.neighborhood_areas    ?? { rows: [] },
    trip_area_preferences: tables.trip_area_preferences ?? { rows: [] },
    trip_saved_places:     tables.trip_saved_places     ?? { rows: [] },
    trip_plan_items:       tables.trip_plan_items       ?? { rows: [] },
    profiles:              tables.profiles              ?? { rows: [] },
    blocks:                tables.blocks                ?? { rows: [] },
    ...tables,
  };

  let idCtr = 0;
  function newId() {
    const n = String(++idCtr).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _upsert: { data: Row | Row[]; opts?: any } | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select() { return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      upsert(data: Row | Row[], opts?: any) { _upsert = { data, opts }; return obj; },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      is(col: string, val: any)  { filters.push((r) => r[col] == val); return obj; },
      or() { return obj; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return obj; },
      limit(n: number) { _limitN = n; return obj; },
      order(col: string, opts?: any) { _orderCol = col; _orderAsc = opts?.ascending !== false; return obj; },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        const table = getTable();

        if (_insert !== null && !_upsert) {
          if (table.nextInsertError) {
            const err = table.nextInsertError;
            table.nextInsertError = undefined;
            return { data: null, error: { message: err } };
          }
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
          table.rows.push(...inserted);
          const result = _single || _maybeSingle ? inserted[0] ?? null : inserted;
          return { data: result, error: null };
        }

        if (_upsert !== null) {
          const rows = Array.isArray(_upsert.data) ? _upsert.data : [_upsert.data];
          const onConflict = _upsert.opts?.onConflict as string | undefined;
          const upserted = rows.map((newRow) => {
            if (onConflict) {
              const keys = onConflict.split(",").map((k) => k.trim());
              const idx = table.rows.findIndex((r) => keys.every((k) => r[k] === (newRow as any)[k]));
              if (idx >= 0) {
                table.rows[idx] = { ...table.rows[idx], ...newRow };
                return table.rows[idx];
              }
            }
            const ins = { id: newId(), created_at: new Date().toISOString(), ...newRow };
            table.rows.push(ins);
            return ins;
          });
          const result = _single || _maybeSingle ? upserted[0] ?? null : upserted;
          return { data: result, error: null };
        }

        if (_delete) {
          table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }

        if (_update !== null) {
          const matched: Row[] = [];
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              const updated = { ...r, ..._update };
              matched.push({ ...updated });
              return updated;
            }
            return r;
          });
          if (_single || _maybeSingle) return { data: matched[0] ?? null, error: null };
          return { data: matched, error: null };
        }

        let rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_orderCol) {
          const col = _orderCol;
          rows = [...rows].sort((a, b) =>
            _orderAsc
              ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
              : String(b[col] ?? "").localeCompare(String(a[col] ?? "")),
          );
        }
        if (_limitN !== null) rows = rows.slice(0, _limitN);
        if (_single || _maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")  return { data: { user: { id: OWNER_ID } },  error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "other-token")  return { data: { user: { id: OTHER_ID } },  error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (tableName: string) => chain(tableName),
  };

  return { client, db };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function flagOn()  { return { rows: [{ flag: "neighborhood_match_enabled", enabled: true }, { flag: "stamp_system_v2_enabled", enabled: true }] }; }
function flagOff() { return { rows: [{ flag: "neighborhood_match_enabled", enabled: false }, { flag: "stamp_system_v2_enabled", enabled: true }] }; }

function baseTrip(overrides: Row = {}): Row {
  return {
    id: TRIP_ID, owner_id: OWNER_ID, title: "Paris trip",
    destination_city: CITY, destination_country: "France",
    destination_lat: CITY_LAT, destination_lng: CITY_LNG,
    status: "upcoming", created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function memberships() {
  return { rows: [
    { trip_id: TRIP_ID, user_id: OWNER_ID,  role: "owner",  status: "accepted" },
    { trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
  ]};
}

// Overpass element fixtures. Pigalle = nightlife hub; Passy = few POIs (quiet);
// Le Marais = zero POIs. A duplicate "Pigalle" node exercises name dedupe.
const AREA_ELEMENTS = [
  { type: "node", id: 1, lat: 48.882, lon: 2.337, tags: { place: "quarter",       name: "Pigalle" } },
  { type: "node", id: 2, lat: 48.857, lon: 2.279, tags: { place: "suburb",        name: "Passy" } },
  { type: "node", id: 3, lat: 48.859, lon: 2.362, tags: { place: "neighbourhood", name: "Le Marais" } },
  { type: "node", id: 4, lat: 48.8821, lon: 2.3371, tags: { place: "quarter",     name: "Pigalle" } },
];

const POI_ELEMENTS = [
  // Pigalle: 5 nightlife + 2 food
  { type: "node", id: 10, lat: 48.882, lon: 2.337, tags: { amenity: "bar" } },
  { type: "node", id: 11, lat: 48.882, lon: 2.337, tags: { amenity: "pub" } },
  { type: "node", id: 12, lat: 48.882, lon: 2.337, tags: { amenity: "nightclub" } },
  { type: "node", id: 13, lat: 48.882, lon: 2.337, tags: { amenity: "bar" } },
  { type: "node", id: 14, lat: 48.882, lon: 2.337, tags: { amenity: "pub" } },
  { type: "node", id: 15, lat: 48.882, lon: 2.337, tags: { amenity: "restaurant" } },
  { type: "node", id: 16, lat: 48.882, lon: 2.337, tags: { amenity: "cafe" } },
  // Passy: 1 food
  { type: "node", id: 17, lat: 48.857, lon: 2.279, tags: { amenity: "cafe" } },
  // Untracked amenity — must be ignored
  { type: "node", id: 18, lat: 48.882, lon: 2.337, tags: { amenity: "bench" } },
];

/** Stub both Overpass calls: place query → areas, everything else → POIs. */
function stubOverpass(
  areas: any[] = AREA_ELEMENTS,
  pois: any[] = POI_ELEMENTS,
): { calls: string[] } {
  const calls: string[] = [];
  _setTestFetch(async (url: any) => {
    const decoded = decodeURIComponent(String(url));
    calls.push(decoded);
    const elements = decoded.includes('"place"') ? areas : pois;
    return { ok: true, json: async () => ({ elements }) };
  });
  return { calls };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  const ct = res.headers.get("content-type") ?? "";
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); }
  catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Lib unit tests
// ---------------------------------------------------------------------------
describe("neighborhoodMatch lib", () => {
  afterEach(() => { _setTestFetch(null); });

  it("fetchCityAreas maps OSM place nodes and dedupes by name", async () => {
    stubOverpass();
    const areas = await fetchCityAreas(CITY, CITY_LAT, CITY_LNG);
    assert.equal(areas.length, 3);
    assert.deepEqual(areas.map((a) => a.name).sort(), ["Le Marais", "Passy", "Pigalle"]);
    assert.ok(areas.every((a) => a.source === "osm"));
    const pigalle = areas.find((a) => a.name === "Pigalle")!;
    assert.equal(pigalle.lat, 48.882);
    assert.equal(pigalle.lng, 2.337);
  });

  it("fetchCityAreas falls back to a labelled 3x3 grid when OSM has <3 areas", async () => {
    stubOverpass(AREA_ELEMENTS.slice(0, 2)); // Pigalle + Passy only
    const areas = await fetchCityAreas(CITY, CITY_LAT, CITY_LNG);
    assert.equal(areas.length, 9);
    assert.ok(areas.every((a) => a.source === "grid"));
    const names = areas.map((a) => a.name);
    assert.ok(names.includes("City center"));
    assert.ok(names.includes("Northwest area"));
    const center = areas.find((a) => a.name === "City center")!;
    assert.equal(center.lat, CITY_LAT);
    assert.equal(center.lng, CITY_LNG);
  });

  it("fetchCityPois maps amenity/tourism/shop tags to categories and skips untracked tags", async () => {
    stubOverpass(AREA_ELEMENTS, [
      ...POI_ELEMENTS,
      { type: "node", id: 20, lat: 48.86, lon: 2.34, tags: { tourism: "museum" } },
      { type: "node", id: 21, lat: 48.86, lon: 2.34, tags: { shop: "clothes" } },
    ]);
    const pois = await fetchCityPois(CITY_LAT, CITY_LNG);
    assert.equal(pois.length, 10); // 8 tracked fixtures + museum + shop; bench dropped
    assert.equal(pois.filter((p) => p.kind === "nightlife").length, 5);
    assert.equal(pois.filter((p) => p.kind === "food").length, 3);
    assert.equal(pois.filter((p) => p.kind === "culture").length, 1);
    assert.equal(pois.filter((p) => p.kind === "shopping").length, 1);
  });

  it("computeAreas normalizes to 0-100 (max area = 100), inverts quiet, caps assignment distance", () => {
    const seeds: AreaSeed[] = [
      { name: "A", lat: 0,    lng: 0, source: "osm" },
      { name: "B", lat: 0.05, lng: 0, source: "osm" }, // ~5.6 km apart
    ];
    const pois: CityPoi[] = [
      { lat: 0, lng: 0, kind: "nightlife" },
      { lat: 0, lng: 0, kind: "nightlife" },
      { lat: 0, lng: 0, kind: "nightlife" },
      { lat: 0, lng: 0, kind: "nightlife" },
      { lat: 0.05, lng: 0, kind: "nightlife" },
      { lat: 0.05, lng: 0, kind: "nightlife" },
      { lat: 0.05, lng: 0, kind: "food" },
      // ~2.2 km from A, ~3.3 km from B → beyond the 1800 m cap → dropped
      { lat: 0.02, lng: 0, kind: "food" },
    ];

    const out = computeAreas(seeds, pois);
    const a = out.find((x) => x.name === "A")!;
    const b = out.find((x) => x.name === "B")!;

    // Normalization: densest area per category = 100
    assert.equal(a.category_scores.nightlife, 100);
    assert.equal(b.category_scores.nightlife, 50);
    assert.equal(b.category_scores.food, 100);
    assert.equal(a.category_scores.food, 0);
    // All-zero category stays 0 everywhere
    assert.equal(a.category_scores.shopping, 0);
    assert.equal(b.category_scores.shopping, 0);
    // Quiet inversion: A is densest (4 of max 4) → quiet 0; B (3/4=75%) → 25
    assert.equal(a.category_scores.quiet, 0);
    assert.equal(b.category_scores.quiet, 25);
    // Distance cap: the stray POI was not assigned anywhere
    assert.equal(a.sample_size, 4);
    assert.equal(b.sample_size, 3);
    assert.equal(a.confidence, "low");
    // Day/night derivation
    assert.deepEqual(a.day_night, { night: "lively", day: "moderate" });
    assert.deepEqual(b.day_night, { day: "lively", night: "quieter" }); // food 100 dominant
  });

  it("rankAreas: sleepVsPlay 'away' prefers the quiet area, 'inside' the lively one; factors + caveat exposed", () => {
    const party: ComputedArea = {
      name: "Party", center_lat: 0, center_lng: 0, radius_m: 1200, source: "osm",
      category_scores: { nightlife: 100, food: 50, culture: 50, shopping: 50, quiet: 0 },
      poi_counts: { nightlife: 40, food: 10, culture: 5, shopping: 5 },
      day_night: { night: "lively", day: "moderate" },
      sample_size: 60, confidence: "medium",
    };
    const calm: ComputedArea = {
      name: "Calm", center_lat: 0.05, center_lng: 0, radius_m: 1200, source: "osm",
      category_scores: { nightlife: 0, food: 50, culture: 50, shopping: 50, quiet: 100 },
      poi_counts: { nightlife: 0, food: 5, culture: 3, shopping: 2 },
      day_night: { day: "moderate", night: "moderate" },
      sample_size: 10, confidence: "low",
    };

    const away = rankAreas([party, calm], { sleepVsPlay: "away" });
    assert.equal(away[0].name, "Calm");
    assert.ok(away[0].matchScore > away[1].matchScore);

    const inside = rankAreas([party, calm], { sleepVsPlay: "inside" });
    assert.equal(inside[0].name, "Party");

    // Factors are explainable: top factor of Calm under 'away' is quiet, with a
    // human label and a numeric contribution.
    const calmRanked = away[0];
    assert.ok(calmRanked.factors.length > 0);
    assert.equal(calmRanked.factors[0].key, "quiet");
    assert.match(calmRanked.factors[0].label, /quiet surroundings \(100\/100\)/);
    assert.ok(calmRanked.factors[0].contribution > 0);
    // Low-confidence caveat
    assert.equal(calmRanked.caveat, "Limited data for this area");
    const partyRanked = away[1];
    assert.equal(partyRanked.caveat, undefined); // medium confidence → no caveat
    // Honesty fields always present
    assert.equal(calmRanked.sampleSize, 10);
    assert.equal(calmRanked.confidence, "low");
  });

  it("centerOfGravity returns mean point + top area shares", () => {
    const areas: ComputedArea[] = [
      { name: "A", center_lat: 0, center_lng: 0, radius_m: 1200, source: "osm",
        category_scores: {}, poi_counts: {}, day_night: { day: "moderate", night: "moderate" },
        sample_size: 0, confidence: "low" },
      { name: "B", center_lat: 0.1, center_lng: 0, radius_m: 1200, source: "osm",
        category_scores: {}, poi_counts: {}, day_night: { day: "moderate", night: "moderate" },
        sample_size: 0, confidence: "low" },
    ];
    const cog = centerOfGravity(
      [{ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }, { lat: 0.1, lng: 0 }, { lat: 0.01, lng: 0 }],
      areas,
    )!;
    assert.ok(Math.abs(cog.lat - 0.03) < 1e-9);
    assert.equal(cog.lng, 0);
    assert.equal(cog.shares[0].areaName, "A");
    assert.equal(cog.shares[0].pct, 75);
    assert.equal(cog.shares[1].areaName, "B");
    assert.equal(cog.shares[1].pct, 25);
    assert.equal(centerOfGravity([], areas), null);
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------
describe("neighborhoods routes", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  afterEach(() => { _setTestFetch(null); });

  after(async () => {
    if (server) server.close();
  });

  // ── GET /cities/neighborhoods ──────────────────────────────────────────────
  describe("GET /cities/neighborhoods", () => {
    it("returns 404 feature_disabled when the flag is off", async () => {
      stubOverpass();
      const { client } = makeFakeClient({ feature_flags: flagOff() });
      _setTestClient(client, true);
      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}&lat=${CITY_LAT}&lng=${CITY_LNG}`, { token: "owner-token" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
    });

    it("returns 401 without auth", async () => {
      const { client } = makeFakeClient({ feature_flags: flagOn() });
      _setTestClient(client, true);
      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}&lat=1&lng=2`, {});
      assert.equal(r.status, 401);
    });

    it("returns 400 when lat/lng are missing", async () => {
      const { client } = makeFakeClient({ feature_flags: flagOn() });
      _setTestClient(client, true);
      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}`, { token: "owner-token" });
      assert.equal(r.status, 400);
    });

    it("computes, stores and returns areas from stubbed Overpass data", async () => {
      stubOverpass();
      const { client, db } = makeFakeClient({ feature_flags: flagOn() });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}&lat=${CITY_LAT}&lng=${CITY_LNG}`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.areas.length, 3);
      assert.ok(r.body.disclaimer.includes("OpenStreetMap"));

      const pigalle = r.body.areas.find((a: any) => a.name === "Pigalle");
      assert.equal(pigalle.categoryScores.nightlife, 100);
      assert.equal(pigalle.poiCounts.nightlife, 5);
      assert.equal(pigalle.sampleSize, 7);
      assert.equal(pigalle.confidence, "low");
      assert.equal(pigalle.source, "osm");
      // Persisted for reuse (upserted by city_name + name)
      assert.equal(db.neighborhood_areas.rows.length, 3);
    });

    it("serves fresh cached rows without calling Overpass", async () => {
      _setTestFetch(async () => { throw new Error("network must not be called"); });
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        neighborhood_areas: { rows: [
          { id: "x", city_name: CITY, country: "France", name: "Cached Area",
            center_lat: CITY_LAT, center_lng: CITY_LNG, radius_m: 1200, source: "osm",
            category_scores: { nightlife: 40, food: 60, culture: 20, shopping: 10, quiet: 50 },
            poi_counts: { nightlife: 4, food: 6, culture: 2, shopping: 1 },
            day_night: { day: "moderate", night: "moderate" },
            sample_size: 13, confidence: "low",
            computed_at: new Date().toISOString() },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}&lat=${CITY_LAT}&lng=${CITY_LNG}`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.areas.length, 1);
      assert.equal(r.body.areas[0].name, "Cached Area");
    });

    it("degrades to { areas: [], reason: 'no_data' } when Overpass fails and nothing is stored", async () => {
      _setTestFetch(async () => { throw new Error("overpass down"); });
      const { client } = makeFakeClient({ feature_flags: flagOn() });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/cities/neighborhoods?city=${CITY}&lat=${CITY_LAT}&lng=${CITY_LNG}`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.areas, []);
      assert.equal(r.body.reason, "no_data");
      assert.ok(typeof r.body.message === "string" && r.body.message.length > 0);
    });
  });

  // ── PUT /trips/:tripId/area-preferences ────────────────────────────────────
  describe("PUT /trips/:tripId/area-preferences", () => {
    it("upserts the caller's own preferences row", async () => {
      const { client, db } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);

      const r = await req(port, "PUT", `/trips/${TRIP_ID}/area-preferences`, {
        token: "member-token",
        body: { sleepVsPlay: "away", priorities: { nightlife: 0.9, quiet: 1 } },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.sleepVsPlay, "away");
      assert.equal(r.body.priorities.nightlife, 0.9);

      const row = db.trip_area_preferences.rows.find(
        (p) => p.trip_id === TRIP_ID && p.user_id === MEMBER_ID,
      );
      assert.ok(row, "preferences row should exist");
      assert.equal(row!.sleep_vs_play, "away");

      // Partial update keeps the untouched field (merge, not clobber)
      const r2 = await req(port, "PUT", `/trips/${TRIP_ID}/area-preferences`, {
        token: "member-token",
        body: { priorities: { quiet: 1 } },
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.sleepVsPlay, "away");
      assert.equal(r2.body.priorities.nightlife, undefined);
      assert.equal(db.trip_area_preferences.rows.length, 1, "still a single row per (trip,user)");
    });

    it("rejects non-members with 403", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "PUT", `/trips/${TRIP_ID}/area-preferences`, {
        token: "other-token",
        body: { sleepVsPlay: "close" },
      });
      assert.equal(r.status, 403);
    });

    it("rejects invalid sleepVsPlay with 400", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "PUT", `/trips/${TRIP_ID}/area-preferences`, {
        token: "member-token",
        body: { sleepVsPlay: "underwater" },
      });
      assert.equal(r.status, 400);
    });
  });

  // ── POST /trips/:tripId/neighborhood-match ─────────────────────────────────
  describe("POST /trips/:tripId/neighborhood-match", () => {
    it("returns 404 feature_disabled when the flag is off", async () => {
      const { client } = makeFakeClient({
        feature_flags: flagOff(),
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "owner-token" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
    });

    it("returns 403 for non-members", async () => {
      stubOverpass();
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "other-token" });
      assert.equal(r.status, 403);
    });

    it("returns 400 trip_missing_destination_coords when the trip has no coords", async () => {
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        trips: { rows: [baseTrip({ destination_lat: null, destination_lng: null })] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "owner-token" });
      assert.equal(r.status, 400);
      assert.equal(r.body.message, "trip_missing_destination_coords");
    });

    it("ranks areas with defaults, exposes factors/caveats/compassPick/disclaimer", async () => {
      stubOverpass();
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "member-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.areas.length, 3);
      // Default (no prefs): the nightlife+food hub wins
      assert.equal(r.body.areas[0].name, "Pigalle");
      assert.ok(r.body.areas[0].matchScore >= r.body.areas[1].matchScore);
      // Explainability + honesty
      assert.ok(r.body.areas[0].factors.length > 0);
      assert.ok(r.body.areas[0].factors[0].label.includes("/100"));
      assert.ok(typeof r.body.areas[0].factors[0].contribution === "number");
      assert.equal(r.body.areas[0].confidence, "low"); // tiny sample in fixture
      assert.equal(r.body.areas[0].caveat, "Limited data for this area");
      assert.equal(typeof r.body.areas[0].sampleSize, "number");
      // Compass pick built from the top area's factors
      assert.equal(r.body.compassPick.name, "Pigalle");
      assert.ok(r.body.compassPick.why.includes("Pigalle"));
      assert.ok(r.body.compassPick.why.toLowerCase().includes("nightlife"));
      assert.equal(
        r.body.disclaimer,
        "Scores derived from OpenStreetMap data density — verify neighborhoods before booking.",
      );
    });

    it("sleepVsPlay 'away' preference flips the ranking to the quiet area", async () => {
      stubOverpass();
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_area_preferences: { rows: [
          { trip_id: TRIP_ID, user_id: MEMBER_ID, sleep_vs_play: "away", priorities: {} },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "member-token" });
      assert.equal(r.status, 200);
      // Passy has almost no POIs → high quiet score → wins under 'away'
      assert.equal(r.body.areas[0].name, "Passy");
      assert.equal(r.body.compassPick.name, "Passy");
      const pigalle = r.body.areas.find((a: any) => a.name === "Pigalle");
      assert.ok(r.body.areas[0].matchScore > pigalle.matchScore);
    });

    it("returns 200 { areas: [], reason: 'no_data' } when Overpass fails", async () => {
      _setTestFetch(async () => { throw new Error("overpass down"); });
      const { client } = makeFakeClient({
        feature_flags: flagOn(),
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/neighborhood-match`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.areas, []);
      assert.equal(r.body.reason, "no_data");
      assert.equal(r.body.compassPick, undefined, "no fabricated pick without data");
    });
  });

  // ── POST /trips/:tripId/location-check ─────────────────────────────────────
  describe("POST /trips/:tripId/location-check", () => {
    function savedPlaces() {
      // Three located places clustered near the city centre
      return { rows: [
        { trip_id: TRIP_ID, user_id: OWNER_ID, place_name: "Louvre",     lat: 48.861, lng: 2.336 },
        { trip_id: TRIP_ID, user_id: OWNER_ID, place_name: "Notre-Dame", lat: 48.853, lng: 2.350 },
        { trip_id: TRIP_ID, user_id: MEMBER_ID, place_name: "Panthéon",  lat: 48.846, lng: 2.346 },
      ]};
    }

    it("returns good_fit for a location at the cluster's center of gravity", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_saved_places: savedPlaces(),
        neighborhood_areas: { rows: [
          { id: "n1", city_name: CITY, name: "Saint-Germain", center_lat: 48.853, center_lng: 2.344,
            radius_m: 1200, source: "osm",
            category_scores: { nightlife: 30, food: 80, culture: 90, shopping: 40, quiet: 40 },
            poi_counts: { nightlife: 3, food: 8, culture: 9, shopping: 4 },
            day_night: { day: "lively", night: "quieter" },
            sample_size: 24, confidence: "low", computed_at: new Date().toISOString() },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "member-token",
        body: { lat: 48.853, lng: 2.344, name: "Hotel Candidate" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.name, "Hotel Candidate");
      assert.equal(r.body.verdict, "good_fit");
      assert.ok(r.body.distanceToCenterOfGravityKm <= 2.5);
      assert.equal(r.body.nearestSavedPlaces.length, 3);
      assert.ok(r.body.nearestSavedPlaces[0].km <= r.body.nearestSavedPlaces[1].km);
      // Falls inside the stored area → areaFit with a personalised score
      assert.equal(r.body.areaFit.areaName, "Saint-Germain");
      assert.equal(typeof r.body.areaFit.matchScore, "number");
      assert.ok(typeof r.body.thresholdNote === "string" && r.body.thresholdNote.includes("2.5"));
    });

    it("returns consider_alternatives when >6km from the center of gravity", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_saved_places: savedPlaces(),
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "member-token",
        body: { lat: 48.95, lng: 2.344 }, // ~10.7 km north of the cluster
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.verdict, "consider_alternatives");
      assert.ok(r.body.distanceToCenterOfGravityKm > 6);
      assert.equal(r.body.areaFit, null, "no stored areas → no areaFit claim");
    });

    it("returns moderate between the thresholds", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_saved_places: savedPlaces(),
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "member-token",
        body: { lat: 48.888, lng: 2.344 }, // ~3.8 km from the cluster CoG
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.verdict, "moderate");
    });

    it("returns insufficient_data with fewer than 3 located points", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_saved_places: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, place_name: "Louvre", lat: 48.861, lng: 2.336 },
          { trip_id: TRIP_ID, user_id: OWNER_ID, place_name: "No coords", lat: null, lng: null },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "owner-token",
        body: { lat: 48.853, lng: 2.344 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.verdict, "insufficient_data");
      assert.equal(r.body.locatedPoints, 1);
      // Unlocated saved place is excluded from nearest list too
      assert.equal(r.body.nearestSavedPlaces.length, 1);
    });

    it("counts located trip_plan_items toward the center of gravity", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
        trip_saved_places: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, place_name: "Louvre", lat: 48.861, lng: 2.336 },
        ]},
        trip_plan_items: { rows: [
          { id: "p1", trip_id: TRIP_ID, title: "Dinner", lat: 48.853, lng: 2.350, removed_at: null },
          { id: "p2", trip_id: TRIP_ID, title: "Walk",   lat: 48.846, lng: 2.346, removed_at: null },
          { id: "p3", trip_id: TRIP_ID, title: "Gone",   lat: 48.900, lng: 2.400, removed_at: "2026-01-02T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "owner-token",
        body: { lat: 48.853, lng: 2.344 },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.locatedPoints, 3); // 1 saved place + 2 live plan items
      assert.equal(r.body.verdict, "good_fit");
    });

    it("rejects non-members with 403 and unknown trips with 404", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);

      const forbidden = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "other-token",
        body: { lat: 48.85, lng: 2.35 },
      });
      assert.equal(forbidden.status, 403);

      const missing = await req(port, "POST", `/trips/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/location-check`, {
        token: "owner-token",
        body: { lat: 48.85, lng: 2.35 },
      });
      assert.equal(missing.status, 404);
    });

    it("rejects invalid coordinates with 400", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [baseTrip()] },
        trip_members: memberships(),
      });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/location-check`, {
        token: "owner-token",
        body: { lat: 123, lng: 2.35 },
      });
      assert.equal(r.status, 400);
    });
  });
});
