/**
 * The route model is WIRED — census-layover L60, L68, L69, L70, L71, L282.
 *
 * node:test + node:assert (NOT vitest). No network, no database, no
 * `process.env` mutation: every gate is proved through an injected `readEnv`,
 * because `process.env` is shared across the whole `--test` process and is how
 * one suite silently changes another's behaviour.
 *
 * ── WHAT WAS RED BEFORE THIS LANE ────────────────────────────────────────────
 * `routeCorridorProvider.ts`, `returnRouteRisk.ts` and
 * `googleRoutesCorridorProvider.ts` existed, were tested, and were imported by
 * nothing outside their own tests:
 *
 *     grep -rn "routeCorridorProvider\|returnRouteRisk" src/services/airport/ src/routes/
 *     (no output)
 *
 * so on L276's precedent the capability was NOT BUILT: a requirement is about
 * what a traveller meets, and nothing a traveller's request touched could
 * reach any of it. Every assertion below is about a path from the layover
 * surface INTO that model. Against the unchanged tree the whole file failed to
 * load — `corridorTravelTimeAdapter.ts` did not exist — and with the adapter
 * present but the seam still `= noRoutedProvider`, the first assertion to go
 * red was the one below at "the wired provider still refuses exactly as it
 * did", with the message:
 *
 *     expected the corridor adapter, got none-configured
 *
 * `.routed` was NOT the first to fail, and that is the point of asserting the
 * id as well: `noRoutedProvider` declares itself routed and answers nothing, so
 * the flag alone cannot tell a wired adapter from the stand-in.
 *
 * ── WHAT MUST NOT MOVE ───────────────────────────────────────────────────────
 * Production behaviour. The corridor provider's two gates are both closed on
 * every deployment, so every landside leg must still be exactly
 * `{ minutes: null, source: "unmeasured", reason: "NO_ROUTED_PROVIDER" }` and
 * no request may be built. That is asserted with a `fetchImpl` that THROWS:
 * if either gate were ever bypassed the test fails loudly rather than making a
 * billable call.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/layoverCorridorWiring.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN,
  corridorToTravelTimeResult,
  corridorTravelTimeProvider,
  freeFlowBoundMinutes,
} from "../lib/providers/corridorTravelTimeAdapter.js";
import {
  PROVIDER_REFUSAL_REASONS,
  refuse,
  type ProviderRefusalReason,
} from "../lib/providers/providerRefusal.js";
import {
  NO_ROUTE_CORRIDOR_PROVIDER,
  independentRouteCount,
  measured,
  transferCountOf,
  unmeasured,
  type CorridorQuery,
  type CorridorResult,
  type BidirectionalQuery,
  type BidirectionalResult,
  type LegInterruptibility,
  type RouteCorridor,
  type RouteCorridorProvider,
  type RouteLeg,
  type RouteOption,
} from "../lib/providers/routeCorridorProvider.js";
import {
  CREDENTIAL_ENV,
  ENABLEMENT_ENV,
  createGoogleRoutesCorridorProvider,
} from "../lib/providers/googleRoutesCorridorProvider.js";
import {
  LAYOVER_TRAVEL_TIME_PROVIDER,
  landsideLeg,
} from "../services/airport/LayoverTravelTime.js";
import {
  LAYOVER_RETURN_CORRIDOR_PROVIDER,
  layoverReturnRisk,
} from "../services/airport/LayoverReturnCorridor.js";
import {
  RETURN_CORRIDOR_UNJUDGEABLE_UNKNOWN,
  returnRiskAdjustedAdvice,
  type LeaveAdvice,
  type ReturnCorridorRisk,
} from "../services/airport/LayoverSafetyEngine.js";
import { assessReturnRisk } from "../lib/providers/returnRouteRisk.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const AIRPORT = { lat: 25.0777, lng: 121.2328 };
const PLACE = { lat: 25.0330, lng: 121.5654 };
const NOW = Date.parse("2026-09-22T10:00:00.000Z");
const DEPART = new Date(NOW);

function leg(
  mode: RouteLeg["mode"],
  minutes: number,
  interruptibility: LegInterruptibility,
  transferPointId: string | null = null,
): RouteLeg {
  return { mode, minutes, distanceMeters: null, interruptibility, transferPointId };
}

/** `totalMinutes` is the TRAFFIC-AWARE total and is deliberately NOT the sum of
 *  the legs, which carry free-flow `staticDuration` — that difference is the
 *  whole bound-versus-expected decision. */
