/**
 * census-compass CT-02 — the Trips-owned projections that replaced Compass's last
 * raw reads of `trips`, `trip_members`, `trip_plan_items` and `trip_commitments`,
 * and the Compass-side acceptors that apply §19.1's consumer rule to them.
 *
 *   TripCompassTripSummaryProjection   owned / by-id / one trip
 *   TripCompassMembershipProjection    memberships by role; membership rows joined to trips
 *   TripCompassPlanProjection          whole live plan; one day's live plan
 *   TripCompassCommitmentsProjection   §5.1 commitments, ordered
 *   TripGraphSourceProjection          the graph's typed trip facts
 *   readTripPlanItemPrivacy            the privacy columns by id (server/trips)
 *   acceptedTripRows / acceptedMemberTrips  (compass/CompassCurrentTrip.ts)
 *
 * The directory-wide "zero raw reads" guard is compassTripProjectionReads.test.ts
 * case D; each consumer's behaviour is pinned by its own existing suite. This file
 * pins what the projections THEMSELVES promise: the query each issues, typed rows,
 * the envelope, and that a failed or malformed read is unavailable — never empty.
 *
 * Run: TZ=UTC SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripCompassConsumerProjections.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildTripCompassOwnedTripsProjection, buildTripCompassTripsByIdProjection, buildTripCompassTripSummaryProjection,
  toTripCompassTripSummary,
} from "../domain/trips/projections/TripCompassTripSummaryProjection.js";
import {
  buildTripCompassMembershipProjection, buildTripCompassMemberTripsProjection, isAcceptedMembershipStatus,
} from "../domain/trips/projections/TripCompassMembershipProjection.js";
import { buildTripCompassPlanProjection, buildTripCompassDayPlanProjection } from "../domain/trips/projections/TripCompassPlanProjection.js";
import { buildTripCompassCommitmentsProjection } from "../domain/trips/projections/TripCompassCommitmentsProjection.js";
import { tripGraphSourceRows, toTripGraphSourceFact } from "../domain/trips/projections/TripGraphSourceProjection.js";
import { readTripPlanItemPrivacy } from "../server/trips/privateAnchorShares.js";
import { acceptedTripRows, acceptedMemberTrips } from "../compass/CompassCurrentTrip.js";
import { TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { WITHHELD_PLAN_TITLE } from "../domain/trips/policies/privateAnchorAccess.js";

const VIEWER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const TRIP = "20000000-0000-4000-8000-000000000001";
const TRIP2 = "20000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-17T12:00:00.000Z");

type Row = Record<string, unknown>;
interface Call { table: string; select?: string; ops: string[] }

/**
 * A chainable fake: filters eq / neq / in / is, honours order + limit, records
 * every call. `errors` makes a table answer `{ data: null, error }`; `bodies`
 * makes it answer a raw (non-row) body with no error — the §59 transport shape.
 */
function fake(tables: Record<string, Row[]>, opts: { errors?: string[]; bodies?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [] };
    calls.push(call);
    let rows = [...(tables[table] ?? [])];
    let limit: number | null = null;
    const result = () => {
      if (opts.errors?.includes(table)) return { data: null, error: { message: `${table} unavailable`, code: "57014" } };
      if (opts.bodies && table in opts.bodies) return { data: opts.bodies[table], error: null };
      return { data: limit === null ? rows : rows.slice(0, limit), error: null };
    };
    const b: any = {
      select: (cols: string) => { call.select = cols; return b; },
      eq: (c: string, v: unknown) => { call.ops.push(`eq:${c}`); rows = rows.filter((r) => r[c] === v); return b; },
      neq: (c: string, v: unknown) => { call.ops.push(`neq:${c}`); rows = rows.filter((r) => r[c] !== v); return b; },
      in: (c: string, vs: unknown[]) => { call.ops.push(`in:${c}`); rows = rows.filter((r) => vs.includes(r[c])); return b; },
      gte: (c: string, v: unknown) => { call.ops.push(`gte:${c}`); rows = rows.filter((r) => r[c] != null && String(r[c]) >= String(v)); return b; },
      is: (c: string, v: unknown) => { call.ops.push(`is:${c}`); rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order: (c: string, o?: { ascending?: boolean }) => {
        call.ops.push(`order:${c}:${o?.ascending === false ? "desc" : "asc"}`);
        rows = [...rows].sort((x, y) => String(x[c]).localeCompare(String(y[c])) * (o?.ascending === false ? -1 : 1));
        return b;
      },
      limit: (n: number) => { call.ops.push(`limit:${n}`); limit = n; return b; },
      maybeSingle: () => {
        const r = result();
        return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null });
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return b;
  };
  return { client: { from } as any, calls };
}

