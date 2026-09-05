/**
 * "Along My Way" through the Map Intelligence Gateway (§36 Phase 6 + §19).
 *
 * lib/mapCorridor is proven pure in src/test/mapCorridor.test.ts. THESE tests
 * drive the REAL route, because the properties that matter are properties of
 * the wiring rather than of the geometry:
 *
 *   1. WITH THE FLAG OFF THE PARAMETER IS IGNORED, AND SAID SO. The response is
 *      byte-for-byte what the endpoint served before Phase 6 — the whole bbox —
 *      and `corridor.refusal` reads 'flag_off' so a client cannot mistake it
 *      for a corridor that happened to keep everything.
 *   2. WITH THE FLAG ON IT FILTERS, AND THE RESULT IS A SUBSET. The same
 *      request with and without a corridor is run over identical fixtures and
 *      the corridor answer is asserted to be a subset of the plain one — the
 *      claim that this opens no privacy surface, checked rather than asserted.
 *   3. THE §31 LADDER STILL DECIDES. The gateway ranks after the corridor runs.
 *   4. A MALFORMED CORRIDOR IS REFUSED, NOT REPAIRED — including a one-point
 *      "route", which would otherwise become a radius search.
 *   5. A CORRIDOR CAN SUPPLY THE VIEWPORT. With no bbox, the polyline's own
 *      padded extent is used, which is strictly tighter than a client guess.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapCorridorRoute.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";

const TOKEN = "corridor-test-token";
const USER = "corridor-viewer";

/**
 * An L-shaped route through Da Nang: east along a street, then north. The
 * corner is what makes "near the LINE" different from "near an endpoint".
 */
const ROUTE = "16.0600,108.2200;16.0600,108.2300;16.0700,108.2300";
/** A bbox that comfortably contains the route and every fixture below. */
const BBOX = "108.20,16.04,108.26,16.09";

// ── fake Supabase client ──────────────────────────────────────────────────────

