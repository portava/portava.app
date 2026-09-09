/**
 * GET /trips/:tripId/feasibility, EXERCISED — not read.
 *
 * WHY THIS FILE EXISTS ALONGSIDE tripFeasibilityRoute.test.ts
 * ==========================================================
 * That file reads the route's source and checks its shape: it is registered,
 * it authorizes before it reads, its read failures are 503. Every one of those
 * assertions passed while the route was INERT.
 *
 * It was inert for a reason worth stating, because it is the exact failure the
 * vertical-slice rule is about. Both endpoints of every hop were hardcoded
 * `null` — with a comment explaining that trip_commitments.place_id has no
 * foreign key — so the provider answered NO_COORDINATES on every hop and the
 * route could return only UNKNOWN. TripFeasibilityEngine can prove INFEASIBLE
 * and has 44 tests saying so; none of that was reachable through the product.
 *
 * So this file drives the real Express app with a fake Supabase client and
 * asserts the VERDICTS, including the one that could not previously happen:
 *
 *   INFEASIBLE at the boundary, and on either side of it by one minute
 *   FEASIBLE_UNVERIFIED, never FEASIBLE, while the provider is not routed
 *   UNKNOWN when a place is missing, absent, or unlocated — three states that
 *     produce one verdict and must still be told apart in the response
 *   503 when the places read fails — an unreadable day is not a workable one
 *
 * The distances are computed from the provider's own published constants
 * rather than copied, so this file cannot drift from it silently.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_MAX_METRES,
} from "../services/trips/TravelTimeProvider.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const TRIP_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_A  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const PLACE_B  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";
const GHOST    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb9";

// ── geometry, derived from the provider's constants ─────────────────────────
const EARTH_RADIUS_M = 6_371_008.8;
/** A point `metres` due north of `lat`/`lng`. Due north so longitude scaling
 *  cannot make the distance depend on the latitude chosen. */
