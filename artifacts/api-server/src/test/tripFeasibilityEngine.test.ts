/**
 * Trips §7 — the temporal consistency invariant (census-trips TR128, TR134).
 *
 * The scenario this file exists for, stated first:
 *
 *   An activity starts at 19:00. You must be there by 18:45. Travel plus
 *   preparation make 18:45 unattainable. THE SYSTEM MUST NOT SAY FEASIBLE.
 *
 * That is `the named scenario` below. Everything else is the boundary either
 * side of it and the ways the computation can fail to happen at all — because
 * the second failure mode, an absent travel time silently read as zero, makes
 * every schedule feasible and is worse than the first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFeasibility, checkFeasibility, foldFeasibility,
  FEASIBILITY_VERDICTS,
  type FeasibilityLeg, type FeasibilityTarget,
} from "../services/trips/TripFeasibilityEngine.js";
import {
  straightLineTravelTimeProvider, noRoutedProvider, estimateTravel,
  haversineMeters,
  WALK_METRES_PER_SECOND, DRIVE_METRES_PER_SECOND, DRIVE_WAIT_SECONDS, WALK_MAX_METRES,
  type TravelTimeProvider, type TravelTimeResult,
} from "../services/trips/TravelTimeProvider.js";
import { pointTravelEstimate, isRoutedSourceClass } from "../lib/travelEstimate.js";

const at = (iso: string) => new Date(iso);
const LISBON = { lat: 38.7223, lng: -9.1393 };
const SINTRA = { lat: 38.7979, lng: -9.3907 };   // ~22 km from Lisbon
const MADRID = { lat: 40.4168, lng: -3.7038 };   // ~500 km, different country

/** A travel term of exactly n minutes, from a ROUTED source. */
const routed = (n: number): TravelTimeResult => ({
  kind: "estimate",
  estimate: pointTravelEstimate(n, "LIVE", "HIGH", 0, ["test"], "2026-10-01T17:00:00Z", null),
});
/** A travel term of exactly n minutes from a NON-routed source. */
const flat = (n: number): TravelTimeResult => ({
  kind: "estimate",
  estimate: pointTravelEstimate(n, "STATIC_DEFAULT", "LOW", 3, ["test"]),
});

const target = (o: Partial<FeasibilityTarget> = {}): FeasibilityTarget => ({
  toPlace: SINTRA,
  requiredArrivalAt: at("2026-10-01T18:45:00Z"),
  startsAt: at("2026-10-01T19:00:00Z"),
  prepMinutes: 0,
  latenessToleranceMinutes: 0,
  ...o,
});
const leg = (o: Partial<FeasibilityLeg> = {}): FeasibilityLeg => ({
  departFrom: at("2026-10-01T18:00:00Z"),
  fromPlace: LISBON,
  ...o,
});

describe("§7.2 — the named scenario", () => {
  it("starts 19:00, must arrive 18:45, travel+prep make 18:45 unattainable → NOT feasible", () => {
    // Leave 18:00, 30 min travel, 20 min prep → on the ground at 18:50.
    // Required arrival 18:45. Five minutes late.
    const r = evaluateFeasibility(leg(), target({ prepMinutes: 20 }), routed(30));
    assert.equal(r.verdict, "INFEASIBLE");
    assert.equal(r.slackMinutes, -5);
    assert.notEqual(r.verdict, "FEASIBLE");
    assert.notEqual(r.verdict, "FEASIBLE_UNVERIFIED");
  });

  it("the same schedule judged against startsAt instead would have looked fine — which is why arrival is a distinct field", () => {
    // 18:50 is comfortably before 19:00. §7.1's whole point is that the thing
    // you must not be late for is the ARRIVAL, not the start.
    const r = evaluateFeasibility(leg(), target({ prepMinutes: 20, requiredArrivalAt: null }), routed(30));
    assert.equal(r.verdict, "FEASIBLE");
    assert.equal(r.usedStartAsArrival, true, "the fallback must be reported, not silent");
    assert.equal(r.slackMinutes, 10);
  });
});

