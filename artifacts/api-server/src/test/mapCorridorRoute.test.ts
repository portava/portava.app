/**
 * "Along My Way" through the Map Intelligence Gateway (§36 Phase 6 + §19).
 *
 * lib/mapCorridor is proven pure in src/test/mapCorridor.test.ts. THESE tests
 * drive the REAL route, because the properties that matter are properties of
 * the wiring rather than of the geometry:
 *
 *   1. WITH THE FLAG OFF THE PARAMETER IS IGNORED, AND SAID SO. The OBJECT SET
 *      is what the endpoint served before Phase 6 — the whole bbox — and
 *      `corridor.refusal` reads 'flag_off' so a client cannot mistake it for a
 *      corridor that happened to keep everything. NOT byte-for-byte, and the
 *      test below compares id sets rather than pretending otherwise: the
 *      envelope grows a `corridor` object and a null `corridorMatches` whenever
 *      a corridor was asked for, because "ignored" is itself something the
 *      client has to be told.
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
      "the OBJECT SET is what it served before Phase 6 — id sets, not bytes",
    );
    assert.equal(withCorridor.body.corridorMatches, null, "no detour lines while it is off");
    // And the two envelopes really are NOT identical, which is why the
    // assertion above is on ids: `corridor` carries the refusal.
    assert.equal(plain.body.corridor, null, "no corridor asked for ⇒ no corridor key content");
    assert.notDeepEqual(withCorridor.body.corridor, plain.body.corridor);
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

// ── 5. THE CORRIDOR RUNS ON WHAT THE GATEWAY SERVES, NOT ON THE TRUTH ─────────
//
// The two leaks that made the "corridor sees only post-§24 objects" claim false
// when the filter ran ~80 lines BEFORE `applyProtection`. Both are reproductions
// of a proven exploit, not hypotheticals, and both are stated as the number the
// response must carry rather than as "no leak".
//
//  A. PRE-COARSENING COORDINATES. A place inside a `medical_facility` zone is
//     served coarsened — its Point replaced by the zone anchor — but the detour
//     was computed from the TRUE centroid it no longer publishes. Two queries
//     with non-parallel polylines trilaterate that centroid to ~1 m, so the
//     cost itself was the disclosure. The cost must now describe the ANCHOR.
//  B. A COUNTER THAT COUNTS WITHHELD OBJECTS. A place inside a `shelter` zone
//     is SUPPRESSED — `objects` is empty — yet `corridor.kept` read 1. Sweeping
//     the polyline at the 50 m minimum half-width turns that integer into a
//     position oracle for an object the gate refused to serve at all.

/** A single-segment route due east along lat 16.0600, ~1 070 m long. */
const STRAIGHT = "16.0600,108.2200;16.0600,108.2300";

/**
 * Inside a medical_facility (coarsen) zone.
 *
 *   TRUE centroid    16.06250, 108.23000  → 0.0025° lat off the line → 278 m
 *   ZONE anchor      16.06400, 108.23000  → 0.0040° lat off the line → 445 m
 *
 * The half-width is 600 m so BOTH survive the filter: the test is about which
 * number is reported, not about whether the object appears.
 */
const CLINIC_PLACE = place("clinic", 16.06250, 108.23000);
const CLINIC_ZONE = {
  id: "zone-clinic",
  category: "medical_facility",
  action: null,
  privacy_floor: null,
  shape: "circle",
  center_lat: 16.06400,
  center_lng: 108.23000,
  radius_meters: 400,
  ring: null,
  jurisdiction: null,
  policy_ref: null,
  active: true,
};

/** Inside a shelter (suppress) zone, and squarely on the route. */
const SHELTER_PLACE = place("refuge", 16.06050, 108.22500);
const SHELTER_ZONE = {
  id: "zone-shelter",
  category: "shelter",
  action: null,
  privacy_floor: null,
  shape: "circle",
  center_lat: 16.06050,
  center_lng: 108.22500,
  radius_meters: 200,
  ring: null,
  jurisdiction: null,
  policy_ref: null,
  active: true,
};