function northOf(lat: number, lng: number, metres: number): { lat: number; lng: number } {
  return { lat: lat + (metres / EARTH_RADIUS_M) * (180 / Math.PI), lng };
}
/** The provider's own drive formula, so the expectation is derived, not copied. */
function driveMinutes(metres: number): number {
  return Math.ceil((metres / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60);
}

const ORIGIN = { lat: 48.8566, lng: 2.3522 };
/** Comfortably past WALK_MAX_METRES so the mode is deterministic. */
const SEPARATION_M = WALK_MAX_METRES * 5;
const DEST = northOf(ORIGIN.lat, ORIGIN.lng, SEPARATION_M);
const TRAVEL_MIN = driveMinutes(SEPARATION_M);

// ── a fake client that supports exactly the chains this route uses ──────────
type Row = Record<string, any>;
interface Opts { errorOn?: string[] }

function makeClient(tables: Record<string, Row[]>, opts: Opts = {}) {
  const errorOn = new Set(opts.errorOn ?? []);
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from(table: string) {
      const failing: any = {
        select: () => failing, eq: () => failing, in: () => failing, order: () => failing,
        maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable` } }),
        single: async () => ({ data: null, error: { message: `${table} unavailable` } }),
        then: (onF: any, onR: any) =>
          Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onF, onR),
      };
      if (errorOn.has(table)) return failing;

      const filters: Array<(r: Row) => boolean> = [];
      let single = false;
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return chain; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
        order: () => chain,
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      function settle() {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      return chain;
    },
  };
}

function commitment(over: Row): Row {
  return {
    id: over.id, trip_id: TRIP_ID, type: "event",
    starts_at: null, required_arrival_at: null, place_id: null,
    lateness_tolerance: null, prep_duration: null, ...over,
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
let server: Server;
let port: number;

async function start(): Promise<void> {
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; resolve(); });
  });
}
after(() => { server?.close(); });

async function get(path: string, token = "owner-token"): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function install(tables: Record<string, Row[]>, opts: Opts = {}) {
  const c = makeClient(tables, opts);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

const crew = [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }];
const places = [
  { id: PLACE_A, latitude: ORIGIN.lat, longitude: ORIGIN.lng },
  { id: PLACE_B, latitude: DEST.lat,   longitude: DEST.lng },
];

/** Two commitments separated by `gapMinutes`, both located. */
function twoHops(gapMinutes: number, extra: Row = {}) {
  const t0 = "2026-10-01T09:00:00.000Z";
  const t1 = new Date(Date.parse(t0) + gapMinutes * 60_000).toISOString();
  return {
    trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
    trip_members: crew,
    places,
    trip_commitments: [
      commitment({ id: "c1", starts_at: t0, place_id: PLACE_A }),
      commitment({ id: "c2", starts_at: t1, required_arrival_at: t1, place_id: PLACE_B, ...extra }),
    ],
  };
}

beforeEach(async () => { if (!server) await start(); });

describe("§7 — the verdict the route could not previously produce", () => {
  it("INFEASIBLE when the gap is one minute SHORT of the straight-line travel time", async () => {
    // A straight line is a LOWER BOUND: no road is shorter than the great
    // circle. So failing here is a sound proof, and it is the only verdict
    // this provider is entitled to state as fact.
    install(twoHops(TRAVEL_MIN - 1));
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.status, 200);
    assert.equal(r.body.verdict, "INFEASIBLE", JSON.stringify(r.body.hops));
    assert.equal(r.body.evaluatedHops, 1);
    assert.equal(r.body.hops[0].slackMinutes, -1);
    assert.equal(r.body.offendingHopIndex, 0);
  });

  it("EXACTLY enough time is not infeasible — the boundary is inclusive", async () => {
    install(twoHops(TRAVEL_MIN));
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "FEASIBLE_UNVERIFIED", JSON.stringify(r.body.hops));
    assert.equal(r.body.hops[0].slackMinutes, 0);
  });

  it("one minute MORE than needed is feasible-unverified, never FEASIBLE", async () => {
    install(twoHops(TRAVEL_MIN + 1));
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "FEASIBLE_UNVERIFIED");
    assert.notEqual(r.body.verdict, "FEASIBLE");
    assert.equal(r.body.hops[0].slackMinutes, 1);
    assert.equal(r.body.provider.routed, false);
    assert.match(r.body.disclosure, /not measured routes/);
  });

  it("prep time comes out of the same budget — enough travel, not enough prep", async () => {
    // The §7.2 invariant is travel + prep, not travel alone. With exactly
    // enough time for the journey, ten minutes of preparation makes it fail.
    install(twoHops(TRAVEL_MIN, { prep_duration: "00:10:00" }));
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "INFEASIBLE");
    assert.equal(r.body.hops[0].prepMinutes, 10);
    assert.equal(r.body.hops[0].slackMinutes, -10);
  });

  it("lateness tolerance buys exactly its own length back, and no more", async () => {
    install(twoHops(TRAVEL_MIN - 5, { lateness_tolerance: "00:05:00" }));
    const ok = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(ok.body.verdict, "FEASIBLE_UNVERIFIED", JSON.stringify(ok.body.hops));

    install(twoHops(TRAVEL_MIN - 6, { lateness_tolerance: "00:05:00" }));
    const bad = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(bad.body.verdict, "INFEASIBLE", JSON.stringify(bad.body.hops));
  });

  it("required_arrival_at is respected even when the thing starts later", async () => {
    // The spec's own example: an activity starts 19:00, arrival is required by
    // 18:45. The deadline is the ARRIVAL, and the system must not call that
    // feasible on the strength of the start time.
    const depart = "2026-10-01T18:00:00.000Z";
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      places,
      trip_commitments: [
        commitment({ id: "c1", starts_at: depart, place_id: PLACE_A }),
        commitment({
          id: "c2",
          starts_at: "2026-10-01T19:00:00.000Z",
          required_arrival_at: "2026-10-01T18:45:00.000Z",
          place_id: PLACE_B,
        }),
      ],
    });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.hops[0].usedStartAsArrival, false,
      "the arrival requirement was ignored in favour of the start time");
    // 45 minutes to travel, against the provider's own number.
    const expected = 45 - TRAVEL_MIN;
    assert.equal(r.body.hops[0].slackMinutes, expected);
    assert.equal(r.body.verdict, expected < 0 ? "INFEASIBLE" : "FEASIBLE_UNVERIFIED");
  });
});

describe("§7 — three ways to have no coordinates, told apart", () => {
  it("a commitment that names no place is UNKNOWN with NO_COORDINATES", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      places,
      trip_commitments: [
        commitment({ id: "c1", starts_at: "2026-10-01T09:00:00.000Z", place_id: PLACE_A }),
        commitment({ id: "c2", starts_at: "2026-10-01T09:30:00.000Z", place_id: null }),
      ],
    });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "UNKNOWN");
    assert.equal(r.body.hops[0].unknownReason, "NO_COORDINATES");
    assert.deepEqual(r.body.unresolvedPlaceIds, []);
  });

  it("a DANGLING place id is UNKNOWN too — but it is named, not silently the same", async () => {
    // place_id has no foreign key by design, so an id with no row behind it is
    // possible and is a data defect. Its verdict is the same as "no place",
    // and it must not be indistinguishable from it to a reader.
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      places,
      trip_commitments: [
        commitment({ id: "c1", starts_at: "2026-10-01T09:00:00.000Z", place_id: PLACE_A }),
        commitment({ id: "c2", starts_at: "2026-10-01T09:30:00.000Z", place_id: GHOST }),
      ],
    });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "UNKNOWN");
    assert.equal(r.body.hops[0].unknownReason, "NO_COORDINATES");
    assert.deepEqual(r.body.unresolvedPlaceIds, [GHOST]);
  });

  it("a place that EXISTS but is not located is UNKNOWN, and is NOT called dangling", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew,
      places: [...places, { id: GHOST, latitude: null, longitude: null }],
      trip_commitments: [
        commitment({ id: "c1", starts_at: "2026-10-01T09:00:00.000Z", place_id: PLACE_A }),
        commitment({ id: "c2", starts_at: "2026-10-01T09:30:00.000Z", place_id: GHOST }),
      ],
    });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.body.verdict, "UNKNOWN");
    assert.deepEqual(r.body.unresolvedPlaceIds, [],
      "an unlocated place exists; reporting it as unresolved would be a different defect");
  });
});

describe("§7 — fail-closed", () => {
  it("an unreadable PLACES table is 503 — never a verdict", async () => {
    // The forbidden shape: places unreadable -> every point null ->
    // NO_COORDINATES -> UNKNOWN, which a client renders as "nothing to worry
    // about here". UNKNOWN is honest only when it is the answer, not when it
    // is the residue of a failure.
    install(twoHops(TRAVEL_MIN - 30), { errorOn: ["places"] });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.verdict, undefined);
  });

  it("an unreadable COMMITMENTS table is 503 — never an empty, workable day", async () => {
    install(twoHops(10), { errorOn: ["trip_commitments"] });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a non-member is refused, not answered", async () => {
    install(twoHops(TRAVEL_MIN - 1));
    const r = await get(`/trips/${TRIP_ID}/feasibility`, "other-token");
    assert.equal(r.status, 403);
    assert.equal(r.body.verdict, undefined);
  });

  it("a trip with no commitments is UNKNOWN, not feasible", async () => {
    install({
      trips: [{ id: TRIP_ID, owner_id: OWNER_ID }],
      trip_members: crew, places, trip_commitments: [],
    });
    const r = await get(`/trips/${TRIP_ID}/feasibility`);
    assert.equal(r.status, 200);
    assert.equal(r.body.evaluatedHops, 0);
    assert.notEqual(r.body.verdict, "FEASIBLE");
    assert.notEqual(r.body.verdict, "FEASIBLE_UNVERIFIED");
  });
});