describe("§7.2 — the boundary", () => {
  it("arriving exactly on the deadline is FEASIBLE, with zero slack", () => {
    const r = evaluateFeasibility(leg(), target({ prepMinutes: 15 }), routed(30));
    assert.equal(r.slackMinutes, 0);
    assert.equal(r.verdict, "FEASIBLE");
  });

  it("one minute over is INFEASIBLE", () => {
    const r = evaluateFeasibility(leg(), target({ prepMinutes: 16 }), routed(30));
    assert.equal(r.slackMinutes, -1);
    assert.equal(r.verdict, "INFEASIBLE");
  });

  it("one minute under is FEASIBLE", () => {
    const r = evaluateFeasibility(leg(), target({ prepMinutes: 14 }), routed(30));
    assert.equal(r.slackMinutes, 1);
    assert.equal(r.verdict, "FEASIBLE");
  });
});

describe("§7.1 — prep duration and lateness tolerance are separate terms", () => {
  it("prep is added to travel, not to the deadline", () => {
    const noPrep = evaluateFeasibility(leg(), target(), routed(30));
    const withPrep = evaluateFeasibility(leg(), target({ prepMinutes: 10 }), routed(30));
    assert.equal(noPrep.slackMinutes! - withPrep.slackMinutes!, 10);
  });

  it("tolerance moves the deadline and can rescue a late arrival", () => {
    const late = evaluateFeasibility(leg(), target({ prepMinutes: 20 }), routed(30));
    assert.equal(late.verdict, "INFEASIBLE");
    const tolerated = evaluateFeasibility(
      leg(), target({ prepMinutes: 20, latenessToleranceMinutes: 5 }), routed(30));
    assert.equal(tolerated.slackMinutes, 0);
    assert.equal(tolerated.verdict, "FEASIBLE");
  });

  it("tolerance one minute short does not rescue it", () => {
    const r = evaluateFeasibility(
      leg(), target({ prepMinutes: 20, latenessToleranceMinutes: 4 }), routed(30));
    assert.equal(r.verdict, "INFEASIBLE");
  });

  it("a negative duration is refused rather than quietly treated as zero", () => {
    for (const bad of [{ prepMinutes: -1 }, { latenessToleranceMinutes: -1 }]) {
      const r = evaluateFeasibility(leg(), target(bad), routed(1));
      assert.equal(r.verdict, "UNKNOWN");
      assert.equal(r.unknownReason, "MALFORMED_DURATION");
    }
  });
});

describe("UNKNOWN is never SAFE — the failure mode that makes everything feasible", () => {
  const unknowns: ReadonlyArray<readonly [string, TravelTimeResult]> = [
    ["no coordinates", { kind: "unknown", reason: "NO_COORDINATES" }],
    ["no routed provider", { kind: "unknown", reason: "NO_ROUTED_PROVIDER" }],
    ["provider outage", { kind: "unknown", reason: "PROVIDER_UNAVAILABLE" }],
    ["stale estimate", { kind: "unknown", reason: "ESTIMATE_STALE" }],
    ["malformed answer", { kind: "unknown", reason: "PROVIDER_MALFORMED" }],
  ];

  for (const [name, travel] of unknowns) {
    it(`${name} → UNKNOWN, and never FEASIBLE`, () => {
      // The schedule below is generous: an hour of slack. A version that read
      // an absent travel term as zero would return FEASIBLE here.
      const r = evaluateFeasibility(leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), travel);
      assert.equal(r.verdict, "UNKNOWN");
      assert.equal(r.travelMinutes, null, "an unknown travel term must not become a number");
      assert.equal(r.slackMinutes, null, "slack computed from an absent term is fiction");
      assert.equal(r.confidence, "INSUFFICIENT");
      assert.notEqual(r.verdict, "FEASIBLE");
    });
  }

  it("no unknown reason anywhere can produce a positive verdict", () => {
    // Exhaustive over the union rather than the five above, so a reason added
    // later is covered without anyone remembering to add a case.
    const reasons = ["NO_COORDINATES", "NO_ROUTED_PROVIDER", "PROVIDER_UNAVAILABLE",
                     "ESTIMATE_STALE", "PROVIDER_MALFORMED"] as const;
    for (const reason of reasons) {
      const r = evaluateFeasibility(leg(), target(), { kind: "unknown", reason });
      assert.ok(r.verdict === "UNKNOWN",
        `${reason} produced ${r.verdict}; every unknown must stay unknown`);
    }
  });

  it("a deadline that does not exist is UNKNOWN, not feasible", () => {
    const r = evaluateFeasibility(leg(), target({ requiredArrivalAt: null, startsAt: null }), routed(5));
    assert.equal(r.verdict, "UNKNOWN");
    assert.equal(r.unknownReason, "NO_DEADLINE");
  });

  it("a departure time that does not exist is UNKNOWN", () => {
    const r = evaluateFeasibility(leg({ departFrom: new Date(NaN) }), target(), routed(5));
    assert.equal(r.verdict, "UNKNOWN");
    assert.equal(r.unknownReason, "NO_DEPARTURE_TIME");
  });
});

