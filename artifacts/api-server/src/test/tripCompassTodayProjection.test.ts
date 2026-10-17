import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTripCompassTodayProjection, COMPASS_TODAY_READ_LIMIT } from "../domain/trips/projections/TripCompassTodayProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { clientFor, fixture, plan, json, itemId, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW, TODAY, TOMORROW, type Row } from "./helpers/tripCompassDayCountFixture.js";

function todayPlan(index = 0, overrides: Row = {}): Row {
  return plan(index, { day_date: TODAY, title: `Today ${index}`, ...overrides });
}

function isTodayRead(url: URL): boolean {
  return url.pathname.endsWith("/trip_plan_items") && url.searchParams.get("limit") === "5";
}

describe("TripCompassTodayProjection strict bounded plan contract", () => {
  it("publishes only typed visible items and the existing envelope from one bounded ordered read", async () => {
    const store = fixture();
    store.trip_plan_items = [todayPlan(0, { starts_at: `${TODAY}T10:00:00+00:00`, notes: "private notes", lat: 1 }),
      todayPlan(1, { privacy_scope: "private", title: "Hidden title" })];
    const { client, requests } = clientFor(store);
    const result = await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY, { now: new Date(NOW) });
    assert.deepEqual(result, { ok: true, projection: {
      tripId: TRIP, viewerId: VIEWER, dayDate: TODAY,
      items: [{ id: itemId(0), title: "Today 0", startsAt: `${TODAY}T10:00:00+00:00`, sortOrder: 0 }],
      itemBasis: "visible_rows_in_capped_read", readLimit: 5,
      generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 7,
      projectionSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, freshness: "live",
    } });
    assert.equal(COMPASS_TODAY_READ_LIMIT, 5);
    assert.equal(requests[0]!.url.searchParams.get("select"), "version");
    assert.equal(requests[0]!.url.searchParams.get("id"), `eq.${TRIP}`);
    const reads = requests.filter(({ url }) => isTodayRead(url));
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.url.searchParams.get("select"), "id,trip_id,day_date,title,starts_at,sort_order,status,removed_at,creator_id,location_is_private,privacy_scope");
    assert.equal(reads[0]!.url.searchParams.get("trip_id"), `eq.${TRIP}`);
    assert.equal(reads[0]!.url.searchParams.get("day_date"), `eq.${TODAY}`);
    assert.equal(reads[0]!.url.searchParams.get("status"), "neq.cancelled");
    assert.equal(reads[0]!.url.searchParams.get("removed_at"), "is.null");
    assert.equal(reads[0]!.url.searchParams.get("order"), "starts_at.asc,sort_order.asc");
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.doesNotMatch(JSON.stringify(result), /Hidden title|private notes|creator_id|privacy_scope|location_is_private|hiddenCount|scannedCount|scanTruncated|"lat"/);
    assert.ok(!JSON.stringify(result).includes(itemId(1)));
  });

  for (const [label, patch] of [
    ["missing id", { id: undefined }], ["padded id", { id: ` ${itemId(1)}` }], ["noncanonical id", { id: "not-an-id" }],
    ["foreign trip", { trip_id: FOREIGN_TRIP }], ["wrong day", { day_date: TOMORROW }],
    ["missing title", { title: undefined }], ["null title", { title: null }], ["numeric title", { title: 1 }],
    ["missing time", { starts_at: undefined }], ["empty time", { starts_at: "" }], ["numeric time", { starts_at: 1 }],
    ["impossible calendar", { starts_at: "2026-02-30T09:00:00Z" }],
    ["unqualified timestamp", { starts_at: `${TODAY}T09:00:00` }], ["24-hour timestamp", { starts_at: `${TODAY}T24:00:00Z` }],
    ["missing order", { sort_order: undefined }], ["null order", { sort_order: null }], ["numeric string order", { sort_order: "1" }],
    ["fractional order", { sort_order: 1.5 }], ["overflow order", { sort_order: 2147483648 }], ["underflow order", { sort_order: -2147483649 }],
    ["null status", { status: null }], ["unknown status", { status: "unknown" }], ["padded status", { status: "confirmed " }],
    ["cancelled status", { status: "cancelled" }], ["missing removal state", { removed_at: undefined }],
    ["removed row", { removed_at: `${TODAY}T01:00:00Z` }], ["padded creator", { creator_id: ` ${OTHER}` }],
    ["missing creator", { creator_id: undefined }], ["numeric privacy flag", { location_is_private: 0 }],
    ["missing privacy flag", { location_is_private: undefined }], ["missing scope", { privacy_scope: undefined }],
    ["unknown scope", { privacy_scope: "unknown" }], ["padded scope", { privacy_scope: "private " }],
  ] satisfies Array<[string, Row]>) {
    it(`refuses ${label} in a hidden tail before reading privacy or emitting a valid prefix`, async () => {
      const { client, requests } = clientFor(fixture(), (url) => isTodayRead(url)
        ? json([todayPlan(), todayPlan(1, { privacy_scope: "private", ...patch })]) : undefined);
      assert.deepEqual(await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
      assert.equal(requests.some(({ url }) => url.pathname.endsWith("/feature_flags")), false);
    });
  }

  for (const [label, body] of [["null", null], ["object", {}], ["null row", [null]], ["array row", [[]]],
    ["duplicate", [todayPlan(), todayPlan()]], ["oversized", Array.from({ length: 6 }, (_, index) => todayPlan(index))]] as const) {
    it(`refuses ${label} rowset rather than manufacturing an empty or partial plan`, async () => {
      const { client } = clientFor(fixture(), (url) => isTodayRead(url) ? json(body) : undefined);
      assert.deepEqual(await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
    });
  }

  for (const status of ["draft", "proposed", "tentative", "confirmed", "in_progress", "done", "moved", "skipped"]) {
    it(`preserves the canonical noncancelled ${status} state`, async () => {
      const store = fixture();
      store.trip_plan_items = [todayPlan(0, { status }), todayPlan(1, { status: "cancelled" }),
        todayPlan(2, { removed_at: `${TODAY}T00:00:00Z` }), todayPlan(3, { day_date: null }), todayPlan(4, { trip_id: FOREIGN_TRIP })];
      const result = await buildTripCompassTodayProjection(clientFor(store).client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.items.map((item) => item.id), [itemId(0)]);
    });
  }

  it("preserves empty text, null time, fractional seconds, offsets and signed int32 ordering without coercion", async () => {
    const store = fixture();
    store.trip_plan_items = [todayPlan(0, { title: "", starts_at: null, sort_order: -2147483648 }),
      todayPlan(1, { starts_at: `${TODAY}T01:02:03.123456+05:30`, sort_order: 2147483647 })];
    const result = await buildTripCompassTodayProjection(clientFor(store).client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, [
      { id: itemId(1), title: "Today 1", startsAt: `${TODAY}T01:02:03.123456+05:30`, sortOrder: 2147483647 },
      { id: itemId(0), title: "", startsAt: null, sortOrder: -2147483648 },
    ]);
  });

  it("keeps nullable legacy privacy fail-closed while preserving the permitted slot and author", async () => {
    const store = fixture();
    store.trip_plan_items = [todayPlan(0, { creator_id: null, location_is_private: null }),
      todayPlan(1, { creator_id: VIEWER, privacy_scope: null }), todayPlan(2, { privacy_scope: null })];
    const result = await buildTripCompassTodayProjection(clientFor(store).client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items.map((item) => item.title), ["Private plan", "Today 1"]);
  });

  for (const total of [0, 1, 5, 6]) {
    it(`reads only the first five of ${total} rows without refilling hidden plans`, async () => {
      const store = fixture();
      store.trip_plan_items = Array.from({ length: total }, (_, index) => todayPlan(index, { privacy_scope: index < 5 ? "private" : "crew" }));
      const { client, requests } = clientFor(store);
      const result = await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.items, []);
      assert.equal(requests.filter(({ url }) => isTodayRead(url)).length, 1);
    });
  }

  it("preserves known missing audience storage without granting a selection", async () => {
    const store = fixture();
    store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
    store.trip_plan_items = [todayPlan(0, { privacy_scope: "selected_participants" })];
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/trip_plan_item_audience")
      ? json({ code: "PGRST205", message: "not in schema cache" }, 404) : undefined);
    const result = await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, []);
  });

  for (const version of [null, "7", undefined]) {
    it(`keeps version ${String(version)} unattributable without inventing zero`, async () => {
      const store = fixture();
      store.trips[0]!.version = version;
      const result = await buildTripCompassTodayProjection(clientFor(store).client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.equal(result.projection.items.length, 1);
    });
  }

  it("retains live readable items when version attribution is unread", async () => {
    const { client } = clientFor(fixture(), (url) => url.pathname.endsWith("/trips") && url.searchParams.get("select") === "version"
      ? json({ message: "unread" }, 400) : undefined);
    const result = await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.equal(result.projection.sourceTripVersion, null);
    assert.equal(result.projection.items.length, 1);
  });

  it("refuses synchronous query failures without throwing or publishing an empty plan", async (context) => {
    const { client } = clientFor();
    context.mock.method(client, "from", () => { throw new Error("synthetic unavailable"); });
    assert.deepEqual(await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("refuses unread access even when the plan batch is empty", async () => {
    const store = fixture();
    store.trip_plan_items = [];
    const { client } = clientFor(store, (url) => url.pathname.endsWith("/feature_flags") ? json({ message: "unread" }, 400) : undefined);
    assert.deepEqual(await buildTripCompassTodayProjection(client, TRIP, VIEWER, TODAY), { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" });
  });

  it("rejects invalid caller identity and calendar scope before reads", async () => {
    const { client, requests } = clientFor();
    for (const [tripId, viewerId, dayDate] of [["bad", VIEWER, TODAY], [TRIP, ` ${VIEWER}`, TODAY],
      [TRIP, VIEWER, "2026-02-30"], [TRIP, VIEWER, "2026-8-5"], [TRIP, VIEWER, `${TODAY}T00:00:00Z`]]) {
      assert.equal((await buildTripCompassTodayProjection(client, tripId!, viewerId!, dayDate!)).ok, false);
    }
    assert.deepEqual(requests, []);
  });

  it("uses shared envelope refusal rules rather than claiming an atomic multi-read snapshot", async () => {
    const result = await buildTripCompassTodayProjection(clientFor().client, TRIP, VIEWER, TODAY, { now: new Date(NOW) });
    assert.ok(result.ok);
    const options = { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, now: NOW, canonicalVersion: 7 };
    assert.equal(acceptTripProjection(result.projection, options).accepted, true);
    for (const changed of [{ ...result.projection, projectionSchemaVersion: 99 }, { ...result.projection, generatedAt: "invalid" },
      { ...result.projection, freshness: "stale" as const }, { ...result.projection, sourceTripVersion: 8 }]) {
      assert.equal(acceptTripProjection(changed, options).accepted, false);
    }
  });
});
