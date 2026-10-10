/**
 * §10 Crowd Flow through the Map Intelligence Gateway (Map spec §10 + §19).
 *
 * WHAT THIS SUITE IS FOR, AND WHY THE POSITIVE TEST IS THE ONE THAT MATTERS
 * ========================================================================
 * §10 was built end to end — producer, two independent signal families, four
 * gates, tests — and NOTHING COULD ASK FOR IT: no route called
 * `produceZoneTransitions` or `deriveCrowdFlow`, so no client could ever be
 * served a flow. `map_crowd_flow_enabled` is also seeded FALSE and both
 * contribution-consent tables are empty, which means a live call today returns
 * no crowd flow AND WOULD HAVE RETURNED NO CROWD FLOW EVEN IF THE WIRING WERE
 * COMPLETELY BROKEN. Those two states are indistinguishable from outside, and
 * that is exactly how this class of defect survives.
 *
 * So the load-bearing test here is the POSITIVE one: a synthetic cohort that
 * clears every gate — two families, past the k floor, inside the freshness
 * window, past the publication delay, no dominant group — driven through the
 * REAL HTTP route, asserting that a `crowd_flow` MapObject actually arrives.
 * Every negative test below removes exactly one of those and asserts it
 * disappears. Without the positive test, a permanently-broken pipeline would
 * pass every single negative one.
 *
 * NOTHING HERE RELAXES A GATE. The fixtures are built to SATISFY
 * PRIVACY_THRESHOLD_V1 as it stands (15 distinct actors, 5 independent groups,
 * max 20% single-group share, 10-minute publication delay) and
 * MIN_SIGNAL_FAMILIES as it stands (2). The suite asserts those constants have
 * not moved.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapCrowdFlowLayer.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

// The accepted_plan family derives an HMAC party token and REFUSES to read
// without a secret (`no_group_key_secret`). Set before any route runs; the real
// server gets this from a required env var.
process.env.INTEL_GROUP_KEY_SECRET =
  process.env.INTEL_GROUP_KEY_SECRET ?? "crowd-flow-layer-test-secret";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import {
  MIN_SIGNAL_FAMILIES,
  MIN_FLOW_COHORT_PER_BUCKET,
  FLOW_DENSITY_BUCKET_MINUTES,
} from "../lib/mapAggregation.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import {
  MIN_FLOW_ZONE_EXTENT_METERS,
  FLOW_ZONE_TYPES,
  parseFlowZones,
  attachFlowEndpoints,
  MIN_FLOW_ENDPOINT_PLACES,
  MAX_FLOW_ENDPOINT_PLACE_IDS,
} from "../lib/mapProjection.js";
import { SIGNAL_MAX_AGE_MINUTES } from "../lib/crowdFlowProducer.js";
import { captureProtection } from "./helpers/protectionTelemetry.js";

// §24 counts are server telemetry now, not the response (lib/mapProtectionTelemetry.ts):
// with one circle member, `protection.suppressed: 1` on the wire disclosed that the
// member was inside a protected zone. Read from the telemetry sink, cleared per test.
const protectionTelemetry = captureProtection();
beforeEach(() => protectionTelemetry.clear());

// ── ids and sentinels ─────────────────────────────────────────────────────────

const TOKEN = "crowd-flow-test-token";
const USER = "crowd-flow-viewer";

/**
 * SENTINELS. Every one of these is a value that MUST NOT reach the wire, chosen
 * to be greppable: an actor id, a party token, a place id and the two raw stop
 * coordinates a route plan is made of. `JSON.stringify` of the whole response
 * is searched for each of them.
 */
const ACTOR = (n: number) => `actor-sentinel-${n}`;
const GROUP = (n: number) => `groupkey-sentinel-${n}`;
const ORIGIN_PLACE_ID = "place-sentinel-origin";
/** The raw coordinates of the route stops. Deliberately unmistakable digits. */
const STOP_FROM = { lat: 16.0491234, lng: 108.2013579 };
const STOP_TO = { lat: 16.0609876, lng: 108.2197531 };
/** The origin PLACE's own coordinate — public geography, still never served. */
const PLACE_POINT = { lat: 16.0507654, lng: 108.2004321 };

/** The two curated zones. Round centroids, so no sentinel digit can hide in one. */
const ZONE_A = { id: "zone-a", name: "An Thuong", lat: 16.05, lng: 108.2 };
const ZONE_B = { id: "zone-b", name: "Han Riverside", lat: 16.06, lng: 108.22 };
/** Only used by the A→B→C chaining test. */
const ZONE_C = { id: "zone-c", name: "My Khe", lat: 16.07, lng: 108.24 };
const ZONE_RADIUS_M = 600;

/** A stop inside zone C, and the second origin place, for the chaining test. */
const STOP_IN_C = { lat: 16.0703691, lng: 108.2402581 };
const SECOND_PLACE_ID = "place-sentinel-second";
const SECOND_PLACE_POINT = { lat: 16.0602468, lng: 108.2201357 };

const BBOX = "108.0,15.9,108.4,16.2";

/**
 * The one instant every signal in the cohort is observed at.
 *
 * 15 minutes is not arbitrary. PRIVACY_THRESHOLD_V1 holds publication back for
 * 10 minutes and mapObjects calls anything older than 30 minutes no longer
 * `recent`, so a publishable flow lives in the 10–30 minute window. Every
 * signal shares ONE timestamp so the whole cohort lands in one 30-minute
 * density bucket — two timestamps straddling a bucket boundary would split the
 * cohort and the suite would be testing bucketing, not gates.
 */