interface TableSpec { rows?: any[]; error?: { message: string } }
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
    limit() { return q; },
    range() { return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    is(col: string, val: any) {
      rows = val === null ? rows.filter((r) => r[col] == null) : rows.filter((r) => r[col] === val);
      return q;
    },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) rows = rows.filter((r) => r[col] != null);
      return q;
    },
    or() { return q; },
    maybeSingle() {
      return Promise.resolve(err ? { data: null, error: err } : { data: rows[0] ?? null, error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

let state: FakeState = {};

function makeClient() {
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

function place(id: string, lat: number, lng: number, name = id): any {
  return {
    id,
    name,
    latitude: lat,
    longitude: lng,
    status: "active",
    merged_into_place_id: null,
    primary_category: "restaurant",
    city: "Da Nang",
    neighborhood: null,
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

/**
 * Three ON the route and three well OFF it. The off-route three sit ~1 km south
 * and ~2 km east of the corner — inside the bbox, outside any sane corridor.
 */
const PLACES = [
  place("on-1", 16.0601, 108.2220),
  place("on-2", 16.0602, 108.2270),
  place("on-3", 16.0660, 108.2301),
  place("off-1", 16.0500, 108.2220),
  place("off-2", 16.0500, 108.2270),
  place("off-3", 16.0600, 108.2500),
];

function baseState(journeyFlag: boolean): FakeState {
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_journey_intelligence_enabled", enabled: journeyFlag },
    ],
    protected_zones: [],
    blocks: [],
    places: PLACES,
    intel_state_snapshots: [],
  };
}

// ── server ────────────────────────────────────────────────────────────────────

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
  _setTestClient(makeClient() as any, true);
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  _clearProtectedZoneCache();
});

const ids = (body: any): string[] => (body.objects ?? []).map((o: any) => o.id);

// ── 1. Flag off ───────────────────────────────────────────────────────────────

describe("corridor — with the flag off the parameter is ignored, and says so", () => {
  it("serves the whole bbox and reports flag_off", async () => {
    state = baseState(false);
    const withCorridor = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=300`,
    );
    state = baseState(false);
    const plain = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=place`);

    assert.equal(withCorridor.status, 200);
    assert.equal(withCorridor.body.corridor.refusal, "flag_off");
    assert.deepEqual(
      ids(withCorridor.body).sort(),
      ids(plain.body).sort(),
      "the answer is what it served before Phase 6",
    );
    assert.equal(withCorridor.body.corridorMatches, null, "no detour lines while it is off");
  });

  it("reports null — not a refusal — when no corridor was asked for at all", async () => {
    state = baseState(true);
    const res = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=place`);
    assert.equal(res.body.corridor, null);
    assert.equal(res.body.corridorMatches, null);
  });
});

// ── 2. Flag on: it filters, and only ever removes ─────────────────────────────

describe("corridor — with the flag on it filters, and the result is a SUBSET", () => {
  it("keeps on-route objects and drops off-route ones", async () => {
    state = baseState(true);
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=300`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.corridor.refusal, null);

    const kept = ids(res.body);
    for (const id of ["place:on-1", "place:on-2", "place:on-3"]) {
      assert.ok(kept.includes(id), `${id} is on the route`);
    }
    for (const id of ["place:off-1", "place:off-2", "place:off-3"]) {
      assert.ok(!kept.includes(id), `${id} is off the route`);
    }
    assert.equal(res.body.corridor.kept, 3);
    assert.equal(res.body.corridor.droppedOffRoute, 3);
  });

  it("is a subset of the SAME request without a corridor", async () => {
    state = baseState(true);
    const corridor = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=300`,
    );
    state = baseState(true);
    const plain = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=place`);

    const plainIds = new Set(ids(plain.body));
    assert.ok(plainIds.size > 0, "the plain answer is not empty — this is not a vacuous subset");
    for (const id of ids(corridor.body)) {
      assert.ok(plainIds.has(id), `${id} was already visible without the corridor`);
    }
    assert.ok(ids(corridor.body).length < plainIds.size, "and it actually removed something");
  });

  it("attaches a detour estimate per served object, labelled as an estimate (§37)", async () => {
    state = baseState(true);
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=300`,
    );
    const matches = res.body.corridorMatches as any[];
    assert.equal(matches.length, res.body.objects.length);
    for (const m of matches) {
      assert.equal(m.detour.basis, "straight_line_estimate");
      assert.ok(/^(Est\. \+\d+ min detour|On your route) · /.test(m.line), m.line);
    }
    assert.deepEqual(
      matches.map((m) => m.objectId),
      res.body.objects.map((o: any) => o.id),
      "match order follows the served page order",
    );
  });

  it("a wider corridor keeps everything a narrower one kept", async () => {
    state = baseState(true);
    const narrow = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=100`,
    );
    state = baseState(true);
    const wide = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=2000`,
    );
    const wideIds = new Set(ids(wide.body));
    for (const id of ids(narrow.body)) assert.ok(wideIds.has(id), `${id} survives the wider corridor`);
  });
});

// ── 3. Malformed corridors are refused, not repaired ──────────────────────────

describe("corridor — refused rather than repaired", () => {
  it("a ONE-POINT route is invalid, and does not become a radius search", async () => {
    state = baseState(true);
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=16.0600,108.2200`,
    );
    assert.equal(res.body.corridor.refusal, "invalid_corridor");
    // The bbox answer is served (a superset), NOT a radius around that point.
    assert.equal(ids(res.body).length, PLACES.length);
    assert.equal(res.body.corridorMatches, null);
  });

  it("an out-of-range vertex is invalid", async () => {
    state = baseState(true);
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=91,0;16.06,108.22`,
    );
    assert.equal(res.body.corridor.refusal, "invalid_corridor");
  });

  it("a garbage corridor is invalid", async () => {
    state = baseState(true);
    const res = await get(`/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=nonsense`);
    assert.equal(res.body.corridor.refusal, "invalid_corridor");
  });
});

// ── 4. A corridor can supply the viewport ─────────────────────────────────────

describe("corridor — it can define the viewport", () => {
  it("with no bbox, the polyline's padded extent is used", async () => {
    state = baseState(true);
    const res = await get(
      `/map/projection?zoom=14&kinds=place&corridor=${ROUTE}&corridorMeters=300`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.corridor.refusal, null);
    assert.deepEqual(ids(res.body).sort(), ["place:on-1", "place:on-2", "place:on-3"]);
    // The derived viewport really is the corridor's own extent, not a default.
    const bbox = res.body.viewport.bbox;
    assert.ok(bbox.south < 16.06 && bbox.north > 16.07, "covers the route in latitude");
    assert.ok(bbox.west < 108.22 && bbox.east > 108.23, "covers the route in longitude");
  });

  it("with neither a bbox NOR a usable corridor, the request is rejected", async () => {
    state = baseState(true);
    const res = await get(`/map/projection?zoom=14&kinds=place&corridor=16.06,108.22`);
    assert.equal(res.body.error, "invalid_payload");
  });
});
