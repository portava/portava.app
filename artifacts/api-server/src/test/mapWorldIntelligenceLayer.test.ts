/**
 * §36 Phase 7 World Intelligence, through the Map Intelligence Gateway.
 *
 * WHY THE POSITIVE TESTS ARE THE LOAD-BEARING ONES
 * ================================================
 * `map_world_intelligence_enabled` is seeded FALSE (migration 2291) and both
 * consent tables are empty in production, so a live call today returns nothing
 * — AND WOULD RETURN NOTHING IF THE WIRING WERE COMPLETELY BROKEN. Those two
 * states are indistinguishable from outside, which is exactly how this class of
 * defect survives (it is the defect src/test/mapCrowdFlowLayer.test.ts was
 * written for, one phase later).
 *
 * So each capability gets a POSITIVE test that drives a synthetic world through
 * the REAL HTTP route and asserts the object arrives, and the negative tests
 * then remove exactly one gate-clearing property each and assert it disappears.
 * Without the positive tests a permanently-broken pipeline would pass every
 * negative one.
 *
 * NOTHING HERE RELAXES A GATE. The fixtures SATISFY PRIVACY_THRESHOLD_V1 as it
 * stands (15 distinct actors, 5 independent groups, max 20% single-group share,
 * 10-minute publication delay), and §0 below pins those constants so a fixture
 * cannot start meaning something its comment does not say.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapWorldIntelligenceLayer.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

// The accepted_plan family derives an HMAC party token and REFUSES to read
// without a secret. Set before any route runs, as the real server does from env.
process.env.INTEL_GROUP_KEY_SECRET =
  process.env.INTEL_GROUP_KEY_SECRET ?? "world-intelligence-layer-test-secret";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { COMPASS_RHYTHM_K } from "../lib/compassRhythmGate.js";
import { canonicalCityKey } from "../lib/canonicalLocations.js";
import {
  MIN_ZONE_COHORT,
  NEVER_AGGREGATED_KINDS,
  activityForCohort,
} from "../lib/mapAggregation.js";
import {
  FORECAST_KINDS,
  MAP_OBJECT_KINDS,
  bboxPolygon,
  isForecastKind,
  point,
  type MapObject,
} from "../lib/mapObjects.js";
import {
  WORLD_INTELLIGENCE_K,
  WORLD_INTELLIGENCE_KINDS,
  bucketCohort,
  resolveWorldIntelligenceK,
} from "../lib/mapProducers/worldIntelligence.js";
import {
  MIN_PULSE_DENSITY_SOURCES,
  PULSE_FORBIDDEN_SOURCE_KINDS,
  PULSE_PEOPLE_SOURCE_KINDS,
  deriveWorldPulse,
} from "../lib/mapProducers/worldPulseProducer.js";
import {
  SINGLE_FAMILY_CONFIDENCE_CAP,
  TRAVELER_FLOW_WINDOW_DAYS,
} from "../lib/mapProducers/travelerFlowProducer.js";
import { WITHHELD_RATHER_THAN_COARSENED_KINDS } from "../lib/mapProjection.js";

// ── ids and sentinels ─────────────────────────────────────────────────────────

const TOKEN = "world-intel-test-token";
const USER = "world-intel-viewer";
const OTHER_USER = "world-intel-stranger";

/**
 * SENTINELS. Values that MUST NOT reach the wire, chosen to be greppable: an
 * actor id, and the raw stop coordinates a route plan is made of.
 * `JSON.stringify` of the whole response is searched for each of them.
 */
const ACTOR = (n: number) => `wi-actor-sentinel-${n}`;
/** Raw coordinates of the route stops. Deliberately unmistakable digits. */
const STOP_IN_A = { lat: 16.0491234, lng: 108.2013579 };
const STOP_IN_B = { lat: 13.7539876, lng: 100.5017531 };
const STOP_IN_C = { lat: 3.1391357, lng: 101.6869246 };
/** A city only the OTHER user has been to. Must never reach this viewer. */
const STRANGER_CITY = "Reykjavik";

/** Three curated CITY zones, far apart, with round centroids. */
const CITY_A = { id: "city-a", name: "Da Nang", lat: 16.05, lng: 108.2 };
const CITY_B = { id: "city-b", name: "Bangkok", lat: 13.75, lng: 100.5 };
const CITY_C = { id: "city-c", name: "Kuala Lumpur", lat: 3.14, lng: 101.69 };
const CITY_RADIUS_M = 40_000;

/** A viewport wide enough to hold all three cities and their expansion. */
const BBOX = "95.0,0.0,115.0,25.0";
/** zoom 8 sits in the `city` band, which carries Phase 7 (§17). */
const ZOOM = 8;

const COHORT_ACTORS = PRIVACY_THRESHOLD_V1.minUniqueActors; // 15

/**
 * The one instant every acceptance shares.
 *
 * 15 minutes clears PRIVACY_THRESHOLD_V1's 10-minute publication delay while
 * leaving the observation dateable. One timestamp for the whole cohort so every
 * hop lands in ONE window bucket — two timestamps straddling a boundary would
 * split the cohort and the suite would be testing bucketing, not gates.
 */
