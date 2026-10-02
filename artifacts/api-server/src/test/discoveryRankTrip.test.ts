/**
 * census-discovery §78 (lane W10-R2) — DV-18's missing leg: `trip_match` gets
 * a producer on the recommendation ranker. Controlled data.
 *
 *   T1  timing: under way = 1; upcoming falls to 0.5 at the horizon; ended,
 *       beyond the horizon, undated or closed = 0
 *   T2  proximity is city-scale and bounded; city-name fallback without coords
 *   T3  the loader reads the viewer's OWN accepted trips through the Map's trip
 *       reader and never another member's invitation or someone else's trip
 *   T4  no counted trip ⇒ no `tripMatch` key; an unreadable layer ⇒ degraded,
 *       and still no key
 *   T5  `tripMatch` → `trip_match`, with fixed plain language, and all nine
 *       codes now have a producer
 *   T6  the term moves a row: a place in the viewer's trip outranks an
 *       otherwise identical place that is not
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankTrip.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tripTiming, tripFitMap, loadTripMatch, TRIP_HORIZON_DAYS, TRIP_RADIUS_KM,
} from "../lib/discoveryRankTrip.js";
import { rankCandidates, TRIP_MATCH_WEIGHT, type ViewerContext } from "../lib/portavaRank.js";
import {
  reasonCodeForSignal, REASON_CODES_WITHOUT_PRODUCER, explainReasonCode, explainReasons,
} from "../lib/discoveryReasonCodes.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

const NOW = Date.UTC(2026, 8, 28, 0);   // midnight, so a date `n` days out is exactly n days out
const DAY = 86_400_000;
const d = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
const V = "eeee0000-0000-4000-8000-00000000000e";
const LISBON = { destinationCity: "Lisbon", destinationLat: 38.7223, destinationLng: -9.1393 };

describe("DV-18 — trip fit on the recommendation ranker", () => {
  it("T1 timing", () => {
    assert.equal(tripTiming({ id: "a", startDate: d(-2), endDate: d(3), status: "active" }, NOW), 1);
    assert.equal(tripTiming({ id: "b", startDate: d(TRIP_HORIZON_DAYS), endDate: d(TRIP_HORIZON_DAYS + 5) }, NOW), 0.5);
    assert.ok(Math.abs(tripTiming({ id: "c", startDate: d(45), endDate: null }, NOW) - 0.75) < 0.01);
    assert.equal(tripTiming({ id: "d", startDate: d(-9), endDate: d(-2) }, NOW), 0, "ended");
    assert.equal(tripTiming({ id: "e", startDate: d(TRIP_HORIZON_DAYS + 2) }, NOW), 0, "beyond the horizon");
    assert.equal(tripTiming({ id: "f", startDate: null, endDate: null }, NOW), 0, "undated: not a trip context yet");
    for (const status of ["cancelled", "completed", "archived"]) assert.equal(tripTiming({ id: "g", startDate: d(1), status }, NOW), 0, status);
    assert.equal(tripTiming({ id: "h", startDate: d(-1), endDate: d(0), status: "draft" }, NOW), 1, "the last day still counts; a draft is still a plan");
  });

  it("T2 proximity: city scale, bounded, and a city-name fallback", () => {
    const trips = [{ id: "t", startDate: d(-1), endDate: d(4), ...LISBON }];
    const fit = tripFitMap([
      { id: "centre", lat: 38.7223, lng: -9.1393 },
      { id: "belem", lat: 38.6979, lng: -9.2061 },
      { id: "porto", lat: 41.1579, lng: -8.6291 },
      { id: "nocoords" },
    ], trips, { city: "lisbon", nowMs: NOW });
    assert.equal(fit.centre, 1);
    assert.ok(fit.belem > 0.7 && fit.belem < 1);
    assert.equal(fit.porto, undefined, `beyond ${TRIP_RADIUS_KM} km: no fit`);
    assert.equal(fit.nocoords, 0.5, "a place without coords falls back to the city name: the request city IS the trip's");
    const noTripCoords = tripFitMap([{ id: "x" }], [{ id: "t", startDate: d(2), destinationCity: "Lisbon" }], { city: " LISBON ", nowMs: NOW });
    assert.ok(noTripCoords.x > 0.49 && noTripCoords.x <= 0.5, "city fallback: 0.5 × timing");
  });

  it("T3 the loader reads only the viewer's accepted trips", async () => {
    const world = newWorld({ tables: {
      trip_members: [
        { trip_id: "trip-mine", user_id: V, role: "owner" },
        { trip_id: "trip-invited", user_id: V, role: "invited" },
        { trip_id: "trip-other", user_id: "someone", role: "owner" },
      ],
      trips: [
        { id: "trip-mine", status: "active", start_date: d(-1), end_date: d(5), destination_city: "Lisbon", destination_lat: 38.7223, destination_lng: -9.1393, visibility: "private" },
        { id: "trip-invited", status: "active", start_date: d(-1), end_date: d(5), destination_city: "Porto", destination_lat: 41.1579, destination_lng: -8.6291 },
        { id: "trip-other", status: "active", start_date: d(-1), end_date: d(5), destination_city: "Porto", destination_lat: 41.1579, destination_lng: -8.6291 },
      ],
    } });
    const r = await loadTripMatch(worldClient(world), V, [
      { id: "lis", lat: 38.72, lng: -9.14 }, { id: "opo", lat: 41.15, lng: -8.63 },
    ], "lisbon", NOW);
    assert.equal(r.degraded, false);
    assert.equal(r.trips, 1);
    assert.ok(r.tripMatch!.lis > 0.9, "the viewer's own private trip counts — it is their own ranking");
    assert.equal(r.tripMatch!.opo, undefined, "an invitation not accepted, and another person's trip, never count");
  });

  it("T4 no counted trip ⇒ no key; an unreadable layer ⇒ degraded and no key", async () => {
    const empty = await loadTripMatch(worldClient(newWorld({ tables: { trip_members: [], trips: [] } })), V, [{ id: "a", lat: 1, lng: 1 }], null, NOW);
    assert.deepEqual(empty, { tripMatch: null, degraded: false, trips: 0 });
    const w = newWorld({ tables: { trip_members: [{ trip_id: "t", user_id: V, role: "owner" }] } });
    w.errorTables.add("trip_members");
    const broken = await loadTripMatch(worldClient(w), V, [{ id: "a", lat: 1, lng: 1 }], null, NOW);
    assert.deepEqual(broken, { tripMatch: null, degraded: true, trips: 0 });
    const [s] = rankCandidates([{ id: "a", kind: "place" }], { userId: V, nowMs: NOW }, {});
    assert.ok(!("tripMatch" in s.features));
  });

  it("T5 `tripMatch` grounds `trip_match`; every one of the nine codes now has a producer", () => {
    assert.equal(reasonCodeForSignal("tripMatch"), "trip_match");
    assert.deepEqual([...REASON_CODES_WITHOUT_PRODUCER], []);
    const text = explainReasonCode("trip_match");
    assert.equal(typeof text, "string");
    assert.match(text!, /^[A-Z].*[.!]$/);
    assert.ok(!/lisbon|tokyo|\d/i.test(text!), "fixed text — names no destination and no date");
    assert.deepEqual(explainReasons(["tripMatch"]).map((r) => r.code), ["trip_match"]);
  });

  it("T6 the term moves a row", () => {
    const ctx: ViewerContext = { userId: V, nowMs: NOW, tripMatch: { in: 0.8 } };
    const out = rankCandidates([{ id: "out", kind: "place" }, { id: "in", kind: "place" }], ctx, { exploration: false });
    assert.deepEqual(out.map((s) => s.candidate.id), ["in", "out"]);
    assert.equal(out[0].features.tripMatch, TRIP_MATCH_WEIGHT * 0.8);
    assert.equal(out[1].features.tripMatch, 0);
  });
});
