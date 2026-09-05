/**
 * §36 Phase 7 World Intelligence, through the Map Intelligence Gateway.
 *
 * WHY THE POSITIVE TESTS ARE THE LOAD-BEARING ONES
 * ================================================
 * `map_world_intelligence_enabled` is seeded FALSE (migration 2295) and both
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
  deriveTravelerFlowEdges,
} from "../lib/mapProducers/travelerFlowProducer.js";
import { WITHHELD_RATHER_THAN_COARSENED_KINDS } from "../lib/mapProjection.js";
import {
  AMBIENT_PRESENCE_KINDS,
  COARSEN_UNSAFE_KINDS,
  classifyAgainstProtected,
  type ProtectedZone,
} from "../lib/protectedLocations.js";
import { CONFIDENCE_STATES } from "../lib/mapObjects.js";
import type { ZoneTransition } from "../lib/mapAggregation.js";

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
/**
 * A city only the OTHER user has been to, and which has NO CURATED GEOGRAPHY.
 * It is a sentinel for the `unplaced` drop path ONLY — it proves nothing about
 * ownership, because it would be dropped whether or not the owner filter ran.
 * The load-bearing stranger rows are the ones in CURATED cities; see
 * `worldState`'s `passport_stamps`.
 */
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

interface TableSpec {
  rows?: any[];
  error?: { message: string };
  /**
   * THROW instead of returning a PostgREST error. The two are different
   * failures and the route treats them on different arms — `error` reaches the
   * producer's own refusal, a THROW unwinds into the route's `.catch(() => null)`
   * — so a fixture that can only produce the first cannot test the second.
   */
  throws?: string;
}
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
    from: (table: string) => {
      const spec = specOf(state, table);
      if (spec.throws) throw new Error(spec.throws);
      return buildQuery(spec);
    },
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

/**
 * Public venues, so the flag-off comparison below runs over a NON-EMPTY object
 * list. Nothing Phase 7 does reads this table.
 */
const PLACE_ROWS: any[] = Array.from({ length: COHORT_ACTORS + 5 }, (_, i) => ({
  id: `pl-${i + 1}`,
  name: `Venue ${i + 1}`,
  // Clustered around CITY_A so §31 folds them into ONE activity zone at the
  // city band — a lone venue is suppressed for k-anonymity and would leave the
  // comparison empty again.
  latitude: CITY_A.lat + i * 0.001,
  longitude: CITY_A.lng + i * 0.001,
  status: "active",
  merged_into_place_id: null,
  primary_category: "cafe",
  city: CITY_A.name,
  neighborhood: null,
  country_code: "VN",
  updated_at: "2026-09-01T00:00:00.000Z",
}));

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
      // ── ANOTHER PERSON'S HISTORY, DELIBERATELY IN CURATED GEOGRAPHY ────────
      // A stranger row in an UNCURATED city is excluded by the `unplaced` path
      // whether or not `.eq("user_id", viewerId)` runs, so it can never show
      // that the owner filter is doing anything. These two are inside the
      // viewport's own curated cities, which leaves the owner predicate as the
      // ONLY thing that can keep them out:
      //   s4  a city the viewer has NEVER been to  ⇒ an unfiltered read
      //       publishes a THIRD personal_city pin.
      //   s5  the viewer's OWN city                ⇒ an unfiltered read inflates
      //       CITY_A's stampCount from 2 to 3, which no per-city filter could
      //       ever correct.
      stampRow("s4", OTHER_USER, CITY_C.name, "2026-06-07T00:00:00.000Z"),
      stampRow("s5", OTHER_USER, CITY_A.name, "2026-07-08T00:00:00.000Z"),
      // …and one in a city with no curated geography, so the sentinel grep
      // covers the drop path too.
      stampRow("s6", OTHER_USER, STRANGER_CITY, "2026-08-09T00:00:00.000Z"),
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

/**
 * `extraQuery` is appended verbatim (leading `&` included). It exists for ONE
 * purpose: driving request parameters that must NOT be able to change the
 * answer — see the 2182 test below.
 */
