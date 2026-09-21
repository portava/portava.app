/**
 * §15 Time Machine through the Map Intelligence Gateway (Map spec §15 + §19).
 *
 * The producer (lib/temporalProjection) had no caller — the exact shape of the
 * §10 crowd-flow defect one layer over — so no client could ever be served a
 * prediction or a historical view. This route is that caller, and these tests
 * drive the REAL HTTP route:
 *
 *   • FORECAST offsets serve kind 'prediction' objects (events, the viewer's own
 *     itinerary, accepted-plan arrivals), each with NO observedAt and never a
 *     live freshness (§37: predictions must not look like observations).
 *   • The accepted_plan positive test is the load-bearing one, exactly as for
 *     crowd flow: a synthetic cohort that CLEARS PRIVACY_THRESHOLD_V1 driven
 *     through the route, asserting the aggregate arrives AND that no actor id or
 *     raw stop coordinate is anywhere in the response.
 *   • HISTORICAL offsets are READ, never reconstructed: an empty snapshot table
 *     is an honest available:true-but-empty, a read FAILURE is available:false,
 *     and a populated snapshot yields an OBSERVED place with freshness
 *     'historical'.
 *
 * Nothing here relaxes a gate; the fixtures are built to SATISFY
 * PRIVACY_THRESHOLD_V1 as it stands.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapProjectionTemporalRoute.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

// The accepted_plan source derives an HMAC party token and REFUSES without a
// secret. Set before any route runs; the real server gets this from env.
process.env.INTEL_GROUP_KEY_SECRET =
  process.env.INTEL_GROUP_KEY_SECRET ?? "time-machine-route-test-secret";

import { _setTestClient } from "../lib/http.js";
import mapProjectionTemporalRouter, {
  _clearTemporalProtectedZoneCache,
  _clearTemporalFlowZoneCache,
} from "../routes/mapProjectionTemporal.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const TOKEN = "tm-test-token";
const USER = "tm-viewer";
const OTHER_HOST = "tm-other-host";

/** Sentinels that MUST NOT reach the wire from the accepted_plan aggregate. */
const ACTOR = (n: number) => `tm-actor-sentinel-${n}`;
/** The raw stop coordinate — a route plan's future arrival point. */
const STOP_POINT = { lat: 16.0491234, lng: 108.2013579 };

const ZONE_A = { id: "tm-zone-a", name: "An Thuong", lat: 16.05, lng: 108.2 };
const ZONE_RADIUS_M = 600;
const BBOX = "108.0,15.9,108.4,16.2";
const MIN = 60_000;

// ── fake Supabase client (only the operators the code under test uses) ────────

interface TableSpec {
  rows?: any[];
  /**
   * `code` is optional and NOT decoration: PostgREST returns SQLSTATE `42P01`
   * for a relation that does not exist, which is precisely the state the M10
   * refusal arm reproduces (2217 unapplied). A fixture that could only carry a
   * message would have to describe that condition in prose, and a reader could
   * not tell it apart from an invented failure.
   */
  error?: { message: string; code?: string };
}
type FakeState = Record<string, TableSpec | any[]>;

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

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

/** A cohort of accepted plans that clears every gate: 15 solo accepters, each
 *  with a stop arriving in the +60m window at zone A, accepted 15m ago. */
function planCohort(nowMs: number, count: number, arriveOffsetMin: number): {
  route_plans: any[];
  route_stops: any[];
  route_flow_contribution_consent: any[];
} {
  const acceptedAt = isoAgo(nowMs, 15 * MIN);
  const arriveAt = new Date(nowMs + arriveOffsetMin * MIN).toISOString();
  const route_plans: any[] = [];
  const route_stops: any[] = [];
  const route_flow_contribution_consent: any[] = [];
  for (let i = 0; i < count; i += 1) {
    const planId = `tm-plan-${i + 1}`;
    const actorId = ACTOR(i + 1);
    route_plans.push({ id: planId, trip_id: null, accepted_by_user_id: actorId, accepted_at: acceptedAt, status: "active" });
    route_flow_contribution_consent.push({ user_id: actorId, enabled: true, withdrawn_at: null });
    route_stops.push({
      id: `${planId}-stop`,
      route_plan_id: planId,
      structured_location: { label: "arrival", ...STOP_POINT },
      planned_arrival_time: arriveAt,
      planned_departure_time: null,
    });
  }
  return { route_plans, route_stops, route_flow_contribution_consent };
}