const OBSERVED_AGO_MS = 15 * 60_000;

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec {
  rows?: any[];
  error?: { message: string };
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
    from: (table: string) => buildQuery(specOf(state, table)),
  };
}

// ── the cohort ────────────────────────────────────────────────────────────────

/**
 * A cohort that clears every §10 gate, built from the two families that are
 * actually wired:
 *
 *   next_stop_contribution  15 contributors standing at ORIGIN_PLACE_ID (which
 *                           sits inside zone A) naming zone B by name. Each
 *                           carries its OWN party token, so 15 independent
 *                           groups and a 1/15 = 6.7% max share.
 *   accepted_plan           3 of those same 15 people also accepted a route plan
 *                           whose legs run A → B. The overlap is deliberate: the
 *                           producer counts actors in a Set ACROSS families, so
 *                           the same person is one body in two families — which
 *                           is what lets the family gate be tested in isolation
 *                           further down without also dropping below k.
 */
const COHORT_ACTORS = PRIVACY_THRESHOLD_V1.minUniqueActors; // 15
const PLAN_ACTORS = 3;

function isoAgo(nowMs: number, agoMs: number): string {
  return new Date(nowMs - agoMs).toISOString();
}

interface NextMoveOpts {
  agoMs?: number;
  /** The place the contributor is standing at. Its zone becomes the ORIGIN. */
  placeId?: string;
  /** The coarse area they name. Its zone becomes the DESTINATION. */
  destination?: string;
}

function nextMoveRows(nowMs: number, count: number, opts: NextMoveOpts = {}): any[] {
  const agoMs = opts.agoMs ?? OBSERVED_AGO_MS;
  const observedAt = isoAgo(nowMs, agoMs);
  const expiresAt = new Date(nowMs - agoMs + SIGNAL_MAX_AGE_MINUTES * 60_000).toISOString();
  return Array.from({ length: count }, (_, i) => ({
    actor_id: ACTOR(i + 1),
    subject_id: opts.placeId ?? ORIGIN_PLACE_ID,
    // Left NULL on purpose: the live capture surface
    // (travel-buddy-standalone/app/intel/quick-signal.tsx) sends subjectId and
    // no zoneId, so the ORIGIN really does have to come from the place index.
    zone_id: null,
    value: { destinationArea: opts.destination ?? ZONE_B.name },
    group_key: GROUP(i + 1),
    observed_at: observedAt,
    expires_at: expiresAt,
    claim_type: "experience.next_move",
    moderation_state: "allowed",
  }));
}

interface PlanOpts {
  agoMs?: number;
  /** Distinguishes one set of plans from another in the same world. */
  prefix?: string;
  from?: { lat: number; lng: number };
  to?: { lat: number; lng: number };
}

function planRows(nowMs: number, count: number, opts: PlanOpts = {}): {
  route_plans: any[];
  route_stops: any[];
  route_legs: any[];
  route_flow_contribution_consent: any[];
} {
  const agoMs = opts.agoMs ?? OBSERVED_AGO_MS;
  const prefix = opts.prefix ?? "plan";
  const from = opts.from ?? STOP_FROM;
  const to = opts.to ?? STOP_TO;
  const acceptedAt = isoAgo(nowMs, agoMs);
  const stopTouchedAt = isoAgo(nowMs, agoMs + 60 * 60_000); // before acceptance
  const route_plans: any[] = [];
  const route_stops: any[] = [];
  const route_legs: any[] = [];
  const route_flow_contribution_consent: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const planId = `${prefix}-${i + 1}`;
    const actorId = ACTOR(i + 1); // deliberately one of the 15
    route_plans.push({
      id: planId,
      trip_id: null, // solo → its own party token, per lib/intelGroupKey
      accepted_by_user_id: actorId,
      accepted_at: acceptedAt,
      status: "active",
    });
    route_flow_contribution_consent.push({
      user_id: actorId,
      enabled: true,
      withdrawn_at: null,
    });
    route_stops.push(
      {
        id: `${planId}-from`,
        route_plan_id: planId,
        structured_location: { label: "start", ...from },
        updated_at: stopTouchedAt,
      },
      {
        id: `${planId}-to`,
        route_plan_id: planId,
        structured_location: { label: "end", ...to },
        updated_at: stopTouchedAt,
      },
    );
    route_legs.push({
      route_plan_id: planId,
      from_stop_id: `${planId}-from`,
      to_stop_id: `${planId}-to`,
    });
  }
  return { route_plans, route_stops, route_legs, route_flow_contribution_consent };
}

function zoneRow(z: { id: string; name: string; lat: number; lng: number }): any {
  return {
    id: z.id,
    name: z.name,
    zone_type: "neighborhood",
    center_lat: z.lat,
    center_lng: z.lng,
    radius_meters: ZONE_RADIUS_M,
    polygon_geojson: null,
  };
}

function zoneRows(): any[] {
  return [ZONE_A, ZONE_B].map(zoneRow);
}

function placeRow(id: string, point: { lat: number; lng: number }): any {
  return {
    id,
    latitude: point.lat,
    longitude: point.lng,
    status: "active",
    merged_into_place_id: null,
  };
}

/** The whole world, gates cleared. `over` replaces individual tables. */
function flowState(nowMs: number, over: FakeState = {}): FakeState {
  const plans = planRows(nowMs, PLAN_ACTORS);
  const actors = nextMoveRows(nowMs, COHORT_ACTORS);
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_crowd_flow_enabled", enabled: true },
    ],
    protected_zones: [],
    geo_zones: zoneRows(),
    places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT)],
    intel_observations: actors,
    intel_contribution_consent: actors.map((a) => ({
      user_id: a.actor_id,
      enabled: true,
      withdrawn_at: null,
    })),
    ...plans,
    blocks: [],
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
  // Both loaders cache for 30s; a stale cache would let one scenario answer
  // another scenario's question.
  _clearProtectedZoneCache();
  _clearFlowZoneCache();
});

