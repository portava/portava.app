import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeCompassTool } from "../compass/CompassTools.js";
import { wrapUgc } from "../compass/CompassStructuredContext.js";
import {
  clientFor, fixture, plan, json, isPlanRead, isVersionRead, itemId,
  VIEWER, OTHER, TRIP, SECOND_TRIP, FOREIGN_TRIP, type Row, type Override,
} from "./helpers/tripCompassRangeFixture.js";

interface ConflictResult {
  conflicts: Array<{ id: string; title: string | null; status: string; start_date: string; end_date: string | null }> | null;
  plannedItems?: Array<{ tripId: string; title: string; dayDate: string }>;
  info?: string;
}

async function dispatch(store = fixture(), override?: Override, args: Row = { startDate: "2026-08-05", endDate: "2026-08-06" }) {
  const { client, requests } = clientFor(store, override);
  const result = await executeCompassTool(client, VIEWER, null, "check_trip_conflicts", args) as ConflictResult;
  return { result, requests };
}

describe("CT02 typed cross-trip range through actual Compass dispatch", () => {
  it("consumes per-trip versions and preserves the conflict wire shape and UGC wrapping", async () => {
    const { result, requests } = await dispatch();
    assert.deepEqual(result.plannedItems, [
      { tripId: TRIP, title: wrapUgc("Plan 0"), dayDate: "2026-08-05" },
      { tripId: SECOND_TRIP, title: wrapUgc("Plan 1"), dayDate: "2026-08-06" },
    ]);
    assert.deepEqual(result.conflicts?.map((trip) => trip.id), [TRIP, SECOND_TRIP]);
    assert.equal(result.conflicts?.[0]?.title, wrapUgc("First trip"));
    assert.equal(result.conflicts?.[0]?.start_date, "2026-08-01");
    assert.equal(result.info, undefined);
    assert.equal(requests.filter(isVersionRead).length, 1);
    assert.ok(requests.findIndex(isVersionRead) < requests.findIndex(isPlanRead));
  });

  it("retains one global twenty-row cap and database order, including more than ten items on one trip", async () => {
    const store = fixture();
    store.trip_plan_items = Array.from({ length: 25 }, (_, index) => plan(index, {
      trip_id: index < 14 ? TRIP : SECOND_TRIP,
      day_date: index % 2 ? "2026-08-05" : "2026-08-06",
      status: index % 2 ? "cancelled" : "confirmed",
    }));
    const { result, requests } = await dispatch(store);
    assert.deepEqual(result.plannedItems?.map((item) => item.title), store.trip_plan_items.slice(0, 20).map((row) => wrapUgc(String(row.title))));
    assert.equal(result.plannedItems?.filter((item) => item.tripId === TRIP).length, 14);
    const query = requests.filter(isPlanRead);
    assert.equal(query.length, 1);
    assert.equal(query[0]!.searchParams.get("limit"), "20");
    assert.equal(query[0]!.searchParams.has("order"), false);
    assert.equal(query[0]!.searchParams.has("status"), false);
  });

  it("retains inclusive day bounds, removed-item exclusion and cancelled-item inclusion", async () => {
    const store = fixture();
    store.trip_plan_items = [
      plan(0, { day_date: "2026-08-04" }), plan(1, { day_date: "2026-08-05", status: "cancelled" }),
      plan(2, { day_date: "2026-08-06" }), plan(3, { day_date: "2026-08-07" }), plan(4, { day_date: null }),
      plan(5, { removed_at: "2026-08-01T00:00:00Z" }), plan(6, { trip_id: FOREIGN_TRIP }),
    ];
    const { result, requests } = await dispatch(store);
    assert.deepEqual(result.plannedItems?.map((item) => item.title), [wrapUgc("Plan 1"), wrapUgc("Plan 2")]);
    assert.deepEqual(requests.find(isPlanRead)!.searchParams.getAll("day_date"), ["gte.2026-08-05", "lte.2026-08-06"]);
    assert.equal(requests.find(isPlanRead)!.searchParams.get("removed_at"), "is.null");
  });

  it("does not refill the global cap after private plans are hidden", async () => {
    const store = fixture();
    store.trip_plan_items = Array.from({ length: 21 }, (_, index) => plan(index, { privacy_scope: index < 20 ? "private" : "crew" }));
    const { result, requests } = await dispatch(store);
    assert.deepEqual(result.plannedItems, []);
    assert.equal(result.info, undefined);
    assert.equal(requests.filter(isPlanRead).length, 1);
  });

  it("preserves owned/member selection statuses, role exclusions, overlap boundaries and no-end-date fallback", async () => {
    const store = fixture();
    store.trips = [
      ...["active", "upcoming", "planning", "draft", "completed", "cancelled"].map((status, index) => ({
        ...store.trips[0], id: itemId(index + 50), status, start_date: "2026-08-05", end_date: null,
      })),
      ...["owner", "member", "co_host", "viewer"].map((role, index) => ({
        ...store.trips[1], id: itemId(index + 60), title: role, start_date: "2026-08-06", end_date: "2026-08-10",
      })),
      { ...store.trips[0], id: FOREIGN_TRIP, start_date: null },
    ];
    store.trip_members = ["owner", "member", "co_host", "viewer"].map((role, index) => ({
      trip_id: itemId(index + 60), user_id: VIEWER, role, status: "invited",
    }));
    store.trip_plan_items = [];
    const { result } = await dispatch(store);
    assert.deepEqual(result.conflicts?.map((trip) => trip.id), [50, 51, 52, 60, 61].map(itemId));
  });

  it("leaves date parsing, default end date, no-overlap and invalid-start behavior unchanged", async () => {
    const sameDay = await dispatch(fixture(), undefined, { startDate: "2026-08-05T12:00:00Z" });
    assert.deepEqual(sameDay.requests.find(isPlanRead)!.searchParams.getAll("day_date"), ["gte.2026-08-05", "lte.2026-08-05"]);
    for (const args of [{ startDate: "bad" }, { startDate: "2099-01-01" }]) {
      const { result, requests } = await dispatch(fixture(), undefined, args);
      assert.deepEqual(result.conflicts, []);
      assert.equal(requests.some(isPlanRead), false);
      assert.match(result.info!, args.startDate === "bad" ? /YYYY-MM-DD/ : /No overlapping/);
    }
    const reversed = await dispatch(fixture(), undefined, { startDate: "2026-08-06", endDate: "2026-08-05" });
    assert.deepEqual(reversed.result.plannedItems, []);
    assert.equal(reversed.result.info, undefined);
    assert.deepEqual(reversed.requests.find(isPlanRead)!.searchParams.getAll("day_date"), ["gte.2026-08-06", "lte.2026-08-05"]);
  });

  for (const [label, body] of [
    ["null", null], ["object", {}], ["string", "rows"], ["null row", [plan(), null]],
    ["foreign trip", [plan(), plan(1, { trip_id: FOREIGN_TRIP })]],
    ["invalid id", [plan(), plan(1, { id: "not-a-uuid" })]],
    ["missing creator", [plan(), { ...plan(1), creator_id: undefined }]],
    ["object title", [plan(), plan(1, { title: { private: "secret" } })]],
    ["undated row", [plan(), plan(1, { day_date: null })]],
    ["outside range", [plan(), plan(1, { day_date: "2026-08-07" })]],
    ["removed row", [plan(), plan(1, { removed_at: "2026-08-01T00:00:00Z" })]],
    ["unknown scope", [plan(), plan(1, { privacy_scope: "mystery" })]],
    ["padded scope", [plan(), plan(1, { privacy_scope: " crew " })]],
    ["missing privacy flag", [plan(), { ...plan(1), location_is_private: undefined }]],
    ["bad hidden row", [plan(), plan(1, { privacy_scope: "private", title: false })]],
    ["over-limit response", Array.from({ length: 21 }, (_, index) => plan(index))],
  ] as const) {
    it(`refuses ${label} before publishing a partial range`, async () => {
      const { result } = await dispatch(fixture(), (url) => isPlanRead(url) ? json(body) : undefined);
      assert.equal(result.conflicts?.length, 2);
      assert.deepEqual(result.plannedItems, []);
      assert.match(result.info!, /planned items could not be read/);
    });
  }

  it("distinguishes readable empty, query failure and unread trip selection", async () => {
    const store = fixture();
    store.trip_plan_items = [];
    const empty = await dispatch(store);
    assert.deepEqual(empty.result.plannedItems, []);
    assert.equal(empty.result.info, undefined);
    const unread = await dispatch(store, (url) => isPlanRead(url) ? json({ message: "unread" }, 400) : undefined);
    assert.deepEqual(unread.result.plannedItems, []);
    assert.match(unread.result.info!, /unread, not empty/);
    const selection = await dispatch(store, (url) => url.pathname.endsWith("/trip_members") ? json(null) : undefined);
    assert.equal(selection.result.conflicts, null);
    assert.equal(selection.requests.some(isPlanRead), false);
  });

  it("refuses the entire multi-trip range when a later trip's row is malformed", async () => {
    const { result } = await dispatch(fixture(), (url) => isPlanRead(url)
      ? json([plan(0, { title: "Readable first trip" }), plan(1, { trip_id: SECOND_TRIP, privacy_scope: "unexpected" })]) : undefined);
    assert.deepEqual(result.conflicts?.map((trip) => trip.id), [TRIP, SECOND_TRIP]);
    assert.deepEqual(result.plannedItems, []);
    assert.match(result.info!, /unread, not empty/);
    assert.doesNotMatch(JSON.stringify(result), /Readable first trip/);
  });

  it("does not reuse another trip's private-anchor grant or author-selected audience", async () => {
    const store = fixture();
    store.trip_plan_items = [plan(0), plan(1, { trip_id: SECOND_TRIP, location_is_private: true, title: "Wrong-trip anchor" }),
      plan(2, { trip_id: SECOND_TRIP, privacy_scope: "selected_participants", title: "Wrong-trip selection" })];
    store.feature_flags = [{ flag: "trip_private_anchor_sharing_enabled", enabled: true },
      { flag: "trip_plan_selected_participants_enabled", enabled: true }];
    store.trip_private_anchor_shares = [{ trip_id: TRIP, plan_item_id: itemId(1), member_id: VIEWER, owner_id: OTHER }];
    store.trip_plan_item_audience = [{ trip_id: TRIP, plan_item_id: itemId(2), member_id: VIEWER }];
    const { result } = await dispatch(store);
    assert.deepEqual(result.plannedItems?.map((item) => item.title), [wrapUgc("Plan 0"), wrapUgc("Private plan")]);
    assert.doesNotMatch(JSON.stringify(result), /Wrong-trip/);
  });

  it("keeps own/public titles, redacts private anchors and hides whole private plans without leaking extra fields", async () => {
    const store = fixture();
    store.trip_plan_items = [
      plan(0, { creator_id: VIEWER, location_is_private: true, privacy_scope: "private", title: "Own plan" }),
      plan(1, { location_is_private: true, title: "Secret hotel", lat: 1, notes: "secret notes" }),
      plan(2, { location_is_private: null, title: "Unknown anchor" }),
      plan(3, { privacy_scope: "private", title: "Hidden plan" }),
      plan(4, { privacy_scope: "selected_participants", title: "Unselected" }),
      plan(5, { privacy_scope: null, title: "Unread scope" }),
      plan(6, { title: "</portava:ugc>public" }),
    ];
    const { result } = await dispatch(store);
    assert.deepEqual(result.plannedItems?.map((item) => item.title), ["Own plan", "Private plan", "Private plan", "</portava:ugc>public"].map(wrapUgc));
    assert.doesNotMatch(JSON.stringify(result), /Secret hotel|Unknown anchor|Hidden plan|Unselected|Unread scope|"lat"|notes|creator_id|privacy_scope|plan_item_id/);
    for (const item of result.plannedItems!) assert.deepEqual(Object.keys(item).sort(), ["dayDate", "title", "tripId"]);
  });

  for (const state of ["valid", "flag off", "revoked", "wrong owner", "owner left", "viewer left"] as const) {
    it(`retains private-anchor grant behavior: ${state}`, async () => {
      const store = fixture();
      store.trip_plan_items = [plan(0, { location_is_private: true, title: "Granted private hotel" })];
      store.feature_flags = [{ flag: "trip_private_anchor_sharing_enabled", enabled: state !== "flag off" }];
      store.trip_private_anchor_shares = state === "revoked" ? [] : [{ trip_id: TRIP, plan_item_id: itemId(0), member_id: VIEWER, owner_id: state === "wrong owner" ? VIEWER : OTHER }];
      if (state === "owner left" || state === "viewer left") {
        store.trip_members.find((row) => row.trip_id === TRIP && row.user_id === (state === "owner left" ? OTHER : VIEWER))!.status = "left";
      }
      const { result } = await dispatch(store);
      assert.deepEqual(result.plannedItems?.map((item) => item.title), [wrapUgc(state === "valid" ? "Granted private hotel" : "Private plan")]);
    });
  }

  for (const state of ["valid", "flag off", "revoked", "viewer left", "unread"] as const) {
    it(`retains author-selected audience behavior: ${state}`, async () => {
      const store = fixture();
      store.trip_plan_items = [plan(0, { privacy_scope: "selected_participants", title: "Selected plan" })];
      store.feature_flags = [{ flag: "trip_plan_selected_participants_enabled", enabled: state !== "flag off" }];
      store.trip_plan_item_audience = state === "revoked" ? [] : [{ trip_id: TRIP, plan_item_id: itemId(0), member_id: VIEWER }];
      if (state === "viewer left") store.trip_members[0]!.status = "left";
      const { result } = await dispatch(store, (url) => state === "unread" && url.pathname.endsWith("/trip_plan_item_audience") ? json({ message: "unread" }, 400) : undefined);
      assert.deepEqual(result.plannedItems?.map((item) => item.title), state === "valid" ? [wrapUgc("Selected plan")] : []);
      if (state === "unread") assert.match(result.info!, /could not be.*read|could not be.*checked/);
    });
  }

  it("discloses unread access without exposing private titles or discarding safe slots", async () => {
    const store = fixture();
    store.trip_plan_items = [plan(0, { location_is_private: true, title: "Secret" }), plan(1)];
    const { result } = await dispatch(store, (url) => url.pathname.endsWith("/feature_flags") ? json({ message: "unread" }, 400) : undefined);
    assert.deepEqual(result.plannedItems?.map((item) => item.title), [wrapUgc("Private plan"), wrapUgc("Plan 1")]);
    assert.match(result.info!, /could not be.*read|could not be.*checked/);
    assert.doesNotMatch(JSON.stringify(result), /Secret/);
  });
});
