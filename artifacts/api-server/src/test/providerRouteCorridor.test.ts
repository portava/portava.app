/**
 * Contract tests for the route-shape port and its Google Routes adapter —
 * census-layover L60, L62, L68, L69, L70, L71, L72, L73.
 *
 * The properties under test are the ones that separate a corridor from a
 * number, plus the one property the owner's provider rule turns on: a provider
 * that cannot answer must produce a NAMED REFUSAL and never an empty or default
 * result. Both this tree's outbound primitives resolve rather than throw, so
 * "it came back" is not "it worked", and the assertions below never accept a
 * shape that a failure could also produce.
 *
 * NO NETWORK IS REACHED. `fetchImpl` is injected everywhere, and a test that
 * forgot to inject one would hit the real endpoint with a real key, which is
 * why the last suite asserts the adapter refuses before it would ever call.
 *
 * NO process.env IS MUTATED. `readEnv` is injected instead: `--test` runs every
 * suite in one process, so a suite that sets an env var changes another suite's
 * behaviour in a way that only shows up in a particular file ordering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NO_ROUTE_CORRIDOR_PROVIDER,
  bothDirections,
  corridorCacheKey,
  corridorConfidence,
  corridorIsStale,
  corridorQueryRefusal,
  independentRouteCount,
  interruptibilityFromMode,
  measured,
  routeInterruptibility,
  transferCountOf,
  unmeasured,
  unmeasuredSignals,
  type CorridorQuery,
  type RouteCorridor,
  type RouteLeg,
  type RouteOption,
} from "../lib/providers/routeCorridorProvider.js";
import {
  CREDENTIAL_ENV,
  ENABLEMENT_ENV,
  createGoogleRoutesCorridorProvider,
  parseDurationSeconds,
  transitInterruptibility,
} from "../lib/providers/googleRoutesCorridorProvider.js";
import {
  credentialRefusal,
  describeRefusal,
  enablementRefusal,
  isConfigurationRefusal,
} from "../lib/providers/providerRefusal.js";

const AIRPORT = { lat: 51.47, lng: -0.4543 };
const CANDIDATE = { lat: 51.5074, lng: -0.1278 };
const OUT_AT = new Date("2030-06-01T11:00:00.000Z");
const BACK_AT = new Date("2030-06-01T16:30:00.000Z");

function leg(over: Partial<RouteLeg> = {}): RouteLeg {
  return {
    mode: "transit",
    minutes: 20,
    distanceMeters: 1000,
    interruptibility: "unknown",
    transferPointId: null,
    ...over,
  };
}

function option(legs: RouteLeg[], totalMinutes = 30): RouteOption {
  return { legs, totalMinutes, transferCount: transferCountOf(legs) };
}

// ── L71 transfer count ───────────────────────────────────────────────────────

describe("L71 — transfer count is changes of conveyance, not leg boundaries", () => {
  it("a route that is one walk has no transfers", () => {
    assert.equal(transferCountOf([leg({ mode: "walk" })]), 0);
  });

  it("walk → train is one ride, so no transfer", () => {
    assert.equal(transferCountOf([leg({ mode: "walk" }), leg({ mode: "transit" })]), 0);
  });

  it("train → walk → train is ONE transfer, not two leg boundaries", () => {
    const legs = [leg({ mode: "transit" }), leg({ mode: "walk" }), leg({ mode: "transit" })];
    assert.equal(transferCountOf(legs), 1);
    assert.notEqual(transferCountOf(legs), legs.length - 1, "leg boundaries are not transfers");
  });

  it("three rides are two transfers", () => {
    assert.equal(
      transferCountOf([
        leg({ mode: "transit" }),
        leg({ mode: "walk" }),
        leg({ mode: "transit" }),
        leg({ mode: "transit" }),
      ]),
      2,
    );
  });

  it("an empty route has no transfers and does not go negative", () => {
    assert.equal(transferCountOf([]), 0);
  });
});

// ── L70 interruptibility ─────────────────────────────────────────────────────

describe("L70 — interruptibility, with unknown kept as a third answer", () => {
  it("walking and driving are interruptible by construction", () => {
    assert.equal(interruptibilityFromMode("walk"), "interruptible");
    assert.equal(interruptibilityFromMode("drive"), "interruptible");
  });

  it("transit is UNKNOWN from the mode alone — a tram is not an airport express", () => {
    assert.equal(interruptibilityFromMode("transit"), "unknown");
    assert.notEqual(interruptibilityFromMode("transit"), "committed");
    assert.notEqual(interruptibilityFromMode("transit"), "interruptible");
  });

  it("a route is as interruptible as its least interruptible leg", () => {
    assert.equal(
      routeInterruptibility([leg({ interruptibility: "interruptible" }), leg({ interruptibility: "committed" })]),
      "committed",
    );
  });

  it("an unknown leg with no committed leg leaves the route unknown — it is not folded either way", () => {
    assert.equal(
      routeInterruptibility([leg({ interruptibility: "interruptible" }), leg({ interruptibility: "unknown" })]),
      "unknown",
    );
  });

  it("all-interruptible is the only way to be interruptible", () => {
    assert.equal(
      routeInterruptibility([leg({ interruptibility: "interruptible" }), leg({ interruptibility: "interruptible" })]),
      "interruptible",
    );
  });

  it("an empty route is unknown, never interruptible", () => {
    assert.equal(routeInterruptibility([]), "unknown");
  });

  it("a transit step's stopCount settles it, and its absence does not", () => {
    assert.equal(transitInterruptibility(1), "committed", "a non-stop hop cannot be abandoned");
    assert.equal(transitInterruptibility(0), "committed");
    assert.equal(transitInterruptibility(5), "interruptible");
    assert.equal(transitInterruptibility(undefined), "unknown");
    assert.equal(transitInterruptibility(null), "unknown");
    assert.equal(transitInterruptibility(Number.NaN), "unknown");
  });
});

// ── L68 / L69 independence ───────────────────────────────────────────────────

describe("L68/L69 — routes sharing a failure point are not independent routes", () => {
  it("three routes through the same interchange count as one", () => {
    const shared = "Kings Cross St Pancras";
    const routes = [
      option([leg({ transferPointId: shared }), leg()]),
      option([leg({ transferPointId: shared }), leg()]),
      option([leg({ transferPointId: shared }), leg()]),
    ];
    assert.equal(independentRouteCount(routes), 1);
    assert.notEqual(independentRouteCount(routes), routes.length, "routes.length is not independence");
  });

  it("routes through different interchanges are independent", () => {
    const routes = [
      option([leg({ transferPointId: "A" })]),
      option([leg({ transferPointId: "B" })]),
      option([leg({ transferPointId: "C" })]),
    ];
    assert.equal(independentRouteCount(routes), 3);
  });

  it("a route with no transfer point at all is always independent", () => {
    const routes = [option([leg({ mode: "walk", transferPointId: null })]), option([leg({ transferPointId: "A" })])];
    assert.equal(independentRouteCount(routes), 2);
  });

  it("partial overlap is conservative — the overlapping route does not count", () => {
    // Under-counting independence raises the fragility a consumer sees, which
    // is the safe direction. Over-counting tells a traveller they have a
    // fallback they do not have.
    const routes = [
      option([leg({ transferPointId: "A" }), leg({ transferPointId: "B" })]),
      option([leg({ transferPointId: "B" }), leg({ transferPointId: "C" })]),
    ];
    assert.equal(independentRouteCount(routes), 1);
  });

  it("no routes is no independent routes", () => {
    assert.equal(independentRouteCount([]), 0);
  });
});

// ── L62 unmeasured signals ───────────────────────────────────────────────────

function corridor(over: Partial<RouteCorridor> = {}): RouteCorridor {
  return {
    from: AIRPORT,
    to: CANDIDATE,
    departAt: OUT_AT.toISOString(),
    routes: [option([leg()])],
    independentRouteCount: 1,
    reliability: measured({ spreadMinutes: 4, optionCount: 2 }, "LIVE", "MEDIUM", ["t"]),
    queueFriction: unmeasured("no queue feed"),
    weather: unmeasured("no weather provider"),
    airportReentryMinutes: unmeasured("not modelled"),
    observedAt: OUT_AT.toISOString(),
    expiresAt: new Date(OUT_AT.getTime() + 5 * 60 * 1000).toISOString(),
    sourceClass: "LIVE",
    confidence: "MEDIUM",
    sourceRefs: ["t"],
    ...over,
  };
}

describe("L62 — the signals nothing can measure are named absences, never zero", () => {
  it("each unmeasured signal names the capability that blocks it", () => {
    const missing = unmeasuredSignals(corridor());
    assert.deepEqual(
      missing.map((m) => m.signal).sort(),
      ["airportReentryMinutes", "queueFriction", "weather"],
    );
    for (const m of missing) {
      assert.ok(m.blockedBy.length > 10, `${m.signal} must name its blocker, not say "n/a"`);
    }
  });

  it("an unmeasured signal has no `value` field to be read as a number", () => {
    const s = unmeasured("no feed");
    assert.equal("value" in s, false, "a value key on an absence is a zero waiting to be read");
    assert.equal(s.measured, false);
  });

  it("confidence folds to the WEAKEST measured signal and never averages", () => {
    const c = corridor({
      confidence: "HIGH",
      reliability: measured({ spreadMinutes: 1, optionCount: 1 }, "LIVE", "LOW", ["t"]),
    });
    assert.equal(corridorConfidence(c), "LOW");
  });

  it("an unmeasured signal does not lower the confidence of what WAS measured", () => {
    // Absence is not uncertainty. It is reported separately by unmeasuredSignals.
    const c = corridor({ confidence: "HIGH", reliability: measured({ spreadMinutes: 1, optionCount: 2 }, "LIVE", "HIGH", ["t"]) });
    assert.equal(corridorConfidence(c), "HIGH");
    assert.equal(unmeasuredSignals(c).length, 3);
  });
});

// ── L73 staleness and cacheability ───────────────────────────────────────────

describe("L73 — every corridor carries its own expiry, and an unreadable one is stale", () => {
  it("is fresh before its expiry and stale at it", () => {
    const c = corridor();
    const expiry = Date.parse(c.expiresAt);
    assert.equal(corridorIsStale(c, expiry - 1), false);
    assert.equal(corridorIsStale(c, expiry), true, "expiry is exclusive — at the instant it is over");
    assert.equal(corridorIsStale(c, expiry + 1), true);
  });

  it("a corridor whose expiry cannot be parsed is STALE, not fresh", () => {
    assert.equal(corridorIsStale(corridor({ expiresAt: "not a date" }), 0), true);
    assert.equal(corridorIsStale(corridor({ expiresAt: "" }), 0), true);
  });

  it("the cache key depends on both endpoints, the mode and the departure bucket", () => {
    const base: CorridorQuery = { from: AIRPORT, to: CANDIDATE, departAt: OUT_AT, mode: "transit" };
    const k = corridorCacheKey(base)!;
    assert.ok(k);
    assert.notEqual(k, corridorCacheKey({ ...base, from: CANDIDATE, to: AIRPORT }), "direction must change the key");
    assert.notEqual(k, corridorCacheKey({ ...base, mode: "drive" }), "mode must change the key");
    assert.notEqual(
      k,
      corridorCacheKey({ ...base, departAt: new Date(OUT_AT.getTime() + 10 * 60 * 1000) }),
      "a different departure bucket must change the key",
    );
    assert.equal(
      k,
      corridorCacheKey({ ...base, departAt: new Date(OUT_AT.getTime() + 60 * 1000) }),
      "a minute later is the same five-minute bucket",
    );
  });

  it("refuses a key for an incomplete or non-finite query rather than making one up", () => {
    assert.equal(corridorCacheKey({ from: null, to: CANDIDATE, departAt: OUT_AT }), null);
    assert.equal(corridorCacheKey({ from: { lat: Number.NaN, lng: 0 }, to: CANDIDATE, departAt: OUT_AT }), null);
  });
});

// ── L60 / L72 bidirectional ──────────────────────────────────────────────────

describe("L60/L72 — both directions, each at its own instant", () => {
  function recordingProvider(behaviour: (q: CorridorQuery) => any) {
    const seen: CorridorQuery[] = [];
    return {
      seen,
      provider: {
        id: "recorder",
        async corridor(q: CorridorQuery) {
          seen.push(q);
          return behaviour(q);
        },
      },
    };
  }

  it("asks twice, in opposite directions, at the two instants given", async () => {
    const { seen, provider } = recordingProvider((q) => ({ ok: true, value: corridor({ from: q.from!, to: q.to! }) }));
    const r = await bothDirections(provider, {
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]!.from, AIRPORT);
    assert.deepEqual(seen[0]!.to, CANDIDATE);
    assert.deepEqual(seen[1]!.from, CANDIDATE, "the return must be candidate → airport");
    assert.deepEqual(seen[1]!.to, AIRPORT);
    assert.equal(seen[0]!.departAt.getTime(), OUT_AT.getTime());
    assert.equal(
      seen[1]!.departAt.getTime(),
      BACK_AT.getTime(),
      "L72: the return is evaluated at the RETURN instant, not the outbound one",
    );
  });

  it("does not model the return as the outbound doubled", async () => {
    // LayoverSafetyEngine.ts:97 models it as `travelTimeMin * 2`. The port must
    // make that unrepresentable: two independent answers, not one scaled.
    const { provider } = recordingProvider((q) => ({
      ok: true,
      value: corridor({ from: q.from!, to: q.to!, routes: [option([leg()], q.from === AIRPORT ? 25 : 61)] }),
    }));
    const r = await bothDirections(provider, {
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.outbound.routes[0]!.totalMinutes, 25);
    assert.equal(r.value.returnLeg.routes[0]!.totalMinutes, 61);
    assert.notEqual(r.value.returnLeg.routes[0]!.totalMinutes, 50, "the return is not the outbound doubled");
  });

  it("a refusal on the OUTBOUND refuses the pair, and does not go on to ask for the return", async () => {
    const { seen, provider } = recordingProvider(() => ({
      ok: false,
      reason: "PROVIDER_REJECTED",
      provider: "recorder",
      detail: "quota",
      envVar: null,
    }));
    const r = await bothDirections(provider, {
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_REJECTED");
    assert.equal(seen.length, 1, "a second billable request after the first already failed is waste");
  });

  it("a refusal on the RETURN refuses the pair — a known way there is not a round trip", async () => {
    const { provider } = recordingProvider((q) =>
      q.from === AIRPORT
        ? { ok: true, value: corridor() }
        : { ok: false, reason: "PROVIDER_UNAVAILABLE", provider: "recorder", detail: "boom", envVar: null },
    );
    const r = await bothDirections(provider, {
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
  });

  it("refuses, by name, when either endpoint has no coordinates", async () => {
    const { seen, provider } = recordingProvider(() => ({ ok: true, value: corridor() }));
    const r = await bothDirections(provider, {
      airport: null,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "REQUEST_INCOMPLETE");
    assert.equal(seen.length, 0, "an incomplete request must not be sent");
  });
});

// ── the default provider ─────────────────────────────────────────────────────

describe("the unbound provider refuses — it never stands in", () => {
  it("answers a named refusal, not an empty corridor", async () => {
    const r = await NO_ROUTE_CORRIDOR_PROVIDER.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNBOUND");
    assert.equal(isConfigurationRefusal(r), true);
  });

  it("is not marked routed", () => {
    assert.equal(NO_ROUTE_CORRIDOR_PROVIDER.routed, false);
  });

  it("refuses the bidirectional call too", async () => {
    const r = await NO_ROUTE_CORRIDOR_PROVIDER.bidirectional({
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, false);
  });
});

// ── credential and spend gates ───────────────────────────────────────────────

describe("credential refusals distinguish absent from set-but-empty", () => {
  it("absent is its own reason", () => {
    const r = credentialRefusal("p", "SOME_KEY", () => undefined)!;
    assert.equal(r.reason, "CREDENTIAL_ABSENT");
    assert.equal(r.envVar, "SOME_KEY");
  });

  it("set-but-empty is a DIFFERENT reason — it looks configured and is not", () => {
    const r = credentialRefusal("p", "SOME_KEY", () => "")!;
    assert.equal(r.reason, "CREDENTIAL_EMPTY");
    const ws = credentialRefusal("p", "SOME_KEY", () => "   ")!;
    assert.equal(ws.reason, "CREDENTIAL_EMPTY", "whitespace is a paste accident, not a key");
  });

  it("a real value is no refusal at all", () => {
    assert.equal(credentialRefusal("p", "SOME_KEY", () => "abc123"), null);
  });

  it("no refusal ever carries the key VALUE", () => {
    const secret = "sk-do-not-leak-me";
    const r = credentialRefusal("p", "SOME_KEY", () => "")!;
    assert.equal(JSON.stringify(r).includes(secret), false);
    assert.equal(describeRefusal(r).includes(secret), false);
  });

  it("the spend gate is off unless explicitly affirmative", () => {
    for (const off of [undefined, "", "0", "false", "no", "maybe", "TRUEISH"]) {
      assert.notEqual(enablementRefusal("p", "GATE", () => off), null, `"${off}" must not enable spending`);
    }
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) {
      assert.equal(enablementRefusal("p", "GATE", () => on), null, `"${on}" should enable`);
    }
  });
});

describe("the Google Routes corridor adapter — gates before spend", () => {
  const q: CorridorQuery = { from: AIRPORT, to: CANDIDATE, departAt: OUT_AT, mode: "transit" };

  function neverFetch(): typeof fetch {
    return (async () => {
      assert.fail("the adapter made a billable request through a closed gate");
    }) as unknown as typeof fetch;
  }

  it("refuses NOT_ENABLED when the key is present but nobody opted in", async () => {
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: neverFetch(),
      readEnv: (n) => (n === CREDENTIAL_ENV ? "a-real-looking-key" : undefined),
    });
    const r = await p.corridor(q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(
      r.reason,
      "PROVIDER_NOT_ENABLED",
      "a key present for Places must never be read as consent to bill Routes",
    );
    assert.equal(r.envVar, ENABLEMENT_ENV);
  });

  it("refuses CREDENTIAL_ABSENT when opted in with no key", async () => {
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: neverFetch(),
      readEnv: (n) => (n === ENABLEMENT_ENV ? "true" : undefined),
    });
    const r = await p.corridor(q);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "CREDENTIAL_ABSENT");
    assert.equal(r.envVar, CREDENTIAL_ENV);
  });

  it("refuses an incomplete query before touching either gate", async () => {
    const p = createGoogleRoutesCorridorProvider({ fetchImpl: neverFetch(), readEnv: () => undefined });
    const r = await p.corridor({ ...q, to: null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "REQUEST_INCOMPLETE");
  });

  it("refuses a non-finite coordinate rather than sending NaN upstream", () => {
    const r = corridorQueryRefusal("p", { from: { lat: 1, lng: Number.NaN }, to: CANDIDATE, departAt: OUT_AT })!;
    assert.equal(r.reason, "REQUEST_INCOMPLETE");
  });
});

describe("the Google Routes corridor adapter — reading a real response shape", () => {
  const ENV = (n: string) => (n === CREDENTIAL_ENV ? "key" : n === ENABLEMENT_ENV ? "true" : undefined);
  const NOW = new Date("2030-06-01T10:00:00.000Z");

  function respond(status: number, body: unknown): typeof fetch {
    return (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;
  }

  const TWO_ROUTES = {
    routes: [
      {
        duration: "1800s",
        distanceMeters: 24000,
        legs: [
          {
            steps: [
              // The step durations deliberately sum to 1700s, not to the
              // route's 1800s: the steps carry free-flow staticDuration and the
              // route carries the traffic-aware total, so a corridor built by
              // summing steps would quietly discard the traffic this request
              // paid for. 1700s ceils to 29 minutes, 1800s to 30.
              { travelMode: "WALK", staticDuration: "250s", distanceMeters: 400 },
              {
                travelMode: "TRANSIT",
                staticDuration: "1150s",
                distanceMeters: 22000,
                transitDetails: {
                  stopCount: 1,
                  stopDetails: { arrivalStop: { name: "Paddington" }, departureStop: { name: "Heathrow T5" } },
                },
              },
              { travelMode: "WALK", staticDuration: "300s", distanceMeters: 600 },
            ],
          },
        ],
      },
      {
        duration: "2700s",
        distanceMeters: 26000,
        legs: [
          {
            steps: [
              {
                travelMode: "TRANSIT",
                staticDuration: "2700s",
                distanceMeters: 26000,
                transitDetails: {
                  stopCount: 14,
                  stopDetails: { arrivalStop: { name: "Green Park" }, departureStop: { name: "Heathrow T5" } },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it("builds a corridor with legs, transfers, interruptibility and alternatives", async () => {
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: respond(200, TWO_ROUTES),
      readEnv: ENV,
      now: () => NOW,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT, mode: "transit" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const c = r.value;

    assert.equal(c.routes.length, 2);
    assert.equal(c.routes[0]!.totalMinutes, 30, "best-first, and the ROUTE duration not the step sum");
    assert.notEqual(c.routes[0]!.totalMinutes, 29, "summing free-flow steps discards the traffic this request paid for");
    assert.equal(c.routes[1]!.totalMinutes, 45);

    // L71
    assert.equal(c.routes[0]!.transferCount, 0, "walk → train → walk is one ride");
    // L70 — stopCount 1 is a non-stop hop
    assert.equal(routeInterruptibility(c.routes[0]!.legs), "committed");
    assert.equal(routeInterruptibility(c.routes[1]!.legs), "interruptible");
    // L68 — different interchanges
    assert.equal(c.independentRouteCount, 2);
    // L62 — reliability measured from the real spread; the other three absent
    assert.equal(c.reliability.measured, true);
    if (c.reliability.measured) assert.equal(c.reliability.value.spreadMinutes, 15);
    assert.deepEqual(unmeasuredSignals(c).map((u) => u.signal).sort(), [
      "airportReentryMinutes",
      "queueFriction",
      "weather",
    ]);
    // L73
    assert.equal(corridorIsStale(c, NOW.getTime()), false);
    assert.equal(corridorIsStale(c, NOW.getTime() + 6 * 60 * 1000), true);
    // The instant asked for is recorded, not the clamped one.
    assert.equal(c.departAt, OUT_AT.toISOString());
  });

  it("two alternatives through the SAME interchange count as one independent route", async () => {
    // The adapter must apply the independence reduction, not report
    // `routes.length`. Two ways to the same single point of failure is one way.
    const shared = {
      routes: [
        {
          duration: "1800s",
          legs: [
            {
              steps: [
                {
                  travelMode: "TRANSIT",
                  staticDuration: "1800s",
                  transitDetails: { stopCount: 6, stopDetails: { arrivalStop: { name: "Paddington" } } },
                },
              ],
            },
          ],
        },
        {
          duration: "2100s",
          legs: [
            {
              steps: [
                {
                  travelMode: "TRANSIT",
                  staticDuration: "2100s",
                  transitDetails: { stopCount: 9, stopDetails: { arrivalStop: { name: "Paddington" } } },
                },
              ],
            },
          ],
        },
      ],
    };
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: respond(200, shared),
      readEnv: ENV,
      now: () => NOW,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT, mode: "transit" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.routes.length, 2);
    assert.equal(r.value.independentRouteCount, 1, "both routes funnel through Paddington — that is one corridor");
  });

  it("a departure already in the past is clamped for the API, but the corridor records what was ASKED", async () => {
    // Routes API rejects a past departureTime, so the request is made for now
    // instead. That substitution must be visible: `departAt` keeps the instant
    // the caller meant, so a consumer comparing it against `observedAt` can see
    // the clamp rather than believing it got the corridor it asked for.
    const past = new Date(NOW.getTime() - 60 * 60 * 1000);
    let sentBody: any = null;
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: (async (_url: any, init: any) => {
        sentBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => TWO_ROUTES } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: past, mode: "transit" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.departAt, past.toISOString(), "the corridor must record the instant asked for");
    assert.notEqual(sentBody.departureTime, past.toISOString(), "the API cannot price a past departure");
    assert.ok(Date.parse(sentBody.departureTime) > NOW.getTime() - 1, "the clamp moves it to now or later");
  });

  it("asks for alternatives — without them every corridor would look fragile", async () => {
    let sentBody: any = null;
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: (async (_url: any, init: any) => {
        sentBody = JSON.parse(init.body);
        return { ok: true, status: 200, json: async () => TWO_ROUTES } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT, mode: "transit" });
    assert.equal(sentBody.computeAlternativeRoutes, true);
    assert.equal(sentBody.travelMode, "TRANSIT");
    assert.equal(typeof sentBody.departureTime, "string", "L72 — the departure instant is sent");
  });

  it("a 200 with NO route is a refusal, never an empty corridor", async () => {
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: respond(200, { routes: [] }),
      readEnv: ENV,
      now: () => NOW,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
    // An empty corridor would score as maximally fragile under L69 rather than
    // as unknown — a fabricated risk signal about a corridor nobody looked at.
    assert.equal("value" in r, false);
  });

  it("403 is PROVIDER_REJECTED and points at enablement, not at an outage", async () => {
    const p = createGoogleRoutesCorridorProvider({
      fetchImpl: respond(403, {}),
      readEnv: ENV,
      now: () => NOW,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_REJECTED");
    assert.match(r.detail, /Routes API is not enabled|restricted/);
  });

  it("a fetch that THROWS is a refusal, not an absent corridor", async () => {
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
  });

  it("a body that is not JSON is MALFORMED and distinct from unavailable", async () => {
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("Unexpected token <");
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("routes with no readable duration are MALFORMED, not a zero-minute corridor", async () => {
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: respond(200, { routes: [{ duration: "soon", legs: [] }] }),
    });
    const r = await p.corridor({ from: AIRPORT, to: CANDIDATE, departAt: OUT_AT });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "PROVIDER_MALFORMED");
  });

  it("parses only the documented duration encoding", () => {
    assert.equal(parseDurationSeconds("1234s"), 1234);
    assert.equal(parseDurationSeconds("12.5s"), 12.5);
    assert.equal(parseDurationSeconds("1234"), null);
    assert.equal(parseDurationSeconds(1234), null);
    assert.equal(parseDurationSeconds(null), null);
  });

  it("bidirectional makes two separate requests at two separate instants", async () => {
    const sent: any[] = [];
    const p = createGoogleRoutesCorridorProvider({
      readEnv: ENV,
      now: () => NOW,
      fetchImpl: (async (_url: any, init: any) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => TWO_ROUTES } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const r = await p.bidirectional({
      airport: AIRPORT,
      candidate: CANDIDATE,
      outboundDepartAt: OUT_AT,
      returnDepartAt: BACK_AT,
    });
    assert.equal(r.ok, true);
    assert.equal(sent.length, 2, "one request per direction — the return is not the outbound reversed in code");
    assert.notEqual(sent[0].departureTime, sent[1].departureTime, "L72 — two instants");
    assert.equal(sent[0].origin.location.latLng.latitude, AIRPORT.lat);
    assert.equal(sent[1].origin.location.latLng.latitude, CANDIDATE.lat);
  });
});
