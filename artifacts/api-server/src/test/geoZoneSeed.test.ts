/**
 * geo_zones seeding — the second Crowd Flow blocker, and the rules that keep a
 * seed honest.
 *
 * WHAT THIS PROVES
 * ================
 *   1. lib/geoZoneSeed.validateGeoZoneSeed enforces the four rules
 *      (docs/geo-zones-seeding.md) and reports EVERY violation, and its type
 *      list is the LIVE CHECK constraint, not the 0034 enum.
 *   2. The NON-production fixture src/test/fixtures/geo-zones.sample.json is
 *      valid and four of its five zones are flow-eligible.
 *   3. POST /admin/geo-zones/import: admin-gated, dry-run writes nothing, a
 *      violation writes nothing, a name that already exists is refused, a good
 *      batch is inserted through the service role.
 *   4. FAIL CLOSED / ACTIVATE, through the REAL /map/projection route: with no
 *      zones Crowd Flow reports `no_zone_model`; with the fixture (converted by
 *      the validator into the rows the loader reads) it reports `refusal: null`
 *      and `zoneModel.zones === 4`. That pair is the whole point — a seed that
 *      validates but does not activate the layer would be a seed that did
 *      nothing, and a layer that activates without a seed would be one that
 *      approximates.
 *   5. The manual SQL template carries the same four rules in prose the owner
 *      will read, and refuses while its placeholder row is present.
 *
 * Run: node --import tsx/esm --test src/test/geoZoneSeed.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

process.env.INTEL_GROUP_KEY_SECRET = process.env.INTEL_GROUP_KEY_SECRET ?? "geo-zone-seed-test-secret";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import mapProjectionRouter, { _clearFlowZoneCache, _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { FLOW_ZONE_TYPES, MIN_FLOW_ZONE_EXTENT_METERS, parseFlowZones } from "../lib/mapProjection.js";
import {
  GEO_ZONE_DB_TYPES,
  MAX_SEED_ZONES,
  validateGeoZoneSeed,
  type GeoZoneInsertRow,
} from "../lib/geoZoneSeed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../..");
const FIXTURE_PATH = join(HERE, "fixtures/geo-zones.sample.json");
const TEMPLATE_PATH = join(REPO_ROOT, "db/seed/geo_zones_production_seed_template.sql");

function fixture(): any {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

/** The shape routes/mapProjection.loadFlowZones selects. */
function loaderRows(rows: readonly GeoZoneInsertRow[]): any[] {
  return rows.map((r, i) => ({
    id: `seeded-${i}`,
    name: r.name,
    zone_type: r.zone_type,
    center_lat: r.center_lat,
    center_lng: r.center_lng,
    radius_meters: r.radius_meters,
    polygon_geojson: r.polygon_geojson,
  }));
}

// ── 1. the validator ─────────────────────────────────────────────────────────

