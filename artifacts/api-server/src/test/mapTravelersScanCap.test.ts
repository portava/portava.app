/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-129): the Discovery map's travelers layer never
 * answers a CUT scan as a complete or empty layer.
 *
 * lib/mapTravelers.ts scanned `user_location_state` with `.limit(250)` and no order, applied eligibility after the
 * cut and sliced the answer to 100, with no marker on either cut. With 260 non-sharers ahead of one sharer, GET
 * /map/travelers answered `200 { travelers: [] }`, the NOW gateway named `travelers` as read over no objects, and
 * /map/search stated the traveler source complete.
 *
 *   V15-TS0  CONTROL (the round-15 verifier's): 20 non-sharers and one sharer — the sharer is served, no marker
 *   V15-TS1  (the verifier's) GET /map/travelers over a scan cut at 250 → never an unmarked empty layer
 *   V15-TS2  (the verifier's) the NOW gateway over the same cut scan → `travelers` is not named as read
 *   TS3      GET /map/search over the same cut scan → the traveler source is not complete (`travelers_capped`)
 *   TS4      the scan is ordered freshest-first: the freshest sharer behind 300 older non-sharers is served
 *   TS5      the 100-row answer slice is marked: 101 eligible sharers → 100 served, `truncated: true`
 *   TS6      the boundary: exactly 250 rows in the viewport is a whole read — no marker
 *   TS7      a cut scan stays cut while it is cached: a second request for the same viewport is still marked
 *   TS8      the row read past the cap only detects the cut: the privacy reads ask for 250 ids, never 251
 *   TSc      CONTROL: a healthy uncut read keeps the body's keys (`travelers`, `generatedAt`) and names `travelers`
 *
 * The fake honours `.order(col, { ascending })` and `.limit(n)`, as PostgREST does; the repo's
 * mapFailureVsEmptiness fake ignores both, which is why it could not see this.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import mapTravelersRouter from "../routes/mapTravelers.js";
import mapSearchRouter from "../routes/mapSearch.js";
import { _clearMapTravelersCache } from "../lib/mapTravelers.js";

const TOKEN = "r16-travelers-cap-token";
const USER = "viewer-user-id";
const SHARER = "sharer-user-id";
const POS = { lat: 16.06, lng: 108.21 };
const BBOX = "108.0,15.9,108.4,16.2";

const inSizes: Record<string, number[]> = {};
function buildQuery(rowsIn: any[], table = "") {
  let rows = [...rowsIn];
  let cap: number | null = null;
  const out = () => (cap == null ? rows : rows.slice(0, cap));
  const q: any = {
    select() { return q; }, range() { return q; }, or() { return q; }, ilike() { return q; },
    contains() { return q; }, gt() { return q; }, lt() { return q; }, is() { return q; }, not() { return q; },
    order(c: string, o?: { ascending?: boolean }) {
      const asc = o?.ascending !== false;
      rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] < b[c]) === asc ? -1 : 1));
      return q;
    },
    limit(n: number) { cap = n; return q; },
    gte(c: string, v: any) { rows = rows.filter((r) => r[c] >= v); return q; },
    lte(c: string, v: any) { rows = rows.filter((r) => r[c] <= v); return q; },
    eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return q; },
    neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return q; },
    in(c: string, vs: any[]) { (inSizes[table] ??= []).push(vs.length); rows = rows.filter((r) => vs.includes(r[c])); return q; },
    maybeSingle() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    single() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    then(res: any, rej?: any) { return Promise.resolve({ data: out(), error: null }).then(res, rej); },
  };
  return q;
}
function makeClient(state: Record<string, any[]>) {
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "no" } }) },
    from: (t: string) => buildQuery(state[t] ?? [], t),
    rpc: async () => ({ data: [], error: null }),
  };
}
const prof = (id: string) => ({ id, handle: id.slice(0, 8), name: id, display_name: id, avatar_url: null, show_profile_picture_publicly: true, verified: false, open_to_meet: false, is_private: false, account_status: "active" });

/**
 * `off` fresh location rows of people whose location mode is "off" (each `offAgeMs` old), then `on` people sharing
 * in discovery (each `onAgeMs` old). Insertion order is the order an unordered scan returns.
 */
function world(off: number, on: number, offAgeMs = 60_000, onAgeMs = 60_000) {
  const offIds = Array.from({ length: off }, (_, i) => `off-user-${String(i).padStart(4, "0")}`);
  const onIds = on === 1 ? [SHARER] : Array.from({ length: on }, (_, i) => `on-user-${String(i).padStart(4, "0")}`);
  const t0 = Date.now();  // one clock reading per world: rows of equal age are equal, so a tick between rows cannot reorder them
  const loc = (user_id: string, age: number) => ({ user_id, lat: POS.lat, lng: POS.lng, city: "Da Nang", country: "VN", last_known_at: new Date(t0 - age).toISOString() });
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }, { flag: "map_search_enabled", enabled: true }],
    blocks: [], protected_zones: [], profile_privacy_settings: [], user_privacy_settings: [], canonical_locations: [], hidden_gems: [], events: [],
    user_location_state: [...offIds.map((id) => loc(id, offAgeMs)), ...onIds.map((id) => loc(id, onAgeMs))],
    location_preferences: [
      ...offIds.map((user_id) => ({ user_id, location_mode: "off", sharing_paused: false, discovery_visibility: null })),
      ...onIds.map((user_id) => ({ user_id, location_mode: "nearby", sharing_paused: false, discovery_visibility: null })),
    ],
    profiles: [...offIds, ...onIds].map(prof),
  };
}

