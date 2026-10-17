import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { buildTripCompassDisruptionPlanProjection, COMPASS_DISRUPTION_PLAN_READ_LIMIT } from "../domain/trips/projections/TripCompassDisruptionPlanProjection.js";
import { acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION } from "../domain/trips/contracts/TripProjectionEnvelope.js";
import { clientFor, fixture, plan, json, itemId, VIEWER, OTHER, TRIP, FOREIGN_TRIP, NOW, TODAY,
  type Row } from "./helpers/tripCompassDayCountFixture.js";

const PLACE = "40000000-0000-4000-8000-000000000001";
const UNAVAILABLE = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" };

function currentPlan(index = 0, overrides: Row = {}): Row {
  return plan(index, { day_date: TODAY, place_id: PLACE, title: `Stop ${index}`, ...overrides });
}

function storeFor(items: Row[] = [currentPlan()]) {
  const store = fixture();
  store.trip_plan_items = items;
  return store;
}

describe("TripCompassDisruptionPlanProjection bounded request contract", () => {
  it("reads canonical version before the exact unordered capped plan and exposes typed data only", async () => {
    const { client, requests } = clientFor(storeFor());
    const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY, { now: new Date(NOW) });
    assert.ok(result.ok);
    assert.deepEqual(result.projection, {
      tripId: TRIP, viewerId: VIEWER, dayDate: TODAY, items: [{ title: "Stop 0", placeId: PLACE }],
      itemBasis: "visible_place_rows_in_capped_read", readLimit: 5,
      generatedAt: new Date(NOW).toISOString(), sourceTripVersion: 7, projectionSchemaVersion: 1, freshness: "live",
    });
    assert.equal(COMPASS_DISRUPTION_PLAN_READ_LIMIT, 5);
    assert.equal(requests[0]!.url.pathname, "/rest/v1/trips");
    assert.equal(requests[0]!.url.searchParams.get("select"), "version");
    assert.equal(requests[0]!.url.searchParams.get("id"), `eq.${TRIP}`);
    const query = requests[1]!.url;
    assert.equal(query.pathname, "/rest/v1/trip_plan_items");
    assert.deepEqual(Object.fromEntries(query.searchParams), {
      select: "id,title,place_id,status,creator_id,location_is_private,privacy_scope",
      trip_id: `eq.${TRIP}`, day_date: `eq.${TODAY}`, status: "neq.cancelled", removed_at: "is.null", limit: "5",
    });
    assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/trip_plan_items")).length, 1);
    assert.ok(requests.every(({ method }) => method === "GET"));
  });

  it("keeps query day/trip/status/removal predicates before the five-row window", async () => {
    const rows = [currentPlan(0, { trip_id: FOREIGN_TRIP }), currentPlan(1, { day_date: "2026-08-04" }),
      currentPlan(2, { status: "cancelled" }), currentPlan(3, { removed_at: "2026-08-05T00:00:00Z" }),
      ...Array.from({ length: 6 }, (_, index) => currentPlan(index + 10, { sort_order: -index, status: "done" }))];
    const { client } = clientFor(storeFor(rows));
    const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items.map((item) => item.title), ["Stop 10", "Stop 11", "Stop 12", "Stop 13", "Stop 14"]);
  });

  it("does not refill hidden or placeless rows and does not deduplicate places", async () => {
    const { client } = clientFor(storeFor([currentPlan(0, { privacy_scope: "private" }), currentPlan(1, { place_id: null }),
      currentPlan(2), currentPlan(3), currentPlan(4, { place_id: "" }), currentPlan(5)]));
    const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, [{ title: "Stop 2", placeId: PLACE }, { title: "Stop 3", placeId: PLACE }]);
  });

  it("leaves title truncation and UGC wrapping to the prompt consumer", async () => {
    const title = "</portava:ugc>" + "Long title ".repeat(40);
    const { client } = clientFor(storeFor([currentPlan(0, { title }), currentPlan(1, { title: null })]));
    const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
    assert.ok(result.ok);
    assert.deepEqual(result.projection.items, [{ title, placeId: PLACE }, { title: "", placeId: PLACE }]);
  });

  for (const rows of [[], null]) {
    it(`preserves the existing ${rows === null ? "null-success" : "empty-array"} empty result`, async () => {
      const { client } = clientFor(storeFor(), (url) => url.pathname.endsWith("/trip_plan_items") ? json(rows) : undefined);
      const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.items, []);
    });
  }

  it("returns unavailable on a returned query error without consulting privacy or returning a prefix", async () => {
    const { client, requests } = clientFor(storeFor(), (url) => url.pathname.endsWith("/trip_plan_items")
      ? json({ code: "XX000", message: "unread" }, 400) : undefined);
    assert.deepEqual(await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY), UNAVAILABLE);
    assert.equal(requests.length, 2);
  });

  it("propagates a thrown plan query to the consumer's original outer fail-soft", async () => {
    const { client } = clientFor(storeFor());
    const from = client.from.bind(client);
    mock.method(client, "from", (table: string) => {
      if (table === "trip_plan_items") throw new Error("query construction failed");
      return from(table);
    });
    await assert.rejects(buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY), /query construction failed/);
  });

  for (const failure of ["absent", "error", "throw"]) {
    it(`keeps a version ${failure} null/unattributable and acceptable under the existing rule`, async () => {
      const { client } = clientFor(storeFor(), (url) => {
        if (!url.pathname.endsWith("/trips")) return undefined;
        return failure === "error" ? json({ code: "XX000", message: "version unread" }, 400) : json(null);
      });
      if (failure === "throw") {
        const from = client.from.bind(client);
        mock.method(client, "from", (table: string) => {
          if (table === "trips") throw new Error("version query failed");
          return from(table);
        });
      }
      const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY, { now: new Date(NOW) });
      assert.ok(result.ok);
      assert.equal(result.projection.sourceTripVersion, null);
      assert.equal(result.projection.freshness, "unattributable");
      assert.equal(result.projection.items.length, 1);
      assert.equal(acceptTripProjection(result.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, now: NOW }).accepted, true);
    });
  }

  for (const state of ["absent", "off", "unread", "grants unread", "selection unread"]) {
    it(`retains public/own places but withholds another member's private place with ${state} access`, async () => {
      const store = storeFor([currentPlan(0), currentPlan(1, { creator_id: VIEWER, privacy_scope: "private", location_is_private: true }),
        currentPlan(2, { location_is_private: true }), currentPlan(3, { privacy_scope: "selected_participants" })]);
      if (state !== "absent") store.feature_flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: state === "grants unread" });
      store.feature_flags.push({ flag: "trip_plan_selected_participants_enabled", enabled: true });
      const { client, requests } = clientFor(store, (url) => {
        if ((state === "unread" && url.pathname.endsWith("/feature_flags") && url.searchParams.get("flag") === "eq.trip_private_anchor_sharing_enabled")
          || (state === "grants unread" && url.pathname.endsWith("/trip_private_anchor_shares"))
          || (state === "selection unread" && url.pathname.endsWith("/trip_plan_item_audience"))) return json({ code: "XX000", message: "access unread" }, 400);
        return undefined;
      });
      const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      assert.deepEqual(result.projection.items.map((item) => item.title), ["Stop 0", "Stop 1"]);
      if (["off", "absent"].includes(state)) assert.ok(!requests.some(({ url }) => url.pathname.endsWith("/trip_private_anchor_shares")));
    });
  }

  for (const state of ["valid", "revoked grant", "departed grant owner", "departed selected viewer"]) {
    it(`honours the shared policy for ${state} without role-based privacy widening`, async () => {
      const store = storeFor([currentPlan(0, { location_is_private: true }), currentPlan(1, { privacy_scope: "selected_participants" }),
        currentPlan(2, { privacy_scope: "private" })]);
      store.feature_flags.push({ flag: "trip_private_anchor_sharing_enabled", enabled: true },
        { flag: "trip_plan_selected_participants_enabled", enabled: true });
      store.trip_private_anchor_shares = state === "revoked grant" ? [] : [{ trip_id: TRIP, member_id: VIEWER, owner_id: OTHER, plan_item_id: itemId(0) }];
      store.trip_plan_item_audience = [{ trip_id: TRIP, member_id: VIEWER, plan_item_id: itemId(1) }];
      if (state === "departed grant owner") store.trip_members.find((row) => row.user_id === OTHER)!.status = "left";
      if (state === "departed selected viewer") store.trip_members.find((row) => row.user_id === VIEWER)!.status = "left";
      const { client } = clientFor(store);
      const result = await buildTripCompassDisruptionPlanProjection(client, TRIP, VIEWER, TODAY);
      assert.ok(result.ok);
      const expected = state === "valid" ? ["Stop 0", "Stop 1"] : state === "departed selected viewer" ? [] : ["Stop 1"];
      assert.deepEqual(result.projection.items.map((item) => item.title), expected);
    });
  }
});