async function projection(state: FakeState, kinds = ALL_KINDS, zoom = ZOOM, extraQuery = "") {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${BBOX}&zoom=${zoom}&kinds=${kinds}${extraQuery}`);
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

  it("personal_city is deliberately NOT an ambient-presence kind either", () => {
    // THE SIBLING LIST, CONSIDERED RATHER THAN OMITTED. An omitted kind in a
    // per-kind list is this codebase's most-repeated Map defect (it is how the
    // `prediction` hole reached the wire), so the absence is pinned here with
    // the reasoning attached rather than left to be rediscovered.
    //
    // AMBIENT_PRESENCE_KINDS escalates coarsen⇒suppress for objects that assert
    // A PERSON WAS AT THE PROTECTED PLACE, because that association survives
    // every amount of coordinate blurring. `memory` qualifies exactly: it is a
    // VENUE-level pin whose title is the venue's own name, so a coarsened
    // memory snapped to the zone anchor still reads "you have a history with
    // this clinic".
    //
    // `personal_city` cannot make that assertion. Its geometry is a CITY
    // CENTROID, its title is the city's label and its payload names a cityKey,
    // a country and the viewer's own stamp count — the association it publishes
    // is with a CITY, never with a place inside one. Snapping a city centroid
    // to a zone anchor removes nothing because there was nothing place-shaped
    // to remove, and "you have been to Da Nang" is not a fact any protected
    // zone exists to withhold. Owner-onlyness is NOT the discriminator here —
    // `memory` is owner-only too; the discriminator is what the object asserts
    // about the protected place.
    //
    // It still follows the zone's own action, so inside a SUPPRESS-class zone
    // it is withheld like anything else. That is asserted by execution below.
    assert.ok(AMBIENT_PRESENCE_KINDS.includes("memory"), "memory left the ambient list");
    assert.equal(AMBIENT_PRESENCE_KINDS.includes("personal_city" as any), false);
    // Not in either escalation table — one statement, so a future edit that
    // moves it into one has to come here and say why.
    assert.equal(COARSEN_UNSAFE_KINDS.includes("personal_city" as any), false);

    // The decision is only defensible while personal_city stays a CITY-CENTROID
    // object with no venue in it. Pin the two properties the reasoning rests on.
    const coarsenZone: ProtectedZone = {
      id: "z", category: "medical_facility", shape: "circle",
      center: { lat: CITY_A.lat, lng: CITY_A.lng }, radiusMeters: 50_000,
    };
    const cityPin: MapObject = {
      id: "mycity:city-a", kind: "personal_city", geometry: point(CITY_A.lat, CITY_A.lng),
      title: CITY_A.name, privacyClass: "place_level", renderingPriority: 30,
    };
    const memoryPin: MapObject = { ...cityPin, id: "memory:m1", kind: "memory" };
    // Same zone, same coordinate, different answers — which is the whole
    // content of the decision.
    assert.equal(classifyAgainstProtected(cityPin, [coarsenZone]).action, "coarsen");
    assert.equal(classifyAgainstProtected(memoryPin, [coarsenZone]).action, "suppress");
    // …and a SUPPRESS-class zone still takes the city pin.
    const shelter: ProtectedZone = { ...coarsenZone, category: "shelter" };
    assert.equal(classifyAgainstProtected(cityPin, [shelter]).action, "suppress");
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
    // ZOOM 12, NOT 14, AND THE DIFFERENCE IS THE WHOLE TEST. The pulse grid is
    // drawn WORLD_PULSE_ZOOM_OFFSET steps coarser, so zoom 14 grids at 12 —
    // where CELL_SIZE_DEGREES_BY_ZOOM is null and `cellFor` returns null, which
    // drops every contributor on its own. At 14 this test passed with the band
    // gate DELETED: it was pinned at the one district zoom where it could not
    // fail. Zoom 12 grids at 10, a real cell, so the band gate is the only
    // thing left that can produce nothing.
    const res = deriveWorldPulse([zoneObj("az:1", 200)], { bbox: PULSE_BBOX, zoom: 12 });
    assert.equal(res.report.band, "district");
    assert.ok(
      res.report.cellSizeDegrees !== null,
      "the grid was unusable at this zoom, so the band gate is not what refused",
    );
    assert.equal(res.pulses.length, 0);
    assert.equal(res.report.cells, 0, "a contributor was binned below the city band");
    // The whole district band, both ends: 12 has a usable grid, 14 does not, and
    // neither may publish.
    for (const zoom of [12, 13, 14]) {
      assert.equal(
        deriveWorldPulse([zoneObj("az:1", 200)], { bbox: PULSE_BBOX, zoom }).pulses.length,
        0,
        `zoom ${zoom} published below the city band`,
      );
    }
    // …and the band immediately above it does publish, so "nothing" is the
    // band's answer rather than the fixture's.
    assert.equal(
      deriveWorldPulse([zoneObj("az:1", 200)], { bbox: PULSE_BBOX, zoom: 11 }).pulses.length,
      1,
    );
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

/**
 * A transition that clears every privacy clause, so each test below removes
 * exactly one property and nothing else can explain the result.
 */
function transition(nowMs: number, over: Partial<ZoneTransition> = {}): ZoneTransition {
  return {
    fromZoneId: CITY_A.id,
    toZoneId: CITY_B.id,
    from: { lat: CITY_A.lat, lng: CITY_A.lng },
    to: { lat: CITY_B.lat, lng: CITY_B.lng },
    distinctActors: COHORT_ACTORS,
    distinctGroups: PRIVACY_THRESHOLD_V1.minIndependentGroups,
    maxGroupShare: PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
    signalFamilies: ["accepted_plan"],
    observedAt: isoAgo(nowMs, ACCEPTED_AGO_MS),
    ...over,
  } as ZoneTransition;
}

describe("an edge never claims more than its evidence supports", () => {
  it("a single-family edge is CAPPED even when its transition declares more", async () => {
    // WHY THIS IS A UNIT TEST. Through the route the cap is invisible:
    // `deriveZoneTransitions` already scores a one-family transition at the
    // weakest band, so `weaker(declared, cap)` returns the same value with or
    // without the cap and deleting the cap left the whole suite green. The cap
    // exists precisely for the case that fixture cannot reach — a transition
    // that arrives declaring a STRONGER band — so that is what is driven here.
    const nowMs = Date.now();
    const strongest = CONFIDENCE_STATES[CONFIDENCE_STATES.length - 1];
    assert.notEqual(strongest, SINGLE_FAMILY_CONFIDENCE_CAP, "the ladder collapsed to one rung");

    const { edges } = deriveTravelerFlowEdges(
      [transition(nowMs, { confidence: strongest, signalFamilies: ["accepted_plan"] })],
      { now: nowMs },
    );
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.equal(
      e.confidence,
      SINGLE_FAMILY_CONFIDENCE_CAP,
      "an uncorroborated edge published the confidence it was handed",
    );
    assert.ok(e.payload);
    assert.equal(e.payload.singleFamily, true);
    // The payload's own copy is capped too — a renderer reading either field
    // must get the same answer.
    assert.equal(e.provenance?.confidence, SINGLE_FAMILY_CONFIDENCE_CAP);
  });

  it("a CORROBORATED edge keeps its declared band, so the cap is not a blanket floor", () => {
    // The other side of the same rule: without this, "always return the cap"
    // would pass the test above.
    const nowMs = Date.now();
    const strongest = CONFIDENCE_STATES[CONFIDENCE_STATES.length - 1];
    const { edges } = deriveTravelerFlowEdges(
      [transition(nowMs, {
        confidence: strongest,
        signalFamilies: ["accepted_plan", "checkin", "live_signal"],
      })],
      { now: nowMs },
    );
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.ok(e.payload);
    assert.equal(e.payload.singleFamily, false);
    assert.equal(e.confidence, strongest);
  });

  it("an edge whose freshness cannot be established is not published", async () => {
    // §37 / §6: an object that carries a live band it did not earn is worse
    // than no object. A FUTURE observation (clock skew beyond the tolerance)
    // is perfectly DATEABLE — `toEpochMs` succeeds — but `deriveFreshness`
    // returns 'unknown', and the producer refuses it.
    //
    // Under PRIVACY_THRESHOLD_V1 the publication-delay clause rejects a future
    // timestamp first, which is why the route-level fixture cannot reach this
    // gate. The threshold is an injected parameter, so the delay is set to zero
    // here to hand the freshness gate the decision on its own. Nothing else is
    // relaxed: k, groups and dominant-group share are the product's own.
    const nowMs = Date.now();
    const noDelay = { ...PRIVACY_THRESHOLD_V1, publicationDelayMinutes: 0 };

    const future = deriveTravelerFlowEdges(
      [transition(nowMs, { observedAt: new Date(nowMs + 10 * 60_000).toISOString() })],
      { now: nowMs, threshold: noDelay },
    );
    assert.equal(future.edges.length, 0, "an edge with unknown freshness was published");
    assert.deepEqual(future.rejected.map((r) => r.reason), ["undateable"]);

    // NOT VACUOUS: the identical transition with a dateable past observation
    // publishes under the same relaxed threshold, so the freshness gate is what
    // refused and not the delay change.
    const past = deriveTravelerFlowEdges([transition(nowMs)], { now: nowMs, threshold: noDelay });
    assert.equal(past.edges.length, 1);
    assert.notEqual(past.edges[0].freshness, "unknown");
  });
});

describe("a single traveller can never be resolved from a flow edge", () => {
  it("k-1 accepters publish nothing", async () => {
    const nowMs = Date.now();
    const plans = planRows(nowMs, { count: COHORT_ACTORS - 1 });
    const { body } = await projection(worldState(nowMs, plans), "traveler_flow");
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    assert.equal(body.worldIntelligence.travelerFlow.published, 0);
    // …and the REPORT does not make up for it. A sub-k cohort is counted
    // nowhere; see "the report is gated by the same floor as the objects".
    assert.equal(body.worldIntelligence.travelerFlow.publishableButUnusable, 0);
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
// 2b. THE REPORT IS GATED BY THE SAME FLOOR AS THE OBJECTS.
//
// The objects clear k or they do not exist. The REPORT used to publish raw
// per-viewport counts of the ungated rows behind them (`hops`, `hopsSkipped`,
// `transitions`, `withheld`), and `bbox` picks the cities those counts are
// taken over — so a two-city viewport turned "1 pair withheld" into "exactly
// this many people, below the floor, moved Da Nang → Bangkok", and a wider
// second request differenced the rest out. Nothing was served in either case.
//
// The fixture below is that disclosure, at its floor: ONE person A→B and THREE
// A→C, so every pair is sub-k and NO object may exist at any viewport.
// ─────────────────────────────────────────────────────────────────────────────

/** A+B in view, C outside it EVEN AFTER `expandBbox` grows it one viewport. */
const BBOX_AB_ONLY = "104.0,13.0,109.0,17.0";
/** A alone, same expansion rule. */
const BBOX_A_ONLY = "107.5,15.5,108.9,16.6";

async function projectionAt(state: FakeState, bbox: string, kinds = "traveler_flow") {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${bbox}&zoom=${ZOOM}&kinds=${kinds}`);
}