const ACCEPTED_AGO_MS = 15 * 60_000;

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec { rows?: any[]; error?: { message: string } }
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/** Chainable PostgREST-ish query over in-memory rows — only the operators the
 *  code under test actually uses, so an unimplemented one cannot silently pass. */
function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  const result = () => (err ? { data: null, error: err } : { data: rows, error: null });

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
    is(col: string, val: any) {
      if (val === null) rows = rows.filter((r) => r[col] == null);
      else rows = rows.filter((r) => r[col] === val);
      return q;
    },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      return q;
    },
    or(expr: string) {
      const parts = expr
        .split(",")
        .map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/))
        .filter(Boolean)
        .map((m) => ({ col: (m as RegExpMatchArray)[1], val: (m as RegExpMatchArray)[3] }));
      rows = rows.filter((r) => parts.some(({ col, val }) => String(r[col]) === val));
      return q;
    },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function isoAgo(nowMs: number, agoMs: number): string {
  return new Date(nowMs - agoMs).toISOString();
}

function cityRow(c: { id: string; name: string; lat: number; lng: number }): any {
  return {
    id: c.id,
    name: c.name,
    zone_type: "city",
    center_lat: c.lat,
    center_lng: c.lng,
    radius_meters: CITY_RADIUS_M,
    polygon_geojson: null,
  };
}

interface PlanOpts {
  count?: number;
  prefix?: string;
  from?: { lat: number; lng: number };
  to?: { lat: number; lng: number };
  /** One shared trip id collapses every accepter into ONE party. */
  tripId?: string | null;
  /** Actor numbering offset, so two plan sets can name different people. */
  offset?: number;
  agoMs?: number;
  consented?: boolean;
}

function planRows(nowMs: number, opts: PlanOpts = {}) {
  const count = opts.count ?? COHORT_ACTORS;
  const prefix = opts.prefix ?? "plan";
  const from = opts.from ?? STOP_IN_A;
  const to = opts.to ?? STOP_IN_B;
  const offset = opts.offset ?? 0;
  const agoMs = opts.agoMs ?? ACCEPTED_AGO_MS;
  const acceptedAt = isoAgo(nowMs, agoMs);
  const stopTouchedAt = isoAgo(nowMs, agoMs + 60 * 60_000); // before acceptance
  const route_plans: any[] = [];
  const route_stops: any[] = [];
  const route_legs: any[] = [];
  const route_flow_contribution_consent: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const planId = `${prefix}-${i + 1}`;
    const actorId = ACTOR(offset + i + 1);
    route_plans.push({
      id: planId,
      // null → a SOLO party token per accepter (lib/intelGroupKey's ruling).
      trip_id: opts.tripId ?? null,
      accepted_by_user_id: actorId,
      accepted_at: acceptedAt,
      status: "active",
    });
    if (opts.consented !== false) {
      route_flow_contribution_consent.push({ user_id: actorId, enabled: true, withdrawn_at: null });
    }
    route_stops.push(
      { id: `${planId}-from`, route_plan_id: planId, structured_location: { label: "start", ...from }, updated_at: stopTouchedAt },
      { id: `${planId}-to`, route_plan_id: planId, structured_location: { label: "end", ...to }, updated_at: stopTouchedAt },
    );
    route_legs.push({ route_plan_id: planId, from_stop_id: `${planId}-from`, to_stop_id: `${planId}-to` });
  }
  return { route_plans, route_stops, route_legs, route_flow_contribution_consent };
}

function mergePlans(...sets: ReturnType<typeof planRows>[]) {
  return {
    route_plans: sets.flatMap((s) => s.route_plans),
    route_stops: sets.flatMap((s) => s.route_stops),
    route_legs: sets.flatMap((s) => s.route_legs),
    route_flow_contribution_consent: sets.flatMap((s) => s.route_flow_contribution_consent),
  };
}

/** A published city aggregate whose named slices clear the map's k floor. */
function cityModelRow(label: string, opts: { actorsPerSlice?: number; slices?: string[] } = {}) {
  const actors = opts.actorsPerSlice ?? WORLD_INTELLIGENCE_K;
  const slices = opts.slices ?? ["fri:evening", "sat:night"];
  const time_slices: Record<string, unknown> = {};
  for (const s of slices) {
    // `count` is deliberately ENORMOUS and `distinctActors` is the real number:
    // the producer must gate on the second and ignore the first.
    time_slices[s] = { count: 100_000, categories: { nightlife: 12 }, distinctActors: actors };
  }
  return {
    city: canonicalCityKey(label),
    time_slices,
    top_categories: ["nightlife", "food"],
    built_at: "2026-09-01T00:00:00.000Z",
  };
}

function stampRow(id: string, userId: string, city: string, awardedAt: string) {
  return { id, user_id: userId, city, country: "VN", awarded_at: awardedAt, stamp_type: "city" };
}