describe("geo zone seed validation", () => {
  it("the type list is the live CHECK constraint, not the 0034 enum", () => {
    assert.deepEqual([...GEO_ZONE_DB_TYPES], ["city", "neighborhood", "venue", "custom", "airport", "hotel"]);
    for (const t of FLOW_ZONE_TYPES) assert.ok(GEO_ZONE_DB_TYPES.includes(t as any), `flow type ${t} must be storable`);
    assert.ok(!(GEO_ZONE_DB_TYPES as readonly string[]).includes("district"), "district never existed in the database");
  });

  it("accepts the sample fixture and counts its flow-eligible zones", () => {
    const v = validateGeoZoneSeed(fixture(), { createdBy: "admin-1" });
    assert.ok(v.ok, `fixture must validate: ${JSON.stringify((v as any).issues)}`);
    assert.equal(v.report.total, 5);
    assert.equal(v.report.flowEligible, 4, "city + 3 neighborhoods; the airport is not a flow type");
    assert.deepEqual(v.report.byType, { city: 1, neighborhood: 3, airport: 1 });
    // What the loader will read from these rows is exactly the flow-eligible set.
    assert.equal(parseFlowZones(loaderRows(v.rows)).length, 4);
    // Column names, not camelCase; provenance stamped; radius an integer.
    const anThuong = v.rows.find((r) => r.name === "An Thuong")!;
    assert.equal(anThuong.zone_type, "neighborhood");
    assert.equal(anThuong.radius_meters, 600);
    assert.equal(anThuong.created_by, "admin-1");
    assert.equal(anThuong.metadata.seed_source, fixture().source);
    assert.equal(anThuong.is_system, true);
    assert.equal(anThuong.verified, true);
    const myKhe = v.rows.find((r) => r.name === "My Khe")!;
    assert.equal(myKhe.center_lat, null);
    assert.equal(myKhe.polygon_geojson?.type, "Polygon");
  });

  it("the fixture says, in its own provenance, that it is not for production", () => {
    assert.match(fixture().source, /do not import into production/i);
  });

  const one = (over: Record<string, unknown>) => ({
    version: 1,
    source: "test",
    zones: [{ name: "Zone", zoneType: "neighborhood", centerLat: 16.05, centerLng: 108.2, radiusMeters: 600, ...over }],
  });

  it("refuses a zoneType the database would refuse", () => {
    const v = validateGeoZoneSeed(one({ zoneType: "district" }));
    assert.equal(v.ok, false);
    assert.ok((v as any).issues.some((i: any) => i.code === "schema" && /zoneType/.test(i.message)));
  });

  it("refuses an unknown key (a typo must not silently drop a field)", () => {
    const v = validateGeoZoneSeed(one({ radiusMetres: 600 }));
    assert.equal(v.ok, false);
  });

  it("refuses two geometries, no geometry, and a half circle", () => {
    const both = validateGeoZoneSeed(one({ polygonGeojson: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } }));
    assert.equal(both.ok, false);
    assert.ok((both as any).issues.some((i: any) => i.code === "geometry" && /not both/.test(i.message)));

    const none = validateGeoZoneSeed(one({ centerLat: undefined, centerLng: undefined, radiusMeters: undefined }));
    assert.equal(none.ok, false);
    assert.ok((none as any).issues.some((i: any) => i.code === "geometry"));

    const half = validateGeoZoneSeed(one({ radiusMeters: undefined }));
    assert.equal(half.ok, false);
    assert.ok((half as any).issues.some((i: any) => i.code === "geometry" && /AND radiusMeters/.test(i.message)));
  });

  it("refuses an open polygon ring", () => {
    const v = validateGeoZoneSeed(one({
      centerLat: undefined, centerLng: undefined, radiusMeters: undefined,
      polygonGeojson: { type: "Polygon", coordinates: [[[108.2, 16.0], [108.3, 16.0], [108.3, 16.1], [108.2, 16.1]]] },
    }));
    assert.equal(v.ok, false);
    assert.ok((v as any).issues.some((i: any) => i.code === "geometry" && /closed/.test(i.message)));
  });

  it("refuses a flow-type zone narrower than the loader's extent floor", () => {
    const tiny = validateGeoZoneSeed(one({ radiusMeters: MIN_FLOW_ZONE_EXTENT_METERS / 4 }));
    assert.equal(tiny.ok, false);
    assert.ok((tiny as any).issues.some((i: any) => i.code === "flow_ineligible"));
    // ...but the same radius is fine for a non-flow type: the floor is Crowd
    // Flow's rule, not a general one.
    const venue = validateGeoZoneSeed(one({ zoneType: "venue", radiusMeters: MIN_FLOW_ZONE_EXTENT_METERS / 4 }));
    assert.ok(venue.ok);
    assert.equal(venue.report.flowEligible, 0);
  });

  it("refuses duplicate names in a batch — an ambiguous name resolves to nothing", () => {
    const v = validateGeoZoneSeed({
      version: 1, source: "test",
      zones: [
        { name: "Downtown", zoneType: "neighborhood", centerLat: 16.05, centerLng: 108.2, radiusMeters: 600 },
        { name: "  downtown ", zoneType: "neighborhood", centerLat: 10.77, centerLng: 106.7, radiusMeters: 600 },
      ],
    });
    assert.equal(v.ok, false);
    const amb = (v as any).issues.filter((i: any) => i.code === "ambiguous_name");
    assert.equal(amb.length, 2, "both rows are reported");
  });

  it("refuses a name that already exists in the store", () => {
    const v = validateGeoZoneSeed(one({}), { existingNames: ["ZONE"] });
    assert.equal(v.ok, false);
    assert.ok((v as any).issues.some((i: any) => i.code === "name_collision"));
  });

  it("reports every issue at once and returns no rows while any remains", () => {
    const v = validateGeoZoneSeed({
      version: 1, source: "test",
      zones: [
        { name: "A", zoneType: "neighborhood", centerLat: 16.05, centerLng: 108.2, radiusMeters: 10 },
        { name: "B", zoneType: "city" },
      ],
    });
    assert.equal(v.ok, false);
    const codes = (v as any).issues.map((i: any) => i.code).sort();
    assert.deepEqual(codes, ["flow_ineligible", "geometry"]);
    assert.ok(!("rows" in v));
  });

  it("bounds a batch", () => {
    const zones = Array.from({ length: MAX_SEED_ZONES + 1 }, (_, i) => ({
      name: `Z${i}`, zoneType: "neighborhood", centerLat: 16.05, centerLng: 108.2, radiusMeters: 600,
    }));
    assert.equal(validateGeoZoneSeed({ version: 1, source: "test", zones }).ok, false);
  });
});