describe("corridor — the detour describes the SERVED geometry, never the truth", () => {
  it("a coarsened place reports the detour to the zone ANCHOR, not to its real centroid", async () => {
    state = { ...baseState(true), places: [CLINIC_PLACE], protected_zones: [CLINIC_ZONE] };
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${STRAIGHT}&corridorMeters=600`,
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.corridor.refusal, null);
    assert.deepEqual(ids(res.body), ["place:clinic"], "the coarsened place is still served");

    const served = res.body.objects[0];
    assert.equal(served.privacyClass, "approximate", "§24 coarsened it");
    const [lng, lat] = served.geometry.coordinates as [number, number];
    assert.ok(Math.abs(lat - 16.064) < 1e-6 && Math.abs(lng - 108.23) < 1e-6,
      `served geometry is the zone anchor, got ${lat},${lng}`);

    const match = (res.body.corridorMatches as any[])[0];
    assert.equal(match.objectId, "place:clinic");
    // 0.0040° lat × 111 195 m/° = 444.8 → 445. The pre-fix answer was 278, the
    // exact perpendicular distance to the coordinate the gate had just removed.
    assert.equal(match.detour.offsetMeters, 445,
      "the detour must be measured from the anchor the client received");
    assert.notEqual(match.detour.offsetMeters, 278,
      "278 m is the distance to the TRUE centroid — publishing it re-leaks it");
    assert.equal(match.detour.extraMeters, 890);
    // alongMeters is derived from the same point and must move with it: the
    // anchor sits at the end of the segment, so it attaches at the far end.
    assert.ok(match.detour.alongMeters >= 1_060 && match.detour.alongMeters <= 1_075,
      `alongMeters ${match.detour.alongMeters} is the anchor's attachment point`);
  });

  it("a SUPPRESSED place is not counted by the corridor at all", async () => {
    state = { ...baseState(true), places: [SHELTER_PLACE], protected_zones: [SHELTER_ZONE] };
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=14&kinds=place&corridor=${STRAIGHT}&corridorMeters=600`,
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.objects, [], "§24 suppressed it");
    assert.equal(res.body.protection.suppressed, 1, "and says so, in counts only");
    // Pre-fix this read 1: a per-request integer that says "something you may
    // not see is within 600 m of this line", sweepable down to 50 m.
    assert.equal(res.body.corridor.kept, 0,
      "a withheld object must not survive in the corridor counter");
    assert.equal(res.body.corridor.considered, 0,
      "it was never offered to the corridor in the first place");
    assert.deepEqual(res.body.corridorMatches, [], "and carries no detour line");
  });
});

// ── 6. The corridor must not re-partition a k-anonymised cohort ───────────────
//
// The second half of "after §24" is "and after §31", and it needs its own test
// because the two coarsened-geometry cases above pass at any zoom below the
// aggregating bands. Filtering BEFORE `aggregateForViewport` would let a caller
// choose which objects get binned together, and therefore choose the cohort
// whose `count` the response publishes: sweep the polyline and you read a
// sequence of counts over sub-cohorts you selected, each individually above the
// k-floor. Filtering AFTER means the cells are binned from the whole protected
// set — cohort membership does not depend on the caller's geometry at all, and
// the corridor can only drop whole already-published cells.

/**
 * Twenty places in one zoom-9 cell (edge 0.703125°, so all of Da Nang is one
 * bin): twelve on the STRAIGHT route, eight well off it. Twenty clears the
 * k-floor of 15; the twelve on-route would not.
 */
const COHORT = [
  ...Array.from({ length: 12 }, (_, i) => place(`near-${i}`, 16.0601 + i * 0.00001, 108.2210 + i * 0.0005)),
  ...Array.from({ length: 8 }, (_, i) => place(`far-${i}`, 16.0800 + i * 0.0005, 108.2210 + i * 0.0005)),
];

describe("corridor — it cannot choose who is in a §31 cohort", () => {
  it("the cell is binned from the whole protected set, and the corridor sees only the cell", async () => {
    state = { ...baseState(true), places: COHORT };
    const res = await get(
      `/map/projection?bbox=${BBOX}&zoom=9&kinds=place&corridor=${STRAIGHT}&corridorMeters=300`,
    );
    assert.equal(res.status, 200);

    // All twenty contributed to ONE cell, and that cell cleared the k-floor of
    // 15. Run pre-aggregation and only the twelve on-route objects would be
    // binned — 12 < 15 — so the cell would be suppressed instead, and the
    // caller would have chosen that outcome with their polyline.
    assert.equal(res.body.aggregation.aggregated, 20, "the whole set was binned, corridor or not");
    assert.equal(res.body.aggregation.zones, 1);
    assert.equal(
      res.body.aggregation.suppressedForKAnonymity,
      0,
      "the corridor must not be able to push a cohort under the k-floor",
    );

    // And the corridor was offered exactly the served object — the cell —
    // rather than the twenty individuals behind it.
    assert.equal(res.body.corridor.considered, 1, "one aggregated cell, not twenty places");
  });

  it("the same cohort is published whatever polyline the caller sends", async () => {
    // The property stated directly: the cohort count cannot be steered.
    const counts: number[] = [];
    for (const line of [
      STRAIGHT,
      "16.0800,108.2200;16.0800,108.2300",
      "16.0400,108.2000;16.0900,108.2600",
    ]) {
      state = { ...baseState(true), places: COHORT };
      const res = await get(
        `/map/projection?bbox=${BBOX}&zoom=9&kinds=place&corridor=${line}&corridorMeters=300`,
      );
      counts.push(res.body.aggregation.aggregated);
    }
    assert.deepEqual(counts, [20, 20, 20], "the cohort is a property of the viewport, not of the route");
  });
});