function route(legs: RouteLeg[], totalMinutes: number): RouteOption {
  return { legs, totalMinutes, transferCount: transferCountOf(legs) };
}

function corridor(routes: RouteOption[], over: Partial<RouteCorridor> = {}): RouteCorridor {
  return {
    from: AIRPORT,
    to: PLACE,
    departAt: new Date(NOW).toISOString(),
    routes,
    independentRouteCount: independentRouteCount(routes),
    reliability: measured(
      {
        spreadMinutes:
          routes.length > 1 ? routes[routes.length - 1]!.totalMinutes - routes[0]!.totalMinutes : 0,
        optionCount: routes.length,
      },
      "LIVE",
      "MEDIUM",
      ["test"],
    ),
    queueFriction: unmeasured("no queue feed in this repository"),
    weather: unmeasured("no weather provider"),
    airportReentryMinutes: unmeasured("re-entry cost is not modelled"),
    observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    sourceClass: "LIVE",
    confidence: "MEDIUM",
    sourceRefs: ["test-corridor"],
    ...over,
  };
}

/** A corridor provider that answers whatever it was handed. */
function fixedCorridorProvider(answer: CorridorResult, id = "test-corridor-provider"): RouteCorridorProvider {
  return {
    id,
    routed: true,
    async corridor(_q: CorridorQuery): Promise<CorridorResult> {
      return answer;
    },
    async bidirectional(_q: BidirectionalQuery): Promise<BidirectionalResult> {
      if (!answer.ok) return answer;
      return { ok: true, value: { outbound: answer.value, returnLeg: answer.value } };
    },
  };
}

/** Both directions, each stamped with its OWN departure instant (L60 + L72). */
function twoWayProvider(outbound: RouteCorridor, returnLeg: RouteCorridor): RouteCorridorProvider {
  return {
    id: "test-two-way",
    routed: true,
    async corridor(): Promise<CorridorResult> {
      return { ok: true, value: outbound };
    },
    async bidirectional(): Promise<BidirectionalResult> {
      return { ok: true, value: { outbound, returnLeg } };
    },
  };
}

/** A fetch that must never be reached. */
const FORBIDDEN_FETCH = (async () => {
  throw new Error("a request was built: a closed gate was bypassed and this would have been billed");
}) as unknown as typeof fetch;

