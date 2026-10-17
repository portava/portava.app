import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTripCompassDayCountProjection, COMPASS_DAY_COUNT_SCAN_LIMIT } from "../domain/trips/projections/TripCompassDayCountProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { clientFor, fixture, plan, json, isDayCountRead, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW, TOMORROW, type Row } from "./helpers/tripCompassDayCountFixture.js";

describe("TripCompassDayCountProjection bounded private count contract", () => {
  it("publishes only an attributed bounded visible count, not an exact total or raw/hidden-row metadata", async () => {
    const store = fixture();
    store.trip_plan_items.push(plan(1, { privacy_scope: "private", title: "Hidden", lat: 1, notes: "secret" }));
    const { client, requests } = clientFor(store);
    const result = await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW, { now: new Date(NOW) });
    assert.deepEqual(result, { ok: true, projection: {
      tripId: TRIP, viewerId: VIEWER, dayDate: TOMORROW, visibleCount: 1,
      countBasis: "visible_rows_in_capped_read", readLimit: 50,
      generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 7,
      projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, freshness: "live",
    } });
    assert.equal(COMPASS_DAY_COUNT_SCAN_LIMIT, 50);
    assert.equal(requests[0]!.url.searchParams.get("select"), "version");
    assert.equal(requests[0]!.url.searchParams.get("id"), `eq.${TRIP}`);
    const countRead = requests.find(({ url }) => isDayCountRead(url))!;
    assert.equal(countRead.url.searchParams.get("select"), "id,trip_id,day_date,status,removed_at,creator_id,location_is_private,privacy_scope");
    assert.equal(countRead.url.searchParams.get("trip_id"), `eq.${TRIP}`);
    assert.equal(countRead.url.searchParams.has("order"), false);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.doesNotMatch(JSON.stringify(result), /hiddenCount|scannedCount|scanTruncated|Hidden|secret|creator_id|privacy_scope|location_is_private|title|"lat"|notes/);
  });

  for (const total of [0, 1, 49, 50, 51, 75]) {
    it(`counts only the first fifty returned rows for ${total} source rows`, async () => {
      const store = fixture();
      store.trip_plan_items = Array.from({ length: total }, (_, index) => plan(index));
      const result = await buildTripCompassDayCountProjection(clientFor(store).client, TRIP, VIEWER, TOMORROW);
      assert.ok(result.ok);
      assert.equal(result.projection.visibleCount, Math.min(total, 50));
    });
  }

  for (const [label, patch] of [
    ["missing id", { id: undefined }], ["empty id", { id: "" }], ["numeric id", { id: 1 }],
    ["padded creator", { creator_id: ` ${OTHER}` }], ["numeric creator", { creator_id: 1 }],
    ["foreign trip", { trip_id: FOREIGN_TRIP }], ["missing day", { day_date: undefined }],
    ["timestamp day", { day_date: `${TOMORROW}T00:00:00Z` }],
    ["missing status", { status: undefined }], ["null status", { status: null }], ["empty status", { status: "" }],
    ["unknown status", { status: "unexpected" }], ["cancelled status", { status: "cancelled" }],
    ["missing removal state", { removed_at: undefined }], ["removed row", { removed_at: "2026-08-01T00:00:00Z" }],
    ["numeric privacy flag", { location_is_private: 0 }], ["missing scope", { privacy_scope: undefined }],
    ["padded scope", { privacy_scope: " private " }],
  ] satisfies Array<[string, Row]>) {
    it(`refuses ${label} in a later hidden row before counting or reading access`, async () => {
      const { client, requests } = clientFor(fixture(), (url) => isDayCountRead(url)
        ? json([plan(), plan(1, { privacy_scope: "private", ...patch })]) : undefined);
      assert.deepEqual(await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.equal(requests.some(({ url }) => url.pathname.endsWith("/feature_flags")), false);
    });
  }

  it("keeps the canonical noncancelled status vocabulary without discarding terminal done/skipped/moved plans", async () => {
    const store = fixture();
    store.trip_plan_items = ["draft", "proposed", "tentative", "confirmed", "in_progress", "done", "moved", "cancelled", "skipped"]
      .map((status, index) => plan(index, { status }));
    const result = await buildTripCompassDayCountProjection(clientFor(store).client, TRIP, VIEWER, TOMORROW);
    assert.ok(result.ok);
    assert.equal(result.projection.visibleCount, 8);
  });

  it("counts legacy nullable private-anchor slots and own/null-scope plans without admitting hidden plans", async () => {
    const store = fixture();
    store.trip_plan_items = [plan(0, { creator_id: null, location_is_private: null }),
      plan(1, { creator_id: VIEWER, privacy_scope: null }), plan(2, { privacy_scope: null }), plan(3, { privacy_scope: "private" })];
    const result = await buildTripCompassDayCountProjection(clientFor(store).client, TRIP, VIEWER, TOMORROW);
    assert.ok(result.ok);
    assert.equal(result.projection.visibleCount, 2);
  });

  for (const version of [null, "7", undefined]) {
    it(`labels version ${String(version)} as unattributable, never zero`, async () => {
      const store = fixture();
      store.trips[0]!.version = version;
      const result = await buildTripCompassDayCountProjection(clientFor(store).client, TRIP, VIEWER, TOMORROW);
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.equal(result.projection.visibleCount, 1);
    });
  }

  it("does not turn an unread version into a false unread or empty plan", async () => {
    const { client } = clientFor(fixture(), (url) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version"
      ? json({ message: "version unread" }, 400) : undefined);
    const result = await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW);
    assert.ok(result.ok);
    assert.equal(result.projection.sourceTripVersion, null);
    assert.equal(result.projection.visibleCount, 1);
  });

  it("does not publish a partial count when known access is unread", async () => {
    const { client } = clientFor(fixture(), (url) => url.pathname.endsWith("/feature_flags") ? json({ message: "access unread" }, 400) : undefined);
    assert.deepEqual(await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("preserves the existing absent-audience-table rule, which cannot contain any selections", async () => {
    const store = fixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_plan_items.push(plan(1, { privacy_scope: "selected_participants" }));
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/trip_plan_item_audience")
      ? json({ message: "table absent", code: "42P01" }, 400) : undefined);
    const result = await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW);
    assert.ok(result.ok);
    assert.equal(result.projection.visibleCount, 1);
  });

  it("refuses a synchronous query failure without publishing an envelope or zero", async (context) => {
    const { client } = clientFor();
    context.mock.method(client, "from", () => { throw new Error("fixture unavailable"); });
    assert.deepEqual(await buildTripCompassDayCountProjection(client, TRIP, VIEWER, TOMORROW), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("validates caller scope and calendar day before any reads", async () => {
    const { client, requests } = clientFor();
    for (const [tripId, viewerId, dayDate] of [["bad", VIEWER, TOMORROW], [TRIP, ` ${VIEWER}`, TOMORROW],
      [TRIP, VIEWER, "2026-02-30"], [TRIP, VIEWER, "2026-8-6"], [TRIP, VIEWER, `${TOMORROW}T00:00:00Z`]]) {
      assert.equal((await buildTripCompassDayCountProjection(client, tripId!, viewerId!, dayDate!)).ok, false);
    }
    assert.deepEqual(requests, []);
  });

  it("uses the shared envelope acceptance rules without claiming an atomic versioned snapshot", async () => {
    const result = await buildTripCompassDayCountProjection(clientFor().client, TRIP, VIEWER, TOMORROW, { now: new Date(NOW) });
    assert.ok(result.ok);
    const options = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, now: NOW, canonicalVersion: 7 };
    assert.equal(acceptTripProjection(result.projection, options).accepted, true);
    for (const changed of [{ ...result.projection, projectionSchemaVersion: 99 }, { ...result.projection, generatedAt: "invalid" },
      { ...result.projection, freshness: "stale" as const }, { ...result.projection, sourceTripVersion: 8 }]) {
      assert.equal(acceptTripProjection(changed, options).accepted, false);
    }
  });
});
