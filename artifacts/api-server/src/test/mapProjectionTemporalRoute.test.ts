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
  error?: { message: string };
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