function envReader(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

// ── 1. a corridor answer becomes an estimate ────────────────────────────────

describe("a corridor answer becomes an estimate, with the bound and the expected kept apart", () => {
  it("estimate.minutes is the FREE-FLOW sum and expectedMinutes is the traffic-aware total", async () => {
    // Free flow: 5 + 15 = 20. Traffic-aware total for the same route: 35.
    const c = corridor([route([leg("walk", 5, "interruptible"), leg("drive", 15, "interruptible")], 35)]);
    const p = corridorTravelTimeProvider(fixedCorridorProvider({ ok: true, value: c }), { now: () => NOW });

    const r = await p.estimate({ from: AIRPORT, to: PLACE, departAt: DEPART });
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;

    assert.equal(freeFlowBoundMinutes(c.routes[0]!), 20);
    assert.equal(r.estimate.minutes, 20, "the BOUND must stay the free-flow lower bound");
    assert.equal(r.expectedMinutes, 35, "the traffic-aware total belongs in the expected channel");
    assert.ok(
      (r.expectedMinutes ?? 0) >= r.estimate.minutes,
      "expected may never fall below the bound it rides over",
    );
    // A ROUTED provider answered FOR the instant it was given: nothing to assume.
    assert.equal(r.assumption, null);
    assert.equal(r.estimate.fallbackLevel, 0);
    assert.equal(r.estimate.sourceClass, "LIVE");
    assert.equal(r.estimate.observedAt, c.observedAt);
    assert.equal(r.estimate.expiresAt, c.expiresAt);
    assert.ok(
      r.estimate.sourceRefs.some((s) => s.includes("corridorTravelTimeAdapter")),
      "the reduction names itself in the provenance trail",
    );
  });

  it("a route that reports no legs falls back to its own total as the bound, never to zero", () => {
    const c = corridor([route([], 42)]);
    const r = corridorToTravelTimeResult(c, NOW, "t");
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;
    assert.equal(r.estimate.minutes, 42);
    assert.equal(r.expectedMinutes, 42);
  });

  it("per-leg ceiling can exceed the route total, and the expected is lifted to the bound", () => {
    // Two 1-minute legs (each already ceiled) against a 1-minute total.
    const c = corridor([route([leg("walk", 1, "interruptible"), leg("walk", 1, "interruptible")], 1)]);
    const r = corridorToTravelTimeResult(c, NOW, "t");
    assert.equal(r.kind, "estimate");
    if (r.kind !== "estimate") return;
    assert.equal(r.estimate.minutes, 2);
    assert.equal(r.expectedMinutes, 2, "never below the bound");
  });

  it("the best route is the one the corridor put first — this code does not re-sort", async () => {
    const fast = route([leg("drive", 10, "interruptible")], 12);
    const slow = route([leg("transit", 40, "committed", "STN-A")], 45);
    const p = corridorTravelTimeProvider(fixedCorridorProvider({ ok: true, value: corridor([fast, slow]) }), {
      now: () => NOW,
    });
    const r = await p.estimate({ from: AIRPORT, to: PLACE, departAt: DEPART });
    assert.equal(r.kind === "estimate" && r.expectedMinutes, 12);
  });
});

// ── 2. every refusal shape becomes its own unknown ──────────────────────────

describe("every refusal shape maps to a distinct unknown, and nothing is lost", () => {
  it("the map is TOTAL over the refusal vocabulary", () => {
    for (const reason of PROVIDER_REFUSAL_REASONS) {
      assert.ok(
        CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN[reason],
        `${reason} has no mapping — a refusal shape would default into whichever unknown was nearest`,
      );
    }
    assert.equal(
      Object.keys(CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN).length,
      PROVIDER_REFUSAL_REASONS.length,
      "the map has entries the refusal vocabulary does not",
    );
  });

  it("a missing coordinate, an outage and an unconfigured provider are THREE different reasons", () => {
    const missing = CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN.REQUEST_INCOMPLETE;
    const outage = CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN.PROVIDER_UNAVAILABLE;
    const notHere = CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN.PROVIDER_NOT_ENABLED;
    assert.equal(missing, "NO_COORDINATES");
    assert.equal(outage, "PROVIDER_UNAVAILABLE");
    assert.equal(notHere, "NO_ROUTED_PROVIDER");
    assert.equal(new Set([missing, outage, notHere]).size, 3, "they collapsed into one reason");
    // A stale answer is its own fact too.
    assert.equal(CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN.ANSWER_STALE, "ESTIMATE_STALE");
    assert.equal(CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN.PROVIDER_MALFORMED, "PROVIDER_MALFORMED");
  });

  it("each of the NINE refusals is still tellable apart in `detail`", async () => {
    const seen = new Set<string>();
    for (const reason of PROVIDER_REFUSAL_REASONS) {
      const p = corridorTravelTimeProvider(
        fixedCorridorProvider(refuse("test-provider", reason as ProviderRefusalReason, `detail for ${reason}`, "SOME_VAR")),
        { now: () => NOW },
      );
      const r = await p.estimate({ from: AIRPORT, to: PLACE, departAt: DEPART });
      assert.equal(r.kind, "unknown");
      if (r.kind !== "unknown") continue;
      assert.equal(r.reason, CORRIDOR_REFUSAL_TO_TRAVEL_UNKNOWN[reason as ProviderRefusalReason]);
      assert.ok(
        r.detail?.startsWith(reason),
        `detail for ${reason} must begin with its own reason token, got ${String(r.detail)}`,
      );
      assert.ok(r.detail?.includes("SOME_VAR"), "the variable NAME travels with the refusal");
      seen.add(r.detail!);
    }
    assert.equal(seen.size, PROVIDER_REFUSAL_REASONS.length, "two refusal shapes produced the same detail");
  });

  it("the adapter never asserts `routed` — it takes it from the provider it wraps", () => {
    const p = corridorTravelTimeProvider(NO_ROUTE_CORRIDOR_PROVIDER);
    assert.equal(p.routed, false, "wrapping must not launder a stand-in into a routed answer");
  });
});

// ── 3. an empty corridor is UNKNOWN and is not zero ─────────────────────────

describe("an empty corridor is an absence, never a zero and never a fragile corridor", () => {
  it("routes: [] is unknown / PROVIDER_MALFORMED", () => {
    const r = corridorToTravelTimeResult(corridor([]), NOW, "t");
    assert.equal(r.kind, "unknown");
    if (r.kind !== "unknown") return;
    assert.equal(r.reason, "PROVIDER_MALFORMED");
    assert.ok(r.detail?.includes("no routes"));
  });

  it("routes: [] never yields a zero-minute estimate", async () => {
    const p = corridorTravelTimeProvider(fixedCorridorProvider({ ok: true, value: corridor([]) }), {
      now: () => NOW,
    });
    const r = await p.estimate({ from: AIRPORT, to: PLACE, departAt: DEPART });
    assert.notEqual(r.kind, "estimate", "an empty corridor produced a figure");
    const legOut = await landsideLeg(AIRPORT, PLACE, DEPART, p);
    assert.equal(legOut.minutes, null, "an absent route was rendered as a number");
    assert.notEqual(legOut.minutes, 0, "an absent route rendered as ZERO makes every schedule feasible");
    assert.equal(legOut.source, "unmeasured");
  });

  it("a best route whose total is zero is malformed, not a free journey", () => {
    const r = corridorToTravelTimeResult(corridor([route([leg("walk", 0, "interruptible")], 0)]), NOW, "t");
    assert.equal(r.kind === "unknown" && r.reason, "PROVIDER_MALFORMED");
  });

  it("a corridor past its own expiry is ESTIMATE_STALE, not served and not discarded silently", () => {
    const c = corridor([route([leg("drive", 10, "interruptible")], 12)], {
      expiresAt: new Date(NOW - 1).toISOString(),
    });
    const r = corridorToTravelTimeResult(c, NOW, "t");
    assert.equal(r.kind === "unknown" && r.reason, "ESTIMATE_STALE");
  });
});

// ── 4. production behaviour has not moved ───────────────────────────────────

describe("the wired provider still refuses exactly as it did, and builds no request", () => {
  it("LAYOVER_TRAVEL_TIME_PROVIDER is routed and answers the same named absence", async () => {
    assert.equal(LAYOVER_TRAVEL_TIME_PROVIDER.routed, true);
    assert.ok(
      LAYOVER_TRAVEL_TIME_PROVIDER.id.startsWith("corridor:"),
      `expected the corridor adapter, got ${LAYOVER_TRAVEL_TIME_PROVIDER.id}`,
    );
    const out = await landsideLeg(AIRPORT, PLACE, DEPART);
    assert.equal(out.minutes, null);
    assert.equal(out.source, "unmeasured");
    assert.equal(out.reason, "NO_ROUTED_PROVIDER", "the answer a traveller meets must be unchanged");
  });

  for (const [label, env] of [
    ["neither gate", {}],
    ["key present, spend gate closed", { [CREDENTIAL_ENV]: "a-real-looking-key" }],
    ["spend gate open, key absent", { [ENABLEMENT_ENV]: "true" }],
    ["spend gate open, key empty", { [ENABLEMENT_ENV]: "true", [CREDENTIAL_ENV]: "   " }],
  ] as Array<[string, Record<string, string>]>) {
    it(`${label}: refuses with NO_ROUTED_PROVIDER and never reaches fetch`, async () => {
      const corridorProvider = createGoogleRoutesCorridorProvider({
        readEnv: envReader(env),
        fetchImpl: FORBIDDEN_FETCH,
        now: () => new Date(NOW),
      });
      const p = corridorTravelTimeProvider(corridorProvider, { now: () => NOW });
      const out = await landsideLeg(AIRPORT, PLACE, DEPART, p);
      assert.equal(out.minutes, null);
      assert.equal(out.source, "unmeasured");
      assert.equal(out.reason, "NO_ROUTED_PROVIDER");
      assert.ok(out.detail, "the refusal beneath the reason must survive to the layover surface");
    });
  }

  it("the four ways to have no routed provider stay tellable apart in `detail`", async () => {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{}, "PROVIDER_NOT_ENABLED", ENABLEMENT_ENV],
      [{ [CREDENTIAL_ENV]: "k" }, "PROVIDER_NOT_ENABLED", ENABLEMENT_ENV],
      [{ [ENABLEMENT_ENV]: "1" }, "CREDENTIAL_ABSENT", CREDENTIAL_ENV],
      [{ [ENABLEMENT_ENV]: "1", [CREDENTIAL_ENV]: "" }, "CREDENTIAL_EMPTY", CREDENTIAL_ENV],
    ];
    const details = new Set<string>();
    for (const [env, expectedToken, expectedVar] of cases) {
      const p = corridorTravelTimeProvider(
        createGoogleRoutesCorridorProvider({
          readEnv: envReader(env),
          fetchImpl: FORBIDDEN_FETCH,
          now: () => new Date(NOW),
        }),
        { now: () => NOW },
      );
      const out = await landsideLeg(AIRPORT, PLACE, DEPART, p);
      assert.equal(out.reason, "NO_ROUTED_PROVIDER");
      assert.ok(
        out.detail?.startsWith(expectedToken),
        `expected detail to begin ${expectedToken}, got ${String(out.detail)}`,
      );
      assert.ok(out.detail?.includes(expectedVar));
      // A refusal names a VARIABLE, never a value.
      assert.ok(!out.detail?.includes("a-real-looking-key"));
      details.add(out.detail!);
    }
    assert.equal(details.size, 3, "PROVIDER_NOT_ENABLED is the same fact twice; the other two differ");
  });

  it("no coordinate is NO_COORDINATES, which is not the same as no provider", async () => {
    const p = corridorTravelTimeProvider(
      createGoogleRoutesCorridorProvider({
        readEnv: envReader({ [ENABLEMENT_ENV]: "1", [CREDENTIAL_ENV]: "k" }),
        fetchImpl: FORBIDDEN_FETCH,
        now: () => new Date(NOW),
      }),
      { now: () => NOW },
    );
    const out = await landsideLeg(AIRPORT, null, DEPART, p);
    assert.equal(out.reason, "NO_COORDINATES");
  });
});

