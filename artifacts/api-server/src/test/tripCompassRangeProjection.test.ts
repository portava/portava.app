import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTripCompassRangeProjection, COMPASS_RANGE_PLAN_ITEM_CAP } from "../domain/trips/projections/TripCompassRangeProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { clientFor, fixture, plan, json, isPlanRead, isVersionRead, VIEWER, TRIP, SECOND_TRIP, FOREIGN_TRIP, type Row } from "./helpers/tripCompassRangeFixture.js";

const RANGE = { startDate: "2026-08-05", endDate: "2026-08-06" };
const NOW = new Date("2026-10-16T12:00:00Z");

describe("TripCompassRangeProjection typed request-scoped contract", () => {
  it("publishes separate source envelopes, never an aggregate version or raw private rows", async () => {
    const store = fixture();
    store.trip_plan_items[0] = plan(0, { notes: "secret", lat: 1, lng: 2, address: "secret address" });
    const { client, requests } = clientFor(store);
    const result = await buildTripCompassRangeProjection(client, [TRIP, SECOND_TRIP], VIEWER, RANGE, { now: NOW });
    assert.deepEqual(result, { ok: true, projection: {
      viewerId: VIEWER, ...RANGE, rowLimit: 20, accessStatus: "ok",
      sources: [
        { tripId: TRIP, sourceTripVersion: 7, projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, generatedAt: NOW.toISOString(), freshness: "live" },
        { tripId: SECOND_TRIP, sourceTripVersion: 12, projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, generatedAt: NOW.toISOString(), freshness: "live" },
      ],
      items: [{ tripId: TRIP, title: "Plan 0", dayDate: "2026-08-05" }, { tripId: SECOND_TRIP, title: "Plan 1", dayDate: "2026-08-06" }],
    } });
    assert.equal(COMPASS_RANGE_PLAN_ITEM_CAP, 20);
    assert.equal(requests.filter(isVersionRead).length, 1);
    assert.equal(requests.filter(isPlanRead).length, 1);
    assert.ok(requests.findIndex(isVersionRead) < requests.findIndex(isPlanRead));
    assert.doesNotMatch(JSON.stringify(result), /creator_id|privacy_scope|location_is_private|notes|address|"lat"|"lng"/);
    const selected = requests.find(isPlanRead)!.searchParams.get("select")!.split(",");
    assert.deepEqual(selected, ["id", "trip_id", "title", "day_date", "removed_at", "creator_id", "location_is_private", "privacy_scope"]);
  });

  for (const [label, body, status] of [
    ["error", { message: "unreadable" }, 400], ["null", null, 200], ["object", {}, 200],
    ["duplicate version", [{ id: TRIP, version: 7 }, { id: TRIP, version: 8 }], 200],
    ["foreign version", [{ id: FOREIGN_TRIP, version: 7 }], 200],
  ] as const) {
    it(`makes ${label} version attribution explicit without inventing zero or dropping readable items`, async () => {
      const { client } = clientFor(fixture(), (url) => isVersionRead(url) ? json(body, status) : undefined);
      const result = await buildTripCompassRangeProjection(client, [TRIP, SECOND_TRIP], VIEWER, RANGE);
      assert.ok(result.ok);
      assert.equal(result.projection.items.length, 2);
      assert.deepEqual(result.projection.sources.map((source) => [source.sourceTripVersion, source.freshness]), [[null, "unattributable"], [null, "unattributable"]]);
    });
  }

  for (const version of [null, "7", -1, 1.5]) {
    it(`does not conflate a trip's ${JSON.stringify(version)} version with another trip's valid version`, async () => {
      const store = fixture();
      store.trips[0]!.version = version;
      const result = await buildTripCompassRangeProjection(clientFor(store).client, [TRIP, SECOND_TRIP], VIEWER, RANGE);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.sources.map((source) => [source.sourceTripVersion, source.freshness]), [[null, "unattributable"], [12, "live"]]);
    });
  }

  it("represents a missing trip version without borrowing the preceding trip's version", async () => {
    const { client } = clientFor(fixture(), (url) => isVersionRead(url) ? json([{ id: TRIP, version: 7 }]) : undefined);
    const result = await buildTripCompassRangeProjection(client, [TRIP, SECOND_TRIP], VIEWER, RANGE);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.sources.map((source) => source.sourceTripVersion), [7, null]);
  });

  for (const [label, patch] of [
    ["padded id", { id: ` ${plan().id}` }], ["numeric trip", { trip_id: 42 }],
    ["invalid creator", { creator_id: "not-a-uuid" }], ["numeric privacy", { location_is_private: 0 }],
    ["missing scope", { privacy_scope: undefined }], ["padded scope", { privacy_scope: " crew " }],
    ["non-calendar date", { day_date: "2026-02-30" }], ["timestamp not date", { day_date: "2026-08-05T00:00:00Z" }],
    ["missing removal state", { removed_at: undefined }],
  ] satisfies Array<[string, Row]>) {
    it(`rejects ${label} before privacy filtering any of the response`, async () => {
      const { client, requests } = clientFor(fixture(), (url) => isPlanRead(url) ? json([plan(), plan(1, { privacy_scope: "private", ...patch })]) : undefined);
      assert.deepEqual(await buildTripCompassRangeProjection(client, [TRIP], VIEWER, RANGE), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.equal(requests.some((url) => url.pathname.endsWith("/feature_flags")), false);
    });
  }

  it("rejects duplicate rows instead of spending two slots on one item", async () => {
    const { client } = clientFor(fixture(), (url) => isPlanRead(url) ? json([plan(), plan()]) : undefined);
    assert.equal((await buildTripCompassRangeProjection(client, [TRIP], VIEWER, RANGE)).ok, false);
  });

  it("preserves legacy nullable privacy fields and title without widening them", async () => {
    const store = fixture();
    store.trip_plan_items = [plan(0, { creator_id: null, location_is_private: null }), plan(1, { privacy_scope: null }),
      plan(2, { creator_id: VIEWER, privacy_scope: null, title: null })];
    const result = await buildTripCompassRangeProjection(clientFor(store).client, [TRIP], VIEWER, RANGE);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, [{ tripId: TRIP, title: "Private plan", dayDate: RANGE.startDate },
      { tripId: TRIP, title: "", dayDate: RANGE.startDate }]);
  });

  it("keeps unread access distinct even when the fail-closed privacy filter emits no items", async () => {
    const store = fixture();
    store.trip_plan_items = [plan(0, { privacy_scope: "selected_participants" })];
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/feature_flags") ? json({ message: "unread" }, 400) : undefined);
    const result = await buildTripCompassRangeProjection(client, [TRIP], VIEWER, RANGE);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, []);
    assert.equal(result.projection.accessStatus, "unread");
  });

  it("refuses a throwing client without emitting a partial range", async (context) => {
    const { client } = clientFor();
    context.mock.method(client, "from", () => { throw new Error("fixture unavailable"); });
    assert.deepEqual(await buildTripCompassRangeProjection(client, [TRIP], VIEWER, RANGE), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("rejects invalid or duplicate selected scopes before issuing reads", async () => {
    const { client, requests } = clientFor();
    for (const ids of [[], [TRIP, TRIP], ["not-a-uuid"], [` ${TRIP}`]]) {
      assert.equal((await buildTripCompassRangeProjection(client, ids, VIEWER, RANGE)).ok, false);
    }
    assert.equal((await buildTripCompassRangeProjection(client, [TRIP], "not-a-uuid", RANGE)).ok, false);
    assert.deepEqual(requests, []);
  });

  it("uses the shared envelope acceptance contract independently for every trip", async () => {
    const result = await buildTripCompassRangeProjection(clientFor().client, [TRIP, SECOND_TRIP], VIEWER, RANGE, { now: NOW });
    assert.ok(result.ok);
    const options = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, now: NOW.getTime() };
    for (const source of result.projection.sources) {
      assert.equal(acceptTripProjection(source, options).accepted, true);
      for (const changed of [{ ...source, projectionSchemaVersion: 99 }, { ...source, generatedAt: "bad" }, { ...source, freshness: "stale" as const }]) {
        assert.equal(acceptTripProjection(changed, options).accepted, false);
      }
      assert.equal(acceptTripProjection(source, { ...options, canonicalVersion: 0 }).accepted, false);
    }
  });
});