/** The whole world, every Phase 7 gate cleared. `over` replaces tables. */
function worldState(nowMs: number, over: FakeState = {}): FakeState {
  const plans = planRows(nowMs);
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_world_intelligence_enabled", enabled: true },
    ],
    protected_zones: [],
    geo_zones: [CITY_A, CITY_B, CITY_C].map(cityRow),
    places: [],
    blocks: [],
    compass_city_models: [cityModelRow(CITY_A.name), cityModelRow(CITY_B.name)],
    passport_stamps: [
      stampRow("s1", USER, CITY_A.name, "2026-01-02T00:00:00.000Z"),
      stampRow("s2", USER, CITY_A.name, "2026-03-04T00:00:00.000Z"),
      stampRow("s3", USER, CITY_B.name, "2026-05-06T00:00:00.000Z"),
      // Another person's history. Must never reach this viewer.
      stampRow("s4", OTHER_USER, STRANGER_CITY, "2026-06-07T00:00:00.000Z"),
    ],
    ...plans,
    ...over,
  };
}

// ── test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method: "GET",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
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

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { error() {}, warn() {}, info() {} };
    next();
  });
  app.use(mapProjectionRouter);
  await new Promise<void>((resolve) => {
    // Bind loopback explicitly: a host-less listen(0) binds [::] and a foreign
    // IPv4 listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  // All three loaders cache for 30s; a stale cache would let one scenario
  // answer another scenario's question.
  _clearProtectedZoneCache();
  _clearFlowZoneCache();
  _clearCityZoneCache();
});

const ALL_KINDS = WORLD_INTELLIGENCE_KINDS.join(",");