/** Drive the real route over one fake world. */
async function projection(state: FakeState, query = `bbox=${BBOX}&zoom=14&kinds=crowd_flow`) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?${query}`);
}

const flowsIn = (body: any): any[] =>
  (body?.objects ?? []).filter((o: any) => o.kind === "crowd_flow");

// ─────────────────────────────────────────────────────────────────────────────
// 0. The gates this suite depends on, pinned. If one of these moves, the
//    fixtures below stop meaning what their comments say they mean.
// ─────────────────────────────────────────────────────────────────────────────

describe("the §10 gates are unchanged", () => {
  it("MIN_SIGNAL_FAMILIES is still 2", () => {
    assert.equal(MIN_SIGNAL_FAMILIES, 2);
  });

  it("the k floor, group floor and dominant-group ceiling are unchanged", () => {
    assert.equal(PRIVACY_THRESHOLD_V1.minUniqueActors, 15);
    assert.equal(PRIVACY_THRESHOLD_V1.minIndependentGroups, 5);
    assert.equal(PRIVACY_THRESHOLD_V1.maxSingleGroupShare, 0.2);
    assert.equal(PRIVACY_THRESHOLD_V1.publicationDelayMinutes, 10);
    assert.equal(MIN_FLOW_COHORT_PER_BUCKET, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(FLOW_DENSITY_BUCKET_MINUTES, PRIVACY_THRESHOLD_V1.timeBucketMinutes);
  });

  it("the freshness horizon is unchanged", () => {
    assert.equal(SIGNAL_MAX_AGE_MINUTES, 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE POSITIVE TEST. Gates cleared → the object arrives through the gateway.
// ─────────────────────────────────────────────────────────────────────────────

describe("a cohort that clears every §10 gate reaches the client", () => {
  it("serves a crowd_flow MapObject through GET /api/map/projection", async () => {
    const now = Date.now();
    const r = await projection(flowState(now));

    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);

    const flows = flowsIn(r.body);
    assert.equal(
      flows.length,
      1,
      `expected exactly one crowd_flow; crowdFlow report was ${JSON.stringify(r.body.crowdFlow)}`,
    );

    const flow = flows[0];
    assert.equal(flow.kind, "crowd_flow");
    assert.equal(flow.id, `flow:${ZONE_A.id}:${ZONE_B.id}`);
    // §10: aggregate movement between ZONES. The geometry is the two zone
    // centroids and nothing else — two positions, not a path.
    assert.equal(flow.geometry.type, "LineString");
    assert.deepEqual(flow.geometry.coordinates, [
      [ZONE_A.lng, ZONE_A.lat],
      [ZONE_B.lng, ZONE_B.lat],
    ]);
    assert.equal(flow.privacyClass, "aggregate_only");
    assert.equal(flow.freshness, "recent");
    assert.equal(flow.payload.observed.cohortSize, COHORT_ACTORS);
    assert.deepEqual(flow.payload.observed.signalFamilies, [
      "accepted_plan",
      "next_stop_contribution",
    ]);
    assert.equal(flow.payload.observed.fromZoneId, ZONE_A.id);
    assert.equal(flow.payload.observed.toZoneId, ZONE_B.id);
    // §10: observed and inferred are separately represented, and no cause was
    // supplied here, so the inferred half is explicitly null rather than absent.
    assert.equal(flow.payload.inferred, null);
  });

  it("reports the layer as an arriving source and counts it in the envelope", async () => {
    const now = Date.now();
    const r = await projection(flowState(now));
    assert.deepEqual(r.body.sources, ["crowd_flow"]);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.crowdFlow.refusal, null);
    assert.deepEqual(r.body.crowdFlow.familyRefusals, {
      accepted_plan: null,
      next_stop_contribution: null,
    });
    assert.equal(r.body.crowdFlow.transitions, 1);
    assert.equal(r.body.crowdFlow.published, 1);
    assert.equal(r.body.crowdFlow.withheld, 0);
    assert.equal(r.body.crowdFlow.zoneModel.zones, 2);
    assert.equal(r.body.crowdFlow.zoneModel.indexedPlaces, 1);
  });

  it("passes through the §31 pipeline rather than beside it", async () => {
    const now = Date.now();
    const r = await projection(flowState(now));
    const flow = flowsIn(r.body)[0];
    // Ranked (a rendering priority and a distance from the viewport centre were
    // attached), aggregation accounted for it, and the protection gate saw it.
    assert.ok(Number.isFinite(flow.renderingPriority));
    assert.ok(typeof flow.distanceKm === "number");
    assert.equal(r.body.aggregation.individual, 1);
    assert.equal(r.body.aggregation.dropped, 0);
    assert.equal(protectionTelemetry.last()!.evaluated, 1);
    assert.equal(protectionTelemetry.last()!.allowed, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ONE GATE AT A TIME. Each removes exactly one thing from the SAME world.
// ─────────────────────────────────────────────────────────────────────────────

describe("dropping one gate removes the flow", () => {
  it("the flag off yields nothing, and says so", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: "map_crowd_flow_enabled", enabled: false },
        ],
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, "flag_off");
    // We never looked, so the layer must not claim to be a source.
    assert.deepEqual(r.body.sources, []);
    // And it did not read the cohort in order to discard it. The zone model is
    // the specific thing this route's own flag check owns: lib/crowdFlowProducer
    // ALSO refuses on the flag, so without this assertion the test would pass
    // even if the route did all the work and let the producer say no.
    assert.equal(r.body.crowdFlow.transitions, 0);
    assert.equal(r.body.crowdFlow.zoneModel.zones, 0, "a disabled layer must cost no reads");
    assert.equal(r.body.crowdFlow.zoneModel.indexedPlaces, 0);
  });

  it("one actor below the k floor removes it", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, { intel_observations: nextMoveRows(now, COHORT_ACTORS - 1) }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    // The distinguishing evidence: we DID look, an edge WAS assembled, and the
    // gate is what stopped it. A broken pipeline would report 0 transitions.
    assert.equal(r.body.crowdFlow.refusal, null);
    assert.equal(r.body.crowdFlow.transitions, 1);
    assert.equal(r.body.crowdFlow.withheld, 1);
    assert.equal(r.body.crowdFlow.published, 0);
  });

  it("one signal family instead of two removes it", async () => {
    const now = Date.now();
    // The accepted-plan accepters withdraw their contribution consent. The 15
    // bodies are untouched (they are the same people), so the ONLY thing that
    // changed is the number of families on the edge.
    const r = await projection(
      flowState(now, {
        route_flow_contribution_consent: planRows(now, PLAN_ACTORS)
          .route_flow_contribution_consent.map((c) => ({ ...c, enabled: false })),
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, null);
    assert.equal(r.body.crowdFlow.transitions, 1);
    assert.equal(r.body.crowdFlow.withheld, 1);
  });

  it("a stale cohort removes it", async () => {
    const now = Date.now();
    const stale = (SIGNAL_MAX_AGE_MINUTES + 15) * 60_000;
    const plans = planRows(now, PLAN_ACTORS, { agoMs: stale });
    const r = await projection(
      flowState(now, {
        intel_observations: nextMoveRows(now, COHORT_ACTORS, { agoMs: stale }),
        route_plans: plans.route_plans,
        route_stops: plans.route_stops,
        route_legs: plans.route_legs,
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, null);
    // Past the freshness horizon nothing even becomes an edge.
    assert.equal(r.body.crowdFlow.transitions, 0);
  });

  it("a cohort younger than the publication delay removes it", async () => {
    const now = Date.now();
    const tooFresh = 2 * 60_000; // inside PRIVACY_THRESHOLD_V1's 10-minute delay
    const plans = planRows(now, PLAN_ACTORS, { agoMs: tooFresh });
    const r = await projection(
      flowState(now, {
        intel_observations: nextMoveRows(now, COHORT_ACTORS, { agoMs: tooFresh }),
        route_plans: plans.route_plans,
        route_stops: plans.route_stops,
        route_legs: plans.route_legs,
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    // The strongest evidence in the suite that the absence is a DECISION: a
    // complete, fresh, two-family, 15-actor edge was assembled and withheld.
    assert.equal(r.body.crowdFlow.transitions, 1);
    assert.equal(r.body.crowdFlow.withheld, 1);
    assert.equal(r.body.crowdFlow.published, 0);
  });

  it("one party holding more than a fifth of the cohort removes it", async () => {
    const now = Date.now();
    // Same 15 people, same freshness, same TWO families, same k — the only
    // thing that changed is how the parties are shaped. §10's "one large group
    // is not a crowd" ceiling.
    //
    // The split is [5,3,3,2,2]: FIVE independent parties, so the
    // minIndependentGroups floor is satisfied and cannot be what fires, and the
    // largest holds 5/15 = 33% against a 20% ceiling. That isolation is only
    // possible in this direction — at k=15 any cohort in fewer than five groups
    // has a largest group of at least 4/15 = 27%, so the group FLOOR can never
    // be violated without the share ceiling going first.
    const partySizes = [5, 3, 3, 2, 2];
    const partyOf = partySizes.flatMap((n, i) => Array.from({ length: n }, () => i + 1));
    const parties = nextMoveRows(now, COHORT_ACTORS).map((r, i) => ({
      ...r,
      group_key: GROUP(partyOf[i]),
    }));
    const r = await projection(flowState(now, { intel_observations: parties }));
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, null);
    assert.equal(r.body.crowdFlow.transitions, 1);
    assert.equal(r.body.crowdFlow.withheld, 1);
  });

  it("withdrawn contribution consent removes the contributors", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        intel_contribution_consent: nextMoveRows(now, COHORT_ACTORS).map((a) => ({
          user_id: a.actor_id,
          enabled: true,
          withdrawn_at: isoAgo(now, 60_000),
        })),
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO ZONE MODEL ⇒ REFUSE, NEVER APPROXIMATE.
// ─────────────────────────────────────────────────────────────────────────────

describe("without a zone model the layer refuses rather than approximating", () => {
  it("refuses when no curated zone exists", async () => {
    const now = Date.now();
    const r = await projection(flowState(now, { geo_zones: [] }));
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, "no_zone_model");
    assert.deepEqual(r.body.sources, []);
    // THE POINT OF THIS TEST: with nowhere to put an endpoint, the route must
    // not fall back to the coordinate it was holding.
    const wire = JSON.stringify(r.body);
    for (const leak of [
      String(STOP_FROM.lat), String(STOP_FROM.lng),
      String(STOP_TO.lat), String(STOP_TO.lng),
      String(PLACE_POINT.lat), String(PLACE_POINT.lng),
    ]) {
      assert.ok(!wire.includes(leak), `a raw coordinate (${leak}) was served as a fallback`);
    }
  });

  it("refuses when the zone read fails — unreadable geography is not absent geography", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, { geo_zones: { error: { message: "boom" } } }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, "zone_read_failed");
  });

  it("a venue-precision zone is not a flow zone", async () => {
    const now = Date.now();
    const venues = zoneRows().map((z) => ({ ...z, zone_type: "venue" }));
    assert.ok(!FLOW_ZONE_TYPES.includes("venue"));
    const r = await projection(flowState(now, { geo_zones: venues }));
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, "no_zone_model");
  });

  it("the parser itself refuses a venue-precision or sub-floor zone", () => {
    // The route ALSO filters `zone_type` in its query, which is what the
    // end-to-end tests above and below actually exercise. This asserts the
    // second line of defence directly, so a change to either one is visible:
    // parseFlowZones must refuse the same rows on its own.
    const [a] = zoneRows();
    assert.deepEqual(parseFlowZones([{ ...a, zone_type: "venue" }]), []);
    assert.deepEqual(
      parseFlowZones([{ ...a, radius_meters: MIN_FLOW_ZONE_EXTENT_METERS / 4 }]),
      [],
    );
    assert.deepEqual(parseFlowZones([{ ...a, name: "   " }]), []);
    // ...and must accept the curated one, or the three refusals above prove
    // nothing.
    assert.equal(parseFlowZones([a]).length, 1);
  });

  it("a zone narrower than the extent floor is not a flow zone", async () => {
    const now = Date.now();
    const tiny = zoneRows().map((z) => ({
      ...z,
      radius_meters: MIN_FLOW_ZONE_EXTENT_METERS / 4, // extent = half the floor
    }));
    const r = await projection(flowState(now, { geo_zones: tiny }));
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.refusal, "no_zone_model");
  });

  it("an ambiguous area name resolves to nothing rather than to a guess", async () => {
    const now = Date.now();
    // A second, distant zone with the SAME name as the destination. Resolving
    // it either way would publish one city's centroid for another city's crowd.
    const zones = [
      ...zoneRows(),
      {
        id: "zone-b-elsewhere",
        name: ZONE_B.name,
        zone_type: "neighborhood",
        center_lat: 16.07,
        center_lng: 108.23,
        radius_meters: ZONE_RADIUS_M,
        polygon_geojson: null,
      },
    ];
    const r = await projection(
      flowState(now, {
        geo_zones: zones,
        // Take the accepted-plan family out: it resolves by CONTAINMENT, not by
        // name, so leaving it in would resolve the edge by the other door.
        route_flow_contribution_consent: [],
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.zoneModel.ambiguousNames, 1);
    assert.equal(r.body.crowdFlow.transitions, 0);
  });

  it("a failed place read is reported, not passed off as an empty city", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, { places: { error: { message: "boom" } } }),
    );
    // The next-stop family loses its origins, so the flow goes — the
    // fail-closed direction — but the response says WHY rather than looking
    // like a neighbourhood with no places in it.
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.zoneModel.placeIndexFailed, true);
    assert.equal(r.body.crowdFlow.zoneModel.indexedPlaces, 0);
    // ...and the healthy world reports the opposite, or the flag means nothing.
    const ok = await projection(flowState(now));
    assert.equal(ok.body.crowdFlow.zoneModel.placeIndexFailed, false);
  });

  it("an origin place outside every zone resolves to nothing", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        // nowhere near either zone
        places: [placeRow(ORIGIN_PLACE_ID, { lat: 40.7128, lng: -74.006 })],
        route_flow_contribution_consent: [],
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.zoneModel.indexedPlaces, 0);
    assert.equal(r.body.crowdFlow.transitions, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. §24 — the gate a bespoke endpoint would have skipped.
// ─────────────────────────────────────────────────────────────────────────────

describe("the §24 protection gate applies to crowd flow", () => {
  it("withholds a flow whose endpoint sits in a coarsen-class protected zone", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        protected_zones: [
          {
            id: "pz-1",
            category: "medical_facility", // the one coarsen-class category
            action: null,
            privacy_floor: null,
            shape: "circle",
            center_lat: ZONE_B.lat,
            center_lng: ZONE_B.lng,
            radius_meters: 400,
            ring: null,
            jurisdiction: null,
            policy_ref: null,
            active: true,
          },
        ],
      }),
    );
    // Coarsening would have left cohortSize and observedAt intact inside
    // `payload.observed` — the very things coarsening exists to strip. So for
    // this kind the answer is to withhold.
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.withheldForProtection, 1);
    assert.equal(r.body.crowdFlow.published, 0);
  });

  it("withholds a flow inside a suppress-class protected zone", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        protected_zones: [
          {
            id: "pz-2",
            category: "shelter",
            action: null,
            privacy_floor: null,
            shape: "circle",
            center_lat: ZONE_A.lat,
            center_lng: ZONE_A.lng,
            radius_meters: 400,
            ring: null,
            jurisdiction: null,
            policy_ref: null,
            active: true,
          },
        ],
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    assert.equal(r.body.crowdFlow.withheldForProtection, 1);
  });

  it("an unreadable protection policy serves nothing at all", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, { protected_zones: { error: { message: "boom" } } }),
    );
    assert.deepEqual(r.body.objects, []);
    assert.equal(r.body.total, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WHAT MUST NEVER CROSS THE WIRE.
// ─────────────────────────────────────────────────────────────────────────────

describe("no actor, no party token, no coordinate, no trajectory", () => {
  it("the whole serialized response is free of every sentinel", async () => {
    const now = Date.now();
    const r = await projection(flowState(now));
    // Guard against a vacuous pass: this only proves anything if a flow was
    // actually published.
    assert.equal(flowsIn(r.body).length, 1);

    const wire = JSON.stringify(r.body);
    const forbidden = [
      // people
      ...Array.from({ length: COHORT_ACTORS }, (_, i) => ACTOR(i + 1)),
      // party tokens
      ...Array.from({ length: COHORT_ACTORS }, (_, i) => GROUP(i + 1)),
      // the place the contributors were standing at, and its coordinate
      ORIGIN_PLACE_ID, SECOND_PLACE_ID,
      String(PLACE_POINT.lat), String(PLACE_POINT.lng),
      // the route stops the accepted plans were made of
      String(STOP_FROM.lat), String(STOP_FROM.lng),
      String(STOP_TO.lat), String(STOP_TO.lng),
      // and the plans themselves
      "plan-1", "plan-2", "plan-3",
    ];
    for (const leak of forbidden) {
      assert.ok(!wire.includes(leak), `'${leak}' reached the wire`);
    }
  });

  it("the flow is an edge, not a path — exactly two positions, both zone centroids", async () => {
    const now = Date.now();
    const r = await projection(flowState(now));
    const flow = flowsIn(r.body)[0];
    assert.equal(flow.geometry.coordinates.length, 2);
    // A trajectory would need an intermediate point; there is nowhere to put one.
    for (const pos of flow.geometry.coordinates) {
      assert.equal(pos.length, 2);
      assert.ok(
        (pos[0] === ZONE_A.lng && pos[1] === ZONE_A.lat) ||
          (pos[0] === ZONE_B.lng && pos[1] === ZONE_B.lat),
        `a position that is not a zone centroid: ${JSON.stringify(pos)}`,
      );
    }
  });

  it("A→B→C by the SAME 15 people publishes two edges and no journey", async () => {
    const now = Date.now();
    // The sharpest version of §10's worry: every one of the 15 makes BOTH hops,
    // so a trajectory genuinely exists in the world. Each edge is gated on its
    // own and published on its own, and the two outputs share nothing an
    // observer could use to say the same people made both — no actor, no party
    // token, no ordering, no sequence number.
    const secondPlans = planRows(now, PLAN_ACTORS, {
      prefix: "plan-bc",
      from: STOP_TO,
      to: STOP_IN_C,
    });
    const firstPlans = planRows(now, PLAN_ACTORS);
    const r = await projection(
      flowState(now, {
        geo_zones: [...zoneRows(), zoneRow(ZONE_C)],
        places: [
          placeRow(ORIGIN_PLACE_ID, PLACE_POINT),
          placeRow(SECOND_PLACE_ID, SECOND_PLACE_POINT),
        ],
        intel_observations: [
          ...nextMoveRows(now, COHORT_ACTORS),
          ...nextMoveRows(now, COHORT_ACTORS, {
            placeId: SECOND_PLACE_ID,
            destination: ZONE_C.name,
          }),
        ],
        route_plans: [...firstPlans.route_plans, ...secondPlans.route_plans],
        route_stops: [...firstPlans.route_stops, ...secondPlans.route_stops],
        route_legs: [...firstPlans.route_legs, ...secondPlans.route_legs],
      }),
    );

    const flows = flowsIn(r.body);
    assert.equal(flows.length, 2, "both edges should clear the gates independently");
    assert.deepEqual(
      flows.map((f: any) => f.id).sort(),
      [`flow:${ZONE_A.id}:${ZONE_B.id}`, `flow:${ZONE_B.id}:${ZONE_C.id}`],
    );
    for (const f of flows) {
      assert.equal(f.geometry.coordinates.length, 2);
      assert.equal(f.payload.observed.cohortSize, COHORT_ACTORS);
      // census-media MD162 (lead ruling D-26d) added `endpoints`: each end's
      // curated zone name and disclosable place ids. It is pinned as tightly as
      // `observed` — an endpoint is a ZONE, and it carries nothing per-actor.
      assert.deepEqual(Object.keys(f.payload).sort(), ["endpoints", "inferred", "observed"]);
      assert.deepEqual(Object.keys(f.payload.endpoints).sort(), ["from", "to"]);
      for (const end of [f.payload.endpoints.from, f.payload.endpoints.to]) {
        assert.deepEqual(Object.keys(end).sort(), ["name", "placeIds", "placesPartial", "placesStatus", "zoneId"]);
      }
      assert.equal(f.payload.endpoints.from.zoneId, f.payload.observed.fromZoneId);
      assert.equal(f.payload.endpoints.to.zoneId, f.payload.observed.toZoneId);
      assert.deepEqual(
        Object.keys(f.payload.observed).sort(),
        ["cohortSize", "flowState", "fromZoneId", "observedAt", "signalFamilies", "toZoneId", "windowMinutes"],
        "a new field on the observed half is where a trajectory would first appear",
      );
    }
    const wire = JSON.stringify(r.body);
    for (let i = 1; i <= COHORT_ACTORS; i += 1) {
      assert.ok(!wire.includes(ACTOR(i)), "an actor id would link the two edges");
      assert.ok(!wire.includes(GROUP(i)), "a party token would link the two edges");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. census-media MD162, lead ruling D-26d — a published flow's ends, named.
//    "Only public places that the place-disclosure choke point already
//    discloses; only on flows that already clear MIN_SIGNAL_FAMILIES and the k
//    floor; only behind map_crowd_flow_enabled." Plus lane M's floor: a zone
//    with fewer than MIN_FLOW_ENDPOINT_PLACES disclosable places lists none, so
//    the origin place stays a wire sentinel (section 5) even when it is public.
// ─────────────────────────────────────────────────────────────────────────────

/** A place the Map place layer would serve: named, active, unmerged. */
function publicPlace(id: string, point: { lat: number; lng: number }): any {
  return {
    ...placeRow(id, point),
    name: `Public ${id}`,
    primary_category: "cafe",
    city: "Da Nang",
    neighborhood: null,
    country_code: "VN",
  };
}

/** Four public places in zone B, each more than 300 m from the others (the
 *  gem proximity radius) and inside the zone's 600 m radius. */
const B_PLACES = {
  "place-b-1": { lat: 16.062, lng: 108.22 },
  "place-b-2": { lat: 16.058, lng: 108.22 },
  "place-b-3": { lat: 16.06, lng: 108.2235 },
  "place-b-4": { lat: 16.06, lng: 108.2165 },
} as const;
const bPlaces = (ids: (keyof typeof B_PLACES)[] = Object.keys(B_PLACES) as any) =>
  ids.map((id) => publicPlace(id, B_PLACES[id]));

function endpointsOf(r: { body: any }): { from: any; to: any } {
  const flows = flowsIn(r.body);
  assert.equal(flows.length, 1, `expected one published flow; report ${JSON.stringify(r.body.crowdFlow)}`);
  return flows[0].payload.endpoints;
}

describe("MD162 (D-26d): a published flow names its ends", () => {
  it("names both zones and lists zone B's disclosable places, sorted", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [
          placeRow(ORIGIN_PLACE_ID, PLACE_POINT),
          ...bPlaces(),
          // In zone B, active, but nameless: projectPlace will not serve it, so
          // the flow must not name it either.
          placeRow("place-b-nameless", { lat: 16.0601, lng: 108.2201 }),
        ],
      }),
    );
    const e = endpointsOf(r);
    assert.deepEqual(e.from.zoneId, ZONE_A.id);
    assert.equal(e.from.name, ZONE_A.name);
    assert.equal(e.to.zoneId, ZONE_B.id);
    assert.equal(e.to.name, ZONE_B.name);
    assert.equal(e.to.placesStatus, "listed");
    assert.deepEqual(e.to.placeIds, ["place-b-1", "place-b-2", "place-b-3", "place-b-4"]);
    assert.equal(e.to.placesPartial, false, "both zones lie wholly inside the viewport");
  });

  it("a nameless place is not disclosed by the choke point, so zone A lists none", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, { places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()] }),
    );
    const e = endpointsOf(r);
    assert.equal(e.from.placesStatus, "too_few");
    assert.deepEqual(e.from.placeIds, []);
    assert.ok(!JSON.stringify(r.body).includes(ORIGIN_PLACE_ID));
  });

  it("a PUBLIC origin place alone in its zone is still never named (the floor)", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [
          publicPlace(ORIGIN_PLACE_ID, PLACE_POINT),
          publicPlace("place-a-2", { lat: 16.0485, lng: 108.2 }),
          ...bPlaces(),
        ],
      }),
    );
    const e = endpointsOf(r);
    assert.ok(MIN_FLOW_ENDPOINT_PLACES > 2);
    assert.equal(e.from.placesStatus, "too_few");
    assert.deepEqual(e.from.placeIds, []);
    assert.ok(
      !JSON.stringify(r.body).includes(ORIGIN_PLACE_ID),
      "two places would make the list a pointer at the place the cohort stood at",
    );
  });

  it("a place a restrictive gem constrains (by place id) is left out", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        hidden_gems: [
          {
            canonical_place_id: "place-b-2",
            sensitivity_level: "protected",
            status: "active",
            city: "Da Nang",
            latitude: null,
            longitude: null,
            approx_latitude: null,
            approx_longitude: null,
          },
        ],
      }),
    );
    const e = endpointsOf(r);
    assert.deepEqual(e.to.placeIds, ["place-b-1", "place-b-3", "place-b-4"]);
  });

  it("a place a restrictive gem sits on (by proximity, same city) is left out", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        hidden_gems: [
          {
            canonical_place_id: null,
            sensitivity_level: "reveal_after_save",
            status: "active",
            city: "Da Nang",
            latitude: B_PLACES["place-b-4"].lat,
            longitude: B_PLACES["place-b-4"].lng,
            approx_latitude: null,
            approx_longitude: null,
          },
        ],
      }),
    );
    assert.deepEqual(endpointsOf(r).to.placeIds, ["place-b-1", "place-b-2", "place-b-3"]);
  });

  it("a place the §24 gate would COARSEN is left out — an id is exact", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        protected_zones: [
          {
            id: "pz-md162",
            category: "medical_facility",
            action: null,
            privacy_floor: null,
            shape: "circle",
            center_lat: B_PLACES["place-b-3"].lat,
            center_lng: B_PLACES["place-b-3"].lng,
            radius_meters: 100,
            ring: null,
            jurisdiction: null,
            policy_ref: null,
            active: true,
          },
        ],
      }),
    );
    assert.deepEqual(endpointsOf(r).to.placeIds, ["place-b-1", "place-b-2", "place-b-4"]);
  });

  it("an unreadable gem table lists NO place on either end — and names the zones", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        hidden_gems: { error: { message: "gems unreadable" } },
      }),
    );
    const e = endpointsOf(r);
    for (const end of [e.from, e.to]) {
      assert.equal(end.placesStatus, "unread");
      assert.deepEqual(end.placeIds, []);
      assert.equal(end.placesPartial, true);
    }
    assert.equal(e.to.name, ZONE_B.name);
  });

  it("with the flag off, no zone name or place id reaches the wire", async () => {
    const now = Date.now();
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: "map_crowd_flow_enabled", enabled: false },
        ],
      }),
    );
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(ZONE_B.name));
    assert.ok(!wire.includes("place-b-1"));
  });

  it("below the k floor, no zone name or place id reaches the wire", async () => {
    const now = Date.now();
    const thin = nextMoveRows(now, COHORT_ACTORS - 1);
    const r = await projection(
      flowState(now, {
        places: [placeRow(ORIGIN_PLACE_ID, PLACE_POINT), ...bPlaces()],
        intel_observations: thin,
        intel_contribution_consent: thin.map((a) => ({ user_id: a.actor_id, enabled: true, withdrawn_at: null })),
      }),
    );
    assert.deepEqual(flowsIn(r.body), []);
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(ZONE_B.name));
    assert.ok(!wire.includes("place-b-1"));
  });
});

describe("MD162: attachFlowEndpoints, pure", () => {
  const zones = parseFlowZones([
    zoneRow({ ...ZONE_A, name: "  An   Thuong " }),
    zoneRow(ZONE_B),
  ]);
  const flow = (from: string | null, to: string | null) => ({
    kind: "crowd_flow",
    payload: { observed: { fromZoneId: from, toZoneId: to }, inferred: null },
  });
  const VIEW = { west: 108.0, south: 15.9, east: 108.4, north: 16.2 };
  const index = (n: number, zoneId: string) =>
    new Map(Array.from({ length: n }, (_, i) => [`p-${String(i).padStart(3, "0")}`, zoneId] as [string, string]));

  it("the curated zone name is attached trimmed and whitespace-collapsed", () => {
    const [f] = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, new Map(), new Set(), { viewport: VIEW });
    assert.equal((f.payload as any).endpoints.from.name, "An Thuong");
    // The polygon branch, likewise.
    const [poly] = parseFlowZones([
      {
        id: "zone-poly",
        name: " My   Khe ",
        zone_type: "neighborhood",
        center_lat: null,
        center_lng: null,
        radius_meters: null,
        polygon_geojson: {
          type: "Polygon",
          coordinates: [[[108.23, 16.06], [108.25, 16.06], [108.25, 16.08], [108.23, 16.08], [108.23, 16.06]]],
        },
      },
    ]);
    assert.equal(poly?.shape.kind, "polygon");
    assert.equal(poly?.displayName, "My Khe");
  });

  it("leaves other kinds, and a flow without both zone ids, untouched", () => {
    const other = { kind: "place", payload: { observed: { fromZoneId: "zone-a", toZoneId: "zone-b" } } };
    const half = flow(ZONE_A.id, null);
    const out = attachFlowEndpoints([other, half], zones, new Map(), new Set());
    assert.equal(out[0], other);
    assert.equal(out[1], half);
  });

  it("the floor: one under MIN lists none; MIN lists them", () => {
    const under = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, index(MIN_FLOW_ENDPOINT_PLACES - 1, ZONE_B.id), new Set(), { viewport: VIEW });
    assert.equal((under[0].payload as any).endpoints.to.placesStatus, "too_few");
    assert.deepEqual((under[0].payload as any).endpoints.to.placeIds, []);
    const at = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, index(MIN_FLOW_ENDPOINT_PLACES, ZONE_B.id), new Set(), { viewport: VIEW });
    assert.equal((at[0].payload as any).endpoints.to.placesStatus, "listed");
    assert.equal((at[0].payload as any).endpoints.to.placeIds.length, MIN_FLOW_ENDPOINT_PLACES);
  });

  it("withheld places do not count toward the floor", () => {
    const idx = index(MIN_FLOW_ENDPOINT_PLACES, ZONE_B.id);
    const out = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, idx, new Set(["p-000"]), { viewport: VIEW });
    assert.equal((out[0].payload as any).endpoints.to.placesStatus, "too_few");
  });

  it("caps a long list at MAX_FLOW_ENDPOINT_PLACE_IDS, sorted", () => {
    const out = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, index(MAX_FLOW_ENDPOINT_PLACE_IDS + 5, ZONE_B.id), new Set(), { viewport: VIEW });
    const ids = (out[0].payload as any).endpoints.to.placeIds as string[];
    assert.equal(ids.length, MAX_FLOW_ENDPOINT_PLACE_IDS);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(ids[0], "p-000");
  });

  it("an unread place index or an unread withhold set lists nothing, as 'unread'", () => {
    for (const [pz, wh] of [[null, new Set<string>()], [index(5, ZONE_B.id), null]] as const) {
      const out = attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, pz, wh, { viewport: VIEW });
      const to = (out[0].payload as any).endpoints.to;
      assert.equal(to.placesStatus, "unread");
      assert.deepEqual(to.placeIds, []);
      assert.equal(to.placesPartial, true, "an unread zone was not seen whole, whatever the viewport");
    }
  });

  it("placesPartial: a truncated read, a zone past the viewport, or no viewport", () => {
    const run = (cov: any) =>
      (attachFlowEndpoints([flow(ZONE_A.id, ZONE_B.id)], zones, index(5, ZONE_B.id), new Set(), cov)[0].payload as any).endpoints.to;
    assert.equal(run({ viewport: VIEW }).placesPartial, false);
    assert.equal(run({ viewport: VIEW, truncated: true }).placesPartial, true);
    // The viewport's north edge runs 100 m north of zone B's centre; its 600 m radius reaches past it.
    assert.equal(run({ viewport: { ...VIEW, north: ZONE_B.lat + 0.0009 } }).placesPartial, true);
    assert.equal(run({}).placesPartial, true);
    // Partial does not empty a list — it says the list is a sample.
    assert.equal(run({ viewport: VIEW, truncated: true }).placesStatus, "listed");
  });
});
