/**
 * M282 — §36 Phase 7 World Intelligence: the arm nobody had asserted.
 *
 * `src/test/mapWorldIntelligenceLayer.test.ts` covers this phase thoroughly and
 * covers two of M282's three arms already:
 *
 *   ARM 1 (flag TRUE + gateway serving ⇒ a Phase 7 object) — "the traveler-flow
 *     graph publishes a city→city edge", "the city model publishes a k-gated
 *     rhythm", "World Pulse is built only from already-aggregated sources".
 *   ARM 3 (an unreadable producer source ⇒ a refusal and NO object, never an
 *     ungated one) — the whole "Phase 7 fails closed" block: unreadable
 *     geography, unreadable city aggregate, unreadable and THROWN stamp reads.
 *
 * ARM 2 IS THE ONE THAT WAS MISSING, and it is the one 2295's own description
 * makes a claim about: with the flag FALSE the route issues **no Phase 7 read
 * at all**. The existing flag-off cases assert the OUTPUT — no objects, refusal
 * `flag_off`, no `sources` entry. Every one of those is satisfied by a route
 * that reads all four Phase 7 sources, builds the objects, and then throws them
 * away. That is not a hypothetical shape: it is what a gate placed after the
 * producers rather than before them does, and the only externally visible
 * difference is the work done and the personal data touched.
 *
 * `passport_stamps` is the reason this matters rather than being tidiness. The
 * personal-city producer reads the VIEWER'S OWN travel history. A disabled
 * capability that still reads it is processing personal data for an output
 * that, by the operator's own decision, will not be produced.
 *
 * So this file counts reads. The route is driven with a client that records
 * every `from(table)`, and the assertion is on the recorded list.
 *
 * ## Anti-vacuity
 *
 * The recorder is proved to record: the same request with the flag ON must show
 * the Phase 7 tables in the list. Without that, "no Phase 7 table was read" is
 * equally satisfied by a spy that never fires, which is the exact shape of a
 * false green this corpus has been bitten by before.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/worldIntelligenceConsumers.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

// The accepted_plan family derives an HMAC party token and refuses without a
// secret. Set before any route runs, exactly as the real server does from env.
process.env.INTEL_GROUP_KEY_SECRET =
  process.env.INTEL_GROUP_KEY_SECRET ?? "world-intelligence-consumers-test-secret";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import {
  WORLD_INTELLIGENCE_FLAG,
  WORLD_INTELLIGENCE_KINDS,
} from "../lib/mapProducers/worldIntelligence.js";

const TOKEN = "world-intel-consumers-token";
const USER = "world-intel-consumers-viewer";

/** A viewport over mainland South-East Asia, at the city band. */
const BBOX = "95.0,0.0,115.0,25.0";
const ZOOM = 8;
const ALL_PHASE_7_KINDS = WORLD_INTELLIGENCE_KINDS.join(",");

const CITY_RADIUS_M = 20_000;

/**
 * The tables ONLY §36 Phase 7 reads on a Phase-7-only request.
 *
 * Derived from `routes/mapProjection.ts`'s Phase 7 block: `loadCityZones`
 * (`geo_zones` where zone_type = 'city'), the city-model aggregate, the
 * viewer's stamps, and the accepted-plan graph the traveler-flow producer
 * walks. None of them is read by the base projection when no other kind is
 * requested, which is what makes the count meaningful.
 *
 * `feature_flags` is deliberately NOT here: reading the flag is the whole
 * permitted cost of a disabled layer, and the route's own comment says so.
 */
const PHASE_7_ONLY_TABLES = [
  "geo_zones",
  "compass_city_models",
  "passport_stamps",
  "route_plans",
  "route_stops",
  "route_legs",
  "route_flow_contribution_consent",
] as const;

// ── a recording fake client ──────────────────────────────────────────────────

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
  const result = () =>
    err ? { data: null, error: err } : { data: rows, error: null, count: rows.length };
  const q: any = {
    select: () => q,
    order: () => q,
    range: () => q,
    ilike: () => q,
    or: () => q,
    limit: (n: number) => {
      rows = rows.slice(0, n);
      return q;
    },
    eq: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] === val);
      return q;
    },
    neq: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] !== val);
      return q;
    },
    in: (col: string, vals: any[]) => {
      rows = rows.filter((r) => vals.includes(r[col]));
      return q;
    },
    gte: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] >= val);
      return q;
    },
    lte: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] <= val);
      return q;
    },
    gt: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] > val);
      return q;
    },
    lt: (col: string, val: any) => {
      rows = rows.filter((r) => r[col] < val);
      return q;
    },
    is: (col: string, val: any) => {
      rows = val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val);
      return q;
    },
    not: (col: string, op: string, val: any) => {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      return q;
    },
    maybeSingle: () =>
      Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
    single: () =>
      Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null }),
    then: (res: (v: any) => void, rej?: (e: any) => void) =>
      Promise.resolve(result()).then(res, rej),
  };
  return q;
}