async function projection(state: FakeState, kinds = ALL_KINDS, zoom = ZOOM) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${BBOX}&zoom=${zoom}&kinds=${kinds}`);
}

const ofKind = (body: any, kind: string): any[] =>
  (body?.objects ?? []).filter((o: any) => o.kind === kind);

/** Does `n` appear as a NUMERIC value anywhere in `value`? Strings do not count. */
function numberAppears(value: unknown, n: number): boolean {
  if (typeof value === "number") return value === n;
  if (Array.isArray(value)) return value.some((v) => numberAppears(v, n));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => numberAppears(v, n));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. The constants every fixture below depends on.
// ─────────────────────────────────────────────────────────────────────────────

describe("§36 Phase 7 borrows its floor and never lowers one", () => {
  it("the k floor IS the product threshold, not a Phase 7 number", () => {
    assert.equal(WORLD_INTELLIGENCE_K, MIN_ZONE_COHORT);
    assert.equal(WORLD_INTELLIGENCE_K, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(WORLD_INTELLIGENCE_K, 15);
  });

  it("an override may only TIGHTEN, and junk fails closed", () => {
    assert.equal(resolveWorldIntelligenceK(null), WORLD_INTELLIGENCE_K);
    assert.equal(resolveWorldIntelligenceK(50), 50);
    // The relaxation attempt is ignored, not honoured.
    assert.equal(resolveWorldIntelligenceK(2), WORLD_INTELLIGENCE_K);
    assert.ok(Number.isNaN(resolveWorldIntelligenceK(0)));
    assert.ok(Number.isNaN(resolveWorldIntelligenceK(Number.NaN)));
  });

  it("the map's city-rhythm floor is TIGHTER than Compass's own, never looser", () => {
    // IG-07 set COMPASS_RHYTHM_K = 5 for a private feed line. The map is a
    // public geographic surface, so it may be more conservative and may never
    // be less. If this ever inverts, the map has become the loosest publisher.
    assert.ok(
      WORLD_INTELLIGENCE_K >= COMPASS_RHYTHM_K,
      "the map must never publish a city rhythm at a looser floor than Compass",
    );
  });

  it("bucketCohort refuses below k rather than returning the bottom rung", () => {
    assert.equal(bucketCohort(WORLD_INTELLIGENCE_K - 1), null);
    assert.equal(bucketCohort(0), null);
    assert.equal(bucketCohort(-1), null);
    assert.equal(bucketCohort(Number.NaN), null);
    // A cohort that only just clears reads `quiet`, never `very_quiet`, which
    // the ladder reserves for cohorts that are never published at all.
    assert.equal(bucketCohort(WORLD_INTELLIGENCE_K), "quiet");
    assert.equal(bucketCohort(WORLD_INTELLIGENCE_K * 16), "peak");
  });

  it("the bucket ladder IS §7's activity ladder, so it moves with k", () => {
    for (const n of [15, 31, 60, 121, 240, 999]) {
      assert.equal(bucketCohort(n), activityForCohort(n, WORLD_INTELLIGENCE_K));
    }
  });

  it("all four kinds are never aggregated and never forecasts", () => {
    for (const kind of WORLD_INTELLIGENCE_KINDS) {
      assert.ok(MAP_OBJECT_KINDS.includes(kind), `${kind} is not a contract kind`);
      assert.ok(NEVER_AGGREGATED_KINDS.includes(kind), `${kind} may be re-binned`);
      // §37: a prediction is always labelled a prediction. None of these is one,
      // and none of them may quietly become one.
      assert.equal(isForecastKind(kind), false, `${kind} must not be a forecast kind`);
    }
    assert.deepEqual([...FORECAST_KINDS], ["prediction"]);
  });

  it("the three aggregate kinds are withheld rather than coarsened inside a §24 zone", () => {
    // Each restates count/observedAt inside its own payload, which coarsening
    // does not touch — so a coarsened one keeps everything coarsening removes.
    for (const kind of ["world_pulse", "traveler_flow", "city_model"]) {
      assert.ok(WITHHELD_RATHER_THAN_COARSENED_KINDS.includes(kind as any), kind);
    }
    // personal_city is deliberately NOT there: it discloses nothing about who
    // is at the protected place. It still follows the zone's own action.
    assert.equal(WITHHELD_RATHER_THAN_COARSENED_KINDS.includes("personal_city" as any), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. World Pulse — the pure producer.
// ─────────────────────────────────────────────────────────────────────────────

const PULSE_BBOX = { west: 100, south: 10, east: 120, north: 25 };

function zoneObj(id: string, count: number | undefined, lat = 16.05, lng = 108.2): MapObject {
  return {
    id,
    kind: "activity_zone",
    geometry: bboxPolygon(lng - 0.05, lat - 0.05, lng + 0.05, lat + 0.05),
    title: `${count ?? "?"} travelers active around this area`,
    privacyClass: "aggregate_only",
    renderingPriority: 50,
    ...(count === undefined ? {} : { count }),
  } as MapObject;
}

function venueObj(id: string, lat = 16.05, lng = 108.2): MapObject {
  return {
    id, kind: "place", geometry: point(lat, lng), title: "Venue",
    privacyClass: "place_level", renderingPriority: 40,
  };
}

/** Strip the parts that legitimately differ between two runs. */
function normalized(o: any): any {
  const { id, ...rest } = o;
  return rest;
}

describe("World Pulse is built only from already-aggregated sources", () => {
  it("publishes a cell from k-gated activity zones", () => {
    const objs = [zoneObj("az:1", 40), zoneObj("az:2", 60)];
    const { pulses, report } = deriveWorldPulse(objs, { bbox: PULSE_BBOX, zoom: 4 });
    assert.equal(pulses.length, 1);
    assert.equal(report.published, 1);
    const p = pulses[0];
    assert.equal(p.kind, "world_pulse");
    assert.equal(p.privacyClass, "aggregate_only");
    assert.equal(p.payload?.basis, "observed_aggregates");
    assert.equal(p.payload?.intensitySource, "people");
    assert.equal(p.payload?.people?.contributingAggregates, 2);
    assert.equal(p.payload?.people?.cohortBucket, activityForCohort(100, WORLD_INTELLIGENCE_K));
  });

  it("NEVER publishes an exact cohort — no count, no cohortSize anywhere", () => {
    const { pulses } = deriveWorldPulse([zoneObj("az:1", 137)], { bbox: PULSE_BBOX, zoom: 4 });
    const p = pulses[0];
    assert.equal(p.count, undefined, "world_pulse must carry no exact count");
    const wire = JSON.stringify(p);
    assert.ok(!wire.includes("cohortSize"), "no cohortSize field may reach the wire");
    assert.ok(!wire.includes("137"), "the exact cohort must not appear anywhere");
  });

  it("a sub-k people cell serializes IDENTICALLY to one with no people at all", () => {
    // THE PROPERTY THAT STOPS SUPPRESSION BECOMING A SIGNAL. If these two
    // differed, "people: withheld" would itself publish that a small group
    // exists in that cell — the leak the floor exists to prevent, one level out.
    const venues = Array.from({ length: MIN_PULSE_DENSITY_SOURCES }, (_, i) => venueObj(`v${i}`));
    const subK = deriveWorldPulse(
      [...venues, zoneObj("az:leak", WORLD_INTELLIGENCE_K - 1)],
      { bbox: PULSE_BBOX, zoom: 4 },
    );
    const none = deriveWorldPulse(venues, { bbox: PULSE_BBOX, zoom: 4 });
    assert.equal(subK.pulses.length, 1);
    assert.equal(none.pulses.length, 1);
    assert.deepEqual(normalized(subK.pulses[0]), normalized(none.pulses[0]));
    assert.equal(subK.pulses[0].payload?.people, null);
    assert.equal(none.pulses[0].payload?.people, null);
    // …and the sub-k contributor was actively rejected, not silently absorbed.
    assert.equal(subK.report.rejectedContributors, 1);
  });

  it("a cell with neither a publishable cohort nor enough public density is suppressed", () => {
    const thin = deriveWorldPulse(
      [venueObj("v1"), venueObj("v2"), zoneObj("az:leak", 3)],
      { bbox: PULSE_BBOX, zoom: 4 },
    );
    assert.equal(thin.pulses.length, 0);
    assert.equal(thin.report.suppressed, 1);
  });

  it("an unknown or fractional contributor count poisons its own contribution", () => {
    // cohortWeightOf returns null for an unusable count; the contributor is
    // dropped and COUNTED, because both source kinds guarantee >= k.
    const bad = deriveWorldPulse([zoneObj("az:bad", 12.5 as unknown as number)], {
      bbox: PULSE_BBOX, zoom: 4,
    });
    assert.equal(bad.pulses.length, 0);
    assert.equal(bad.report.rejectedContributors, 1);
  });

  it("refuses every person-shaped and forecast-shaped source kind", () => {
    // The allow-lists and the refusal list together must cover the contract,
    // so a NEW kind is a decision rather than a default.
    const allowed = [...PULSE_PEOPLE_SOURCE_KINDS, ...["place", "event"]];
    for (const kind of MAP_OBJECT_KINDS) {
      const declared = allowed.includes(kind) || PULSE_FORBIDDEN_SOURCE_KINDS.includes(kind);
      assert.ok(declared, `kind "${kind}" is neither allowed nor explicitly refused by World Pulse`);
    }
    // And the refusal is real, not just declared: a big cohort on a forbidden
    // kind produces nothing.
    for (const kind of PULSE_FORBIDDEN_SOURCE_KINDS) {
      const obj = { ...zoneObj("x", 500), kind } as MapObject;
      const res = deriveWorldPulse([obj], { bbox: PULSE_BBOX, zoom: 4 });
      assert.equal(res.pulses.length, 0, `${kind} contributed to a pulse`);
      assert.equal(res.report.ineligible, 1, `${kind} was not reported as ineligible`);
    }
  });

  it("produces nothing below the city band (§17)", () => {
    const res = deriveWorldPulse([zoneObj("az:1", 200)], { bbox: PULSE_BBOX, zoom: 14 });
    assert.equal(res.pulses.length, 0);
    assert.equal(res.report.band, "district");
  });

  it("its grid is COARSER than the aggregation grid it summarizes", () => {
    // Two zones a whole aggregation cell apart still land in one pulse cell.
    const res = deriveWorldPulse(
      [zoneObj("az:1", 40, 16.05, 108.2), zoneObj("az:2", 40, 16.05, 110.9)],
      { bbox: PULSE_BBOX, zoom: 8 },
    );
    assert.equal(res.pulses.length, 1, "the pulse grid did not summarize across aggregation cells");
    assert.equal(res.report.cells, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The traveler-flow graph, through the real route.
// ─────────────────────────────────────────────────────────────────────────────

describe("the traveler-flow graph publishes a city→city edge", () => {
  it("a consented, k-clearing cohort produces exactly one edge", async () => {
    const { body, status } = await projection(worldState(Date.now()), "traveler_flow");
    assert.equal(status, 200);
    const edges = ofKind(body, "traveler_flow");
    assert.equal(edges.length, 1, JSON.stringify(body.worldIntelligence));
    const e = edges[0];
    assert.equal(e.geometry.type, "LineString");
    assert.equal(e.payload.basis, "observed_accepted_plans");
    assert.equal(e.payload.fromCityLabel, CITY_A.name);
    assert.equal(e.payload.toCityLabel, CITY_B.name);
    assert.equal(e.privacyClass, "aggregate_only");
    assert.deepEqual(body.worldIntelligence.travelerFlow.refusal, null);
    assert.ok(body.sources.includes("traveler_flow"));
  });

  it("the edge draws city CENTROIDS, never the raw stop coordinates", async () => {
    const { body } = await projection(worldState(Date.now()), "traveler_flow");
    const e = ofKind(body, "traveler_flow")[0];
    assert.deepEqual(e.geometry.coordinates, [
      [CITY_A.lng, CITY_A.lat],
      [CITY_B.lng, CITY_B.lat],
    ]);
  });

  it("no actor id, party token or raw stop coordinate survives to the wire", async () => {
    const { body } = await projection(worldState(Date.now()), "traveler_flow");
    // NOT VACUOUS: an empty response would satisfy every check below, so the
    // edge has to be there first.
    assert.equal(ofKind(body, "traveler_flow").length, 1);
    const wire = JSON.stringify(body);
    for (let i = 1; i <= COHORT_ACTORS; i += 1) {
      assert.ok(!wire.includes(ACTOR(i)), `actor sentinel ${i} reached the wire`);
    }
    // The party token is an HMAC over a secret, so there is no plantable
    // sentinel for it — what is checked instead is that no field CAPABLE of
    // carrying one exists on the wire at all.
    for (const field of ["groupKey", "group_key", "actorId", "actor_id", "distinctActors", "maxGroupShare"]) {
      assert.ok(!wire.includes(field), `field "${field}" reached the wire`);
    }
    for (const v of [STOP_IN_A.lat, STOP_IN_A.lng, STOP_IN_B.lat, STOP_IN_B.lng]) {
      assert.ok(!wire.includes(String(v)), `raw stop coordinate ${v} reached the wire`);
    }
  });

  it("the cohort is BUCKETED, never exact", async () => {
    const { body } = await projection(worldState(Date.now()), "traveler_flow");
    const e = ofKind(body, "traveler_flow")[0];
    assert.equal(e.count, undefined, "traveler_flow must carry no exact count");
    assert.equal(e.payload.cohortBucket, bucketCohort(COHORT_ACTORS));
    const wire = JSON.stringify(e);
    assert.ok(!wire.includes("cohortSize"));
    // The exact cohort size must not be readable off the edge in any form.
    // Checked over VALUES rather than as a substring of the JSON: an ISO
    // timestamp contains ":15" roughly one minute in four, which would make a
    // substring assertion pass or fail depending on the clock.
    assert.ok(
      !numberAppears(e, COHORT_ACTORS),
      "the exact cohort appeared as a number somewhere on the edge",
    );
    assert.ok(!/\b15 travel/i.test(wire), "the exact cohort appeared in prose");
  });

  it("declares its evidence honestly: one family, capped at the weakest band", async () => {
    const { body } = await projection(worldState(Date.now()), "traveler_flow");
    const e = ofKind(body, "traveler_flow")[0];
    assert.equal(e.payload.singleFamily, true);
    assert.deepEqual(e.payload.signalFamilies, ["accepted_plan"]);
    assert.equal(e.confidence, SINGLE_FAMILY_CONFIDENCE_CAP);
    assert.equal(e.payload.windowDays, TRAVELER_FLOW_WINDOW_DAYS);
    assert.match(String(e.provenance.lines[0].text), /uncorroborated/);
  });
});

describe("a single traveller can never be resolved from a flow edge", () => {
  it("k-1 accepters publish nothing", async () => {
    const nowMs = Date.now();
    const plans = planRows(nowMs, { count: COHORT_ACTORS - 1 });
    const { body } = await projection(worldState(nowMs, plans), "traveler_flow");
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    assert.equal(body.worldIntelligence.travelerFlow.published, 0);
    assert.ok(body.worldIntelligence.travelerFlow.withheld >= 1);
  });

  it("ONE person's A→B→C itinerary publishes neither leg", async () => {
    // The chaining property: each edge is gated independently, so a lone
    // traveller's second hop dies alone even when the first hop is busy.
    const nowMs = Date.now();
    const crowd = planRows(nowMs, { count: COHORT_ACTORS, prefix: "crowd" });
    const loner = planRows(nowMs, {
      count: 1, prefix: "chain", offset: 900,
      from: STOP_IN_B, to: STOP_IN_C,
    });
    const { body } = await projection(worldState(nowMs, mergePlans(crowd, loner)), "traveler_flow");
    const edges = ofKind(body, "traveler_flow");
    // The busy A→B edge publishes; the lone B→C hop does not.
    assert.equal(edges.length, 1);
    assert.equal(edges[0].payload.fromCityId, CITY_A.id);
    assert.equal(edges[0].payload.toCityId, CITY_B.id);
    for (const e of edges) {
      assert.notEqual(e.payload.toCityId, CITY_C.id, "a one-person hop was published");
    }
    assert.ok(!JSON.stringify(body).includes(ACTOR(901)));
  });

  it("one shared trip is ONE party, so the dominant-group ceiling refuses it", async () => {
    // 15 people, all on one trip → one group key → maxGroupShare 1.0, well over
    // PRIVACY_THRESHOLD_V1.maxSingleGroupShare. A large party is not a crowd.
    const nowMs = Date.now();
    const plans = planRows(nowMs, { count: COHORT_ACTORS, tripId: "one-big-trip" });
    const { body } = await projection(worldState(nowMs, plans), "traveler_flow");
    assert.equal(ofKind(body, "traveler_flow").length, 0);
  });

  it("withdrawn consent removes the contributor, and the cohort falls below k", async () => {
    const nowMs = Date.now();
    const plans = planRows(nowMs);
    plans.route_flow_contribution_consent = plans.route_flow_contribution_consent
      .slice(0, COHORT_ACTORS - 1)
      .concat([{ user_id: ACTOR(COHORT_ACTORS), enabled: true, withdrawn_at: nowMs }]);
    const { body } = await projection(worldState(nowMs, plans), "traveler_flow");
    assert.equal(ofKind(body, "traveler_flow").length, 0);
  });

  it("a consent-read FAILURE empties the cohort — it can never inflate one", async () => {
    const nowMs = Date.now();
    const { body } = await projection(
      worldState(nowMs, { route_flow_contribution_consent: { error: { message: "boom" } } }),
      "traveler_flow",
    );
    assert.equal(ofKind(body, "traveler_flow").length, 0);
  });

  it("an acceptance older than the window contributes nothing", async () => {
    const nowMs = Date.now();
    const plans = planRows(nowMs, { agoMs: (TRAVELER_FLOW_WINDOW_DAYS + 1) * 24 * 60 * 60_000 });
    const { body } = await projection(worldState(nowMs, plans), "traveler_flow");
    assert.equal(ofKind(body, "traveler_flow").length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The city model.
// ─────────────────────────────────────────────────────────────────────────────

describe("the city model publishes a k-gated rhythm", () => {
  it("publishes the cities whose slices clear the floor", async () => {
    const { body } = await projection(worldState(Date.now()), "city_model");
    const models = ofKind(body, "city_model");
    assert.equal(models.length, 2);
    const a = models.find((m: any) => m.payload.cityLabel === CITY_A.name);
    assert.ok(a);
    assert.equal(a.payload.basis, "observed_history");
    assert.equal(a.payload.rhythm.length, 2);
    assert.deepEqual(a.payload.rhythm.map((r: any) => `${r.day}:${r.band}`), ["fri:evening", "sat:night"]);
    assert.equal(a.payload.rhythm[0].activityBucket, bucketCohort(WORLD_INTELLIGENCE_K));
    assert.ok(body.sources.includes("city_models"));
  });

  it("gates on distinctActors and IGNORES the observation count entirely", async () => {
    // IG-07's leak: `count` sums observations whose dedup key holds no user id,
    // so N observations can be ONE person. Here count is 100 000 and
    // distinctActors is k-1: nothing may publish.
    const state = worldState(Date.now(), {
      compass_city_models: [cityModelRow(CITY_A.name, { actorsPerSlice: WORLD_INTELLIGENCE_K - 1 })],
    });
    const { body } = await projection(state, "city_model");
    const models = ofKind(body, "city_model");
    // The city still publishes (it has top categories), but with NO rhythm —
    // and "withheld" is indistinguishable from "thin" in the payload.
    assert.equal(models.length, 1);
    assert.deepEqual(models[0].payload.rhythm, []);
    assert.equal(body.worldIntelligence.cityModels.slicesWithheld, 2);
    assert.equal(body.worldIntelligence.cityModels.slicesPublished, 0);
    assert.ok(!JSON.stringify(body).includes("100000"));
  });

  it("a slice with no distinct-actor count at all is suppressed, not assumed", async () => {
    const row = cityModelRow(CITY_A.name);
    for (const k of Object.keys(row.time_slices)) {
      delete (row.time_slices as any)[k].distinctActors;
    }
    const { body } = await projection(
      worldState(Date.now(), { compass_city_models: [row] }),
      "city_model",
    );
    assert.deepEqual(ofKind(body, "city_model")[0].payload.rhythm, []);
  });

  it("a malformed slice key is dropped rather than guessed", async () => {
    const row = cityModelRow(CITY_A.name, { slices: ["notaslice", "xxx:evening", "fri:teatime"] });
    const { body } = await projection(
      worldState(Date.now(), { compass_city_models: [row] }),
      "city_model",
    );
    assert.deepEqual(ofKind(body, "city_model")[0].payload.rhythm, []);
  });

  it("two geo_zones canonicalizing to one city key yield NO city at all", async () => {
    // Ambiguity resolves to refusal: publishing one city's aggregate at the
    // other's centroid, or merging them, are both wrong answers.
    const dup = { ...cityRow(CITY_A), id: "city-a-dup", center_lat: 20, center_lng: 100 };
    const { body } = await projection(
      worldState(Date.now(), { geo_zones: [cityRow(CITY_A), dup, cityRow(CITY_B)] }),
      "city_model",
    );
    const labels = ofKind(body, "city_model").map((m: any) => m.payload.cityLabel);
    assert.deepEqual(labels, [CITY_B.name]);
    assert.equal(body.worldIntelligence.cityModelGeography.ambiguousKeys, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The personal city model.
// ─────────────────────────────────────────────────────────────────────────────

describe("the personal city model is the viewer's own history and nobody else's", () => {
  it("summarizes the viewer's own stamps per city", async () => {
    const { body } = await projection(worldState(Date.now()), "personal_city");
    const mine = ofKind(body, "personal_city");
    assert.equal(mine.length, 2);
    const a = mine.find((m: any) => m.payload.cityLabel === CITY_A.name);
    assert.ok(a);
    assert.equal(a.payload.basis, "observed_own_history");
    assert.equal(a.payload.stampCount, 2);
    assert.equal(a.payload.firstVisitAt, "2026-01-02T00:00:00.000Z");
    assert.equal(a.payload.lastVisitAt, "2026-03-04T00:00:00.000Z");
    assert.equal(a.privacyClass, "place_level");
    assert.ok(body.sources.includes("personal_cities"));
  });

  it("another person's stamp never appears, in any field", async () => {
    const { body } = await projection(worldState(Date.now()), "personal_city");
    // NOT VACUOUS: the viewer's OWN summaries must be present, or an empty
    // response would satisfy every absence check below.
    assert.equal(ofKind(body, "personal_city").length, 2);
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(OTHER_USER), "another user's id reached the wire");
    assert.ok(!wire.includes(STRANGER_CITY), "another user's city reached the wire");
    assert.ok(!wire.includes("s4"), "another user's stamp id reached the wire");
  });

  it("carries no live band — it is history, not a claim about now", async () => {
    const { body } = await projection(worldState(Date.now()), "personal_city");
    for (const p of ofKind(body, "personal_city")) {
      assert.equal(p.freshness, undefined);
      assert.equal(p.confidence, undefined);
      assert.equal(p.activity, undefined);
    }
  });

  it("a stamp whose city has no curated geography is dropped, never placed at a guess", async () => {
    const { body } = await projection(
      worldState(Date.now(), {
        passport_stamps: [stampRow("s9", USER, "Nowhere-at-all", "2026-02-02T00:00:00.000Z")],
      }),
      "personal_city",
    );
    assert.equal(ofKind(body, "personal_city").length, 0);
    assert.equal(body.worldIntelligence.personalCities.unplaced, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The flag, the band, and failing closed.
// ─────────────────────────────────────────────────────────────────────────────

describe("with the flag OFF nothing changes", () => {
  it("no Phase 7 object is served and the refusal says why", async () => {
    const state = worldState(Date.now(), {
      feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    });
    const { body } = await projection(state);
    for (const kind of WORLD_INTELLIGENCE_KINDS) {
      assert.equal(ofKind(body, kind).length, 0, `${kind} was served with the flag off`);
    }
    assert.equal(body.worldIntelligence.refusal, "flag_off");
    assert.equal(body.worldIntelligence.worldPulse, null);
    assert.equal(body.worldIntelligence.travelerFlow, null);
  });

  it("the served map is byte-identical to one where Phase 7 was never asked for", async () => {
    // The whole behavioural claim of "gated behind a flag seeded OFF": with the
    // flag off, everything the renderer consumes is EXACTLY what it was before
    // Phase 7 existed. Only the diagnostic report differs — and that is the
    // same shape `crowdFlow`, `producers` and `places` already added.
    const nowMs = Date.now();
    const flagOff = worldState(nowMs, {
      feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    });
    const asked = await projection(flagOff, ALL_KINDS);
    const notAsked = await projection(flagOff, "place");

    assert.deepEqual(asked.body.objects, notAsked.body.objects);
    assert.deepEqual(asked.body.objects, []);
    for (const field of ["aggregation", "protection", "liveEnrichment", "crowdFlow", "total"]) {
      assert.deepEqual(asked.body[field], notAsked.body[field], `${field} differed`);
    }
    // …and nothing was read for a layer that cannot publish: no source claims
    // an answer it never obtained.
    for (const s of ["world_pulse", "traveler_flow", "city_models", "personal_cities"]) {
      assert.ok(!asked.body.sources.includes(s), `${s} claimed a source with the flag off`);
    }
  });
});

describe("Phase 7 fails closed", () => {
  it("refuses below the city band rather than reporting an empty layer", async () => {
    const { body } = await projection(worldState(Date.now()), ALL_KINDS, 15);
    assert.equal(body.worldIntelligence.refusal, "band_not_eligible");
    for (const kind of WORLD_INTELLIGENCE_KINDS) assert.equal(ofKind(body, kind).length, 0);
  });

  it("an unreadable city geography is a refusal, not an absent geography", async () => {
    const { body } = await projection(
      worldState(Date.now(), { geo_zones: { error: { message: "boom" } } }),
      ALL_KINDS,
    );
    assert.equal(body.worldIntelligence.refusal, "read_failed");
    for (const kind of WORLD_INTELLIGENCE_KINDS) assert.equal(ofKind(body, kind).length, 0);
  });

  it("an unreadable published city aggregate publishes no city model", async () => {
    const { body } = await projection(
      worldState(Date.now(), { compass_city_models: { error: { message: "boom" } } }),
      "city_model",
    );
    assert.equal(ofKind(body, "city_model").length, 0);
    assert.equal(body.worldIntelligence.refusal, "read_failed");
  });

  it("an unreadable stamp table publishes no personal city", async () => {
    const { body } = await projection(
      worldState(Date.now(), { passport_stamps: { error: { message: "boom" } } }),
      "personal_city",
    );
    assert.equal(ofKind(body, "personal_city").length, 0);
    assert.equal(body.worldIntelligence.personalCities, null);
  });

  it("no curated city geography at all is a refusal, and nothing is read", async () => {
    const { body } = await projection(worldState(Date.now(), { geo_zones: [] }), ALL_KINDS);
    for (const kind of WORLD_INTELLIGENCE_KINDS) assert.equal(ofKind(body, kind).length, 0);
    assert.equal(body.worldIntelligence.cityModelGeography.cities, 0);
  });

  it("a §24 SUPPRESS zone over a city removes its aggregates", async () => {
    // A suppress-class zone covering city B's centroid: the A→B edge and B's
    // own city model both go, because the gate runs over Phase 7's output too.
    const { body } = await projection(
      worldState(Date.now(), {
        protected_zones: [{
          id: "pz-1", category: "shelter", action: null, privacy_floor: null,
          shape: "circle", center_lat: CITY_B.lat, center_lng: CITY_B.lng,
          radius_meters: 50_000, ring: null, jurisdiction: null, policy_ref: null,
          active: true,
        }],
      }),
      "traveler_flow,city_model",
    );
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    const labels = ofKind(body, "city_model").map((m: any) => m.payload.cityLabel);
    assert.ok(!labels.includes(CITY_B.name), "a suppressed city still published its model");
    assert.ok(body.worldIntelligence.withheldForProtection >= 1);
  });
});