// ── 5. the card takes the EXPECTED figure, not the bound ────────────────────

describe("landsideLeg reads the expected figure, because a card certifies and a bound may only refuse", () => {
  it("a 20-minute free-flow bound under a 35-minute traffic-aware total lands as 35", async () => {
    const c = corridor([route([leg("drive", 20, "interruptible")], 35)]);
    const p = corridorTravelTimeProvider(fixedCorridorProvider({ ok: true, value: c }), { now: () => NOW });
    const out = await landsideLeg(AIRPORT, PLACE, DEPART, p);
    assert.equal(out.minutes, 35, "the card must not certify off a lower bound");
    assert.equal(out.source, "measured");
    assert.equal(out.reason, null);
    assert.equal(out.detail, null);
  });

  it("a provider that states no expected figure is read exactly as before", async () => {
    const p = {
      id: "bound-only",
      routed: true,
      async estimate() {
        return {
          kind: "estimate" as const,
          estimate: {
            minutes: 18, p50Minutes: 18, p75Minutes: 18, p90Minutes: 18,
            confidence: "HIGH" as const, sourceClass: "LIVE" as const,
            observedAt: null, expiresAt: null, fallbackLevel: 0 as const,
            sourceRefs: ["bound-only"],
          },
        };
      },
    };
    const out = await landsideLeg(AIRPORT, PLACE, DEPART, p);
    assert.equal(out.minutes, 18);
  });
});