/** Every `from(table)` the route performed on the last request, in order. */
let reads: string[] = [];

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => {
      reads.push(table);
      return buildQuery(specOf(state, table));
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const CITY_A = { id: "city-a", name: "Da Nang", lat: 16.05, lng: 108.2 };
const CITY_B = { id: "city-b", name: "Hoi An", lat: 15.88, lng: 108.33 };

const cityRow = (c: typeof CITY_A) => ({
  id: c.id,
  name: c.name,
  zone_type: "city",
  center_lat: c.lat,
  center_lng: c.lng,
  radius_meters: CITY_RADIUS_M,
  polygon_geojson: null,
});

/**
 * Enough state that a flag-ON request has something to read in every Phase 7
 * table. The point of this file is WHICH TABLES ARE TOUCHED, not what is
 * published, so the rows only have to be shaped well enough to be read.
 */
function phase7State(over: FakeState = {}): FakeState {
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: WORLD_INTELLIGENCE_FLAG, enabled: true },
    ],
    protected_zones: [],
    geo_zones: [CITY_A, CITY_B].map(cityRow),
    places: [],
    blocks: [],
    compass_city_models: [],
    passport_stamps: [],
    route_plans: [],
    route_stops: [],
    route_legs: [],
    route_flow_contribution_consent: [],
    ...over,
  };
}

// ── test server ──────────────────────────────────────────────────────────────

let server: http.Server;
let base = "";

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
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
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
    // Loopback explicitly: a host-less listen(0) binds [::] and a foreign IPv4
    // listener can then answer the request.
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  reads = [];
  // All three loaders cache for 30 s. A warm cache would let one scenario
  // answer another scenario's question — and here it would also hide a read,
  // which is precisely what is being counted.
  _clearProtectedZoneCache();
  _clearFlowZoneCache();
  _clearCityZoneCache();
});

async function projection(state: FakeState, kinds = ALL_PHASE_7_KINDS) {
  _setTestClient(makeClient(state) as any, true);
  return get(`/map/projection?bbox=${BBOX}&zoom=${ZOOM}&kinds=${kinds}`);
}

const phase7Reads = () => reads.filter((t) => (PHASE_7_ONLY_TABLES as readonly string[]).includes(t));

// ─────────────────────────────────────────────────────────────────────────────

describe("M282 arm 2 — a disabled Phase 7 issues NO Phase 7 read", () => {
  it("the recorder records, and the flag-ON request touches the Phase 7 sources", async () => {
    // ANTI-VACUITY, FIRST. Everything below is a claim that a list is EMPTY,
    // and an empty list is what a broken spy produces too.
    const r = await projection(phase7State());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.worldIntelligence.refusal, null, JSON.stringify(r.body.worldIntelligence));
    assert.ok(reads.length > 0, "the recorder saw no reads at all");
    assert.ok(
      phase7Reads().length > 0,
      `with the flag ON at least one Phase 7 source must be read; saw ${reads.join(", ")}`,
    );
    assert.ok(
      reads.includes("passport_stamps"),
      "the personal-city producer must read the viewer's stamps when enabled",
    );
  });

  it("with the flag OFF, not one Phase 7 table is read", async () => {
    const r = await projection(
      phase7State({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: WORLD_INTELLIGENCE_FLAG, enabled: false },
        ],
      }),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.worldIntelligence.refusal, "flag_off");
    assert.deepEqual(
      phase7Reads(),
      [],
      "a disabled capability read a Phase 7 source anyway — the gate is after the producers, not before them",
    );
  });

  it("with the flag OFF, the viewer's travel history is NOT read", async () => {
    // Stated separately from the case above because it is the one with a
    // privacy consequence rather than a cost one, and because a future change
    // that narrows PHASE_7_ONLY_TABLES must not be able to drop it silently.
    //
    // HONEST NOTE ON WHAT THIS CASE CAN AND CANNOT CATCH. `passport_stamps` is
    // behind TWO independent gates: the route's Phase 7 block, and
    // `personalCityProducer`'s own `isFlagEnabled` check (mapProducers/
    // personalCityProducer.ts, which pins the same literal). Measured: removing
    // the ROUTE gate entirely leaves this case GREEN, because the producer's
    // own check still refuses — the route gate's unique contribution is
    // skipping `loadCityZones`, which the case above catches. So this is a
    // defence-in-depth assertion, not a mutation-proven one: it fails only if
    // BOTH gates go, which is exactly the day it is worth having. It is
    // recorded as such rather than presented as stronger than it is.
    await projection(
      phase7State({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: WORLD_INTELLIGENCE_FLAG, enabled: false },
        ],
      }),
    );
    assert.ok(
      !reads.includes("passport_stamps"),
      "a disabled capability read the viewer's personal travel history",
    );
  });

  it("reading the flag itself IS the permitted cost, and it happens", async () => {
    // The complement: the route is not permitted to skip the flag read either,
    // because a capability nobody checks is a capability nobody can turn off.
    await projection(
      phase7State({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: WORLD_INTELLIGENCE_FLAG, enabled: false },
        ],
      }),
    );
    assert.ok(reads.includes("feature_flags"), "the flag was never read");
  });

  it("and no Phase 7 object is served", async () => {
    const r = await projection(
      phase7State({
        feature_flags: [
          { flag: "map_projection_enabled", enabled: true },
          { flag: WORLD_INTELLIGENCE_FLAG, enabled: false },
        ],
      }),
    );
    for (const kind of WORLD_INTELLIGENCE_KINDS) {
      assert.equal(
        (r.body.objects ?? []).filter((o: any) => o.kind === kind).length,
        0,
        `${kind} was served with the flag off`,
      );
    }
  });
});

describe("the flag the route checks is the flag 2295 created", () => {
  it("the route's literal and the module constant have not drifted apart", () => {
    // `routes/mapProjection.ts` checks a STRING LITERAL so `check:flag-polarity`
    // can resolve it statically, and pins it against this constant in the same
    // file. If the two ever diverge, the layer is gated by a flag row that does
    // not exist — which reads as "permanently off" and looks like a dark
    // feature rather than a typo.
    assert.equal(WORLD_INTELLIGENCE_FLAG, "map_world_intelligence_enabled");
  });
});