describe("a straight line proves INFEASIBLE and never proves FEASIBLE", () => {
  it("fits against the lower bound → FEASIBLE_UNVERIFIED, not FEASIBLE", () => {
    const r = evaluateFeasibility(leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), flat(30));
    assert.equal(r.verdict, "FEASIBLE_UNVERIFIED");
    assert.equal(r.routed, false);
    assert.notEqual(r.verdict, "FEASIBLE");
  });

  it("fails against the lower bound → INFEASIBLE, and that IS sound", () => {
    // No road is shorter than the great circle, so a real route can only be
    // longer. An infeasibility proved here cannot be overturned by a provider.
    const r = evaluateFeasibility(leg(), target(), flat(120));
    assert.equal(r.verdict, "INFEASIBLE");
  });

  it("a routed source is the only thing that yields FEASIBLE", () => {
    assert.equal(isRoutedSourceClass("LIVE"), true);
    assert.equal(isRoutedSourceClass("HISTORICAL"), true);
    for (const c of ["STATIC_DEFAULT", "AIRPORT_PROFILE", "USER_DECLARED", "", null, undefined]) {
      assert.equal(isRoutedSourceClass(c as never), false,
        `${String(c)} is treated as a route; the fail-closed default is broken`);
    }
  });
});

describe("crossing timezones and DST", () => {
  it("a leg crossing a zone is correct because the comparison is on instants", () => {
    // 18:00 in Lisbon (WEST, UTC+1) to a deadline expressed in Madrid time
    // (CEST, UTC+2). The wall clocks differ by an hour; the instants do not.
    const departLisbon = at("2026-10-01T17:00:00Z");        // 18:00 WEST
    const arriveByMadrid = at("2026-10-01T17:45:00Z");      // 19:45 CEST
    const r = evaluateFeasibility(
      { departFrom: departLisbon, fromPlace: LISBON },
      target({ toPlace: MADRID, requiredArrivalAt: arriveByMadrid, startsAt: null }),
      routed(45));
    assert.equal(r.slackMinutes, 0, "45 minutes of travel into a 45-minute window is exactly on time");
    assert.equal(r.verdict, "FEASIBLE");
  });

  it("a leg spanning the European DST fallback is still measured in real elapsed time", () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET. The wall clock repeats 02:00-03:00,
    // so wall-clock arithmetic would compute 30 minutes for a 90-minute gap.
    const depart = at("2026-10-25T00:30:00Z");   // 02:30 CEST
    const deadline = at("2026-10-25T02:00:00Z"); // 03:00 CET — 90 real minutes later
    const fits = evaluateFeasibility(
      { departFrom: depart, fromPlace: LISBON },
      target({ toPlace: SINTRA, requiredArrivalAt: deadline, startsAt: null }),
      routed(90));
    assert.equal(fits.slackMinutes, 0);
    assert.equal(fits.verdict, "FEASIBLE");

    const over = evaluateFeasibility(
      { departFrom: depart, fromPlace: LISBON },
      target({ toPlace: SINTRA, requiredArrivalAt: deadline, startsAt: null }),
      routed(91));
    assert.equal(over.verdict, "INFEASIBLE",
      "a wall-clock implementation would have found spare hours here");
  });
});