let server: http.Server; let base: string;
function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const r = http.request({ hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); r.end();
  });
}
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, n) => { req.log = { error() {}, warn() {}, info() {} }; n(); });
  app.use(mapProjectionRouter); app.use(mapTravelersRouter); app.use(mapSearchRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))); });
beforeEach(() => { _clearMapTravelersCache(); _clearProtectedZoneCache(); });

const TRUNC_KEYS = ["truncated", "partial", "incomplete", "refusal", "coverage", "capped", "hasMore"];
const saysCut = (body: any) => TRUNC_KEYS.some((k) => body && body[k] != null && body[k] !== false);
const travelersUrl = `/map/travelers?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50`;

describe("§113 (D-W11X2-129): the Discovery map's travelers layer over a cut scan", () => {
  it("V15-TS0 CONTROL: 20 non-sharers and one sharer — the sharer is served", async () => {
    _setTestClient(makeClient(world(20, 1)) as any, true);
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.travelers.map((t: any) => t.id), [SHARER]);
    assert.equal(saysCut(r.body), false);
  });

  it("V15-TS1 GET /map/travelers: 260 non-sharers ahead of the sharer — the scan is cut at 250; never an unmarked empty layer", async () => {
    _setTestClient(makeClient(world(260, 1)) as any, true);
    const r = await get(travelersUrl);
    assert.ok(!(r.status === 200 && Array.isArray(r.body.travelers) && r.body.travelers.length === 0 && !saysCut(r.body)),
      `a scan cut at 250 rows is answered as an empty layer with no marker: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, true);
  });

  it("V15-TS2 the NOW gateway: the same cut scan never names `travelers` as read over an empty layer", async () => {
    _setTestClient(makeClient(world(260, 1)) as any, true);
    const r = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=social_zone`);
    assert.ok(!(r.status === 200 && (r.body.sources ?? []).includes("travelers") && (r.body.objects ?? []).length === 0),
      `the gateway names travelers as read and draws none over a scan cut at 250: ${JSON.stringify({ sources: r.body.sources, objects: r.body.objects?.length })}`);
    assert.equal((r.body.sources ?? []).includes("travelers"), false);
  });

  it("TS3 GET /map/search: the same cut scan → the traveler source is not stated complete", async () => {
    _setTestClient(makeClient(world(260, 1)) as any, true);
    const r = await get(`/map/search?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50&types=traveler`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.sources?.traveler?.refusal, "travelers_capped", JSON.stringify(r.body.sources));
  });

  it("TS4 the scan is ordered freshest-first: the freshest sharer behind 300 older non-sharers is served (and the cut is said)", async () => {
    _setTestClient(makeClient(world(300, 1, 30 * 60_000, 60_000)) as any, true);
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.travelers.map((t: any) => t.id), [SHARER]);
    assert.equal(r.body.truncated, true);
  });

  it("TS5 the 100-row answer slice is marked: 101 eligible sharers → 100 served, truncated", async () => {
    _setTestClient(makeClient(world(0, 101)) as any, true);
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.equal(r.body.travelers.length, 100);
    assert.equal(r.body.truncated, true);
    const g = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=social_zone`);
    assert.equal((g.body.sources ?? []).includes("travelers"), false, JSON.stringify(g.body.sources));
  });

  it("TS6 the boundary: exactly 250 rows in the viewport is a whole read — no marker, the sharer served", async () => {
    _setTestClient(makeClient(world(249, 1)) as any, true);
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.travelers.map((t: any) => t.id), [SHARER]);
    assert.equal(saysCut(r.body), false, JSON.stringify(Object.keys(r.body)));
  });

  it("TS7 a cut scan stays cut while cached: the second request for the viewport is still marked", async () => {
    _setTestClient(makeClient(world(260, 1)) as any, true);
    const first = await get(travelersUrl);
    assert.equal(first.body.truncated, true);
    _setTestClient(makeClient(world(0, 0)) as any, true);  // a cache miss would now read an empty, whole viewport
    const second = await get(travelersUrl);
    assert.equal(second.status, 200);
    assert.equal(second.body.truncated, true, JSON.stringify(second.body).slice(0, 160));
  });

  it("TS8 the row read past the cap only detects the cut: the privacy reads ask for 250 ids, never 251", async () => {
    for (const k of Object.keys(inSizes)) delete inSizes[k];
    _setTestClient(makeClient(world(250, 1, 60_000, 120_000)) as any, true);  // the sharer is strictly the oldest, so freshest-first puts it at row 251, the one read only to detect the cut
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.equal(r.body.truncated, true);
    assert.deepEqual(inSizes.location_preferences, [250]);
    assert.deepEqual(r.body.travelers, []);
  });

  it("TSc CONTROL: a healthy uncut read — the body is `travelers` and `generatedAt` only; the gateway and search name the source", async () => {
    _setTestClient(makeClient(world(5, 100)) as any, true);
    const r = await get(travelersUrl);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["generatedAt", "travelers"]);
    assert.equal(r.body.travelers.length, 100);
    const g = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=social_zone`);
    assert.equal((g.body.sources ?? []).includes("travelers"), true, JSON.stringify(g.body.sources));
    const s = await get(`/map/search?lat=${POS.lat}&lng=${POS.lng}&radiusKm=50&types=traveler`);
    assert.equal(s.body.sources?.traveler?.refusal, null, JSON.stringify(s.body.sources));
  });
});