// ── 6. the safety engine CONSUMES the terms ─────────────────────────────────

/** A plain advice to fold a risk into. */
function advice(verdict: LeaveAdvice["verdict"] = "yes"): LeaveAdvice {
  return {
    verdict,
    reasons: ["About 3h 0m of usable time after exit and return buffers."],
    unknowns: ["Visa or transit-permit requirements for your nationality"],
    disclaimer: "d",
    reasonCodes: ["ENTRY_NOT_CONFIRMED"],
    engineVersion: "test",
  };
}

/** Read the risk terms off a return corridor exactly as production does. */
function riskOf(routes: RouteOption[], over: Partial<RouteCorridor> = {}): ReturnCorridorRisk {
  const r = assessReturnRisk(corridor(routes, over), NOW);
  assert.ok(r, "fixture produced no assessment");
  return r!;
}

describe("the safety engine consumes independence, interruptibility and transfers", () => {
  it("no corridor is the IDENTITY — this is every call on this tree", () => {
    const a = advice();
    assert.equal(returnRiskAdjustedAdvice(a, null), a, "an absent corridor must not rebuild the advice");
  });

  it("L71 transfers: the SAME window flips yes -> tight when every way back needs two changes", () => {
    const easy = riskOf([
      route([leg("drive", 20, "interruptible")], 22),
      route([leg("drive", 25, "interruptible")], 27),
    ]);
    const hard = riskOf([
      route(
        [leg("transit", 8, "interruptible", "A"), leg("transit", 9, "interruptible", "B"), leg("transit", 7, "interruptible", null)],
        26,
      ),
      route(
        [leg("transit", 9, "interruptible", "C"), leg("transit", 9, "interruptible", "D"), leg("transit", 9, "interruptible", null)],
        29,
      ),
    ]);
    assert.equal(easy.facts.minTransferCount, 0);
    assert.equal(hard.facts.minTransferCount, 2);

    assert.equal(returnRiskAdjustedAdvice(advice("yes"), easy).verdict, "yes");
    const out = returnRiskAdjustedAdvice(advice("yes"), hard);
    assert.equal(out.verdict, "tight", "L71's transfer count did not reach the verdict");
    assert.ok(out.reasonCodes.includes("RETURN_ROUTE_UNRELIABLE"));
    assert.ok(out.reasons.some((r) => r.includes("changes of transport")));
  });

  it("L70 interruptibility: the SAME single corridor flips yes -> tight when the way back is committed", () => {
    const free = riskOf([route([leg("drive", 20, "interruptible")], 22)]);
    const stuck = riskOf([route([leg("transit", 20, "committed")], 22)]);
    assert.equal(free.facts.bestRouteInterruptibility, "interruptible");
    assert.equal(stuck.facts.bestRouteInterruptibility, "committed");
    assert.equal(free.fragileCorridor, true, "one route is fragile either way — only L70 differs");
    assert.equal(stuck.fragileCorridor, true);

    assert.equal(returnRiskAdjustedAdvice(advice("yes"), free).verdict, "yes");
    const out = returnRiskAdjustedAdvice(advice("yes"), stuck);
    assert.equal(out.verdict, "tight", "L70's interruptibility did not reach the verdict");
    assert.ok(out.reasons.some((r) => r.includes("cannot be interrupted")));
  });

  it("L68 independence: three routes through ONE interchange are one route wearing three hats", () => {
    const shared = riskOf([
      route([leg("transit", 20, "committed", "CENTRAL"), leg("walk", 4, "interruptible")], 26),
      route([leg("transit", 24, "committed", "CENTRAL"), leg("walk", 5, "interruptible")], 31),
      route([leg("transit", 26, "committed", "CENTRAL"), leg("walk", 5, "interruptible")], 33),
    ]);
    const independent = riskOf([
      route([leg("transit", 20, "committed", "CENTRAL"), leg("walk", 4, "interruptible")], 26),
      route([leg("transit", 24, "committed", "NORTH"), leg("walk", 5, "interruptible")], 28),
      route([leg("transit", 26, "committed", "WEST"), leg("walk", 5, "interruptible")], 29),
    ]);
    assert.equal(shared.facts.offeredReturnRoutes, 3);
    assert.equal(shared.facts.independentReturnRoutes, 1, "shared interchange must not count three times");
    assert.equal(independent.facts.independentReturnRoutes, 3);

    const blocked = returnRiskAdjustedAdvice(advice("yes"), shared);
    assert.equal(blocked.verdict, "tight", "L68's independence count did not reach the verdict");
    assert.ok(blocked.reasons.some((r) => r.includes("independent way back")));
    assert.equal(
      returnRiskAdjustedAdvice(advice("yes"), independent).verdict,
      "yes",
      "three genuinely independent ways back must not be penalised",
    );
  });

  it("it may only ever DOWNGRADE — a refusal is never softened", () => {
    const stuck = riskOf([route([leg("transit", 20, "committed")], 22)]);
    assert.equal(returnRiskAdjustedAdvice(advice("no"), stuck).verdict, "no");
    assert.equal(returnRiskAdjustedAdvice(advice("tight"), stuck).verdict, "tight");
    assert.equal(returnRiskAdjustedAdvice(advice("stay_airside"), stuck).verdict, "stay_airside");
  });

  it("a stale corridor cannot support the judgement, and says so rather than passing", () => {
    const stale = riskOf([route([leg("transit", 20, "committed")], 22)], {
      expiresAt: new Date(NOW - 60_000).toISOString(),
    });
    assert.equal(stale.returnRouteUnreliable, null, "stale must be unknown, never 'reliable'");
    const out = returnRiskAdjustedAdvice(advice("yes"), stale);
    assert.equal(out.verdict, "yes", "an unknown is not evidence for a downgrade");
    assert.ok(out.unknowns.some((u) => u.includes("no longer current")), "the unknown was not disclosed");
    assert.ok(!out.reasonCodes.includes("RETURN_ROUTE_UNRELIABLE"));
  });

  it("L62 — the three signals nothing can measure are disclosed, not scored as zero", () => {
    const out = returnRiskAdjustedAdvice(advice("yes"), riskOf([route([leg("drive", 20, "interruptible")], 22)]));
    for (const signal of ["queueFriction", "weather", "airportReentryMinutes"]) {
      assert.ok(
        out.unknowns.some((u) => u.includes(signal)),
        `${signal} was folded away instead of being named`,
      );
    }
  });

  it("RETURN_ROUTE_UNRELIABLE now has an emitter — it had none in any shape", () => {
    const stuck = riskOf([route([leg("transit", 20, "committed")], 22)]);
    assert.ok(returnRiskAdjustedAdvice(advice("yes"), stuck).reasonCodes.includes("RETURN_ROUTE_UNRELIABLE"));
  });
});