describe("the straight-line adapter", () => {
  it("uses routeOptimizer's own constants, so two modules cannot disagree", () => {
    assert.equal(WALK_METRES_PER_SECOND, 1.25);
    assert.equal(DRIVE_METRES_PER_SECOND, 8.33);
    assert.equal(DRIVE_WAIT_SECONDS, 180);
    assert.equal(WALK_MAX_METRES, 2000);
  });

  it("picks drive over walk beyond the threshold", async () => {
    const near = { lat: LISBON.lat + 0.005, lng: LISBON.lng };   // ~550 m
    const a = await straightLineTravelTimeProvider.estimate({ from: LISBON, to: near, departAt: new Date() });
    assert.equal(a.kind, "estimate");
    assert.ok(haversineMeters(LISBON, near) < WALK_MAX_METRES);

    const b = await straightLineTravelTimeProvider.estimate({ from: LISBON, to: SINTRA, departAt: new Date() });
    assert.equal(b.kind, "estimate");
    if (a.kind === "estimate" && b.kind === "estimate") {
      // ~22 km driven is far more than ~550 m walked, and both are lower bounds.
      assert.ok(b.estimate.minutes > a.estimate.minutes);
    }
  });

  it("is the FASTEST mode, so it is a lower bound at every distance: a 1.9 km hop is a taxi's 7 minutes, not a walk's 26", async () => {
    const near = { lat: LISBON.lat + 0.0171, lng: LISBON.lng };   // ~1.9 km
    const m = haversineMeters(LISBON, near);
    assert.ok(m > 1800 && m < WALK_MAX_METRES, `${m} m`);
    const r = await straightLineTravelTimeProvider.estimate({ from: LISBON, to: near, departAt: new Date() });
    assert.equal(r.kind, "estimate");
    if (r.kind === "estimate") {
      assert.equal(r.estimate.minutes, Math.ceil((m / DRIVE_METRES_PER_SECOND + DRIVE_WAIT_SECONDS) / 60));
      assert.ok(r.estimate.minutes < Math.ceil(m / WALK_METRES_PER_SECOND / 60));
    }
    // An explicitly requested mode is a policy, not a bound, and is honoured.
    const walked = await straightLineTravelTimeProvider.estimate({ from: LISBON, to: near, departAt: new Date(), mode: "walk" });
    if (walked.kind === "estimate") assert.equal(walked.estimate.minutes, Math.ceil(m / WALK_METRES_PER_SECOND / 60));
  });

  it("is subadditive: going via a third point is never faster than the direct line (what §22.4's property needs)", async () => {
    const at = (dLat: number, dLng: number) => ({ lat: LISBON.lat + dLat, lng: LISBON.lng + dLng });
    const mins = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
      const r = await straightLineTravelTimeProvider.estimate({ from, to, departAt: new Date() });
      return r.kind === "estimate" ? r.estimate.minutes : Number.NaN;
    };
    for (const [b, via] of [
      [at(0.018, 0), at(0.017, 0.001)],       // the case that broke: 2001 m via a point 1 m short of the direct 2000 m
      [at(0.002, 0), at(0.001, 0.0005)],      // all walking
      [at(0.2, 0.1), at(0.1, 0.05)],          // all driving
      [at(0.003, 0), at(0.0015, 0.002)],      // walk + drive mix
    ] as const) {
      const direct = await mins(LISBON, b);
      const detour = (await mins(LISBON, via)) + (await mins(via, b));
      assert.ok(detour >= direct, `detour ${detour} < direct ${direct}`);
    }
  });

  it("never claims to be routed, whatever the distance", async () => {
    for (const to of [SINTRA, MADRID, { lat: LISBON.lat + 0.001, lng: LISBON.lng }]) {
      const r = await straightLineTravelTimeProvider.estimate({ from: LISBON, to, departAt: new Date() });
      assert.equal(r.kind, "estimate");
      if (r.kind === "estimate") {
        assert.equal(r.estimate.sourceClass, "STATIC_DEFAULT");
        assert.equal(isRoutedSourceClass(r.estimate.sourceClass), false);
        assert.equal(r.estimate.fallbackLevel, 3);
      }
    }
  });

  it("a missing coordinate is NO_COORDINATES, not a zero-length hop", async () => {
    for (const q of [{ from: null, to: SINTRA }, { from: LISBON, to: null }, { from: null, to: null }]) {
      const r = await straightLineTravelTimeProvider.estimate({ ...q, departAt: new Date() });
      assert.equal(r.kind, "unknown");
      if (r.kind === "unknown") assert.equal(r.reason, "NO_COORDINATES");
    }
  });

  it("a non-finite coordinate is malformed, not NaN minutes", async () => {
    const r = await straightLineTravelTimeProvider.estimate(
      { from: { lat: NaN, lng: 0 }, to: SINTRA, departAt: new Date() });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("a long-distance hop is enormous rather than absent — the airport case", async () => {
    const r = await straightLineTravelTimeProvider.estimate({ from: LISBON, to: MADRID, departAt: new Date() });
    assert.equal(r.kind, "estimate");
    if (r.kind === "estimate") {
      // ~500 km at the drive speed is ~17 hours. That is the RIGHT answer for a
      // ground route and the reason an airport hop needs a real provider: this
      // will correctly refuse a same-day plan that a flight would make possible.
      assert.ok(r.estimate.minutes > 600,
        `Lisbon->Madrid came back as ${r.estimate.minutes} minutes by road`);
    }
  });
});

describe("provider failure modes", () => {
  it("a provider that throws is PROVIDER_UNAVAILABLE, never an absent term", async () => {
    const boom: TravelTimeProvider = {
      id: "boom", routed: true,
      async estimate() { throw new Error("connect ETIMEDOUT"); },
    };
    const r = await estimateTravel(boom, { from: LISBON, to: SINTRA, departAt: new Date() });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") {
      assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
      assert.match(r.detail ?? "", /ETIMEDOUT/);
    }
  });

  it("a provider that returns nonsense is PROVIDER_MALFORMED", async () => {
    const junk = { id: "junk", routed: true, estimate: async () => ({ nope: true }) } as unknown as TravelTimeProvider;
    const r = await estimateTravel(junk, { from: LISBON, to: SINTRA, departAt: new Date() });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("an expired estimate is ESTIMATE_STALE, not used", async () => {
    const stale: TravelTimeProvider = {
      id: "stale", routed: true,
      async estimate() {
        return { kind: "estimate",
                 estimate: pointTravelEstimate(5, "LIVE", "HIGH", 0, ["t"],
                   "2026-10-01T10:00:00Z", "2026-10-01T10:05:00Z") };
      },
    };
    const r = await estimateTravel(stale, { from: LISBON, to: SINTRA, departAt: new Date() },
                                   at("2026-10-01T12:00:00Z"));
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "ESTIMATE_STALE");
  });

  it("an estimate still inside its window is used", async () => {
    const fresh: TravelTimeProvider = {
      id: "fresh", routed: true,
      async estimate() {
        return { kind: "estimate",
                 estimate: pointTravelEstimate(5, "LIVE", "HIGH", 0, ["t"],
                   "2026-10-01T10:00:00Z", "2026-10-01T14:00:00Z") };
      },
    };
    const r = await estimateTravel(fresh, { from: LISBON, to: SINTRA, departAt: new Date() },
                                   at("2026-10-01T12:00:00Z"));
    assert.equal(r.kind, "estimate");
  });

  it("a constant with no expiry never goes stale", async () => {
    const r = await estimateTravel(straightLineTravelTimeProvider,
      { from: LISBON, to: SINTRA, departAt: new Date() }, at("2099-01-01T00:00:00Z"));
    assert.equal(r.kind, "estimate");
  });

  it("the absent routed provider is a value, not a null anyone has to check", async () => {
    const r = await estimateTravel(noRoutedProvider, { from: LISBON, to: SINTRA, departAt: new Date() });
    assert.equal(r.kind, "unknown");
    if (r.kind === "unknown") assert.equal(r.reason, "NO_ROUTED_PROVIDER");
    const f = await checkFeasibility(noRoutedProvider, leg(), target());
    assert.equal(f.verdict, "UNKNOWN");
  });
});

describe("confidence degrades and never improves", () => {
  it("a non-routed term caps confidence at LOW however sure the provider claims to be", () => {
    const overconfident: TravelTimeResult = {
      kind: "estimate",
      estimate: pointTravelEstimate(5, "STATIC_DEFAULT", "HIGH", 3, ["t"]),
    };
    const r = evaluateFeasibility(leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), overconfident);
    assert.equal(r.confidence, "LOW");
  });

  it("a routed term keeps the provider's own confidence when it is the weaker", () => {
    const cautious: TravelTimeResult = {
      kind: "estimate",
      estimate: pointTravelEstimate(5, "LIVE", "MEDIUM", 0, ["t"]),
    };
    const r = evaluateFeasibility(leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), cautious);
    assert.equal(r.confidence, "MEDIUM");
  });
});

