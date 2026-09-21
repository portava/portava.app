/**
 * Trips spec §14.2 — "route chains carry … future-time traffic/transit
 * assumptions" — census-trips TR267.
 *
 *   1. the band table: a weekday commute hour is PEAK, a weekend has none,
 *      the small hours are NIGHT, in the trip's own zone;
 *   2. every factor is ≥ 1 — an assumption never shortens a bound;
 *   3. the wrapper leaves the inner estimate UNTOUCHED and adds the
 *      assumption beside it; a routed inner is passed through with nothing
 *      assumed; an unknown result is passed through as it is;
 *   4. through the real freedom projection: windows and conflicts are judged
 *      on the bound exactly as before, and each arrival estimate now carries
 *      an expected arrival at or after the bound with the band named.
 *
 * Run: node --import tsx/esm --test src/test/tripDepartureAssumptions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEPARTURE_BANDS, DEPARTURE_FACTORS, DEPARTURE_ASSUMPTIONS_MODEL,
  assumeDeparture, departureBand, withDepartureAssumptions,
} from "../domain/trips/services/TripDepartureAssumptions.js";
import {
  straightLineTravelTimeProvider, noRoutedProvider, estimateTravel,
  type TravelTimeProvider, type TravelTimeResult,
} from "../domain/trips/contracts/TravelTimeProvider.js";
import { pointTravelEstimate } from "../lib/travelEstimate.js";
import { buildTripFreedomProjection } from "../domain/trips/projections/TripFreedomProjection.js";
import { TRIP_ENGINE_VERSIONS } from "../domain/trips/services/TripDecisionLedger.js";
import { makeClient, base } from "./tripHealthProjection.test.js";

const TRIP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LISBON = { lat: 38.7223, lng: -9.1393 };
const PORTO = { lat: 41.1579, lng: -8.6291 };

describe("§14.2 the band table", () => {
  it("a Tuesday 08:00 in Paris is PEAK; Saturday 08:00 is not; 03:00 is NIGHT — read in the trip's zone", () => {
    // 2026-09-15 is a Tuesday. 06:00Z is 08:00 in Paris (CEST).
    const tue = assumeDeparture(new Date("2026-09-15T06:00:00Z"), "Europe/Paris", "drive");
    assert.equal(tue.localHour, 8); assert.equal(tue.weekend, false); assert.equal(tue.band, "PEAK");
    assert.equal(tue.timezone, "Europe/Paris"); assert.equal(tue.timezoneAssumed, false);
    // 2026-09-19 is a Saturday.
    const sat = assumeDeparture(new Date("2026-09-19T06:00:00Z"), "Europe/Paris", "drive");
    assert.equal(sat.weekend, true); assert.notEqual(sat.band, "PEAK");
    const night = assumeDeparture(new Date("2026-09-15T01:00:00Z"), "Europe/Paris", "transit");
    assert.equal(night.localHour, 3); assert.equal(night.band, "NIGHT");
    assert.equal(night.transitServiceLikely, false, "transit at night: a service may not run");
    assert.match(night.detail, /may not run/);
  });
  it("no timezone: judged in UTC, and the assumption says so", () => {
    const a = assumeDeparture(new Date("2026-09-15T08:30:00Z"), null, "drive");
    assert.equal(a.timezone, "UTC"); assert.equal(a.timezoneAssumed, true); assert.equal(a.localHour, 8);
    assert.match(a.detail, /declared no timezone/);
    const b = assumeDeparture(new Date("2026-09-15T08:30:00Z"), "Not/AZone", "drive");
    assert.equal(b.timezoneAssumed, true);
  });
  it("the table is total and monotone in the direction a bound needs: every factor ≥ 1, night drive is free-flow", () => {
    for (const mode of ["drive", "transit", "walk"] as const) {
      for (const band of DEPARTURE_BANDS) assert.ok(DEPARTURE_FACTORS[mode][band] >= 1, `${mode}/${band}`);
    }
    assert.equal(DEPARTURE_FACTORS.drive.NIGHT, 1.0);
    assert.equal(DEPARTURE_FACTORS.drive.PEAK > DEPARTURE_FACTORS.drive.OFF_PEAK, true);
    for (let h = 0; h < 24; h += 1) {
      assert.ok(DEPARTURE_BANDS.includes(departureBand(h, false)));
      assert.ok(DEPARTURE_BANDS.includes(departureBand(h, true)));
      assert.notEqual(departureBand(h, true), "PEAK", "weekends have no commute peak");
    }
  });
  it("mode unknown takes the drive table (the fastest-mode bound is a drive); walking is never slowed", () => {
    const at = new Date("2026-09-15T06:00:00Z");
    assert.equal(assumeDeparture(at, "Europe/Paris", undefined).factor, DEPARTURE_FACTORS.drive.PEAK);
    assert.equal(assumeDeparture(at, "Europe/Paris", "unknown").mode, "unknown");
    assert.equal(assumeDeparture(at, "Europe/Paris", "walk").factor, 1);
    assert.equal(assumeDeparture(at, "Europe/Paris", "walk").sourceClass, "STATIC_DEFAULT");
    assert.equal(assumeDeparture(at, "Europe/Paris", "walk").confidence, "LOW");
  });
});

describe("the wrapper: the bound is untouched, the assumption rides beside it", () => {
  it("same minutes, same percentiles, same source class as the inner; expectedMinutes = ceil(bound × factor) ≥ bound", async () => {
    const q = { from: LISBON, to: PORTO, departAt: new Date("2026-09-15T06:00:00Z"), mode: "drive" as const };
    const plain = await straightLineTravelTimeProvider.estimate(q);
    const wrapped = withDepartureAssumptions(straightLineTravelTimeProvider, "Europe/Lisbon");
    assert.equal(wrapped.id, "straight-line"); assert.equal(wrapped.routed, false);
    assert.equal(wrapped.assumptionsModel, DEPARTURE_ASSUMPTIONS_MODEL);
    const r = await wrapped.estimate(q);
    assert.ok(plain.kind === "estimate" && r.kind === "estimate");
    assert.deepEqual(r.estimate, plain.estimate, "the bound is byte-identical");
    assert.ok(r.assumption); assert.equal(r.assumption!.band, "PEAK");
    assert.equal(r.expectedMinutes, Math.ceil(plain.estimate.minutes * DEPARTURE_FACTORS.drive.PEAK));
    assert.ok(r.expectedMinutes! >= r.estimate.minutes);
    // estimateTravel (the safe caller) preserves the extra fields.
    const via = await estimateTravel(wrapped, q, new Date("2026-09-15T05:00:00Z"));
    assert.ok(via.kind === "estimate"); assert.equal(via.assumption?.band, "PEAK");
  });
  it("a routed inner is passed through with nothing assumed (it answered for the departure it was given)", async () => {
    const routed: TravelTimeProvider = {
      id: "fake-routed", routed: true,
      async estimate(): Promise<TravelTimeResult> {
        return { kind: "estimate", estimate: pointTravelEstimate(40, "LIVE", "HIGH", 0, ["fake"], "2026-09-15T05:00:00Z", "2026-09-15T05:30:00Z") };
      },
    };
    const w = withDepartureAssumptions(routed, "Europe/Lisbon");
    const r = await w.estimate({ from: LISBON, to: PORTO, departAt: new Date("2026-09-15T06:00:00Z") });
    assert.ok(r.kind === "estimate");
    assert.equal(r.assumption, null); assert.equal(r.expectedMinutes, 40); assert.equal(w.routed, true);
  });
  it("an unknown result is passed through unchanged", async () => {
    const w = withDepartureAssumptions(noRoutedProvider, "Europe/Lisbon");
    const r = await w.estimate({ from: LISBON, to: PORTO, departAt: new Date() });
    assert.deepEqual(r, { kind: "unknown", reason: "NO_ROUTED_PROVIDER" });
    const w2 = withDepartureAssumptions(straightLineTravelTimeProvider, "Europe/Lisbon");
    const r2 = await w2.estimate({ from: null, to: PORTO, departAt: new Date() });
    assert.deepEqual(r2, { kind: "unknown", reason: "NO_COORDINATES" });
  });
});

describe("through the freedom projection: the bound decides, the assumption is carried", () => {
  it("each arrival estimate carries expectedArrivalAt ≥ estimatedArrivalAt with the band; windows and conflicts are the bound's", async () => {
    const tables = base();
    const before = await buildTripFreedomProjection(makeClient(tables) as any, TRIP_ID, { now: new Date("2026-09-13T12:00:00Z") });
    assert.ok(before.ok);
    const p = before.projection;
    assert.equal(p.provider.id, "straight-line");
    assert.equal(p.provider.assumptionsModel, DEPARTURE_ASSUMPTIONS_MODEL);
    assert.equal(p.arrivalEstimates.length, 1);
    const a = p.arrivalEstimates[0]!;
    assert.ok(a.assumption, "the hop carries its assumption");
    // The fixture's hop departs 10:00Z on 2026-09-13 (a Sunday), Europe/Paris → 12:00 local, weekend.
    assert.equal(a.assumption!.timezone, "Europe/Paris");
    assert.equal(a.assumption!.weekend, true);
    assert.equal(a.assumption!.localHour, 12);
    assert.equal(a.assumption!.sourceClass, "STATIC_DEFAULT");
    assert.ok(a.expectedTravelMinutes! >= a.travelMinutes!, "expected never below the bound");
    assert.ok(Date.parse(a.expectedArrivalAt!) >= Date.parse(a.estimatedArrivalAt!));
    assert.equal(a.expectedTravelMinutes, Math.max(a.travelMinutes!, Math.ceil(a.travelMinutes! * a.assumption!.factor)));
    // The bound is what the windows are judged on: the between-window's reserved minutes equal the bound + prep, not the expected term.
    const between = p.windows.find((w) => w.position === "between");
    assert.ok(between);
    assert.equal(between!.reservedMinutes, a.travelMinutes);
    // The ledger names the assumption engine and says the bound alone decides.
    assert.ok(TRIP_ENGINE_VERSIONS.TripDepartureAssumptions);
  });
  it("a trip without a timezone is judged in UTC and the assumption says so", async () => {
    const tables = base();
    tables.trips = tables.trips!.map((t) => ({ ...t, timezone: null }));
    const r = await buildTripFreedomProjection(makeClient(tables) as any, TRIP_ID, { now: new Date("2026-09-13T12:00:00Z") });
    assert.ok(r.ok);
    const a = r.projection.arrivalEstimates[0]!;
    assert.equal(a.assumption!.timezone, "UTC"); assert.equal(a.assumption!.timezoneAssumed, true);
    assert.equal(a.assumption!.localHour, 10);
  });
});