/** 1 consented person A→B and 3 A→C. Every pair below k; nothing publishable. */
function subKWorld(nowMs: number) {
  return worldState(
    nowMs,
    mergePlans(
      planRows(nowMs, { count: 1, prefix: "ab", from: STOP_IN_A, to: STOP_IN_B, offset: 0 }),
      planRows(nowMs, { count: 3, prefix: "ac", from: STOP_IN_A, to: STOP_IN_C, offset: 100 }),
    ),
  );
}

/** The same world with the LONE A→B traveller removed. Nothing else changes. */
function subKWorldWithoutTheOne(nowMs: number) {
  return worldState(
    nowMs,
    planRows(nowMs, { count: 3, prefix: "ac", from: STOP_IN_A, to: STOP_IN_C, offset: 100 }),
  );
}

describe("the traveler-flow REPORT is gated by the same floor as its objects", () => {
  it("publishes no raw hop, skip or transition count — at any viewport", async () => {
    // `hops` and `hopsSkipped` had NO test at all. They count LEGS, so no band
    // could rescue them either: fifteen legs can be one person's fifteen trips.
    const nowMs = Date.now();
    for (const bbox of [BBOX, BBOX_AB_ONLY, BBOX_A_ONLY]) {
      const { body } = await projectionAt(subKWorld(nowMs), bbox);
      const flow = body.worldIntelligence.travelerFlow;
      assert.ok(flow, `no traveler-flow report at bbox ${bbox}`);
      for (const banned of ["hops", "hopsSkipped", "transitions", "withheld"]) {
        assert.ok(
          !(banned in flow),
          `"${banned}" is a viewport-scoped count of UNGATED rows and reached the wire at ${bbox}`,
        );
      }
      assert.deepEqual(Object.keys(flow).sort(), [
        "publishableButUnusable", "published", "refusal",
      ]);
    }
  });

  it("a sub-k world reports IDENTICALLY to a world with nobody in it", async () => {
    // THE PROPERTY. One consented person with an accepted Da Nang → Bangkok
    // plan must be indistinguishable from none, at the viewport that names
    // exactly those two cities and nothing else.
    const nowMs = Date.now();
    const withOne = await projectionAt(subKWorld(nowMs), BBOX_AB_ONLY);
    const withNone = await projectionAt(subKWorldWithoutTheOne(nowMs), BBOX_AB_ONLY);
    assert.equal(ofKind(withOne.body, "traveler_flow").length, 0);
    assert.equal(ofKind(withNone.body, "traveler_flow").length, 0);
    assert.deepEqual(
      withOne.body.worldIntelligence.travelerFlow,
      withNone.body.worldIntelligence.travelerFlow,
      "the lone A→B traveller changed the report, so the report discloses them",
    );
  });

  it("two overlapping viewports cannot be DIFFERENCED into a pair count", async () => {
    // The wide viewport sees A, B and C; the narrow one only A and B. Before
    // the fix these answered `hops:4 … withheld:2` and `hops:1 … withheld:1`,
    // and 4 − 1 = 3 named the size of the Da Nang → Kuala Lumpur cohort.
    // Every pair here is sub-k, so all three viewports must agree — and agree
    // with the report over an EMPTY world, which is the only honest answer.
    const nowMs = Date.now();
    const world = subKWorld(nowMs);
    const wide = await projectionAt(world, BBOX);
    const narrow = await projectionAt(world, BBOX_AB_ONLY);
    const single = await projectionAt(world, BBOX_A_ONLY);
    const empty = await projectionAt(
      worldState(nowMs, { route_plans: [], route_stops: [], route_legs: [] }),
      BBOX,
    );
    for (const r of [wide, narrow, single, empty]) {
      assert.equal(ofKind(r.body, "traveler_flow").length, 0);
    }
    const reportOf = (r: any) => r.body.worldIntelligence.travelerFlow;
    assert.deepEqual(reportOf(wide), reportOf(narrow));
    assert.deepEqual(reportOf(narrow), reportOf(single));
    assert.deepEqual(reportOf(single), reportOf(empty));
    // NOT VACUOUS: the same three viewports over a world that DOES clear the
    // floor differ, so the reports are not simply constant.
    const busy = await projectionAt(worldState(nowMs), BBOX);
    assert.equal(reportOf(busy).published, 1);
  });

  it("`publishableButUnusable` counts only pairs that already cleared every gate", async () => {
    // The one thing the report may still say out loud: "a pair we were allowed
    // to publish was lost to a defect in the data". Pure-producer level, so the
    // defect can be injected exactly.
    const nowMs = Date.now();
    const broken = deriveTravelerFlowEdges(
      [transition(nowMs, { to: { lat: Number.NaN, lng: CITY_B.lng } } as any)],
      { now: nowMs },
    );
    assert.equal(broken.edges.length, 0);
    assert.deepEqual(broken.rejected.map((r) => r.reason), ["invalid_geometry"]);
    assert.equal(broken.publishableButUnusable, 1);

    // …and a SUB-K pair with the identical defect is counted NOWHERE, which is
    // the whole distinction.
    const subK = deriveTravelerFlowEdges(
      [transition(nowMs, {
        distinctActors: WORLD_INTELLIGENCE_K - 1,
        to: { lat: Number.NaN, lng: CITY_B.lng },
      } as any)],
      { now: nowMs },
    );
    assert.equal(subK.edges.length, 0);
    assert.equal(subK.rejected.length, 1);
    assert.equal(subK.publishableButUnusable, 0, "a sub-k pair was counted on the wire");

    // Nor is a pair the privacy gate refused for a NON-cohort reason: the
    // refusal itself would state that a full cohort moved between two named
    // cities before the publication delay let it be said.
    const tooFresh = deriveTravelerFlowEdges(
      [transition(nowMs, { observedAt: new Date(nowMs).toISOString() })],
      { now: nowMs },
    );
    assert.deepEqual(tooFresh.rejected.map((r) => r.reason), ["privacy_gate"]);
    assert.equal(tooFresh.publishableButUnusable, 0);
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
    const mine = ofKind(body, "personal_city");
    // NOT VACUOUS: the viewer's OWN summaries must be present, or an empty
    // response would satisfy every absence check below.
    assert.equal(mine.length, 2);

    // ── WHAT MAKES THE OWNER PREDICATE LOAD-BEARING ──────────────────────────
    // Greps alone cannot do it: a stranger's row in an uncurated city never
    // reaches the payload anyway, so an absence check passes with the owner
    // filter deleted. These two assertions read the CONTENT the filter decides.
    // The stranger holds stamps in CITY_C (a curated city the viewer has never
    // visited) and in CITY_A (the viewer's own), so removing
    // `.eq("user_id", viewerId)` publishes a third pin AND raises CITY_A's
    // stampCount to 3. Both are asserted.
    assert.deepEqual(
      mine.map((m: any) => m.payload.cityLabel).sort(),
      [CITY_A.name, CITY_B.name].sort(),
      "a city only ANOTHER user has stamps in was published",
    );
    const a = mine.find((m: any) => m.payload.cityLabel === CITY_A.name);
    assert.ok(a);
    assert.equal(a.payload.stampCount, 2, "another user's stamps were counted into the viewer's city");

    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(OTHER_USER), "another user's id reached the wire");
    assert.ok(!wire.includes(STRANGER_CITY), "another user's city reached the wire");
    assert.ok(!wire.includes(CITY_C.name), "a city only another user has been to reached the wire");
    for (const id of ["s4", "s5", "s6"]) {
      assert.ok(!wire.includes(`"${id}"`), `another user's stamp id ${id} reached the wire`);
    }
  });

  it("the owner is the SESSION identity — no request parameter can redirect it (2182)", async () => {
    // THE 2182 LESSON, MADE EXECUTABLE. personalCityProducer's header and the
    // route's own comment both say the owner "must never come from a query
    // parameter", and until this test nothing checked it: swapping `user.id`
    // for `req.query.viewerId` left the whole suite green.
    //
    // Every plausible spelling is sent at once, naming the OTHER user, whose
    // curated-city stamps would produce a visibly different answer. The result
    // must be identical to the request that named nobody.
    const state = worldState(Date.now());
    const clean = await projection(state, "personal_city");
    const spoof = [
      "viewerId", "viewer_id", "userId", "user_id", "ownerId", "owner_id", "asUser",
    ].map((p) => `&${p}=${encodeURIComponent(OTHER_USER)}`).join("");
    const spoofed = await projection(state, "personal_city", ZOOM, spoof);

    assert.equal(spoofed.status, 200);
    assert.deepEqual(
      ofKind(spoofed.body, "personal_city").map((m: any) => m.payload.cityLabel).sort(),
      [CITY_A.name, CITY_B.name].sort(),
      "a query parameter changed whose history was read",
    );
    assert.deepEqual(spoofed.body.objects, clean.body.objects);
    assert.deepEqual(spoofed.body.worldIntelligence.personalCities, clean.body.worldIntelligence.personalCities);
    assert.ok(!JSON.stringify(spoofed.body).includes(CITY_C.name));
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

  it("the RENDERED map is identical to one where Phase 7 was never asked for", async () => {
    // THE CLAIM, STATED ACCURATELY. The response is NOT byte-identical to the
    // pre-Phase-7 one and this test does not pretend it is: a default
    // projection now always carries a top-level `worldIntelligence` key, which
    // with the flag off holds `refusal: "flag_off"`. That is deliberate — the
    // report's whole job is to keep "the gates said no" distinguishable from
    // "nothing asked" — and it is the same shape `crowdFlow`, `producers` and
    // `places` already added. What IS unchanged is everything the RENDERER
    // consumes: the object list and every pre-existing report field.
    //
    // The comparison is made over a NON-EMPTY object list on purpose. An
    // earlier version compared two empty arrays, which would have held equally
    // well if the whole projection were broken.
    const nowMs = Date.now();
    const flagOff = worldState(nowMs, {
      feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
      places: PLACE_ROWS,
    });
    const asked = await projection(flagOff, `${ALL_KINDS},place`);
    const notAsked = await projection(flagOff, "place");

    assert.ok(asked.body.objects.length > 0, "the pre-Phase-7 map produced nothing to compare");
    assert.deepEqual(asked.body.objects, notAsked.body.objects);
    for (const field of ["aggregation", "protection", "liveEnrichment", "crowdFlow", "total"]) {
      assert.deepEqual(asked.body[field], notAsked.body[field], `${field} differed`);
    }
    // The ONE documented difference, asserted rather than glossed: the
    // diagnostic key, and nothing else.
    const strip = (b: any) => {
      // `generatedAt` is a clock reading and legitimately differs between two
      // requests; it is not part of the claim.
      const { worldIntelligence, generatedAt, ...rest } = b;
      return rest;
    };
    assert.deepEqual(strip(asked.body), strip(notAsked.body));
    assert.equal(asked.body.worldIntelligence.refusal, "flag_off");
    assert.equal(notAsked.body.worldIntelligence, null);
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

  it("an unreadable stamp table publishes no personal city, AND says so", async () => {
    const { body } = await projection(
      worldState(Date.now(), { passport_stamps: { error: { message: "boom" } } }),
      "personal_city",
    );
    assert.equal(ofKind(body, "personal_city").length, 0);
    assert.equal(body.worldIntelligence.personalCities, null);
    // "WE COULD NOT LOOK" MUST NOT READ AS "NOTHING HERE". `personalCities:
    // null` is also what a request that never asked for the layer produces, so
    // without a refusal the two are indistinguishable — which is the exact
    // confusion this report exists to prevent.
    assert.equal(body.worldIntelligence.refusal, "read_failed");
  });

  it("a THROWN personal-city read is a refusal, not a silent absence", async () => {
    // The other failure shape: the route wraps the read in `.catch(() => null)`,
    // and that arm used to set nothing at all.
    const { body } = await projection(
      worldState(Date.now(), { passport_stamps: { throws: "connection reset" } }),
      "personal_city",
    );
    assert.equal(ofKind(body, "personal_city").length, 0);
    assert.equal(body.worldIntelligence.personalCities, null);
    assert.equal(body.worldIntelligence.refusal, "read_failed");
    assert.ok(!body.sources.includes("personal_cities"));
  });

  it("a THROWN city-model read is a refusal, not a zero-count report", async () => {
    // This arm wrote `modelsRead: 0, published: 0` and left `refusal` null: a
    // city with no published aggregate and a city we could not ask about
    // rendered identically. The traveler-flow arm beside it already did this
    // correctly; this is the same shape.
    const { body } = await projection(
      worldState(Date.now(), { compass_city_models: { throws: "connection reset" } }),
      "city_model",
    );
    assert.equal(ofKind(body, "city_model").length, 0);
    assert.equal(body.worldIntelligence.refusal, "read_failed");
    // The counts still travel — they say what was ATTEMPTED — but they can no
    // longer be mistaken for an answer.
    assert.equal(body.worldIntelligence.cityModels.published, 0);
    assert.ok(!body.sources.includes("city_models"));
  });

  it("a THROWN traveler-flow read already refuses, and still does", async () => {
    // The arm the two above were made to match. Pinned so a future edit cannot
    // regress the one that was right.
    const { body } = await projection(
      worldState(Date.now(), { route_plans: { throws: "connection reset" } }),
      "traveler_flow",
    );
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    // The producer names WHICH read failed; what matters is that a refusal is
    // present at all rather than a zero-count report with none.
    assert.match(String(body.worldIntelligence.travelerFlow.refusal), /read_failed/);
    assert.ok(!body.sources.includes("traveler_flow"));
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
      worldState(Date.now(), { protected_zones: [zoneRow({ at: CITY_B })] }),
      "traveler_flow,city_model",
    );
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    const labels = ofKind(body, "city_model").map((m: any) => m.payload.cityLabel);
    assert.ok(!labels.includes(CITY_B.name), "a suppressed city still published its model");
    assert.ok(body.worldIntelligence.withheldForProtection >= 1);
  });

  it("`published` is what SURVIVED §24, not what the producer minted", async () => {
    // Each producer counts its own output BEFORE the §24 gate runs over it, and
    // the crowd-flow arm has always subtracted its removals. Phase 7 did not:
    // a legitimate, fully k-clearing A→B cohort under a zone covering city B
    // reported `published: 1` beside an EMPTY objects array — #393's "the kept
    // count included the suppressed objects", one layer along.
    const { body } = await projection(
      worldState(Date.now(), { protected_zones: [zoneRow({ at: CITY_B })] }),
      "traveler_flow,personal_city",
    );
    assert.equal(ofKind(body, "traveler_flow").length, 0);
    assert.equal(
      body.worldIntelligence.travelerFlow.published, 0,
      "a report claimed a published edge §24 had already removed",
    );
    // …and the companion count still discloses the removal honestly, so the
    // reconciliation shrinks `published` rather than hiding the event.
    assert.ok(body.worldIntelligence.withheldForProtection >= 1);
    // NOT VACUOUS: the untouched city's own pin still publishes AND is still
    // counted, so the subtraction is per-kind and not a blanket zeroing.
    const pins = ofKind(body, "personal_city");
    assert.deepEqual(pins.map((p: any) => p.payload.cityLabel), [CITY_A.name]);
    assert.equal(body.worldIntelligence.personalCities.published, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. §24 over Phase 7's OWN output — the gate, not just the pre-filter.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One protected-zone row. `category`/`action`/`floor` default to a plain
 * SUPPRESS-class shelter; the radius comfortably covers the named city centroid
 * without reaching any other city (the three are thousands of km apart).
 */
function zoneRow(opts: {
  at: { lat: number; lng: number };
  id?: string;
  category?: string;
  action?: string | null;
  floor?: string | null;
  offsetDeg?: number;
}): any {
  const d = opts.offsetDeg ?? 0;
  return {
    id: opts.id ?? "pz-1",
    category: opts.category ?? "shelter",
    action: opts.action ?? null,
    privacy_floor: opts.floor ?? null,
    shape: "circle",
    center_lat: opts.at.lat + d,
    center_lng: opts.at.lng + d,
    radius_meters: 50_000,
    ring: null,
    jurisdiction: null,
    policy_ref: null,
    active: true,
  };
}

describe("the §24 gate itself runs over Phase 7 output, not only the pre-filter", () => {
  // WHY THIS BLOCK EXISTS. The §24 test above uses `traveler_flow` and
  // `city_model`, both of which `withholdCoarsenableAggregates` removes BEFORE
  // `applyProtection` is ever reached — so replacing `applyProtection` with a
  // pass-through left it, and the whole suite, green. `personal_city` is
  // deliberately absent from COARSEN_UNSAFE_KINDS, so the pre-filter passes it
  // through untouched and `applyProtection` is the ONLY thing that can act on
  // it. Every test here is therefore a direct measurement of the gate.
  //
  // This is not hypothetical bookkeeping: on the sibling Map unit #393 a filter
  // running on the wrong side of `applyProtection` was proven by execution to
  // publish protected coordinates.

  it("a SUPPRESS zone removes an object the pre-filter never touches", async () => {
    const { body } = await projection(
      worldState(Date.now(), { protected_zones: [zoneRow({ at: CITY_A })] }),
      "personal_city",
    );
    const labels = ofKind(body, "personal_city").map((m: any) => m.payload.cityLabel);
    // NOT VACUOUS: the city OUTSIDE the zone must still publish, or an empty
    // layer (a broken pipeline) would satisfy the absence check.
    assert.deepEqual(labels, [CITY_B.name]);
    assert.equal(body.worldIntelligence.withheldForProtection, 1);
  });

  it("a COARSEN zone rewrites the object rather than publishing it as minted", async () => {
    // A coarsen-class category. `personal_city` is in neither escalation table,
    // so it takes the zone's own action: it survives, snapped to the ZONE's
    // anchor and dropped to the category's privacy floor. Both are properties
    // only `coarsenForZone` — reached only through `applyProtection` — produces.
    const { body } = await projection(
      worldState(Date.now(), {
        protected_zones: [zoneRow({ at: CITY_A, category: "medical_facility", offsetDeg: 0.1 })],
      }),
      "personal_city",
    );
    const pins = ofKind(body, "personal_city");
    assert.equal(pins.length, 2, "the coarsen path dropped an object it should have kept");
    const a = pins.find((m: any) => m.payload.cityLabel === CITY_A.name);
    assert.ok(a, "the city inside the coarsen zone disappeared instead of being coarsened");
    assert.equal(a.privacyClass, "approximate", "the object kept its minted precision rung");
    // Compared with a tolerance: `zoneAnchor` runs the longitude through
    // `normalizeLng`, whose modular arithmetic is not bit-exact.
    const near = (got: number, want: number) => Math.abs(got - want) < 1e-9;
    assert.ok(
      near(a.geometry.coordinates[0], CITY_A.lng + 0.1) &&
        near(a.geometry.coordinates[1], CITY_A.lat + 0.1),
      `the object kept its own coordinate instead of the zone anchor: ${JSON.stringify(a.geometry.coordinates)}`,
    );
    // …and the city outside the zone was NOT rewritten.
    const b = pins.find((m: any) => m.payload.cityLabel === CITY_B.name);
    assert.equal(b.privacyClass, "place_level");
    assert.deepEqual(b.geometry.coordinates, [CITY_B.lng, CITY_B.lat]);
  });

  it("an object coarsened onto the `none` rung never reaches the wire", async () => {
    // `policy_defined` is the one category whose row IS the policy, so it can
    // ask for COARSEN with a floor of `none` — the rung `isServable` refuses.
    // The object therefore takes the coarsen path and is then withheld at the
    // wire boundary, which is the composite §39/§24 invariant.
    const { body } = await projection(
      worldState(Date.now(), {
        protected_zones: [
          zoneRow({ at: CITY_A, category: "policy_defined", action: "coarsen", floor: "none" }),
        ],
      }),
      "personal_city",
    );
    const pins = ofKind(body, "personal_city");
    assert.deepEqual(pins.map((m: any) => m.payload.cityLabel), [CITY_B.name]);
    for (const p of pins) assert.notEqual(p.privacyClass, "none");
    assert.equal(body.worldIntelligence.withheldForProtection, 1);
  });

  it("the gate is not bypassed by asking for every kind at once", async () => {
    // The pre-filter and the gate must BOTH run in one request: the aggregate
    // kinds go by escalation, personal_city goes by the gate, and the count is
    // the sum rather than either half.
    const { body } = await projection(
      worldState(Date.now(), { protected_zones: [zoneRow({ at: CITY_A })] }),
      ALL_KINDS,
    );
    for (const o of body.objects) {
      const c = o.geometry?.type === "Point" ? o.geometry.coordinates : null;
      if (c) {
        assert.ok(
          Math.abs(c[1] - CITY_A.lat) > 0.5 || Math.abs(c[0] - CITY_A.lng) > 0.5,
          `a Phase 7 object survived inside the protected zone: ${o.id}`,
        );
      }
    }
    assert.ok(body.worldIntelligence.withheldForProtection >= 1);
  });
});
