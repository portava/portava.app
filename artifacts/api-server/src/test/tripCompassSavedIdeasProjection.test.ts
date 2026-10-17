import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { buildTripCompassSavedIdeasProjection } from "../domain/trips/projections/TripCompassSavedIdeasProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";

const TRIP = "b0000002-0000-0000-0000-000000000001";
const VIEWER = "a0000002-0000-0000-0000-000000000001";
const OTHER = "a0000002-0000-0000-0000-000000000002";
const NOW = new Date("2026-10-16T12:00:00Z");
const ideaId = (index = 0) => `c0000002-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
type Row = Record<string, unknown>;
const idea = (index = 0, overrides: Row = {}): Row => ({
  id: ideaId(index), trip_id: TRIP, user_id: VIEWER, place_id: "provider:opaque-id", place_name: `Idea ${index}`,
  place_type: "unrestricted text", notes: null, saved_at: NOW.toISOString(), ...overrides,
});
const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" };

function fixture(body: unknown, options: { version?: unknown; versionError?: boolean; savedError?: boolean; savedReject?: boolean } = {}) {
  const requests: URL[] = [];
  const unexpected: string[] = [];
  const client = createClient("http://127.0.0.1:9", "dummy", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.origin !== "http://127.0.0.1:9" || (init?.method ?? "GET") !== "GET") unexpected.push(String(input));
      const version = url.pathname === "/rest/v1/trips";
      if (!version && url.pathname !== "/rest/v1/trip_saved_places") unexpected.push(url.pathname);
      if (!version && options.savedReject) throw new DOMException("offline fixture rejection", "AbortError");
      const failed = version ? options.versionError : options.savedError;
      const payload = failed ? { code: "XX000", message: "fixture read unavailable" }
        : version ? [{ version: Object.hasOwn(options, "version") ? options.version : 7 }] : body;
      return new Response(JSON.stringify(payload), { status: failed ? 400 : 200, headers: { "content-type": "application/json" } });
    } },
  });
  return { client, requests, unexpected };
}

describe("TripCompassSavedIdeasProjection request-scoped contract", () => {
  it("publishes a typed read with the established envelope, not raw rows or a certified total", async () => {
    const { client, requests, unexpected } = fixture([idea(0, { lat: 1, lng: 2, email: "secret", owner_id: OTHER })]);
    const result = await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER, { now: NOW });
    assert.deepEqual(result, { ok: true, projection: {
      tripId: TRIP, viewerId: VIEWER, countBasis: "returned_rows", generatedAt: NOW.toISOString(), sourceTripVersion: 7,
      projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, freshness: "live",
      ideas: [{ id: ideaId(), placeId: "provider:opaque-id", name: "Idea 0", placeType: "unrestricted text", notes: null, savedBy: "you", savedAt: NOW.toISOString() }],
    } });
    assert.deepEqual(requests.map((url) => url.pathname), ["/rest/v1/trips", "/rest/v1/trip_saved_places"]);
    assert.equal(requests[0]!.searchParams.get("select"), "version");
    assert.equal(requests[0]!.searchParams.get("id"), `eq.${TRIP}`);
    assert.equal(requests[1]!.searchParams.get("select"), "id,trip_id,user_id,place_id,place_name,place_type,notes,saved_at");
    assert.equal(requests[1]!.searchParams.get("trip_id"), `eq.${TRIP}`);
    assert.deepEqual([...requests[1]!.searchParams.keys()].sort(), ["select", "trip_id"]);
    assert.deepEqual(unexpected, []);
  });

  it("treats real empty as readable", async () => {
    const result = await buildTripCompassSavedIdeasProjection(fixture([]).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.ideas, []);
    assert.equal(result.projection.countBasis, "returned_rows");
  });

  for (const [label, body] of [
    ["null response", null], ["object response", {}], ["string response", ""], ["boolean response", false],
    ["null row", [idea(), null]], ["array row", [idea(), []]], ["string row", [idea(), "row"]],
    ["noncanonical bookmark UUID", [idea(0, { id: ideaId().toUpperCase() })]],
    ["padded bookmark UUID", [idea(0, { id: ` ${ideaId()} ` })]],
    ["coercible bookmark UUID", [idea(0, { id: [ideaId()] })]],
    ["invalid saver UUID", [idea(0, { user_id: "not-a-uuid" })]],
    ["padded saver UUID", [idea(0, { user_id: ` ${VIEWER}` })]],
    ["coercible saver UUID", [idea(0, { user_id: [VIEWER] })]],
    ["foreign trip", [idea(0, { trip_id: OTHER })]],
    ["coercible trip UUID", [idea(0, { trip_id: [TRIP] })]],
    ["null required name", [idea(0, { place_name: null })]],
    ["numeric required name", [idea(0, { place_name: 12 })]],
    ["null required saved_at", [idea(0, { saved_at: null })]],
    ["numeric required saved_at", [idea(0, { saved_at: 123 })]],
    ["object opaque place ID", [idea(0, { place_id: {} })]],
    ["boolean place type", [idea(0, { place_type: false })]],
    ["array notes", [idea(0, { notes: [] })]],
    ["duplicate bookmark identity", [idea(), idea(0, { user_id: OTHER })]],
  ] as const) {
    it(`refuses the whole read on ${label}`, async () => {
      const { client, unexpected } = fixture(body);
      assert.deepEqual(await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER), UNAVAILABLE);
      assert.deepEqual(unexpected, []);
    });
  }

  for (const field of ["id", "trip_id", "user_id", "place_id", "place_name", "place_type", "notes", "saved_at"]) {
    it(`requires selected field ${field}, even behind a valid prefix`, async () => {
      const { client, unexpected } = fixture([idea(), idea(1, { [field]: undefined })]);
      assert.deepEqual(await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER), UNAVAILABLE);
      assert.deepEqual(unexpected, []);
    });
  }

  it("retains legitimate null and empty TEXT values and never invents a place ID/category grammar", async () => {
    const result = await buildTripCompassSavedIdeasProjection(fixture([
      idea(0, { place_name: "", place_id: null, place_type: null, notes: null }),
      idea(1, { place_id: "", place_type: "", notes: "" }),
      idea(2, { place_id: "opaque provider/id:日本", place_type: " freeform unknown type ", notes: "Crew note" }),
    ]).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.equal(result.projection.ideas[0]!.name, "");
    assert.deepEqual(result.projection.ideas.map((entry) => [entry.placeId, entry.placeType, entry.notes]), [
      [null, null, null], ["", "", ""], ["opaque provider/id:日本", " freeform unknown type ", "Crew note"],
    ]);
  });

  it("preserves lexical timestamp order and stable ties, including PostgreSQL special timestamp strings", async () => {
    const result = await buildTripCompassSavedIdeasProjection(fixture([
      idea(0, { saved_at: "2026-10-16T10:00:00Z" }), idea(1, { saved_at: "2026-10-16T11:00:00+02:00" }),
      idea(2, { saved_at: "2026-10-16T11:00:00+02:00" }), idea(3, { saved_at: "infinity" }), idea(4, { saved_at: "-infinity" }),
    ]).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.ideas.map((entry) => entry.id), [3, 1, 2, 0, 4].map(ideaId));
  });

  it("keeps distinct saved rows for different crew and imposes no application cap", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => idea(index, { user_id: index % 2 ? OTHER : VIEWER }));
    const { client, requests, unexpected } = fixture(rows);
    const result = await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.equal(result.projection.ideas.length, 75);
    assert.deepEqual(result.projection.ideas.slice(0, 2).map((entry) => entry.savedBy), ["you", "a crew member"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(unexpected, []);
  });

  for (const options of [{ savedError: true }, { savedReject: true }]) {
    it(`refuses a failed SDK read: ${JSON.stringify(options)}`, async () => {
      const { client, unexpected } = fixture([], options);
      assert.deepEqual(await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER), UNAVAILABLE);
      assert.deepEqual(unexpected, []);
    });
  }

  it("refuses synchronous source exceptions without partial content", async (context) => {
    const { client } = fixture([idea()]);
    context.mock.method(client, "from", () => { throw new Error("source unavailable"); });
    assert.deepEqual(await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER), UNAVAILABLE);
  });

  for (const options of [{ version: null }, { version: "7" }, { versionError: true }]) {
    it(`keeps unreadable version unattributable: ${JSON.stringify(options)}`, async () => {
      const { client, unexpected } = fixture([idea()], options);
      const result = await buildTripCompassSavedIdeasProjection(client, TRIP, VIEWER);
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.equal(result.projection.ideas.length, 1);
      assert.deepEqual(unexpected, []);
    });
  }

  it("uses the existing acceptance rule without claiming an atomic snapshot", async () => {
    const result = await buildTripCompassSavedIdeasProjection(fixture([]).client, TRIP, VIEWER, { now: NOW });
    assert.ok(result.ok);
    const options = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion: 7, now: NOW.getTime() };
    assert.equal(acceptTripProjection(result.projection, options).accepted, true);
    for (const changed of [
      { ...result.projection, projectionSchemaVersion: 99 }, { ...result.projection, generatedAt: "invalid" },
      { ...result.projection, freshness: "stale" as const }, { ...result.projection, sourceTripVersion: 8 },
    ]) assert.equal(acceptTripProjection(changed, options).accepted, false);
  });

  it("rejects malformed scope without reads while preserving valid uppercase query identities", async () => {
    const { client, requests } = fixture([]);
    for (const [tripId, viewerId] of [["", VIEWER], [TRIP, ""], ["not-a-uuid", VIEWER], [TRIP, ` ${VIEWER}`]]) {
      assert.deepEqual(await buildTripCompassSavedIdeasProjection(client, tripId!, viewerId!), UNAVAILABLE);
    }
    assert.deepEqual(requests, []);
    const result = await buildTripCompassSavedIdeasProjection(fixture([idea()]).client, TRIP.toUpperCase(), VIEWER);
    assert.ok(result.ok);
    assert.equal(result.projection.ideas.length, 1);
  });
});