describe("folding a whole itinerary", () => {
  const ok = () => evaluateFeasibility(leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), routed(5));
  const bad = () => evaluateFeasibility(leg(), target({ prepMinutes: 20 }), routed(30));
  const unk = () => evaluateFeasibility(leg(), target(), { kind: "unknown", reason: "NO_COORDINATES" });

  it("one impossible hop makes the day impossible", () => {
    const f = foldFeasibility([ok(), ok(), bad(), ok()]);
    assert.equal(f.verdict, "INFEASIBLE");
    assert.equal(f.offendingIndex, 2, "the fold must name which hop failed");
  });

  it("one unknown hop makes the day unknown, not feasible", () => {
    const f = foldFeasibility([ok(), unk(), ok()]);
    assert.equal(f.verdict, "UNKNOWN");
    assert.equal(f.confidence, "INSUFFICIENT");
  });

  it("infeasible beats unknown: a proven failure is more actionable than an absence", () => {
    const f = foldFeasibility([unk(), bad()]);
    assert.equal(f.verdict, "INFEASIBLE");
  });

  it("an unverified hop drags an otherwise routed day down", () => {
    const unverified = evaluateFeasibility(
      leg(), target({ requiredArrivalAt: at("2026-10-01T23:00:00Z") }), flat(5));
    const f = foldFeasibility([ok(), unverified]);
    assert.equal(f.verdict, "FEASIBLE_UNVERIFIED");
  });

  it("an empty itinerary is UNKNOWN, because nothing was checked", () => {
    const f = foldFeasibility([]);
    assert.equal(f.verdict, "UNKNOWN");
    assert.notEqual(f.verdict, "FEASIBLE");
  });

  it("the verdict order puts every non-positive answer before FEASIBLE", () => {
    // A consumer testing `verdict !== "FEASIBLE"` must catch UNKNOWN. This
    // pins the order that makes that true.
    assert.deepEqual([...FEASIBILITY_VERDICTS],
      ["INFEASIBLE", "UNKNOWN", "FEASIBLE_UNVERIFIED", "FEASIBLE"]);
  });
});

describe("overlapping commitments", () => {
  it("a commitment that starts before the previous one ends is INFEASIBLE even with no travel at all", () => {
    // Zero travel, zero prep, and the deadline is in the past relative to the
    // departure. Overlap is the degenerate case of the same invariant.
    const r = evaluateFeasibility(
      { departFrom: at("2026-10-01T19:00:00Z"), fromPlace: LISBON },
      target({ toPlace: LISBON, requiredArrivalAt: at("2026-10-01T18:30:00Z"), startsAt: null }),
      routed(0));
    assert.equal(r.verdict, "INFEASIBLE");
    assert.equal(r.slackMinutes, -30);
  });

  it("back-to-back at the same place with no travel is exactly feasible", () => {
    const r = evaluateFeasibility(
      { departFrom: at("2026-10-01T19:00:00Z"), fromPlace: LISBON },
      target({ toPlace: LISBON, requiredArrivalAt: at("2026-10-01T19:00:00Z"), startsAt: null }),
      routed(0));
    assert.equal(r.slackMinutes, 0);
    assert.equal(r.verdict, "FEASIBLE");
  });
});
