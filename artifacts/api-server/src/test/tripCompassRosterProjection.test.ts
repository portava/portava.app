import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { buildTripCompassRosterProjection } from "../domain/trips/projections/TripCompassRosterProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";

const TRIP = "20000000-0000-4000-8000-000000000001";
const VIEWER = "10000000-0000-4000-8000-000000000001";
const memberId = (index: number) => `10000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
const MEMBER = memberId(0);
const NOW = new Date("2026-10-16T12:00:00Z");
const member = (userId = MEMBER, role = "member", status: string | null = "accepted") => ({ user_id: userId, role, status });

function fixture(rows: unknown, opts: { rosterError?: boolean; version?: unknown; versionError?: boolean } = {}) {
  const requests: URL[] = [];
  const client = createClient("http://127.0.0.1:9", "dummy", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      const url = new URL(String(input));
      requests.push(url);
      const version = url.pathname.endsWith("/trips");
      assert.ok(version || url.pathname.endsWith("/trip_members"));
      const failed = version ? opts.versionError : opts.rosterError;
      const body = failed ? { message: "fixture unavailable", code: "XX000" }
        : version ? [{ version: Object.hasOwn(opts, "version") ? opts.version : 7 }] : rows;
      return new Response(JSON.stringify(body), { status: failed ? 400 : 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  return { client, requests };
}

describe("TripCompassRosterProjection request-scoped contract", () => {
  it("publishes only member IDs for the already-selected trip with the existing envelope", async () => {
    const { client, requests } = fixture([{ ...member(VIEWER, "owner"), lat: 1, date_of_birth: "1990-01-01" }, member(), member()]);
    const result = await buildTripCompassRosterProjection(client, TRIP, VIEWER, { now: NOW });
    assert.deepEqual(result, { ok: true, projection: {
      tripId: TRIP, viewerId: VIEWER, memberIds: [VIEWER, MEMBER], generatedAt: NOW.toISOString(),
      sourceTripVersion: 7, projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, freshness: "live",
    } });
    assert.deepEqual(requests.map((url) => url.pathname), ["/rest/v1/trips", "/rest/v1/trip_members"]);
    const roster = requests[1]!;
    assert.equal(roster.searchParams.get("trip_id"), `eq.${TRIP}`);
    assert.equal(roster.searchParams.get("select"), "user_id,role,status");
    assert.equal(roster.searchParams.get("role"), "in.(owner,co_host,member,viewer)");
    assert.equal(roster.searchParams.has("status"), false);
    assert.equal(roster.searchParams.has("limit"), false);
  });

  it("preserves all four roles, null statuses, self inclusion, order and deduplication", async () => {
    const rows = [member(memberId(0), "owner"), member(memberId(1), "co_host", null), member(memberId(2)), member(memberId(3), "viewer"),
      member(memberId(1), "co_host"), ...["invited", "declined", "removed", "left"].map((status, index) => member(memberId(index + 4), "member", status))];
    const result = await buildTripCompassRosterProjection(fixture(rows).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.memberIds, [VIEWER, ...[0, 1, 2, 3].map(memberId)]);
  });

  it("does not substitute a presence roster or introduce an item cap", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => member(memberId(index)));
    const { client, requests } = fixture(rows);
    const result = await buildTripCompassRosterProjection(client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.equal(result.projection.memberIds.length, 76);
    assert.equal(requests.length, 2);
  });

  it("distinguishes a readable empty roster from an unreadable one", async () => {
    const result = await buildTripCompassRosterProjection(fixture([]).client, TRIP, VIEWER);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.memberIds, [VIEWER]);
    assert.deepEqual(await buildTripCompassRosterProjection(fixture([], { rosterError: true }).client, TRIP, VIEWER),
      { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("refuses a synchronously throwing client without exposing partial members", async (context) => {
    const { client } = fixture([member()]);
    context.mock.method(client, "from", () => { throw new Error("fixture client unavailable"); });
    assert.deepEqual(await buildTripCompassRosterProjection(client, TRIP, VIEWER),
      { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  for (const [label, rows] of [
    ["null", null], ["object", {}], ["string", "rows"], ["null row", [null]],
    ["missing id", [{ role: "member", status: "accepted" }]],
    ["empty id", [member(" ")]], ["numeric id", [{ ...member(), user_id: 1 }]],
    ["non-UUID id", [member("not-a-uuid")]], ["padded UUID", [member(` ${MEMBER} `)]],
    ["malformed inactive id", [member("not-a-uuid", "member", "left")]],
    ["missing role", [{ user_id: MEMBER, status: "accepted" }]],
    ["unexpected role", [member(MEMBER, "unexpected")]],
    ["missing status", [{ user_id: MEMBER, role: "member" }]],
    ["unknown status", [member(MEMBER, "member", "unexpected")]],
    ["padded status", [member(MEMBER, "member", " accepted ")]],
    ["empty status", [member(MEMBER, "member", "")]],
    ["nonstring status", [{ ...member(), status: false }]],
  ] as const) {
    it(`refuses the whole roster on ${label}, including when valid rows precede it`, async () => {
      const body = Array.isArray(rows) ? [member(memberId(99)), ...rows] : rows;
      const result = await buildTripCompassRosterProjection(fixture(body).client, TRIP, VIEWER);
      assert.deepEqual(result, { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    });
  }

  for (const opts of [{ version: null }, { version: "7" }, { versionError: true }]) {
    it(`keeps missing version attribution explicit: ${JSON.stringify(opts)}`, async () => {
      const result = await buildTripCompassRosterProjection(fixture([member()], opts).client, TRIP, VIEWER);
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.deepEqual(result.projection.memberIds, [VIEWER, MEMBER]);
    });
  }

  it("uses the existing acceptance rule for valid, stale, incompatible and ahead envelopes", async () => {
    const result = await buildTripCompassRosterProjection(fixture([]).client, TRIP, VIEWER, { now: NOW });
    assert.ok(result.ok);
    const options = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion: 7, now: NOW.getTime() };
    assert.equal(acceptTripProjection(result.projection, options).accepted, true);
    for (const changed of [
      { ...result.projection, projectionSchemaVersion: 99 }, { ...result.projection, generatedAt: "not an instant" },
      { ...result.projection, freshness: "stale" as const }, { ...result.projection, sourceTripVersion: 8 },
    ]) assert.equal(acceptTripProjection(changed, options).accepted, false);
  });

  it("refuses empty scope before reading anything", async () => {
    const { client, requests } = fixture([]);
    assert.equal((await buildTripCompassRosterProjection(client, "", VIEWER)).ok, false);
    assert.equal((await buildTripCompassRosterProjection(client, TRIP, "")).ok, false);
    assert.equal((await buildTripCompassRosterProjection(client, "not-a-uuid", VIEWER)).ok, false);
    assert.equal((await buildTripCompassRosterProjection(client, TRIP, ` ${VIEWER}`)).ok, false);
    assert.deepEqual(requests, []);
  });
});