// ── 7. the layover surface's own ask ────────────────────────────────────────

describe("layoverReturnRisk asks for both directions and refuses everything it cannot trust", () => {
  const q = {
    airport: AIRPORT,
    candidate: PLACE,
    outboundDepartAt: DEPART,
    returnDepartAt: new Date(NOW + 3 * 3600_000),
  };

  it("the provider the layover surface names refuses without building a request", async () => {
    assert.equal(LAYOVER_RETURN_CORRIDOR_PROVIDER.routed, true);
    const out = await layoverReturnRisk(q, NOW, LAYOVER_RETURN_CORRIDOR_PROVIDER);
    assert.equal(out.risk, null);
    assert.equal(out.reason, "PROVIDER_NOT_ENABLED", "the spend gate must be the one that answers");
    assert.ok(out.detail?.includes(ENABLEMENT_ENV));
  });

  it("an unrouted provider is refused before it can speak", async () => {
    const out = await layoverReturnRisk(q, NOW, NO_ROUTE_CORRIDOR_PROVIDER);
    assert.equal(out.risk, null);
    assert.equal(out.reason, "PROVIDER_UNBOUND");
  });

  it("two corridors stamped with the SAME instant are the *2 model and are refused", async () => {
    const c = corridor([route([leg("drive", 20, "interruptible")], 22)]);
    const out = await layoverReturnRisk(q, NOW, fixedCorridorProvider({ ok: true, value: c }));
    assert.equal(out.risk, null);
    assert.equal(out.reason, "PROVIDER_MALFORMED");
    assert.ok(out.detail?.includes("travelTimeMin * 2"));
  });

  it("a provider that THROWS is an absence, not an error page", async () => {
    const thrower: RouteCorridorProvider = {
      id: "test-thrower",
      routed: true,
      async corridor(): Promise<CorridorResult> {
        throw new Error("socket hang up");
      },
      async bidirectional(): Promise<BidirectionalResult> {
        throw new Error("socket hang up");
      },
    };
    const out = await layoverReturnRisk(q, NOW, thrower);
    assert.equal(out.risk, null);
    assert.equal(out.reason, "PROVIDER_UNAVAILABLE");
    assert.ok(out.detail?.includes("socket hang up"));
  });

  it("a return corridor with no routes is NO_ROUTES, not a fragile corridor", async () => {
    const out = await layoverReturnRisk(
      q,
      NOW,
      twoWayProvider(
        corridor([route([leg("drive", 20, "interruptible")], 22)]),
        corridor([], { departAt: new Date(NOW + 3 * 3600_000).toISOString() }),
      ),
    );
    assert.equal(out.risk, null);
    assert.equal(out.reason, "NO_ROUTES");
  });

  it("the RETURN half is what is judged — a clean outbound cannot rescue a committed way home", async () => {
    const out = await layoverReturnRisk(
      q,
      NOW,
      twoWayProvider(
        corridor([
          route([leg("drive", 12, "interruptible")], 14),
          route([leg("drive", 15, "interruptible")], 17),
        ]),
        corridor([route([leg("transit", 30, "committed")], 34)], {
          departAt: new Date(NOW + 3 * 3600_000).toISOString(),
        }),
      ),
    );
    assert.ok(out.risk, `expected a risk, got ${out.reason}: ${out.detail}`);
    assert.equal(out.risk!.returnRouteUnreliable, true);
    assert.equal(out.risk!.facts.bestRouteInterruptibility, "committed");
    assert.equal(out.risk!.facts.independentReturnRoutes, 1);
    assert.equal(returnRiskAdjustedAdvice(advice("yes"), out.risk!).verdict, "tight");
  });

  it("a judgement that cannot be made is disclosed as an unknown, never as 'reliable'", () => {
    const out = returnRiskAdjustedAdvice(advice("yes"), {
      returnRouteUnreliable: null,
      fragileCorridor: null,
      contributingFactors: [],
      facts: {
        independentReturnRoutes: 0,
        offeredReturnRoutes: 0,
        bestRouteInterruptibility: "interruptible",
        allRoutesInterruptibility: "interruptible",
        minTransferCount: 0,
        maxTransferCount: 0,
        stale: false,
        unmeasured: [],
      },
    });
    assert.ok(out.unknowns.includes(RETURN_CORRIDOR_UNJUDGEABLE_UNKNOWN));
    assert.equal(out.verdict, "yes");
  });
});