interface StateOver { [table: string]: TableSpec | any[]; }

function baseState(nowMs: number, over: StateOver = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    protected_zones: [],
    geo_zones: [zoneRow(ZONE_A)],
    blocks: [],
    event_roles: [],
    ...over,
  };
}

// ── server ──────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function get(path: string): Promise<{ status: number; body: any; raw: string }> {
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
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
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
  app.use(mapProjectionTemporalRouter);
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
  _clearTemporalProtectedZoneCache();
  _clearTemporalFlowZoneCache();
});

async function temporal(state: FakeState, query: string) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection/temporal?${query}`);
}

const predictions = (body: any): any[] => (body?.objects ?? []).filter((o: any) => o.kind === "prediction");

// ── the constants this suite depends on ───────────────────────────────────────

describe("PRIVACY_THRESHOLD_V1 is unchanged", () => {
  it("k/group/delay floors are what the fixtures assume", () => {
    assert.equal(PRIVACY_THRESHOLD_V1.minUniqueActors, 15);
    assert.equal(PRIVACY_THRESHOLD_V1.minIndependentGroups, 5);
    assert.equal(PRIVACY_THRESHOLD_V1.publicationDelayMinutes, 10);
  });
});

// ── flag + input validation ───────────────────────────────────────────────────

describe("gating and input validation", () => {
  it("fail-soft: flag off → enabled:false, empty", async () => {
    const now = Date.now();
    const res = await temporal(
      baseState(now, { feature_flags: [{ flag: "map_projection_enabled", enabled: false }] }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.objects, []);
  });

  it("rejects a request with no temporal target", async () => {
    const now = Date.now();
    const res = await temporal(baseState(now), `bbox=${BBOX}`);
    assert.equal(res.status, 400);
  });

  it("rejects a missing bbox", async () => {
    const now = Date.now();
    const res = await temporal(baseState(now), `offsetMinutes=60`);
    assert.equal(res.status, 400);
  });

  it("NOW offset serves nothing and reports neither forecast nor history", async () => {
    const now = Date.now();
    const res = await temporal(baseState(now), `bbox=${BBOX}&offsetMinutes=0`);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.target.mode, "now");
    assert.equal(res.body.total, 0);
    assert.equal(res.body.forecast, null);
    assert.equal(res.body.history, null);
  });
});

// ── forecast: events ──────────────────────────────────────────────────────────

describe("forecast — scheduled events", () => {
  function eventState(nowMs: number, over: StateOver = {}): FakeState {
    return baseState(nowMs, {
      events: [
        {
          id: "tm-ev-1",
          host_id: OTHER_HOST,
          title: "Rooftop set",
          location_name: "Sky Bar",
          location_lat: 16.05,
          location_lng: 108.2,
          show_exact_location: true,
          starts_at: new Date(nowMs + 40 * MIN).toISOString(),
          ends_at: new Date(nowMs + 100 * MIN).toISOString(),
          visibility: "public",
          state: "published",
          age_min: null,
          age_max: null,
          trust_score_min: null,
          verified_only: false,
        },
      ],
      ...over,
    });
  }

  it("serves an event whose schedule window covers +60m as a prediction", async () => {
    const now = Date.now();
    const res = await temporal(eventState(now), `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.target.mode, "forecast");
    const preds = predictions(res.body);
    const ev = preds.find((o: any) => o.id === "prediction:event:tm-ev-1");
    assert.ok(ev, "the event forecast should be served");
    // §37: a prediction was never observed, and is never live.
    assert.equal(ev.observedAt, undefined);
    assert.notEqual(ev.freshness, "live");
    assert.equal(res.body.forecast.events, 1);
    assert.ok(res.body.sources.includes("events"));
  });

  it("does not serve an event whose window is far from the target", async () => {
    const now = Date.now();
    const state = eventState(now);
    (state.events as any[])[0].starts_at = new Date(now + 300 * MIN).toISOString();
    (state.events as any[])[0].ends_at = new Date(now + 360 * MIN).toISOString();
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(predictions(res.body).length, 0);
    assert.equal(res.body.forecast.events, 0);
  });
});