const trip = (o: Row = {}): Row => ({
  id: TRIP, owner_id: VIEWER, title: "Cebu", destination_city: "Cebu", destination_country: "PH",
  start_date: "2026-10-16", end_date: "2026-10-20", status: "active", timezone: "Asia/Manila",
  visibility: "private", created_at: "2026-09-01T00:00:00Z", version: 7, ...o,
});

// ── Trip rows ────────────────────────────────────────────────────────────────

describe("TripCompassTripSummaryProjection — typed trip rows, one envelope per row", () => {
  it("owned: reads trips by owner in the named statuses, types every row, and attributes each to its own version", async () => {
    const { client, calls } = fake({ trips: [trip(), trip({ id: TRIP2, status: "draft", version: undefined }), trip({ id: "x", owner_id: OTHER })] });
    const built = await buildTripCompassOwnedTripsProjection(client, VIEWER, { statuses: ["active", "draft"], now: NOW });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.projection.trips.map((t) => t.id), [TRIP, TRIP2]);
    assert.deepEqual(built.projection.trips[0], {
      id: TRIP, ownerId: VIEWER, title: "Cebu", destinationCity: "Cebu", destinationCountry: "PH", startDate: "2026-10-16",
      endDate: "2026-10-20", status: "active", timezone: "Asia/Manila", visibility: "private", createdAt: "2026-09-01T00:00:00Z",
    });
    assert.deepEqual(built.projection.sources.map((s) => [s.tripId, s.sourceTripVersion, s.freshness]), [[TRIP, 7, "live"], [TRIP2, null, "unattributable"]]);
    assert.equal(built.projection.sources[0]!.projectionSchemaVersion, TRIP_PROJECTION_SCHEMA_VERSION);
    assert.equal(built.projection.sources[0]!.generatedAt, NOW.toISOString());
    assert.deepEqual(calls.map((c) => [c.table, c.ops]), [["trips", ["eq:owner_id", "in:status"]]]);
    assert.match(calls[0]!.select!, /\bversion\b/, "attribution must come from the SAME row read, not a second read");
  });

  it("owned: no statuses = every status; order and limit are the caller's (the Passport list's cap)", async () => {
    const { client, calls } = fake({ trips: [trip({ id: "a" }), trip({ id: "c", status: "cancelled" }), trip({ id: "b" })] });
    const built = await buildTripCompassOwnedTripsProjection(client, VIEWER, { order: "id_desc", limit: 2 });
    assert.equal(built.ok, true);
    if (built.ok) assert.deepEqual(built.projection.trips.map((t) => t.id), ["c", "b"]);
    assert.deepEqual(calls[0]!.ops, ["eq:owner_id", "order:id:desc", "limit:2"]);
  });

  it("by id: an empty id list is an empty answer that reads nothing", async () => {
    const { client, calls } = fake({ trips: [trip()] });
    const built = await buildTripCompassTripsByIdProjection(client, VIEWER, []);
    assert.deepEqual(built, { ok: true, projection: { userId: VIEWER, trips: [], sources: [] } });
    assert.equal(calls.length, 0);
  });

  it("by id: reads only the named trips, in the named statuses", async () => {
    const { client, calls } = fake({ trips: [trip(), trip({ id: TRIP2, status: "completed" })] });
    const built = await buildTripCompassTripsByIdProjection(client, VIEWER, [TRIP, TRIP2], { statuses: ["active", "upcoming"] });
    assert.equal(built.ok, true);
    if (built.ok) assert.deepEqual(built.projection.trips.map((t) => t.id), [TRIP]);
    assert.deepEqual(calls[0]!.ops, ["in:id", "in:status"]);
  });

  for (const [label, opts] of [
    ["a returned error", { errors: ["trips"] }],
    ["a null body with no error (§59)", { bodies: { trips: null } }],
    ["an object body", { bodies: { trips: {} } }],
    ["a string body", { bodies: { trips: "rows" } }],
    ["a row with a numeric id", { bodies: { trips: [trip({ id: 7 })] } }],
    ["a row with a numeric title", { bodies: { trips: [trip({ title: 3 })] } }],
    ["a null row", { bodies: { trips: [trip(), null] } }],
  ] as const) {
    it(`owned and by-id: ${label} is UNAVAILABLE, never an empty list`, async () => {
      const owned = await buildTripCompassOwnedTripsProjection(fake({ trips: [trip()] }, opts as any).client, VIEWER);
      const byId = await buildTripCompassTripsByIdProjection(fake({ trips: [trip()] }, opts as any).client, VIEWER, [TRIP]);
      assert.deepEqual(owned, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.deepEqual(byId, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    });
  }

  it("one trip: found, not found (unattributable, not a failure), owner-scoped, and unreadable", async () => {
    const found = await buildTripCompassTripSummaryProjection(fake({ trips: [trip()] }).client, TRIP, { now: NOW });
    assert.equal(found.ok && found.projection.trip?.title, "Cebu");
    assert.equal(found.ok && found.projection.sourceTripVersion, 7);
    const missing = await buildTripCompassTripSummaryProjection(fake({ trips: [] }).client, TRIP);
    assert.equal(missing.ok, true);
    if (missing.ok) { assert.equal(missing.projection.trip, null); assert.equal(missing.projection.freshness, "unattributable"); }
    const borrowed = await buildTripCompassTripSummaryProjection(fake({ trips: [trip({ owner_id: OTHER })] }).client, TRIP, { ownerId: VIEWER });
    assert.equal(borrowed.ok && borrowed.projection.trip, null, "a borrowed trip id resolves to nothing for a non-owner");
    const failed = await buildTripCompassTripSummaryProjection(fake({ trips: [trip()] }, { errors: ["trips"] }).client, TRIP);
    assert.deepEqual(failed, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("the row typer refuses what is not a trip row", () => {
    assert.equal(toTripCompassTripSummary(null), null);
    assert.equal(toTripCompassTripSummary([trip()]), null);
    assert.equal(toTripCompassTripSummary(trip({ id: "" })), null);
    assert.equal(toTripCompassTripSummary(trip({ start_date: 20261016 })), null);
    assert.equal(toTripCompassTripSummary({ id: TRIP })?.title, null, "absent columns are null, not invented");
  });
});

// ── Memberships ──────────────────────────────────────────────────────────────

describe("TripCompassMembershipProjection — memberships by role, and Trips' one 'accepted' rule", () => {
  const members = [
    { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
    { trip_id: TRIP2, user_id: VIEWER, role: "owner", status: null },
    { trip_id: "t-invited", user_id: VIEWER, role: "member", status: "invited" },
    { trip_id: "t-viewer", user_id: VIEWER, role: "viewer", status: "accepted" },
    { trip_id: "t-other", user_id: OTHER, role: "member", status: "accepted" },
  ];

  it("reads the user's rows in the named roles; tripIds is every status, acceptedTripIds is accepted-or-unserved", async () => {
    const { client, calls } = fake({ trip_members: members });
    const built = await buildTripCompassMembershipProjection(client, VIEWER, { roles: ["owner", "member"], now: NOW });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.projection.tripIds, [TRIP, TRIP2, "t-invited"]);
    assert.deepEqual(built.projection.acceptedTripIds, [TRIP, TRIP2]);
    assert.deepEqual(calls.map((c) => [c.table, c.select, c.ops]), [["trip_members", "trip_id, role, status", ["eq:user_id", "in:role"]]]);
    assert.equal(built.projection.freshness, "unattributable", "a membership set spans trips: it is not one aggregate's version");
    assert.equal(built.projection.sourceTripVersion, null);
  });

  it("'accepted' is status accepted or not served — nothing else", () => {
    assert.equal(isAcceptedMembershipStatus(null), true);
    assert.equal(isAcceptedMembershipStatus("accepted"), true);
    for (const s of ["invited", "declined", "removed", "left", ""]) assert.equal(isAcceptedMembershipStatus(s), false, s);
  });

  for (const [label, opts] of [
    ["a returned error", { errors: ["trip_members"] }],
    ["a null body with no error", { bodies: { trip_members: null } }],
    ["a row with no trip id", { bodies: { trip_members: [{ role: "member", status: "accepted" }] } }],
    ["a row with a numeric status", { bodies: { trip_members: [{ trip_id: TRIP, role: "member", status: 1 }] } }],
  ] as const) {
    it(`${label} is UNAVAILABLE, never "on no trips"`, async () => {
      const built = await buildTripCompassMembershipProjection(fake({ trip_members: members }, opts as any).client, VIEWER, { roles: ["member"] });
      assert.deepEqual(built, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    });
  }

  it("member trips: the fallback feed's unfiltered, capped join — typed embeds, a null embed is no trip, a malformed one is unavailable", async () => {
    const rows = [
      { trip_id: TRIP, role: "member", status: "invited", trips: trip() },
      { trip_id: TRIP2, role: "member", status: "accepted", trips: null },
    ];
    const { client, calls } = fake({}, { bodies: { trip_members: rows } });
    const built = await buildTripCompassMemberTripsProjection(client, VIEWER, { limit: 5, now: NOW });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.projection.memberTrips.map((m) => [m.tripId, m.status, m.trip?.destinationCity ?? null]), [[TRIP, "invited", "Cebu"], [TRIP2, "accepted", null]]);
    assert.deepEqual(built.projection.sources.map((s) => [s.tripId, s.sourceTripVersion]), [[TRIP, 7]]);
    assert.deepEqual(calls[0]!.ops, ["eq:user_id", "limit:5"], "no role or status filter: the feed's own question");
    assert.match(calls[0]!.select!, /trips\(/);
    const malformed = await buildTripCompassMemberTripsProjection(fake({}, { bodies: { trip_members: [{ trip_id: TRIP, role: "member", status: null, trips: trip({ title: 9 }) }] } }).client, VIEWER, { limit: 5 });
    assert.deepEqual(malformed, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    const failed = await buildTripCompassMemberTripsProjection(fake({}, { errors: ["trip_members"] }).client, VIEWER, { limit: 5 });
    assert.deepEqual(failed, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });
});

// ── The Compass acceptors ────────────────────────────────────────────────────

describe("acceptedTripRows / acceptedMemberTrips — §19.1's consumer rule over every source", () => {
  it("accepts live and unattributable sources, and refuses the WHOLE list if any one source is stale or from another schema", async () => {
    const built = await buildTripCompassOwnedTripsProjection(fake({ trips: [trip(), trip({ id: TRIP2, version: null })] }).client, VIEWER);
    assert.equal(acceptedTripRows(built)?.length, 2);
    assert.equal(acceptedTripRows({ ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" }), null);
    if (!built.ok) return;
    const stale = { ok: true as const, projection: { ...built.projection, sources: [built.projection.sources[0]!, { ...built.projection.sources[1]!, freshness: "stale" as const }] } };
    assert.equal(acceptedTripRows(stale), null, "one stale trip refuses the list: a partial union is unread");
    const otherSchema = { ok: true as const, projection: { ...built.projection, sources: [{ ...built.projection.sources[0]!, projectionSchemaVersion: 99 }, built.projection.sources[1]!] } };
    assert.equal(acceptedTripRows(otherSchema), null);
  });

  it("member trips: the projection's own envelope and every embedded trip's are checked", async () => {
    const built = await buildTripCompassMemberTripsProjection(fake({}, { bodies: { trip_members: [{ trip_id: TRIP, role: "member", status: "accepted", trips: trip() }] } }).client, VIEWER, { limit: 5 });
    assert.equal(acceptedMemberTrips(built)?.length, 1);
    if (!built.ok) return;
    assert.equal(acceptedMemberTrips({ ok: true, projection: { ...built.projection, generatedAt: "not-an-instant" } }), null);
    assert.equal(acceptedMemberTrips({ ok: true, projection: { ...built.projection, sources: [{ ...built.projection.sources[0]!, freshness: "stale" }] } }), null);
  });
});

// ── Plans ────────────────────────────────────────────────────────────────────

describe("TripCompassPlanProjection — uncapped plans, privacy applied in Trips", () => {
  const item = (o: Row = {}): Row => ({
    id: "p-own", trip_id: TRIP, title: "Lunch", category: "food", status: "confirmed", lock_type: "fixed", day_date: "2026-10-17",
    starts_at: "2026-10-17T12:00:00Z", ends_at: "2026-10-17T13:00:00Z", location_name: "Larsian", lat: 10.3, lng: 123.9,
    source_type: "place", source_id: "place-1", sort_order: 0, creator_id: VIEWER, location_is_private: false, privacy_scope: "crew", removed_at: null, ...o,
  });
  const plan = [
    item(),
    item({ id: "p-private", creator_id: OTHER, location_is_private: true, title: "Clinic", location_name: "Secret clinic" }),
    item({ id: "p-hidden", creator_id: OTHER, privacy_scope: "private", title: "Hidden" }),
    item({ id: "p-cancelled", status: "cancelled" }),
    item({ id: "p-removed", removed_at: "2026-10-16T00:00:00Z" }),
    item({ id: "p-tomorrow", day_date: "2026-10-18" }),
  ];

  it("whole plan: version read first, live rows only, another member's private item keeps its slot and loses its name and place, a hidden plan is dropped", async () => {
    const { client, calls } = fake({ trips: [trip()], trip_plan_items: plan });
    const built = await buildTripCompassPlanProjection(client, TRIP, VIEWER, { now: NOW });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(calls[0]!.table, "trips", "the version is read BEFORE the rows");
    assert.equal(built.projection.sourceTripVersion, 7);
    assert.deepEqual(built.projection.rows.map((r) => r.id), ["p-own", "p-private", "p-tomorrow"]);
    const priv = built.projection.rows.find((r) => r.id === "p-private")!;
    assert.equal(priv.title, WITHHELD_PLAN_TITLE);
    assert.equal(priv.location_name, null);
    assert.equal(priv.lat, null);
    assert.equal(priv.starts_at, "2026-10-17T12:00:00Z", "the slot (time) stays");
    const planRead = calls.find((c) => c.table === "trip_plan_items")!;
    assert.deepEqual(planRead.ops, ["eq:trip_id", "is:removed_at", "neq:status"]);
  });

  it("day plan: one day, cancelled and removed dropped, privacy applied, no cap", async () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `p-${i}`, starts_at: `2026-10-17T${String(8 + i).padStart(2, "0")}:00:00Z` }));
    const { client } = fake({ trips: [trip()], trip_plan_items: [...plan, ...many] });
    const built = await buildTripCompassDayPlanProjection(client, TRIP, VIEWER, "2026-10-17");
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const ids = built.projection.items.map((i) => i.id);
    assert.ok(ids.includes("p-own") && ids.includes("p-private") && !ids.includes("p-hidden"));
    assert.ok(!ids.includes("p-cancelled") && !ids.includes("p-removed") && !ids.includes("p-tomorrow"));
    assert.equal(ids.length, 2 + 12, "uncapped: the Today projection's five-row cap is not this projection's");
    assert.equal(built.projection.items.find((i) => i.id === "p-private")!.title, WITHHELD_PLAN_TITLE);
  });

  it("an empty day reads no access tables; an unreadable access read is disclosed, not refused", async () => {
    const empty = fake({ trips: [trip()], trip_plan_items: [] });
    const none = await buildTripCompassDayPlanProjection(empty.client, TRIP, VIEWER, "2026-10-17");
    assert.equal(none.ok && none.projection.items.length, 0);
    assert.deepEqual(empty.calls.map((c) => c.table), ["trips", "trip_plan_items"]);
    const unreadAccess = fake({ trips: [trip()], trip_plan_items: plan }, { errors: ["feature_flags"] });
    const built = await buildTripCompassDayPlanProjection(unreadAccess.client, TRIP, VIEWER, "2026-10-17");
    assert.equal(built.ok, true);
    if (built.ok) {
      assert.equal(built.projection.accessStatus, "unread");
      assert.equal(built.projection.items.find((i) => i.id === "p-private")!.title, WITHHELD_PLAN_TITLE, "unread access withholds, as before");
    }
  });

  for (const [label, opts] of [
    ["a returned error", { errors: ["trip_plan_items"] }],
    ["a null body with no error", { bodies: { trip_plan_items: null } }],
    ["a row with a string latitude", { bodies: { trip_plan_items: [item({ lat: "10.3" })] } }],
  ] as const) {
    it(`whole and day plan: ${label} is UNAVAILABLE, never an empty plan`, async () => {
      const whole = await buildTripCompassPlanProjection(fake({ trips: [trip()], trip_plan_items: plan }, opts as any).client, TRIP, VIEWER);
      const day = await buildTripCompassDayPlanProjection(fake({ trips: [trip()], trip_plan_items: plan }, opts as any).client, TRIP, VIEWER, "2026-10-17");
      assert.deepEqual(whole, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.deepEqual(day, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    });
  }

  it("an unreadable version is unattributable, not a failure", async () => {
    const built = await buildTripCompassPlanProjection(fake({ trips: [trip()], trip_plan_items: plan }, { errors: ["trips"] }).client, TRIP, VIEWER);
    assert.equal(built.ok && built.projection.freshness, "unattributable");
  });
});

// ── Commitments, privacy columns, graph facts ────────────────────────────────

describe("TripCompassCommitmentsProjection, readTripPlanItemPrivacy, TripGraphSourceProjection", () => {
  const commitment = (o: Row = {}): Row => ({
    id: "c-1", trip_id: TRIP, stage_id: null, type: "flight", starts_at: "2026-10-18T09:00:00Z", required_arrival_at: "2026-10-18T07:00:00Z",
    place_id: null, lateness_tolerance: "00:15:00", prep_duration: null, flexibility: "fixed", confidence: 0.9, ...o,
  });

  it("commitments: typed, ordered by required arrival else start, envelope from the trip version", async () => {
    const rows = [commitment(), commitment({ id: "c-0", required_arrival_at: null, starts_at: "2026-10-17T20:00:00Z" })];
    const built = await buildTripCompassCommitmentsProjection(fake({ trips: [trip()], trip_commitments: rows }).client, TRIP, VIEWER);
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.projection.commitments.map((c) => c.id), ["c-0", "c-1"]);
    assert.deepEqual(built.projection.commitments[1], {
      id: "c-1", stageId: null, type: "flight", startsAt: "2026-10-18T09:00:00Z", requiredArrivalAt: "2026-10-18T07:00:00Z", placeId: null,
      latenessTolerance: "00:15:00", prepDuration: null, flexibility: "fixed", confidence: 0.9,
    });
    assert.equal(built.projection.sourceTripVersion, 7);
    for (const opts of [{ errors: ["trip_commitments"] }, { bodies: { trip_commitments: null } }, { bodies: { trip_commitments: [commitment({ type: 4 })] } }]) {
      const failed = await buildTripCompassCommitmentsProjection(fake({ trips: [trip()], trip_commitments: rows }, opts as any).client, TRIP, VIEWER);
      assert.deepEqual(failed, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" }, JSON.stringify(opts));
    }
  });

  it("privacy columns: a map by id; an error or a non-array body is null (withhold everything), never an empty map", async () => {
    const rows = [{ id: "p-1", trip_id: TRIP, creator_id: OTHER, location_is_private: true, privacy_scope: "crew" }];
    const ok = await readTripPlanItemPrivacy(fake({ trip_plan_items: rows }).client, TRIP);
    assert.deepEqual(ok?.get("p-1"), { creator_id: OTHER, location_is_private: true, privacy_scope: "crew" });
    assert.equal(await readTripPlanItemPrivacy(fake({ trip_plan_items: rows }, { errors: ["trip_plan_items"] }).client, TRIP), null);
    assert.equal(await readTripPlanItemPrivacy(fake({ trip_plan_items: rows }, { bodies: { trip_plan_items: null } }).client, TRIP), null);
  });

  it("graph facts: the one literal read, and a typer that refuses what is not a trip fact", () => {
    const { client, calls } = fake({ trips: [] });
    tripGraphSourceRows(client);
    assert.deepEqual(calls.map((c) => [c.table, c.select, c.ops]), [["trips", "id, owner_id, destination_city, start_date, end_date, destination_lat, destination_lng", []]]);
    assert.deepEqual(toTripGraphSourceFact({ id: "t-1", owner_id: VIEWER, destination_city: "Bohol", start_date: "2026-05-01", end_date: null, destination_lat: 9.8, destination_lng: null }), {
      tripId: "t-1", ownerId: VIEWER, destinationCity: "Bohol", startDate: "2026-05-01", endDate: null, destinationLat: 9.8, destinationLng: null,
    });
    assert.equal(toTripGraphSourceFact({ owner_id: VIEWER }), null);
    assert.equal(toTripGraphSourceFact({ id: "t-1", destination_lat: "9.8" }), null);
    assert.equal(toTripGraphSourceFact({ id: "t-1", destination_lat: Number.NaN }), null);
  });
});

// ── The vocabularies a filter may name (the static enum check, now a contract) ─

describe("status and role filters name only enum labels — refused BEFORE any read", () => {
  it("an unknown trip_status label (the old `in_progress` 22P02) is unavailable and issues no read", async () => {
    for (const build of [
      (c: any) => buildTripCompassOwnedTripsProjection(c, VIEWER, { statuses: ["active", "in_progress"] }),
      (c: any) => buildTripCompassTripsByIdProjection(c, VIEWER, [TRIP], { statuses: ["in_progress"] }),
      (c: any) => buildTripCompassTripsByIdProjection(c, VIEWER, [], { statuses: ["in_progress"] }),
    ]) {
      const { client, calls } = fake({ trips: [trip()] });
      assert.deepEqual(await build(client), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.equal(calls.length, 0);
    }
  });

  it("every status list and role list Compass passes is inside the enums", async () => {
    const { TOOL_TRIP_STATUSES, CONTEXT_TRIP_STATUSES, SELECTION_TRIP_ROLES, SOCIAL_CONTEXT_TRIP_ROLES } = await import("../compass/CompassCurrentTrip.js");
    const { TRIP_STATUS_LABELS } = await import("../domain/trips/projections/TripCompassTripSummaryProjection.js");
    const { TRIP_MEMBER_ROLE_LABELS } = await import("../domain/trips/projections/TripCompassMembershipProjection.js");
    for (const s of [...TOOL_TRIP_STATUSES, ...CONTEXT_TRIP_STATUSES, "active", "upcoming"]) assert.ok((TRIP_STATUS_LABELS as readonly string[]).includes(s), s);
    for (const r of [...SELECTION_TRIP_ROLES, ...SOCIAL_CONTEXT_TRIP_ROLES]) assert.ok((TRIP_MEMBER_ROLE_LABELS as readonly string[]).includes(r), r);
  });

  it("an unknown member_role label is unavailable and issues no read", async () => {
    const { client, calls } = fake({ trip_members: [] });
    assert.deepEqual(await buildTripCompassMembershipProjection(client, VIEWER, { roles: ["member", "guest"] }), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    assert.equal(calls.length, 0);
  });
});

// ── The route-layer projections (census-compass CT-02 D2) ────────────────────

describe("trips by owner, ending on or after a day, and a trip's member ids", () => {
  it("owned: endingOnOrAfter is a gte on end_date; a malformed day is refused unread", async () => {
    const { client, calls } = fake({ trips: [trip({ end_date: "2026-10-20" })] });
    const built = await buildTripCompassOwnedTripsProjection(client, VIEWER, { statuses: ["active"], endingOnOrAfter: "2026-10-17" });
    assert.equal(built.ok, true);
    assert.deepEqual(calls[0]!.ops, ["eq:owner_id", "in:status", "gte:end_date"]);
    const ended = await buildTripCompassOwnedTripsProjection(fake({ trips: [trip({ end_date: "2026-10-01" })] }).client, VIEWER, { endingOnOrAfter: "2026-10-17" });
    assert.equal(ended.ok && ended.projection.trips.length, 0, "a trip that ended before the day is not returned");
    const bad = await buildTripCompassOwnedTripsProjection(fake({ trips: [] }).client, VIEWER, { endingOnOrAfter: "17/10/2026" });
    assert.deepEqual(bad, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("by owners: only the named owners, statuses and visibilities; `friends` (not a trip_visibility label) is refused before any read", async () => {
    const { buildTripCompassTripsByOwnersProjection } = await import("../domain/trips/projections/TripCompassTripSummaryProjection.js");
    const rows = [trip({ id: "t-pub", owner_id: OTHER, visibility: "public" }), trip({ id: "t-priv", owner_id: OTHER, visibility: "private" }), trip({ id: "t-mine", owner_id: VIEWER, visibility: "public" })];
    const { client, calls } = fake({ trips: rows });
    const built = await buildTripCompassTripsByOwnersProjection(client, VIEWER, [OTHER], { statuses: ["active", "upcoming"], visibilities: ["public", "buddies"] });
    assert.equal(built.ok && built.projection.trips.map((t) => t.id).join(), "t-pub");
    assert.deepEqual(calls[0]!.ops, ["in:owner_id", "in:status", "in:visibility"]);
    const friends = fake({ trips: rows });
    assert.deepEqual(await buildTripCompassTripsByOwnersProjection(friends.client, VIEWER, [OTHER], { statuses: ["active"], visibilities: ["friends"] }), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    assert.equal(friends.calls.length, 0);
    const none = fake({ trips: rows });
    assert.deepEqual(await buildTripCompassTripsByOwnersProjection(none.client, VIEWER, [], { statuses: ["active"], visibilities: ["public"] }), { ok: true, projection: { userId: VIEWER, trips: [], sources: [] } });
    assert.equal(none.calls.length, 0);
    const leaked = await buildTripCompassTripsByOwnersProjection(fake({}, { bodies: { trips: [trip({ owner_id: OTHER, visibility: "private" })] } }).client, VIEWER, [OTHER], { statuses: ["active"], visibilities: ["public"] });
    assert.deepEqual(leaked, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" }, "a private trip served to a public-only question is refused, not passed on");
  });

  it("member ids: every membership row (the feed's question), the accepted ones named apart, version-attributed; unreadable is unavailable", async () => {
    const { buildTripCompassTripMemberIdsProjection } = await import("../domain/trips/projections/TripCompassMembershipProjection.js");
    const members = [
      { trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: OTHER, role: "member", status: "declined" },
      { trip_id: TRIP2, user_id: "u-elsewhere", role: "member", status: "accepted" },
    ];
    const built = await buildTripCompassTripMemberIdsProjection(fake({ trips: [trip()], trip_members: members }).client, TRIP);
    assert.equal(built.ok, true);
    if (built.ok) {
      assert.deepEqual(built.projection.memberIds, [VIEWER, OTHER]);
      assert.deepEqual(built.projection.acceptedMemberIds, [VIEWER]);
      assert.equal(built.projection.sourceTripVersion, 7);
    }
    assert.deepEqual(await buildTripCompassTripMemberIdsProjection(fake({ trips: [trip()], trip_members: members }, { errors: ["trip_members"] }).client, TRIP), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    assert.deepEqual(await buildTripCompassTripMemberIdsProjection(fake({ trips: [trip()] }, { bodies: { trip_members: null } }).client, TRIP), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });
});