// ── fake Supabase for the two routes ─────────────────────────────────────────

interface TableSpec { rows?: any[]; error?: { message: string } }
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/** Writes are captured here so a test can assert what reached the table. */
const writes: Array<{ table: string; rows: any[] }> = [];

function buildQuery(table: string, spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null, count: rows.length });
  const q: any = {
    select() { return q; },
    order() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    range() { return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    ilike() { return q; },
    is(col: string, val: any) { rows = val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val); return q; },
    not(col: string, op: string, val: any) { if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null); return q; },
    or(expr: string) {
      const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/)).filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      return q;
    },
    insert(data: any) {
      const list = Array.isArray(data) ? data : [data];
      writes.push({ table, rows: list });
      rows = list.map((r, i) => ({ id: `new-${i}`, ...r }));
      return q;
    },
    maybeSingle() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
    single() { return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }); },
    then(resolve: (v: any) => void, reject?: (e: any) => void) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return q;
}

const TOKEN = "geo-seed-test-token";
const USER = "geo-seed-admin";

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(table, specOf(state, table)),
  };
}

function useState(state: FakeState) {
  const c = makeClient(state) as any;
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

let server: http.Server;
let base: string;

function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {} }; next(); });
  app.use(adminRouter);
  app.use(mapProjectionRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });
beforeEach(() => { writes.length = 0; _clearFlowZoneCache(); _clearProtectedZoneCache(); });

const adminState = (over: FakeState = {}): FakeState => ({
  profiles: [{ id: USER, role: "admin", display_name: "Admin", username: "admin", handle: "admin" }],
  geo_zones: [],
  ...over,
});

// ── 3. the import route ──────────────────────────────────────────────────────

describe("POST /admin/geo-zones/import", () => {
  it("is admin-gated", async () => {
    useState(adminState({ profiles: [{ id: USER, role: "user" }] }));
    const r = await request("POST", "/admin/geo-zones/import", fixture());
    assert.equal(r.status, 403);
    assert.equal(writes.length, 0);
  });

  it("dry run validates, reports, and writes nothing", async () => {
    useState(adminState());
    const r = await request("POST", "/admin/geo-zones/import", { ...fixture(), dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.wouldInsert, 5);
    assert.equal(r.body.report.flowEligible, 4);
    assert.equal(writes.length, 0);
  });

  it("a violation anywhere in the batch writes nothing and lists every issue", async () => {
    useState(adminState());
    const bad = fixture();
    bad.zones[1].radiusMeters = 10;          // flow_ineligible
    bad.zones[2].name = bad.zones[0].name;   // ambiguous with the city
    const r = await request("POST", "/admin/geo-zones/import", bad);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    const codes = new Set(r.body.issues.map((i: any) => i.code));
    assert.ok(codes.has("flow_ineligible"));
    assert.ok(codes.has("ambiguous_name"));
    assert.equal(writes.length, 0);
  });

  it("a name already in the store is refused", async () => {
    useState(adminState({ geo_zones: [{ id: "x", name: "an thuong" }] }));
    const r = await request("POST", "/admin/geo-zones/import", fixture());
    assert.equal(r.status, 400);
    assert.ok(r.body.issues.some((i: any) => i.code === "name_collision" && i.name === "An Thuong"));
    assert.equal(writes.length, 0);
  });

  it("a failed read of existing names is a refusal, not an empty store", async () => {
    useState(adminState({ geo_zones: { error: { message: "boom" } } }));
    const r = await request("POST", "/admin/geo-zones/import", fixture());
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.equal(writes.length, 0);
  });

  it("a good batch is inserted in geo_zones column names with the admin as created_by", async () => {
    useState(adminState());
    const r = await request("POST", "/admin/geo-zones/import", fixture());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.inserted, 5);
    assert.equal(r.body.report.flowEligible, 4);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].table, "geo_zones");
    const row = writes[0].rows.find((x) => x.name === "An Thuong");
    assert.equal(row.zone_type, "neighborhood");
    assert.equal(row.radius_meters, 600);
    assert.equal(row.created_by, USER);
    assert.ok(!("zoneType" in row) && !("radiusMeters" in row), "camelCase keys must not reach the table");
  });

  it("the single-zone POST accepts every live type and refuses the phantom ones", async () => {
    for (const t of GEO_ZONE_DB_TYPES) {
      useState(adminState());
      const r = await request("POST", "/admin/geo-zones", { name: `t-${t}`, zoneType: t });
      assert.equal(r.status, 201, `${t}: ${JSON.stringify(r.body)}`);
    }
    for (const t of ["district", "venue_area", "safety_zone"]) {
      useState(adminState());
      const r = await request("POST", "/admin/geo-zones", { name: `t-${t}`, zoneType: t });
      assert.equal(r.status, 400, `${t} was never a database type`);
    }
  });

  it("the single-zone POST can carry a polygon, which is what Crowd Flow reads", async () => {
    useState(adminState());
    const polygon = fixture().zones.find((z: any) => z.name === "My Khe").polygonGeojson;
    const r = await request("POST", "/admin/geo-zones", { name: "poly", zoneType: "neighborhood", polygonGeojson: polygon });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(writes[0].rows[0].polygon_geojson, polygon);
  });
});

