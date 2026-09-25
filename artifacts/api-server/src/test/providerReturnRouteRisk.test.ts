/**
 * Return-route risk — the input for census-layover L282
 * (`RETURN_ROUTE_UNRELIABLE`) and the §8 risk terms L68, L69, L70, L71.
 *
 * The properties that matter here are about the THIRD ANSWER. This code's job
 * is to raise a warning, so every place an unknown could be quietly resolved to
 * "fine" is a place a traveller stops being warned, and the suite asserts that
 * `null` survives rather than collapsing to `false`.
 *
 * The clock is an argument everywhere, so nothing in this file can rot.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RETURN_RISK_POLICY,
  RETURN_RISK_FACTORS,
  assessBidirectionalReturnRisk,
  assessReturnRisk,
  corridorsWereEvaluatedIndependently,
  returnRiskFacts,
} from "../lib/providers/returnRouteRisk.js";
import {
  measured,
  transferCountOf,
  unmeasured,
  type LegInterruptibility,
  type RouteCorridor,
  type RouteLeg,
  type RouteOption,
} from "../lib/providers/routeCorridorProvider.js";

const A = { lat: 51.47, lng: -0.4543 };
const B = { lat: 51.5074, lng: -0.1278 };
const OUT_AT = "2030-06-01T11:00:00.000Z";
const BACK_AT = "2030-06-01T16:30:00.000Z";
const NOW = Date.parse("2030-06-01T16:00:00.000Z");

function leg(over: Partial<RouteLeg> = {}): RouteLeg {
  return {
    mode: "transit",
    minutes: 30,
    distanceMeters: 20000,
    interruptibility: "interruptible",
    transferPointId: null,
    ...over,
  };
}

function option(legs: RouteLeg[], totalMinutes: number): RouteOption {
  return { legs, totalMinutes, transferCount: transferCountOf(legs) };
}

function corridor(over: Partial<RouteCorridor> = {}): RouteCorridor {
  return {
    from: B,
    to: A,
    departAt: BACK_AT,
    routes: [option([leg()], 30)],
    independentRouteCount: 1,
    reliability: measured({ spreadMinutes: 0, optionCount: 1 }, "LIVE", "MEDIUM", ["t"]),
    queueFriction: unmeasured("no queue feed"),
    weather: unmeasured("no weather provider"),
    airportReentryMinutes: unmeasured("not modelled"),
    observedAt: "2030-06-01T15:58:00.000Z",
    expiresAt: "2030-06-01T16:03:00.000Z",
    sourceClass: "LIVE",
    confidence: "MEDIUM",
    sourceRefs: ["t"],
    ...over,
  };
}

// ── facts ────────────────────────────────────────────────────────────────────

describe("the facts are measurements, with no threshold in them", () => {
  it("reads independence, transfers, interruptibility and the return instant", () => {
    const c = corridor({
      routes: [
        option([leg({ mode: "transit" }), leg({ mode: "walk" }), leg({ mode: "transit" })], 40),
        option([leg()], 55),
      ],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 15, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    const f = returnRiskFacts(c, NOW)!;
    assert.equal(f.independentReturnRoutes, 2);
    assert.equal(f.offeredReturnRoutes, 2);
    assert.equal(f.minTransferCount, 0);
    assert.equal(f.maxTransferCount, 1);
    assert.equal(f.spreadMinutes, 15);
    assert.equal(f.bestReturnMinutes, 40);
    assert.equal(f.returnEvaluatedFor, BACK_AT, "L72 — the facts name the instant they are about");
    assert.equal(f.stale, false);
  });

  it("carries the three unmeasured signals rather than scoring them zero", () => {
    const f = returnRiskFacts(corridor(), NOW)!;
    assert.deepEqual(f.unmeasured.map((u) => u.signal).sort(), [
      "airportReentryMinutes",
      "queueFriction",
      "weather",
    ]);
  });

  it("reports null spread when the corridor could not measure reliability", () => {
    const f = returnRiskFacts(corridor({ reliability: unmeasured("single route") }), NOW)!;
    assert.equal(f.spreadMinutes, null, "an unmeasured spread is not a spread of zero");
  });

  it("returns null for a corridor with no routes rather than an assessment built on undefined", () => {
    assert.equal(returnRiskFacts(corridor({ routes: [] }), NOW), null);
    assert.equal(assessReturnRisk(corridor({ routes: [] }), NOW), null);
  });

  it("the all-routes interruptibility is the weakest link across every route", () => {
    const c = corridor({
      routes: [
        option([leg({ interruptibility: "interruptible" })], 30),
        option([leg({ interruptibility: "committed" })], 40),
      ],
      independentRouteCount: 2,
    });
    const f = returnRiskFacts(c, NOW)!;
    assert.equal(f.bestRouteInterruptibility, "interruptible");
    assert.equal(f.allRoutesInterruptibility, "committed");
  });
});

// ── L69 / L282 ───────────────────────────────────────────────────────────────

describe("L69/L282 — a sole committed way back is unreliable", () => {
  function assess(over: Partial<RouteCorridor> = {}, now = NOW) {
    return assessReturnRisk(corridor(over), now)!;
  }

  it("one independent route on committed transport flags both", () => {
    const r = assess({
      routes: [option([leg({ interruptibility: "committed" })], 30)],
      independentRouteCount: 1,
    });
    assert.equal(r.fragileCorridor, true);
    assert.equal(r.returnRouteUnreliable, true);
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.NO_INDEPENDENT_ALTERNATIVE));
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.COMMITTED_TRANSPORT));
  });

  it("one route that IS interruptible is fragile but not, by that alone, unreliable", () => {
    const r = assess({
      routes: [option([leg({ mode: "walk", interruptibility: "interruptible" })], 25)],
      independentRouteCount: 1,
    });
    assert.equal(r.fragileCorridor, true);
    assert.equal(r.returnRouteUnreliable, false, "a walk you can turn round on is a recoverable single route");
  });

  it("two independent interruptible routes are neither fragile nor unreliable", () => {
    const r = assess({
      routes: [
        option([leg({ interruptibility: "interruptible", transferPointId: "X" })], 30),
        option([leg({ interruptibility: "interruptible", transferPointId: "Y" })], 34),
      ],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 4, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    assert.equal(r.fragileCorridor, false);
    assert.equal(r.returnRouteUnreliable, false);
    assert.deepEqual(r.contributingFactors, []);
  });

  it("fragility is judged on INDEPENDENT routes, not on how many were offered", () => {
    // This is the whole of L68. Two committed ways back that both funnel
    // through Paddington are two options and one failure point; counting the
    // options would tell a traveller they have a fallback they do not have.
    const r = assess({
      routes: [
        option([leg({ interruptibility: "committed", transferPointId: "Paddington" })], 30),
        option([leg({ interruptibility: "committed", transferPointId: "Paddington" })], 36),
      ],
      independentRouteCount: 1,
      reliability: measured({ spreadMinutes: 6, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    assert.equal(r.facts.offeredReturnRoutes, 2);
    assert.equal(r.facts.independentReturnRoutes, 1);
    assert.equal(r.fragileCorridor, true, "two routes through one interchange is one corridor");
    assert.equal(r.returnRouteUnreliable, true);
  });

  it("an UNKNOWN interruptibility is recorded as a factor AND folded cautiously by default", () => {
    // The fold is towards the warning, and only for the judgement. The FACT
    // stays unknown so a consumer can always see the unknown was there.
    const r = assess({
      routes: [option([leg({ interruptibility: "unknown" })], 30)],
      independentRouteCount: 1,
    });
    assert.equal(r.facts.bestRouteInterruptibility, "unknown", "the fact must not be rewritten");
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.INTERRUPTIBILITY_UNKNOWN));
    assert.equal(r.returnRouteUnreliable, true, "silence on a corridor nobody could check is the worse error");
  });

  it("a policy may decline that fold, and then the unknown does not flag", () => {
    const r = assessReturnRisk(
      corridor({ routes: [option([leg({ interruptibility: "unknown" })], 30)], independentRouteCount: 1 }),
      NOW,
      { ...DEFAULT_RETURN_RISK_POLICY, treatUnknownInterruptibilityAsCommitted: false },
    )!;
    assert.equal(r.returnRouteUnreliable, false);
    assert.ok(
      r.contributingFactors.includes(RETURN_RISK_FACTORS.INTERRUPTIBILITY_UNKNOWN),
      "the factor is still recorded even when the policy does not act on it",
    );
  });

  it("a wide spread between ways back is unreliable on its own", () => {
    const r = assess({
      routes: [
        option([leg({ interruptibility: "interruptible", transferPointId: "X" })], 20),
        option([leg({ interruptibility: "interruptible", transferPointId: "Y" })], 45),
      ],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 25, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.WIDE_SPREAD));
    assert.equal(r.returnRouteUnreliable, true);
  });

  it("the spread threshold is relative, so it means the same at any scale", () => {
    // 10 minutes over a 20-minute best is wide; 10 over a 90-minute best is not.
    const wide = assess({
      routes: [option([leg({ transferPointId: "X" })], 20), option([leg({ transferPointId: "Y" })], 31)],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 11, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    const narrow = assess({
      routes: [option([leg({ transferPointId: "X" })], 90), option([leg({ transferPointId: "Y" })], 101)],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 11, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    assert.ok(wide.contributingFactors.includes(RETURN_RISK_FACTORS.WIDE_SPREAD));
    assert.equal(narrow.contributingFactors.includes(RETURN_RISK_FACTORS.WIDE_SPREAD), false);
  });

  it("L71 — two or more transfers on every way back is unreliable", () => {
    const three = [leg({ mode: "transit" }), leg({ mode: "transit" }), leg({ mode: "transit" })];
    const r = assess({
      routes: [option(three, 50), option(three, 55)],
      independentRouteCount: 2,
      reliability: measured({ spreadMinutes: 5, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    });
    assert.equal(r.facts.minTransferCount, 2);
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.MANY_TRANSFERS));
    assert.equal(r.returnRouteUnreliable, true);
  });
});

// ── staleness ────────────────────────────────────────────────────────────────

describe("L73 — a stale corridor cannot support the judgement in EITHER direction", () => {
  const stale = { expiresAt: "2030-06-01T15:00:00.000Z" };

  it("answers null rather than true or false", () => {
    const r = assessReturnRisk(corridor(stale), NOW)!;
    assert.equal(r.facts.stale, true);
    assert.equal(r.returnRouteUnreliable, null, "'unreliable an hour ago' is not a claim about now");
    assert.equal(r.fragileCorridor, null);
    assert.notEqual(r.returnRouteUnreliable, false);
  });

  it("records the staleness as a factor and drops confidence to INSUFFICIENT", () => {
    const r = assessReturnRisk(corridor(stale), NOW)!;
    assert.ok(r.contributingFactors.includes(RETURN_RISK_FACTORS.STALE_CORRIDOR));
    assert.equal(r.confidence, "INSUFFICIENT");
  });

  it("an unparseable expiry is stale too", () => {
    const r = assessReturnRisk(corridor({ expiresAt: "shortly" }), NOW)!;
    assert.equal(r.returnRouteUnreliable, null);
  });
});

// ── confidence ───────────────────────────────────────────────────────────────

describe("the judgement's confidence is never better than the corridor's", () => {
  it("is capped at MEDIUM even when the corridor is HIGH — this rests on two of five signals", () => {
    const r = assessReturnRisk(
      corridor({ confidence: "HIGH", reliability: measured({ spreadMinutes: 0, optionCount: 1 }, "LIVE", "HIGH", ["t"]) }),
      NOW,
    )!;
    assert.equal(r.confidence, "MEDIUM");
  });

  it("inherits a worse corridor confidence rather than overriding it", () => {
    const r = assessReturnRisk(
      corridor({ confidence: "LOW", reliability: measured({ spreadMinutes: 0, optionCount: 1 }, "LIVE", "LOW", ["t"]) }),
      NOW,
    )!;
    assert.equal(r.confidence, "LOW");
  });
});

// ── L60 / L72 diagnostic ─────────────────────────────────────────────────────

describe("L60/L72 — the symmetry diagnostic", () => {
  it("two corridors computed for two instants were evaluated independently", () => {
    const c = { outbound: corridor({ from: A, to: B, departAt: OUT_AT }), returnLeg: corridor() };
    assert.equal(corridorsWereEvaluatedIndependently(c), true);
  });

  it("two corridors computed for the SAME instant are a symmetry assumption, not a round trip", () => {
    // This is what `travelTimeMin * 2` looks like once it is wearing a
    // bidirectional shape, and it must be detectable.
    const c = { outbound: corridor({ from: A, to: B, departAt: BACK_AT }), returnLeg: corridor() };
    assert.equal(corridorsWereEvaluatedIndependently(c), false);
  });

  it("the bidirectional assessment reads the RETURN half, not the outbound", () => {
    // A fragile outbound costs a nice afternoon; a fragile return costs a flight.
    const c = {
      outbound: corridor({
        from: A,
        to: B,
        departAt: OUT_AT,
        routes: [option([leg({ interruptibility: "committed" })], 30)],
        independentRouteCount: 1,
      }),
      returnLeg: corridor({
        routes: [
          option([leg({ interruptibility: "interruptible", transferPointId: "X" })], 30),
          option([leg({ interruptibility: "interruptible", transferPointId: "Y" })], 33),
        ],
        independentRouteCount: 2,
        reliability: measured({ spreadMinutes: 3, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
      }),
    };
    const r = assessBidirectionalReturnRisk(c, NOW)!;
    assert.equal(r.returnRouteUnreliable, false, "the outbound's fragility must not leak into the return signal");
    assert.equal(r.facts.independentReturnRoutes, 2);
  });
});