// ── forecast: the viewer's own itinerary ──────────────────────────────────────

describe("forecast — the viewer's own itinerary", () => {
  it("serves the viewer's own planned stop covering the target", async () => {
    const now = Date.now();
    const state = baseState(now, {
      route_plans: [{ id: "tm-my-plan", owner_user_id: USER, status: "active", trip_id: null, accepted_at: null, accepted_by_user_id: null }],
      route_stops: [
        {
          id: "tm-my-stop",
          route_plan_id: "tm-my-plan",
          title: "Dinner",
          structured_location: { label: "Bun Cha", lat: 16.05, lng: 108.2 },
          planned_arrival_time: new Date(now + 58 * MIN).toISOString(),
          planned_departure_time: new Date(now + 90 * MIN).toISOString(),
        },
      ],
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    const stop = predictions(res.body).find((o: any) => o.id === "prediction:itinerary:tm-my-stop");
    assert.ok(stop, "the itinerary forecast should be served");
    assert.equal(stop.privacyClass, "place_level");
    assert.equal(res.body.forecast.itinerary, 1);
    assert.ok(res.body.sources.includes("itinerary"));
  });
});

// ── forecast: accepted_plan (the load-bearing privacy test) ───────────────────

describe("forecast — accepted_plan arrivals", () => {
  it("refuses when map_crowd_flow_enabled is off (honest, not silent)", async () => {
    const now = Date.now();
    const res = await temporal(baseState(now, planCohort(now, 15, 60)), `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(res.body.forecast.plan.refusal, "flag_off");
    assert.equal(res.body.forecast.plan.published, 0);
    assert.ok(!res.body.sources.includes("accepted_plan"));
  });

  it("a cohort that clears every gate publishes ONE aggregate, leaking no actor or coordinate", async () => {
    const now = Date.now();
    const state = baseState(now, {
      feature_flags: [
        { flag: "map_projection_enabled", enabled: true },
        { flag: "map_crowd_flow_enabled", enabled: true },
      ],
      ...planCohort(now, PRIVACY_THRESHOLD_V1.minUniqueActors, 60),
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    const zonePred = predictions(res.body).find((o: any) => o.id === `prediction:zone:${ZONE_A.id}`);
    assert.ok(zonePred, "the aggregate zone prediction should arrive");
    assert.equal(zonePred.privacyClass, "aggregate_only");
    assert.equal(zonePred.count, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(res.body.forecast.plan.published, 1);
    assert.ok(res.body.sources.includes("accepted_plan"));

    // No actor id and no raw stop coordinate anywhere in the serialized response.
    for (let i = 1; i <= PRIVACY_THRESHOLD_V1.minUniqueActors; i += 1) {
      assert.ok(!res.raw.includes(ACTOR(i)), `actor sentinel ${i} leaked`);
    }
    assert.ok(!res.raw.includes(String(STOP_POINT.lat)), "raw stop lat leaked");
    assert.ok(!res.raw.includes(String(STOP_POINT.lng)), "raw stop lng leaked");
  });

  it("withholds a sub-k cohort — the aggregate never appears", async () => {
    const now = Date.now();
    const state = baseState(now, {
      feature_flags: [
        { flag: "map_projection_enabled", enabled: true },
        { flag: "map_crowd_flow_enabled", enabled: true },
      ],
      ...planCohort(now, PRIVACY_THRESHOLD_V1.minUniqueActors - 1, 60),
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(predictions(res.body).filter((o: any) => o.id.startsWith("prediction:zone")).length, 0);
    assert.equal(res.body.forecast.plan.published, 0);
    assert.ok(res.body.forecast.plan.withheld >= 1);
  });
});

// ── §24 protection gate over the temporal layer ───────────────────────────────
//
// The route had NO protection-gate coverage at all: its `protected_zones`
// fixture was `[]` for every case above, so the one path that matters for a
// forecast served inside a hospital was never exercised. What that path did:
// `prediction` was absent from AMBIENT_PRESENCE_KINDS, so a coarsen-class zone
// took the COARSEN branch, `coarsenForZone` deleted only TOP-LEVEL fields, and
// the object reached the wire with `payload.cohort` and `payload.predictedFor`
// intact — "20 people are due to arrive at this clinic at 13:00", which is the
// exact §24 association disclosure the gate exists to prevent, restated one
// level down. Same class as crowd_flow's `payload.observed`.
describe("§24 — a prediction inside a protected zone", () => {
  /** A coarsen-class zone (medical_facility) centred on the arrival zone. */
  const CLINIC_ZONE = {
    id: "tm-protected-clinic",
    category: "medical_facility",
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: ZONE_A.lat,
    center_lng: ZONE_A.lng,
    radius_meters: 1_000,
    ring: null,
    jurisdiction: null,
    policy_ref: null,
    active: true,
  };

  function protectedPlanState(nowMs: number): FakeState {
    return baseState(nowMs, {
      feature_flags: [
        { flag: "map_projection_enabled", enabled: true },
        { flag: "map_crowd_flow_enabled", enabled: true },
      ],
      protected_zones: [CLINIC_ZONE],
      ...planCohort(nowMs, PRIVACY_THRESHOLD_V1.minUniqueActors, 60),
    });
  }

  it("is WITHHELD, not coarsened — no cohort size or predicted time on the wire", async () => {
    const now = Date.now();
    const res = await temporal(protectedPlanState(now), `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(res.status, 200);

    const zonePred = predictions(res.body).find((o: any) => o.id === `prediction:zone:${ZONE_A.id}`);
    assert.equal(zonePred, undefined, "a prediction inside a medical facility must not be served");

    // The association disclosure must be gone from the SERIALIZED objects, not
    // merely from the top-level fields: `payload` survives coarsening untouched,
    // which is exactly what shipped the defect. (`sources` legitimately still
    // names accepted_plan — that the layer was consulted for this viewport is
    // not a claim about any place.)
    const objectsRaw = JSON.stringify(res.body.objects ?? []);
    assert.ok(!objectsRaw.includes("cohort"), "payload.cohort leaked the cohort size");
    assert.ok(!objectsRaw.includes("predictedFor"), "payload.predictedFor leaked the predicted time");
    assert.ok(!objectsRaw.includes(ZONE_A.id), "the arrival zone id leaked");
    assert.ok(!objectsRaw.includes("accepted_plan"), "payload.source leaked the provenance");

    // And the removal is REPORTED, not silent.
    assert.ok(res.body.protection.suppressed >= 1, "the withheld prediction must be counted");
  });

  it("the same cohort with NO protected zone is served — the gate is what removed it", async () => {
    const now = Date.now();
    const state = protectedPlanState(now);
    state.protected_zones = [];
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    const zonePred = predictions(res.body).find((o: any) => o.id === `prediction:zone:${ZONE_A.id}`);
    assert.ok(zonePred, "control: without a protected zone the aggregate is served");
    assert.equal(zonePred.payload.cohort, PRIVACY_THRESHOLD_V1.minUniqueActors);
  });

  it("an event prediction inside the same zone is withheld too (not a plan-only fix)", async () => {
    const now = Date.now();
    const state = baseState(now, {
      protected_zones: [CLINIC_ZONE],
      events: [
        {
          id: "tm-ev-clinic",
          host_id: OTHER_HOST,
          title: "Blood drive",
          location_name: "Clinic",
          location_lat: ZONE_A.lat,
          location_lng: ZONE_A.lng,
          show_exact_location: true,
          starts_at: new Date(now + 40 * MIN).toISOString(),
          ends_at: new Date(now + 100 * MIN).toISOString(),
          visibility: "public",
          state: "published",
          age_min: null,
          age_max: null,
          trust_score_min: null,
          verified_only: false,
        },
      ],
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(predictions(res.body).length, 0, "an event prediction in a protected zone must be withheld");
    assert.ok(!res.raw.includes("tm-ev-clinic"), "the event id leaked");
  });
});

// ── historical: read, never reconstruct ───────────────────────────────────────

describe("historical — read, never reconstruct", () => {
  const HIST_PLACE = { id: "tm-place-a", name: "An Thuong", latitude: 16.05, longitude: 108.2, status: "active", merged_into_place_id: null };

  it("no snapshot rows yet → available:true but empty (honest 'no history yet')", async () => {
    const now = Date.now();
    const state = baseState(now, { places: [HIST_PLACE], intel_state_snapshot_versions: [] });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=-1440`);
    assert.equal(res.body.target.mode, "historical");
    assert.equal(res.body.history.available, true);
    assert.equal(res.body.total, 0);
  });

  it("a snapshot read FAILURE → available:false (not a fabricated empty past)", async () => {
    const now = Date.now();
    const state = baseState(now, {
      places: [HIST_PLACE],
      intel_state_snapshot_versions: { error: { message: "boom" } },
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=-1440`);
    assert.equal(res.body.history.available, false);
  });

  it("a covering snapshot yields an OBSERVED place with freshness 'historical'", async () => {
    const now = Date.now();
    const at = now - 1440 * MIN;
    const state = baseState(now, {
      places: [HIST_PLACE],
      intel_state_snapshot_versions: [
        {
          subject_id: "tm-place-a",
          claim_type: "crowd.level",
          value: { level: "busy" },
          confidence_band: "strong",
          privacy_eligible: true,
          observed_at: new Date(at - 30 * MIN).toISOString(),
          expires_at: new Date(at + 30 * MIN).toISOString(),
        },
      ],
    });
    const res = await temporal(state, `bbox=${BBOX}&offsetMinutes=-1440`);
    assert.equal(res.body.history.available, true);
    const hist = (res.body.objects ?? []).find((o: any) => o.id === "history:tm-place-a");
    assert.ok(hist, "the historical place should be served");
    assert.equal(hist.kind, "place");
    assert.equal(hist.freshness, "historical");
    assert.equal(hist.activity, "busy");
    assert.notEqual(hist.kind, "prediction");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M10 / M280 — Time Machine as a PRIMARY MAP SURFACE, and Phase 5 behind it.
//
// The census's criterion, verbatim:
//
//   "2217 is applied to production *and* `map_projection_enabled` is TRUE
//    there, and `GET /api/map/projection/temporal?offset=+60m` answers
//    `enabled: true` with a non-null `forecast`."
//
// The cases above already prove the individual producers. What was never
// asserted as its own statement is the CRITERION: both halves of the envelope,
// together, at +60m, plus the refusal arm that the same criterion's other
// sentence names. M280 adds nothing of its own — the census says "Nothing else
// in the phase has a blocker of its own" — so its acceptance is M10's positive
// arm plus §15's already-correct rows (M106–M111) re-executed in the same run;
// those five live in travel-buddy-standalone and are named in the report rather
// than re-implemented here.
//
// ── A CONTRACT DISCREPANCY, RECORDED RATHER THAN PAPERED OVER ───────────────
// The census writes the request as `?offset=+60m`. This route does not accept
// that parameter: `parseTemporalTarget` is handed `offsetMinutes`, `at`,
// `windowStartsAt` and `windowEndsAt`, and nothing else. `?offset=+60m` is
// therefore an `invalid_payload` today. The last case below pins that fact so
// the gap is visible and falsifiable, instead of being hidden by a test that
// quietly used the working spelling. Which of the two moves — the census's
// wording or the route's parameter list — is an owner call, not a lane's.
// ═════════════════════════════════════════════════════════════════════════════
describe("M10 — the §15 criterion, stated as the criterion", () => {
  /** A curated §24 zone far from ZONE_A, so it protects nothing in this viewport. */
  const FAR_ZONE = {
    id: "m10-zone-far",
    category: "medical_facility",
    action: null,
    privacy_floor: null,
    shape: "circle",
    center_lat: 10.0,
    center_lng: 100.0,
    radius_meters: 100,
    ring: null,
    jurisdiction: "VN",
    policy_ref: "portava/map-spec-24-m10",
    active: true,
  };

  function m10State(nowMs: number, over: StateOver = {}): FakeState {
    return baseState(nowMs, {
      // `protected_zones` READABLE and non-empty — 2217 applied AND curated,
      // which is the state the criterion's first half describes.
      protected_zones: [FAR_ZONE],
      events: [
        {
          id: "m10-ev-1",
          host_id: OTHER_HOST,
          title: "Riverside fireworks",
          location_name: "Han River",
          location_lat: ZONE_A.lat,
          location_lng: ZONE_A.lng,
          show_exact_location: true,
          starts_at: new Date(nowMs + 40 * MIN).toISOString(),
          ends_at: new Date(nowMs + 100 * MIN).toISOString(),
          visibility: "public",
          state: "published",
          age_min: null, age_max: null, trust_score_min: null, verified_only: false,
        },
      ],
      ...over,
    });
  }

  it("POSITIVE ARM: flag TRUE + 2217 applied ⇒ enabled:true with a NON-NULL forecast at +60m", async () => {
    const now = Date.now();
    const res = await temporal(m10State(now), `bbox=${BBOX}&offsetMinutes=60`);

    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true, "the criterion's first half");
    assert.notEqual(res.body.forecast, null, "the criterion's second half — a NULL forecast is not a Time Machine");
    assert.equal(res.body.target.mode, "forecast");
    assert.equal(
      res.body.target.at,
      new Date(now + 60 * MIN).toISOString().slice(0, 16) + res.body.target.at.slice(16),
      "the answer must be about the offset that was asked for",
    );

    // "non-null forecast" must mean a forecast that FORECAST something, not an
    // empty report object. A zeroed report would satisfy `!== null` and would be
    // the vacuous pass this arm exists to exclude.
    assert.ok(
      res.body.forecast.events + res.body.forecast.itinerary + res.body.forecast.plan.published >= 1,
      `forecast is non-null but counts nothing: ${JSON.stringify(res.body.forecast)}`,
    );
    const preds = predictions(res.body);
    assert.ok(preds.length >= 1, "a non-null forecast that served no prediction is an empty Time Machine");
    // §37, restated on the wire: a prediction is never an observation.
    for (const p of preds) {
      assert.equal(p.observedAt, undefined);
      assert.notEqual(p.freshness, "live");
    }
  });

  it("REFUSAL ARM: protected_zones unreadable ⇒ protection_unreadable, never an empty success", async () => {
    const now = Date.now();
    const res = await temporal(
      m10State(now, {
        protected_zones: { error: { message: 'relation "public.protected_zones" does not exist', code: "42P01" } },
      }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, false, "an unreadable §24 policy must not serve a forecast");
    assert.equal(res.body.refusal, "protection_unreadable");
    assert.deepEqual(res.body.objects, []);
    assert.equal(res.body.forecast, null);
    assert.equal(res.body.protection, null);
  });

  it("ANTI-VACUITY: the two arms differ only in the policy read — same offset, same events", async () => {
    // Without this, "the refusal arm returned nothing" is indistinguishable from
    // "there was nothing to return". The positive arm above and this one are the
    // SAME fixture; only `protected_zones` changes.
    const now = Date.now();
    const ok = await temporal(m10State(now), `bbox=${BBOX}&offsetMinutes=60`);
    // The §24 policy is cached for 30 s inside the route. Without this clear the
    // second request reuses the FIRST one's zone list and never sees the read
    // failure at all — the case would then compare a response with itself and
    // pass for the wrong reason. (It did, before this line was added.)
    _clearTemporalProtectedZoneCache();
    const bad = await temporal(
      m10State(now, { protected_zones: { error: { message: "boom" } } }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );
    assert.ok(ok.body.objects.length > 0, "the positive arm must actually serve something");
    assert.equal(bad.body.objects.length, 0);
    assert.notEqual(ok.body.enabled, bad.body.enabled);
  });

  it("ANTI-VACUITY: flag FALSE ⇒ enabled:false with a null forecast, and no refusal", async () => {
    const now = Date.now();
    const res = await temporal(
      m10State(now, { feature_flags: [{ flag: "map_projection_enabled", enabled: false }] }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.forecast, null);
    assert.equal("refusal" in res.body, false, "a deliberate off switch is not a refusal");
  });

  it("CONTRACT GAP: the census's `?offset=+60m` spelling is NOT accepted by this route", async () => {
    // Pinned deliberately. `parseTemporalTarget` reads offsetMinutes / at /
    // windowStartsAt / windowEndsAt; `offset` is not in that list, so the
    // criterion as written cannot be executed verbatim against this build.
    // If the route later grows the alias, this case goes red and whoever added
    // it must decide what the criterion now says — which is the point.
    const now = Date.now();
    const res = await temporal(m10State(now), `bbox=${BBOX}&offset=%2B60m`);
    assert.equal(res.status, 400, "if this is no longer 400, the alias landed — update the census wording");
    assert.equal(res.body.error ?? res.body.code, "invalid_payload");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// M280 — Phase 5, Temporal Intelligence.
//
// "M10 does — 2217 applied, then `map_projection_enabled` TRUE in production,
//  in that order. Nothing else in the phase has a blocker of its own."
//
// So the phase's acceptance is M10's positive arm PLUS the §15 rows already
// graded C (M106–M111) still holding. Five of those six are client-side
// constants and components; the one this package can re-execute is the
// producer contract they all rest on — that a forecast object is a
// DISCRIMINATED kind carrying confidence and never a live freshness (M106,
// M110), which is what makes "historical and forecast, unmistakably different"
// true on the wire rather than only in a type.
// ═════════════════════════════════════════════════════════════════════════════
describe("M280 — Phase 5 holds when M10's positive arm holds", () => {
  it("ORDER: 2217 before the flag. The reverse order serves nothing at all", async () => {
    const now = Date.now();
    // The state a production "flip 2201 first" produces: flag TRUE, table absent.
    const flipFirst = await temporal(
      baseState(now, {
        protected_zones: { error: { message: 'relation "public.protected_zones" does not exist', code: "42P01" } },
      }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );
    assert.equal(flipFirst.body.enabled, false);
    assert.equal(flipFirst.body.refusal, "protection_unreadable");

    // The state the correct order produces: table present (even empty), flag TRUE.
    const correctOrder = await temporal(baseState(now), `bbox=${BBOX}&offsetMinutes=60`);
    assert.equal(correctOrder.body.enabled, true);
    assert.notEqual(correctOrder.body.forecast, null);
  });

  it("M106/M110 on the wire: every served forecast object is a prediction, never live, never observed", async () => {
    const now = Date.now();
    const res = await temporal(
      baseState(now, {
        protected_zones: [],
        events: [
          {
            id: "m280-ev", host_id: OTHER_HOST, title: "Night set",
            location_name: "Sky Bar", location_lat: ZONE_A.lat, location_lng: ZONE_A.lng,
            show_exact_location: true,
            starts_at: new Date(now + 40 * MIN).toISOString(),
            ends_at: new Date(now + 100 * MIN).toISOString(),
            visibility: "public", state: "published",
            age_min: null, age_max: null, trust_score_min: null, verified_only: false,
          },
        ],
      }),
      `bbox=${BBOX}&offsetMinutes=60`,
    );
    assert.equal(res.body.enabled, true);
    const preds = predictions(res.body);
    assert.ok(preds.length >= 1, "no prediction served — the rest of this case would be vacuous");
    for (const p of preds) {
      assert.equal(p.kind, "prediction");
      assert.notEqual(p.freshness, "live", "§37: a prediction must never look live");
      assert.equal(p.observedAt, undefined, "§37: a prediction was never observed");
    }
    // And the historical arm is the OTHER branch — not the same objects relabelled.
    const past = await temporal(baseState(now, { protected_zones: [] }), `bbox=${BBOX}&offsetMinutes=-1440`);
    assert.equal(past.body.target.mode === "forecast", false, "a negative offset must not be a forecast");
    assert.equal(past.body.forecast, null, "the historical arm reports history, not forecast");
  });
});