// ── 4. fail closed / activate, through the real projection route ─────────────

const BBOX = "108.0,15.9,108.4,16.2";

function flowState(geoZones: FakeState[string]): FakeState {
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_crowd_flow_enabled", enabled: true },
    ],
    protected_zones: [],
    geo_zones: geoZones,
    places: [],
    intel_observations: [],
    intel_contribution_consent: [],
    route_plans: [],
    route_stops: [],
    route_legs: [],
    route_flow_contribution_consent: [],
    blocks: [],
  };
}

async function projection(state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
  return request("GET", `/map/projection?bbox=${BBOX}&zoom=14&kinds=crowd_flow`);
}

describe("Crowd Flow fails closed without a zone model and activates with the seed", () => {
  it("with geo_zones empty — production today — the layer refuses with no_zone_model", async () => {
    const r = await projection(flowState([]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crowdFlow.refusal, "no_zone_model");
    assert.equal(r.body.crowdFlow.zoneModel.zones, 0);
    assert.deepEqual(r.body.sources, [], "a refused layer must not claim an empty answer");
  });

  it("with the validated fixture the zone model exists and the refusal is gone", async () => {
    const v = validateGeoZoneSeed(fixture());
    assert.ok(v.ok);
    const r = await projection(flowState(loaderRows(v.rows)));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.crowdFlow.refusal, null, JSON.stringify(r.body.crowdFlow));
    assert.equal(r.body.crowdFlow.zoneModel.zones, v.report.flowEligible);
    assert.equal(r.body.crowdFlow.zoneModel.ambiguousNames, 0);
    // No signals were seeded, so nothing is published — activation is the
    // zone model, not an invented flow.
    assert.equal(r.body.crowdFlow.transitions, 0);
    assert.equal(r.body.crowdFlow.published, 0);
    assert.ok(r.body.sources.includes("crowd_flow"));
  });

  it("a seed the validator would refuse is one the loader would drop (the two agree)", async () => {
    const v = validateGeoZoneSeed(fixture());
    assert.ok(v.ok);
    const rows = loaderRows(v.rows).map((z) => ({ ...z, radius_meters: z.radius_meters == null ? null : 10 }));
    // The polygon survives; every circle is now under the floor.
    assert.equal(parseFlowZones(rows).length, 1);
    const r = await projection(flowState(rows));
    assert.equal(r.body.crowdFlow.zoneModel.zones, 1);
  });
});

// ── 5. the manual template ───────────────────────────────────────────────────

describe("the owner's manual SQL template", () => {
  const sql = () => readFileSync(TEMPLATE_PATH, "utf8");

  it("exists outside every migration root and is not migration-shaped", () => {
    assert.ok(!/^\d{4}_/.test("geo_zones_production_seed_template.sql"));
    assert.match(sql(), /NOT A MIGRATION/);
  });

  it("refuses while the placeholder row is present, and rolls back by default", () => {
    const s = sql();
    assert.match(s, /__FILL_ME__/);
    assert.match(s, /RAISE EXCEPTION 'SEED REFUSED: the template placeholder/);
    assert.match(s, /\nROLLBACK;/, "the first run must be a rehearsal");
  });

  it("carries the same four rules as lib/geoZoneSeed", () => {
    const s = sql();
    for (const t of GEO_ZONE_DB_TYPES) assert.ok(s.includes(`'${t}'`), `type ${t} missing from the template's rule 1`);
    assert.match(s, /give a circle OR a polygon, not both/);
    assert.match(s, /and be closed/);
    assert.ok(s.includes(String(MIN_FLOW_ZONE_EXTENT_METERS)), "rule 3's floor must match MIN_FLOW_ZONE_EXTENT_METERS");
    assert.match(s, /appears %s times in the batch/);
    assert.match(s, /already exists in geo_zones/);
    assert.match(s, /INSERT INTO public\.geo_zones/);
  });
});
