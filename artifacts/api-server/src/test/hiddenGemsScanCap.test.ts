/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-131): the Hidden Gems discovery scan never states a
 * cut read as the whole answer.
 *
 * `discoverGems` (services/hiddenGems/HiddenGemDiscoveryService.ts) read `min(limit × 3, 300)` active gems with NO
 * order, radius-filtered them AFTER the cut and sliced the ranked list to `limit`, with no marker. GET
 * /hidden-gems/nearby, GET /hidden-gems, the NOW gateway's gems layer and /map/search's gem source all stated the
 * result as complete — the round-15 verifier's B3 is the client half (Near Me filtered the default 40-gem page).
 *
 *   NB0  CONTROL: 10 box-corner gems and one near gem → the near gem is served; no `truncated` key
 *   NB1  151 fresher box-corner gems ahead of the near gem (limit 50 → a 150-row scan) → never an unmarked empty list
 *   NB2  the scan is ordered freshest-first: the freshest near gem behind 200 older corner gems is served (and cut)
 *   NB3  60 gems in the circle, limit 50 → 50 served, truncated
 *   NB4  the boundary: exactly 150 rows in the box, 1 near → whole, no marker
 *   LS1  GET /hidden-gems, 130 gems, the default page of 40 → 40 served, truncated
 *   LSc  CONTROL: GET /hidden-gems over 5 gems → no `truncated` key (the body is unchanged)
 *   MP1  the NOW gateway over a cut gem scan → `gems` is not named as read
 *   MS1  /map/search over a cut gem scan → the gem source is `gems_capped`, never complete
 *   MPc  CONTROL: the gateway and search over a whole scan → `gems` named, refusal null
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import mapSearchRouter from "../routes/mapSearch.js";

const TOKEN = "r16-gems-cap-token";
const USER = "ab000000-0000-4000-a000-0000000000b1";
const ME = { lat: 38.72, lng: -9.14 };
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

