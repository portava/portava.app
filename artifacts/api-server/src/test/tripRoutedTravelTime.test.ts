/**
 * Trips routed travel time behind a daily quota and a hard budget, with a
 * graceful fallback (census-trips TR128, TR267, TR341, TR412) — the owner's
 * decision of 2026-10-04, verbatim:
 *
 *   "Routes API: Yes, for a bounded rollout if routing is a core trip feature.
 *    Put calls behind a server-side provider interface, set daily quotas and a
 *    hard budget, and fall back gracefully when the limit is reached."
 *
 * WHAT WAS TRUE BEFORE. GoogleRoutesTravelTimeProvider was PREPARED, NOT WIRED:
 * every Trips seam bound the straight-line provider, there was no spend ceiling
 * anywhere in the repository, and so no window could ever be certified.
 *
 * WHAT IS ASSERTED
 *   A. the configuration: every one of quota, budget, per-call price and key
 *      must be present and valid, or the gate is OFF — never a default number;
 *   B. the gate: OFF without configuration or with the flag off (no counter
 *      call at all); the counter's own verdicts passed through; an unreachable,
 *      erroring or absent counter is `unavailable`, never `granted`;
 *   C. the provider: anything but `granted` answers with the straight-line bound
 *      and NAMES why; a granted unit makes ONE routed call whose answer is
 *      cached (no second unit for the same route in the same bucket); a routed
 *      failure falls back; a routed answer is marked `assumption: null`;
 *   D. what a consumer reads: the departure band is applied to a fallback
 *      answer and NOT stacked on a routed one; the disclosure says what the
 *      hops actually were, and with none routed it is the old sentence, word
 *      for word;
 *   E. the migration's SQL is shaped as the gate assumes (static: there is no
 *      Postgres on this machine, so 3971 itself was not executed — CI is its
 *      first execution).
 *
 * SHOWN RED FIRST: none of RoutesSpendGate.ts, GatedRoutedTravelTimeProvider.ts
 * or feasibilityDisclosure existed at `2e46835263` (the file does not load).
 * Mutants, each applied alone and restored, are listed in the commit.
 *
 * Run: node --import tsx/esm --test src/test/tripRoutedTravelTime.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readRoutesSpendConfig, dbRoutesSpendGate, type RoutesSpendGate, type SpendVerdict } from "../domain/trips/contracts/RoutesSpendGate.js";
import { createGatedRoutedTravelTimeProvider, GATED_ROUTED_PROVIDER_ID } from "../domain/trips/contracts/GatedRoutedTravelTimeProvider.js";
import { straightLineTravelTimeProvider, type TravelTimeProvider, type TravelTimeQuery, type TravelTimeResult } from "../domain/trips/contracts/TravelTimeProvider.js";
import { withDepartureAssumptions } from "../domain/trips/services/TripDepartureAssumptions.js";
import { feasibilityDisclosure, FEASIBILITY_UNVERIFIED_DISCLOSURE } from "../routes/tripFeasibility.js";
import { pointTravelEstimate } from "../lib/travelEstimate.js";
import { TRIP_TRAVEL_TIME_PROVIDER } from "../domain/trips/contracts/tripTravelTimeProvider.js";

const FULL = {
  GOOGLE_MAPS_API_KEY: "k",
  ROUTES_API_DAILY_QUOTA: "500",
  ROUTES_API_DAILY_BUDGET_USD: "10",
  ROUTES_API_COST_PER_CALL_USD: "0.005",
};

const Q: TravelTimeQuery = {
  from: { lat: 38.7223, lng: -9.1393 },
  to: { lat: 38.7369, lng: -9.1427 },
  departAt: new Date("2026-10-05T18:00:00Z"),
  mode: "drive",
};

function gateOf(...verdicts: SpendVerdict[]): RoutesSpendGate & { calls: number } {
  const g = {
    calls: 0,
    async decide(): Promise<SpendVerdict> { g.calls += 1; return verdicts[Math.min(g.calls - 1, verdicts.length - 1)]!; },
  };
  return g;
}

function routedOf(...answers: Array<TravelTimeResult>): TravelTimeProvider & { calls: number } {
  const p = {
    id: "fake-routed", routed: true, calls: 0,
    async estimate(): Promise<TravelTimeResult> { p.calls += 1; return answers[Math.min(p.calls - 1, answers.length - 1)]!; },
  };
  return p;
}

const LIVE_14: TravelTimeResult = {
  kind: "estimate",
  estimate: pointTravelEstimate(14, "LIVE", "HIGH", 0, ["fake:routes"]),
};

describe("A. configuration: all four, valid, or OFF", () => {
  it("A1. a full configuration reads as micro-USD; nothing is defaulted", () => {
    assert.deepEqual(readRoutesSpendConfig(FULL), { dailyQuota: 500, dailyBudgetMicros: 10_000_000, costPerCallMicros: 5_000 });
  });

  it("A2. any missing, unparseable, zero or contradictory part is OFF (null)", () => {
    for (const k of Object.keys(FULL)) {
      const env: Record<string, string | undefined> = { ...FULL, [k]: undefined };
      assert.equal(readRoutesSpendConfig(env), null, `${k} missing`);
    }
    for (const [k, v] of [["ROUTES_API_DAILY_QUOTA", "0"], ["ROUTES_API_DAILY_QUOTA", "1.5"], ["ROUTES_API_DAILY_BUDGET_USD", "-1"],
      ["ROUTES_API_DAILY_BUDGET_USD", "ten"], ["ROUTES_API_COST_PER_CALL_USD", "0"], ["ROUTES_API_COST_PER_CALL_USD", "0.0000001"]] as const) {
      assert.equal(readRoutesSpendConfig({ ...FULL, [k]: v }), null, `${k}=${v}`);
    }
    assert.equal(readRoutesSpendConfig({ ...FULL, ROUTES_API_COST_PER_CALL_USD: "11" }), null, "a single call over the whole budget is OFF");
  });
});

describe("B. the gate", () => {
  const cfg = () => readRoutesSpendConfig(FULL);
  const client = (flagOn: boolean | "error", rpc: { data?: unknown; error?: unknown } | "throw") => {
    const calls: string[] = [];
    const sc = {
      calls,
      from: (t: string) => {
        calls.push(`from:${t}`);
        const q: any = { select: () => q, eq: () => q,
          maybeSingle: async () => (flagOn === "error" ? { data: null, error: { message: "x" } } : { data: { enabled: flagOn }, error: null }) };
        return q;
      },
      rpc: async (name: string) => {
        calls.push(`rpc:${name}`);
        if (rpc === "throw") throw new Error("boom");
        return { data: rpc.data ?? null, error: rpc.error ?? null };
      },
    };
    return sc;
  };

  it("B1. no configuration: OFF, and neither the flag nor the counter is touched", async () => {
    const sc = client(true, { data: "granted" });
    assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: () => null }).decide(), "off");
    assert.deepEqual(sc.calls, []);
  });

  it("B2. flag OFF or unreadable: OFF, and the counter is not touched", async () => {
    for (const flag of [false, "error"] as const) {
      const sc = client(flag, { data: "granted" });
      assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: cfg }).decide(), "off");
      assert.ok(!sc.calls.some((c) => c.startsWith("rpc:")), `flag ${String(flag)}`);
    }
  });

  it("B3. the counter's verdicts pass through; anything else is unavailable — never granted", async () => {
    for (const v of ["granted", "quota_exhausted", "budget_exhausted", "off"] as const) {
      assert.equal(await dbRoutesSpendGate({ client: () => client(true, { data: v }) as never, config: cfg }).decide(), v);
    }
    for (const rpc of [{ data: "GRANTED" }, { data: null }, { error: { code: "42883", message: "function does not exist" } }, "throw"] as const) {
      assert.equal(await dbRoutesSpendGate({ client: () => client(true, rpc as never) as never, config: cfg }).decide(), "unavailable", JSON.stringify(rpc));
    }
    assert.equal(await dbRoutesSpendGate({ client: () => null, config: cfg }).decide(), "unavailable");
  });
});

describe("C. the gated provider", () => {
  it("C1. THE POINT: not granted → the straight-line bound, which names why; no routed call", async () => {
    for (const v of ["off", "quota_exhausted", "budget_exhausted", "unavailable"] as const) {
      const routed = routedOf(LIVE_14);
      const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate: gateOf(v) });
      const r = await p.estimate(Q);
      const bound = await straightLineTravelTimeProvider.estimate(Q);
      assert.equal(routed.calls, 0, `${v}: a routed call was made without a granted unit`);
      assert.equal(r.kind, "estimate");
      if (r.kind !== "estimate" || bound.kind !== "estimate") return;
      assert.equal(r.estimate.minutes, bound.estimate.minutes);
      assert.equal(r.estimate.sourceClass, "STATIC_DEFAULT");
      assert.ok(r.estimate.sourceRefs.includes(`routes-api-fallback:${v}`), `${v} is named`);
      assert.equal(r.assumption, undefined, "a fallback answer leaves the band to the assumptions wrapper");
    }
  });

  it("C2. granted → one routed call, answered with assumption:null; the same route in the same bucket is cached and spends nothing", async () => {
    const routed = routedOf(LIVE_14);
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate });
    const a = await p.estimate(Q);
    const b = await p.estimate({ ...Q, departAt: new Date(Q.departAt.getTime() + 60_000) });
    assert.equal(routed.calls, 1);
    assert.equal(gate.calls, 1, "a cache hit takes no unit");
    assert.equal(a.kind === "estimate" && a.estimate.minutes, 14);
    assert.equal(a.kind === "estimate" && a.assumption, null);
    assert.deepEqual(a, b);
  });

  it("C3. a routed failure falls back, named by its reason, and is not cached", async () => {
    const routed = routedOf({ kind: "unknown", reason: "PROVIDER_UNAVAILABLE", detail: "HTTP 429" }, LIVE_14);
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate });
    const first = await p.estimate(Q);
    assert.ok(first.kind === "estimate" && first.estimate.sourceRefs.includes("routes-api-fallback:PROVIDER_UNAVAILABLE"));
    const second = await p.estimate(Q);
    assert.equal(second.kind === "estimate" && second.estimate.minutes, 14, "the failure was not cached");
    assert.equal(gate.calls, 2);
  });

  it("C4. no coordinates: nothing to route and nothing spent", async () => {
    const gate = gateOf("granted");
    const routed = routedOf(LIVE_14);
    const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate });
    assert.deepEqual(await p.estimate({ ...Q, from: null }), { kind: "unknown", reason: "NO_COORDINATES" });
    assert.equal(gate.calls, 0);
    assert.equal(routed.calls, 0);
  });

  it("C7. a granted call answered by the adapter's straight-line WALK substitution is static: it keeps its band", async () => {
    const walk: TravelTimeResult = { kind: "estimate", estimate: pointTravelEstimate(9, "STATIC_DEFAULT", "LOW", 3, ["walk"]) };
    const p = withDepartureAssumptions(createGatedRoutedTravelTimeProvider({ routed: routedOf(walk), fallback: straightLineTravelTimeProvider, gate: gateOf("granted") }), "Europe/Lisbon");
    const r = await p.estimate(Q);
    assert.ok(r.kind === "estimate" && r.assumption, "a static answer is not 'answered for this departure'");
  });

  it("C5. the provider never claims routed statically; the seams bind it", async () => {
    assert.equal(TRIP_TRAVEL_TIME_PROVIDER.id, GATED_ROUTED_PROVIDER_ID);
    assert.equal(TRIP_TRAVEL_TIME_PROVIDER.routed, false);
    for (const [file, seam] of [
      ["../routes/tripFeasibility.ts", "const PROVIDER = TRIP_TRAVEL_TIME_PROVIDER;"],
      ["../domain/trips/projections/TripFreedomProjection.ts", "const BOUND_PROVIDER = TRIP_TRAVEL_TIME_PROVIDER;"],
      ["../domain/trips/projections/TripRouteChainProjection.ts", "const BOUND_PROVIDER = TRIP_TRAVEL_TIME_PROVIDER;"],
    ] as const) {
      assert.ok(readFileSync(new URL(file, import.meta.url), "utf8").includes(seam), file);
    }
  });

  it("C6. unconfigured in this process (no Routes API env), the wired provider IS the straight-line bound", async () => {
    const r = await TRIP_TRAVEL_TIME_PROVIDER.estimate(Q);
    const bound = await straightLineTravelTimeProvider.estimate(Q);
    assert.ok(r.kind === "estimate" && bound.kind === "estimate");
    if (r.kind !== "estimate" || bound.kind !== "estimate") return;
    assert.equal(r.estimate.minutes, bound.estimate.minutes);
    assert.ok(r.estimate.sourceRefs.some((s) => s.startsWith("routes-api-fallback:")));
  });
});

describe("D. what consumers read", () => {
  it("D1. the departure band rides a fallback answer and is NOT stacked on a routed one", async () => {
    const off = withDepartureAssumptions(createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate: gateOf("off") }), "Europe/Lisbon");
    const fallback = await off.estimate(Q);
    assert.ok(fallback.kind === "estimate" && fallback.assumption, "the fallback carries a band");
    const on = withDepartureAssumptions(createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate: gateOf("granted") }), "Europe/Lisbon");
    const routed = await on.estimate(Q);
    assert.ok(routed.kind === "estimate");
    if (routed.kind !== "estimate") return;
    assert.equal(routed.assumption, null);
    assert.equal(routed.expectedMinutes, 14, "no band stacked on a live route");
  });

  it("D2. the disclosure is the hops': none routed is the old sentence word for word; all and some are said", () => {
    assert.equal(feasibilityDisclosure([]), FEASIBILITY_UNVERIFIED_DISCLOSURE);
    assert.equal(feasibilityDisclosure([{ routed: false }, { routed: false }]), FEASIBILITY_UNVERIFIED_DISCLOSURE);
    assert.match(feasibilityDisclosure([{ routed: true }]), /^Travel times are routed estimates/);
    assert.match(feasibilityDisclosure([{ routed: true }, { routed: false }]), /^Some travel times are routed estimates; the rest are straight-line lower bounds/);
  });
});

describe("E. 3971's SQL, statically (no Postgres here; CI executes it)", () => {
  const sql = readFileSync(new URL("../migrations/3971_trip_routes_api_spend_gate.sql", import.meta.url), "utf8");
  it("E1. the spend is one conditional UPDATE under the row lock, and a refusal writes nothing", () => {
    assert.match(sql, /UPDATE public\.routes_api_daily_usage\s+SET calls = calls \+ 1,[\s\S]*?WHERE usage_day = d\s+AND calls \+ 1 <= p_quota\s+AND spend_micros \+ p_cost_micros <= p_budget_micros;/);
    assert.match(sql, /IF p_quota IS NULL OR p_quota <= 0[\s\S]*?RETURN 'off';/);
  });
  it("E2. clients can neither spend nor read; the flag ships OFF", () => {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.routes_api_try_spend\(integer, bigint, bigint\) FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /REVOKE ALL ON public\.routes_api_daily_usage FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /'trip_routes_api_enabled',\s*\n\s*false,/);
  });
});
