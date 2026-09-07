/**
 * TripDiscoveryProjection — lib/tripDiscoveryProjection.ts, the Trip-owned
 * contract Discovery consumes (Trips spec §1, §6.3, §19.1, §25;
 * census-discovery A10 / D3).
 *
 * What is pinned here:
 *   * the §19.1 envelope on every projection (generatedAt, sourceTripVersion,
 *     projectionSchemaVersion, freshness) and the schema version number;
 *   * the discoverability rule, in the pure function AND in the SQL the
 *     search reader issues — the two must say the same thing;
 *   * the non-member privacy toggles reach a Discovery searcher (show_exact_dates,
 *     show_destination_city, show_header_publicly) exactly as
 *     toPrivateTripPreview applies them;
 *   * the shape is a narrow COPY: a column not in the contract never appears;
 *   * both readers fail CLOSED on a database error (supabase-js resolves on
 *     error) and on a thrown client — never an empty result read as success;
 *   * tripDiscoveryAdmits encodes Discovery's searchPlans rule without Discovery
 *     re-deriving it.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/tripDiscoveryProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION,
  TRIP_DISCOVERY_EXCLUDED_STATUSES,
  TRIP_DISCOVERY_SOURCE_COLUMNS,
  isTripDiscoverable,
  projectTripForDiscovery,
  tripDiscoveryAdmits,
  tripDiscoveryIlikePattern,
  searchTripDiscoveryProjections,
  readTripDiscoveryProjections,
  type TripDiscoveryProjection,
} from "../lib/tripDiscoveryProjection.js";
import { PRIVATE_TRIP_COVER_PLACEHOLDER } from "../lib/privacy/coverPlaceholders.js";

const OWNER = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";
const T1 = "33333333-0000-0000-0000-000000000001";
const T2 = "33333333-0000-0000-0000-000000000002";
const T3 = "33333333-0000-0000-0000-000000000003";
const AT = "2026-09-07T12:00:00.000Z";

function row(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: T1, owner_id: OWNER, title: "Lisbon in October", destination_city: "Lisbon", destination_country: "PT",
    cover_url: "https://img/cover.jpg", start_date: "2026-10-01", end_date: "2026-10-05", status: "upcoming",
    visibility: "public", show_in_discovery: true, show_exact_dates: true, show_destination_city: true,
    show_header_publicly: true, precise_location_visible: false, trip_type: "leisure", open_to_meet: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z", version: 3,
    // columns the contract must never copy across
    internal_notes: "NEVER-TO-CLIENT", trip_notes: "hotel: Rua X 12, room 4", destination_lat: 38.7, destination_lng: -9.1,
    reminder_sent_at: null, max_members: 6, neighborhoods: ["Alfama"],
    ...over,
  };
}

// ── Fake client: records the query it was handed, answers what it is told ────
interface Recorded { table: string; select?: string; calls: Array<[string, any[]]> }
function fakeClient(answer: { data: any; error: any } | "throw", recorded: Recorded[] = []) {
  return {
    recorded,
    from(table: string) {
      const rec: Recorded = { table, calls: [] };
      recorded.push(rec);
      const b: any = {};
      for (const m of ["select", "or", "eq", "not", "order", "gte", "lt", "in"]) {
        b[m] = (...args: any[]) => { rec.calls.push([m, args]); if (m === "select") rec.select = args[0]; return b; };
      }
      b.range = async (...args: any[]) => { rec.calls.push(["range", args]); if (answer === "throw") throw new Error("boom"); return answer; };
      // .in(...) is awaited directly by readTripDiscoveryProjections
      b.then = (onF: any, onR: any) => {
        if (answer === "throw") return Promise.reject(new Error("boom")).then(onF, onR);
        return Promise.resolve(answer).then(onF, onR);
      };
      return b;
    },
  };
}

describe("TripDiscoveryProjection — the §19.1 envelope and the narrow copy", () => {
  it("carries generatedAt, sourceTripVersion, projectionSchemaVersion, freshness and nothing the contract does not list", () => {
    const p = projectTripForDiscovery(row(), AT);
    assert.equal(p.projectionSchemaVersion, TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION);
    assert.equal(TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION, 1);
    assert.equal(p.generatedAt, AT);
    assert.equal(p.sourceTripVersion, 3);
    assert.equal(p.freshness, "live");
    assert.deepEqual(Object.keys(p).sort(), [
      "coverUrl", "createdAt", "destinationCity", "destinationCountry", "discoverable", "endDate", "freshness",
      "generatedAt", "ownerId", "projectionSchemaVersion", "sourceTripVersion", "startDate", "status", "title",
      "tripId", "updatedAt",
    ]);
    const json = JSON.stringify(p);
    for (const leak of ["NEVER-TO-CLIENT", "Rua X", "38.7", "-9.1", "reminder", "max_members", "Alfama", "neighborhoods"]) {
      assert.equal(json.includes(leak), false, `${leak} must not reach a consumer`);
    }
    assert.equal(p.tripId, T1);
    assert.equal(p.ownerId, OWNER);
    assert.equal(p.title, "Lisbon in October");
    assert.equal(p.destinationCity, "Lisbon");
    assert.equal(p.coverUrl, "https://img/cover.jpg");
    assert.equal(p.startDate, "2026-10-01");
    assert.equal(p.endDate, "2026-10-05");
  });

  it("sourceTripVersion 0 for a row with no kernel history (legacy writers do not bump trips.version); a missing/invalid version is 0, never NaN", () => {
    assert.equal(projectTripForDiscovery(row({ version: 0 }), AT).sourceTripVersion, 0);
    assert.equal(projectTripForDiscovery(row({ version: undefined }), AT).sourceTripVersion, 0);
    assert.equal(projectTripForDiscovery(row({ version: "x" }), AT).sourceTripVersion, 0);
    assert.equal(projectTripForDiscovery(row({ version: "12" }), AT).sourceTripVersion, 12);
  });

  it("the non-member privacy toggles apply to a Discovery searcher exactly as toPrivateTripPreview applies them", () => {
    const hidden = projectTripForDiscovery(row({ show_exact_dates: false, show_destination_city: false, show_header_publicly: false }), AT);
    assert.equal(hidden.startDate, null, "show_exact_dates=false hides the start date");
    assert.equal(hidden.endDate, null);
    assert.equal(hidden.destinationCity, null, "show_destination_city=false hides the city");
    assert.equal(hidden.destinationCountry, "PT", "the country is never hidden by that toggle");
    assert.equal(hidden.coverUrl, PRIVATE_TRIP_COVER_PLACEHOLDER, "show_header_publicly=false replaces the cover with the placeholder");
    assert.equal(hidden.discoverable, true, "hiding fields does not make the trip undiscoverable");
  });
});

describe("TripDiscoveryProjection — the discoverability rule, once", () => {
  it("public AND show_in_discovery AND status not in draft/cancelled/archived", () => {
    assert.deepEqual([...TRIP_DISCOVERY_EXCLUDED_STATUSES], ["draft", "cancelled", "archived"]);
    assert.equal(isTripDiscoverable(row()), true);
    assert.equal(isTripDiscoverable(row({ visibility: "buddies" })), false);
    assert.equal(isTripDiscoverable(row({ visibility: "private" })), false);
    assert.equal(isTripDiscoverable(row({ show_in_discovery: false })), false);
    assert.equal(isTripDiscoverable(row({ show_in_discovery: null })), false, "an absent flag is not an opt-in");
    for (const s of ["draft", "cancelled", "archived"]) assert.equal(isTripDiscoverable(row({ status: s })), false, s);
    for (const s of ["planning", "upcoming", "active", "completed"]) assert.equal(isTripDiscoverable(row({ status: s })), true, s);
  });

  it("tripDiscoveryAdmits: a discoverable trip for anyone, the owner's own trip otherwise, never an excluded lifecycle state — Discovery's searchPlans rule, owned here", () => {
    const pub = projectTripForDiscovery(row(), AT);
    const priv = projectTripForDiscovery(row({ visibility: "private", show_in_discovery: false }), AT);
    const draftOwn = projectTripForDiscovery(row({ status: "draft" }), AT);
    assert.equal(tripDiscoveryAdmits(pub, OTHER), true);
    assert.equal(tripDiscoveryAdmits(pub, null), true, "anonymous viewer, public trip");
    assert.equal(tripDiscoveryAdmits(priv, OTHER), false);
    assert.equal(tripDiscoveryAdmits(priv, OWNER), true, "the owner sees their own private trip's plans");
    assert.equal(tripDiscoveryAdmits(priv, null), false);
    assert.equal(tripDiscoveryAdmits(draftOwn, OWNER), false, "legacy searchPlans excluded draft/cancelled/archived for the owner too");
  });
});

describe("TripDiscoveryProjection — the readers issue the rule in SQL and fail closed", () => {
  it("searchTripDiscoveryProjections: the SQL predicate is the rule (public, show_in_discovery, status denylist of real labels), same ilike escaping as Discovery, ordered by start_date, paged", async () => {
    const sc = fakeClient({ data: [row(), row({ id: T2, title: "Lisbon again", version: 0 })], error: null });
    const r = await searchTripDiscoveryProjections(sc, { text: "lis%bon,(x)", startsAfter: "2026-09-01T00:00:00Z", startsBefore: "2026-12-01", offset: 20, limit: 10 });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.projections.length, 2);
    assert.equal(r.projections[0].generatedAt, r.generatedAt, "one generatedAt per read");
    assert.equal(r.projections[1].sourceTripVersion, 0);
    const q = sc.recorded[0];
    assert.equal(q.table, "trips");
    assert.equal(q.select, TRIP_DISCOVERY_SOURCE_COLUMNS);
    assert.ok(TRIP_DISCOVERY_SOURCE_COLUMNS.includes("version"), "the source list carries trips.version (2420)");
    assert.ok(!TRIP_DISCOVERY_SOURCE_COLUMNS.includes("trip_notes") && !TRIP_DISCOVERY_SOURCE_COLUMNS.includes("destination_lat"), "lodging notes and coordinates are never selected");
    const calls = Object.fromEntries(q.calls.map(([m, a]) => [m, a]));
    const pat = tripDiscoveryIlikePattern("lis%bon,(x)");
    assert.equal(pat, "%lis\\%bonx%", "`,()` stripped, LIKE wildcards escaped — the rule Discovery applies today");
    assert.equal(calls.or[0], `title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`);
    assert.deepEqual(q.calls.filter(([m]) => m === "eq").map(([, a]) => a), [["visibility", "public"], ["show_in_discovery", true]]);
    assert.deepEqual(calls.not, ["status", "in", '("draft","cancelled","archived")'], "real trip_status labels only — a non-label is a 22P02, not an empty match");
    assert.deepEqual(calls.order, ["start_date", { ascending: true }]);
    assert.deepEqual(calls.gte, ["start_date", "2026-09-01"]);
    assert.deepEqual(calls.lt, ["start_date", "2026-12-01"]);
    assert.deepEqual(calls.range, [20, 29]);
  });

  it("readTripDiscoveryProjections: by id, de-duplicated, NOT filtered by discoverability (the consumer applies tripDiscoveryAdmits per viewer); empty input never touches the database", async () => {
    const sc = fakeClient({ data: [row({ id: T1 }), row({ id: T3, visibility: "private", show_in_discovery: false, status: "draft" })], error: null });
    const r = await readTripDiscoveryProjections(sc, [T1, T3, T1, "", T3]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.projections.map((p: TripDiscoveryProjection) => [p.tripId, p.discoverable]), [[T1, true], [T3, false]]);
    const q = sc.recorded[0];
    assert.deepEqual(q.calls.find(([m]) => m === "in")![1], ["id", [T1, T3]]);
    assert.equal(q.calls.some(([m]) => m === "eq" || m === "not"), false, "no visibility predicate in SQL for the by-id reader");

    const none = fakeClient({ data: null, error: { message: "must not be called" } });
    const e = await readTripDiscoveryProjections(none, []);
    assert.deepEqual(e, { ok: true, generatedAt: (e as any).generatedAt, projections: [] });
    assert.equal(none.recorded.length, 0);
  });

  it("a database error (supabase-js RESOLVES with { data: null, error }) is TRIP_PROJECTION_UNAVAILABLE, not an empty result; a thrown client is the same", async () => {
    const errored = fakeClient({ data: null, error: { message: 'column "version" does not exist' } });
    const s = await searchTripDiscoveryProjections(errored, { text: "x", offset: 0, limit: 5 });
    assert.deepEqual(s, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", detail: 'column "version" does not exist' });
    const b = await readTripDiscoveryProjections(errored, [T1]);
    assert.equal(b.ok, false);
    assert.equal((b as any).reason, "TRIP_PROJECTION_UNAVAILABLE");

    const thrown = fakeClient("throw");
    const s2 = await searchTripDiscoveryProjections(thrown, { text: "x", offset: 0, limit: 5 });
    assert.equal(s2.ok, false);
    assert.equal((s2 as any).detail, "boom");
    const b2 = await readTripDiscoveryProjections(thrown, [T1]);
    assert.equal(b2.ok, false);
  });

  it("a non-array data payload is an empty projection set, and the search reader's rows are all discoverable by construction of the SQL", async () => {
    const weird = fakeClient({ data: { not: "an array" }, error: null });
    const s = await searchTripDiscoveryProjections(weird, { text: "x", offset: 0, limit: 5 });
    assert.equal(s.ok, true);
    if (s.ok) assert.deepEqual(s.projections, []);
  });
});