function buildQuery(rowsIn: any[]) {
  let rows = [...rowsIn];
  let cap: number | null = null;
  const out = () => (cap == null ? rows : rows.slice(0, cap));
  const q: any = {
    select() { return q; }, range() { return q; }, or() { return q; }, ilike() { return q; }, contains() { return q; },
    gt() { return q; }, lt() { return q; }, is() { return q; }, not() { return q; }, filter() { return q; }, match() { return q; },
    order(c: string, o?: { ascending?: boolean }) {
      const asc = o?.ascending !== false;
      rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] < b[c]) === asc ? -1 : 1));
      return q;
    },
    limit(n: number) { cap = n; return q; },
    gte(c: string, v: any) { rows = rows.filter((r) => r[c] == null || r[c] >= v); return q; },
    lte(c: string, v: any) { rows = rows.filter((r) => r[c] == null || r[c] <= v); return q; },
    eq(c: string, v: any) { rows = rows.filter((r) => !(c in r) || r[c] === v); return q; },
    neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return q; },
    in(c: string, vs: any[]) { rows = rows.filter((r) => !(c in r) || vs.includes(r[c])); return q; },
    maybeSingle() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    single() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    then(res: any, rej?: any) { return Promise.resolve({ data: out(), error: null, count: out().length }).then(res, rej); },
  };
  return q;
}
function makeClient(gems: any[]) {
  const state: Record<string, any[]> = {
    feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }, { flag: "map_projection_enabled", enabled: true }, { flag: "map_search_enabled", enabled: true }],
    hidden_gems: gems,
  };
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "no" } }) },
    from: (t: string) => buildQuery(state[t] ?? []),
    rpc: async () => ({ data: [], error: null }),
  };
}
let n = 0;
function gem(lat: number, lng: number, ageMs: number) {
  n += 1;
  const id = `9e000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
  return { id, name: `Gem ${n}`, category: "food", city: "Lisbon", country: "PT", neighborhood: null, description: "x", latitude: lat, longitude: lng, approx_latitude: lat, approx_longitude: lng, vibe_tags: [], price_range: null, safety_notes: null, best_time_to_go: null, local_etiquette: null, layover_safe: false, minimum_layover_minutes: null, sensitivity_level: "public", verification_level: "community", status: "active", crowd_level: "quiet", submitted_by: null, guide_verified_by: null, save_count: 0, visit_count: 0, report_count: 0, image_url: null, canonical_place_id: null, source_type: "user", moderation_status: "approved", created_at: agoIso(ageMs), updated_at: agoIso(ageMs) };
}
/** Inside the 50 km search box but outside the 50 km circle (~69 km away). */
const corner = (ageMs: number) => gem(ME.lat + 0.44, ME.lng + 0.56, ageMs);
const near = (ageMs: number) => gem(ME.lat + 0.01, ME.lng + 0.01, ageMs);
const HOUR = 3_600_000;

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
function use(gems: any[]) { const c = makeClient(gems); _setTestClient(c as any, true); _setTestServiceClient(c as any); }
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, nx) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; nx(); });
  app.use("/api", hiddenGemsRouter); app.use(mapProjectionRouter); app.use(mapSearchRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))); });
beforeEach(() => { _clearProtectedZoneCache(); });

const nearbyUrl = `/api/hidden-gems/nearby?lat=${ME.lat}&lng=${ME.lng}&radiusKm=50&limit=50`;
const BBOX = `${ME.lng - 0.6},${ME.lat - 0.45},${ME.lng + 0.6},${ME.lat + 0.45}`;
const ids = (b: any) => (b.gems ?? []).map((g: any) => g.id);

describe("§113 (D-W11X2-131): the Hidden Gems discovery scan over a cut read", () => {
  it("NB0 CONTROL: 10 corner gems and one near gem → the near gem is served, no marker", async () => {
    const g = near(HOUR); use([...Array.from({ length: 10 }, () => corner(60_000)), g]);
    const r = await get(nearbyUrl);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.deepEqual(ids(r.body), [g.id]);
    assert.equal("truncated" in r.body, false);
  });

  it("NB1 151 fresher corner gems ahead of the near gem → never an unmarked empty list", async () => {
    use([...Array.from({ length: 151 }, () => corner(60_000)), near(HOUR)]);
    const r = await get(nearbyUrl);
    assert.equal(r.status, 200);
    assert.ok(!(ids(r.body).length === 0 && r.body.truncated !== true), `a cut scan answered as no gems near: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.truncated, true);
  });

  it("NB2 the scan is ordered freshest-first: the freshest near gem behind 200 older corner gems is served", async () => {
    const g = near(60_000); use([...Array.from({ length: 200 }, () => corner(HOUR)), g]);
    const r = await get(nearbyUrl);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r.body), [g.id]);
    assert.equal(r.body.truncated, true);
  });

  it("NB3 60 gems in the circle, limit 50 → 50 served, truncated", async () => {
    use(Array.from({ length: 60 }, () => near(HOUR)));
    const r = await get(nearbyUrl);
    assert.equal(r.status, 200);
    assert.equal(ids(r.body).length, 50);
    assert.equal(r.body.truncated, true);
  });

  it("NB4 the boundary: exactly 150 rows in the box, one near → whole, no marker", async () => {
    const g = near(HOUR); use([...Array.from({ length: 149 }, () => corner(60_000)), g]);
    const r = await get(nearbyUrl);
    assert.deepEqual(ids(r.body), [g.id]);
    assert.equal("truncated" in r.body, false);
  });

  it("LS1 GET /hidden-gems: 130 gems, the default page of 40 → 40 served, truncated", async () => {
    use(Array.from({ length: 130 }, () => near(HOUR)));
    const r = await get(`/api/hidden-gems`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(ids(r.body).length, 40);
    assert.equal(r.body.truncated, true);
  });

  it("LSc CONTROL: GET /hidden-gems over 5 gems → no truncated key", async () => {
    use(Array.from({ length: 5 }, () => near(HOUR)));
    const r = await get(`/api/hidden-gems`);
    assert.equal(ids(r.body).length, 5);
    assert.equal("truncated" in r.body, false);
  });

  it("MP1 the NOW gateway over a cut gem scan (301 rows for its 300) → `gems` is not named as read", async () => {
    use([...Array.from({ length: 301 }, () => corner(60_000)), near(HOUR)]);
    const r = await get(`/map/projection?bbox=${BBOX}&zoom=12&kinds=hidden_gem`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal((r.body.sources ?? []).includes("gems"), false, JSON.stringify(r.body.sources));
  });

  it("MS1 /map/search over a cut gem scan (181 rows for its 180) → the gem source is gems_capped", async () => {
    use([...Array.from({ length: 181 }, () => corner(60_000)), near(HOUR)]);
    const r = await get(`/map/search?lat=${ME.lat}&lng=${ME.lng}&radiusKm=50&types=gem`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.sources?.gem?.refusal, "gems_capped", JSON.stringify(r.body.sources));
  });

  it("MPc CONTROL: the gateway and search over a whole scan → `gems` named, refusal null", async () => {
    use([...Array.from({ length: 5 }, () => corner(60_000)), near(HOUR)]);
    const g = await get(`/map/projection?bbox=${BBOX}&zoom=12&kinds=hidden_gem`);
    assert.equal((g.body.sources ?? []).includes("gems"), true, JSON.stringify(g.body.sources));
    const s = await get(`/map/search?lat=${ME.lat}&lng=${ME.lng}&radiusKm=50&types=gem`);
    assert.equal(s.body.sources?.gem?.refusal, null, JSON.stringify(s.body.sources));
  });
});
