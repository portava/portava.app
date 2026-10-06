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
import { withRoutesRequestBudget, ROUTES_MAX_CALLS_PER_REQUEST } from "../domain/trips/contracts/RoutesRequestBudget.js";
import { createGoogleRoutesTravelTimeProvider } from "../domain/trips/contracts/GoogleRoutesTravelTimeProvider.js";
import { computeFreedomWindows, type EngineCommitment } from "../domain/trips/invariants/TripFreedomEngine.js";
import { checkFeasibility } from "../domain/trips/invariants/TripFeasibilityEngine.js";
import { routeChainDisclosure } from "../domain/trips/projections/TripRouteChainProjection.js";
import { freedomReadingFor, FREEDOM_READING } from "../domain/trips/projections/TripFreedomProjection.js";
import { TRIP_TRAVEL_TIME_PROVIDER } from "../domain/trips/contracts/tripTravelTimeProvider.js";

const FULL = {
  GOOGLE_MAPS_API_KEY: "k",
  ROUTES_API_DAILY_QUOTA: "500",
  ROUTES_API_DAILY_BUDGET_USD: "10",
  ROUTES_API_COST_PER_CALL_USD: "0.005",
  ROUTES_API_USER_DAILY_SHARE: "50",
  ROUTES_API_TRIP_DAILY_SHARE: "100",
};

const USER = "11111111-0000-4000-8000-000000000001";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const SCOPE = { userId: USER, tripId: TRIP };
/** Every estimate the seams make runs inside a read's routing budget (§82); so do these. */
const inRead = <T>(fn: () => Promise<T>, limits?: Parameters<typeof withRoutesRequestBudget>[2]) => withRoutesRequestBudget(SCOPE, fn, limits);

const Q: TravelTimeQuery = {
  from: { lat: 38.7223, lng: -9.1393 },
  to: { lat: 38.7369, lng: -9.1427 },
  departAt: new Date("2026-10-05T18:00:00Z"),
  mode: "drive",
};

function gateOf(...verdicts: SpendVerdict[]): RoutesSpendGate & { calls: number; scopes: unknown[] } {
  const g = {
    calls: 0, scopes: [] as unknown[],
    async decide(scope: unknown): Promise<SpendVerdict> { g.calls += 1; g.scopes.push(scope); return verdicts[Math.min(g.calls - 1, verdicts.length - 1)]!; },
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

/**
 * What the REAL adapter returns for a DRIVE route (GoogleRoutesTravelTimeProvider:
 * sourceClass LIVE, confidence MEDIUM — one number, no spread — and
 * `assumption: null`). Wave 1 stamped this fake HIGH, which the adapter never
 * does, and so this suite could not see that no window is ever certified
 * (verifier finding 4; census-trips §82).
 */
const LIVE_14: TravelTimeResult = {
  kind: "estimate",
  estimate: pointTravelEstimate(14, "LIVE", "MEDIUM", 0, ["fake:routes"]),
  assumption: null,
};

describe("A. configuration: all four, valid, or OFF", () => {
  it("A1. a full configuration reads as micro-USD; nothing is defaulted", () => {
    assert.deepEqual(readRoutesSpendConfig(FULL), { dailyQuota: 500, dailyBudgetMicros: 10_000_000, costPerCallMicros: 5_000, userDailyShare: 50, tripDailyShare: 100 });
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
    assert.equal(readRoutesSpendConfig({ ...FULL, ROUTES_API_USER_DAILY_SHARE: "501" }), null, "a user share above the day's quota is OFF");
    assert.equal(readRoutesSpendConfig({ ...FULL, ROUTES_API_TRIP_DAILY_SHARE: "0" }), null, "a zero trip share is OFF");
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
    assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: () => null }).decide(SCOPE), "off");
    assert.deepEqual(sc.calls, []);
  });

  it("B2. flag OFF or unreadable: OFF, and the counter is not touched", async () => {
    for (const flag of [false, "error"] as const) {
      const sc = client(flag, { data: "granted" });
      assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: cfg }).decide(SCOPE), "off");
      assert.ok(!sc.calls.some((c) => c.startsWith("rpc:")), `flag ${String(flag)}`);
    }
  });

  it("B3. the counter's verdicts pass through; anything else is unavailable — never granted", async () => {
    for (const v of ["granted", "quota_exhausted", "budget_exhausted", "user_share_exhausted", "trip_share_exhausted", "off"] as const) {
      assert.equal(await dbRoutesSpendGate({ client: () => client(true, { data: v }) as never, config: cfg }).decide(SCOPE), v);
    }
    for (const rpc of [{ data: "GRANTED" }, { data: null }, { data: "unscoped" }, { error: { code: "42883", message: "function does not exist" } }, "throw"] as const) {
      assert.equal(await dbRoutesSpendGate({ client: () => client(true, rpc as never) as never, config: cfg }).decide(SCOPE), "unavailable", JSON.stringify(rpc));
    }
    assert.equal(await dbRoutesSpendGate({ client: () => null, config: cfg }).decide(SCOPE), "unavailable");
  });

  it("B4. §82: no user or no trip is `unscoped` — nothing is touched, nothing is spent", async () => {
    for (const scope of [{ userId: null, tripId: TRIP }, { userId: USER, tripId: null }] as const) {
      const sc = client(true, { data: "granted" });
      assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: cfg }).decide(scope), "unscoped");
      assert.deepEqual(sc.calls, []);
    }
  });

  it("B5. §82: the spend names the user, the trip and both shares, through 3973's function", async () => {
    let args: any = null; let name = "";
    const sc = { from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: true }, error: null }) }; return q; },
      rpc: async (n: string, a: unknown) => { name = n; args = a; return { data: "granted", error: null }; } };
    assert.equal(await dbRoutesSpendGate({ client: () => sc as never, config: cfg }).decide(SCOPE), "granted");
    assert.equal(name, "routes_api_try_spend_scoped");
    assert.deepEqual(args, { p_quota: 500, p_budget_micros: 10_000_000, p_cost_micros: 5_000, p_user_id: USER, p_trip_id: TRIP, p_user_share: 50, p_trip_share: 100 });
  });
});

describe("C. the gated provider", () => {
  it("C1. THE POINT: not granted → the straight-line bound, which names why; no routed call", async () => {
    for (const v of ["off", "quota_exhausted", "budget_exhausted", "unavailable"] as const) {
      const routed = routedOf(LIVE_14);
      const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate: gateOf(v) });
      const r = await inRead(() => p.estimate(Q));
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
    const [a, b] = await inRead(async () => [await p.estimate(Q), await p.estimate({ ...Q, departAt: new Date(Q.departAt.getTime() + 60_000) })] as const);
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
    const first = await inRead(() => p.estimate(Q));
    assert.ok(first.kind === "estimate" && first.estimate.sourceRefs.includes("routes-api-fallback:PROVIDER_UNAVAILABLE"));
    const second = await inRead(() => p.estimate(Q));
    assert.equal(second.kind === "estimate" && second.estimate.minutes, 14, "the failure was not cached");
    assert.equal(gate.calls, 2);
  });

  it("C4. no coordinates: nothing to route and nothing spent", async () => {
    const gate = gateOf("granted");
    const routed = routedOf(LIVE_14);
    const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate });
    assert.deepEqual(await inRead(() => p.estimate({ ...Q, from: null })), { kind: "unknown", reason: "NO_COORDINATES" });
    assert.equal(gate.calls, 0);
    assert.equal(routed.calls, 0);
  });

  it("C7. §82: the REAL adapter's straight-line WALK substitution keeps its departure band — through the gated provider AND through the bare adapter", async () => {
    // Verifier finding 5: the adapter stamped `assumption: null` on its walk
    // substitution, the gated provider passed it through, and the wrapper then
    // skipped the band. Wave 1's C7 passed only because its fake omitted the
    // key. Here the answer comes from the real adapter: a 300 m hop with no
    // mode, a slow DRIVE route (15 min), so the ~4-minute walk bound binds.
    const adapter = createGoogleRoutesTravelTimeProvider({
      apiKey: "k", now: () => new Date("2026-10-05T17:00:00Z"),
      fetchImpl: (async () => new Response(JSON.stringify({ routes: [{ duration: "900s" }] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });
    const short: TravelTimeQuery = { from: { lat: 38.7223, lng: -9.1393 }, to: { lat: 38.7250, lng: -9.1393 }, departAt: new Date("2026-10-05T18:00:00Z") };
    const raw = await adapter.estimate(short);
    assert.ok(raw.kind === "estimate" && raw.estimate.sourceClass === "STATIC_DEFAULT", "vacuity guard: the walk substitution happened");
    assert.equal(raw.kind === "estimate" && "assumption" in raw, false, "the adapter does not claim a static walk was answered for this departure");
    for (const p of [
      withDepartureAssumptions(createGatedRoutedTravelTimeProvider({ routed: adapter, fallback: straightLineTravelTimeProvider, gate: gateOf("granted") }), "Europe/Lisbon"),
      withDepartureAssumptions(adapter, "Europe/Lisbon"),
    ]) {
      const r = await inRead(() => p.estimate(short));
      assert.ok(r.kind === "estimate" && r.assumption, "a static answer carries the band");
      assert.ok(r.kind === "estimate" && typeof r.expectedMinutes === "number" && r.expectedMinutes >= r.estimate.minutes);
    }
  });

  it("C8a. §82: the gated provider REMOVES `assumption` from any answer that is not routed, whatever the routed side sent", async () => {
    const lying: TravelTimeResult = { kind: "estimate", estimate: pointTravelEstimate(9, "STATIC_DEFAULT", "LOW", 3, ["walk"]), assumption: null };
    const p = createGatedRoutedTravelTimeProvider({ routed: routedOf(lying), fallback: straightLineTravelTimeProvider, gate: gateOf("granted") });
    const r = await inRead(() => p.estimate(Q));
    assert.equal(r.kind === "estimate" && "assumption" in r, false);
  });

  it("C8b. §82: the departure wrapper skips the band only for a ROUTED source class — a static answer keyed `assumption: null` still gets it", async () => {
    const lying: TravelTimeResult = { kind: "estimate", estimate: pointTravelEstimate(9, "STATIC_DEFAULT", "LOW", 3, ["walk"]), assumption: null };
    const r = await withDepartureAssumptions(routedOf(lying), "Europe/Lisbon").estimate(Q);
    assert.ok(r.kind === "estimate" && r.assumption, "the band is applied");
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
    const fallback = await inRead(() => off.estimate(Q));
    assert.ok(fallback.kind === "estimate" && fallback.assumption, "the fallback carries a band");
    const on = withDepartureAssumptions(createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate: gateOf("granted") }), "Europe/Lisbon");
    const routed = await inRead(() => on.estimate(Q));
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

describe("F. §82 certification: what TR341/TR412 can and cannot get from the real adapter", () => {
  const P = { lat: 38.7223, lng: -9.1393 }; const R = { lat: 38.7369, lng: -9.1427 };
  const T = (hh: string) => new Date(`2026-10-06T${hh}:00:00.000Z`);
  const commitment = (id: string, o: Partial<EngineCommitment>): EngineCommitment => ({
    id, type: "event", startsAt: null, requiredArrivalAt: null, endsAt: null, place: { placeId: `p-${id}`, point: P },
    flexibility: "flexible", prepMinutes: 0, latenessToleranceMinutes: 0, ...o,
  });
  const adapter = createGoogleRoutesTravelTimeProvider({
    apiKey: "k", now: () => new Date("2026-10-06T09:00:00Z"),
    fetchImpl: (async () => new Response(JSON.stringify({ routes: [{ duration: "840s" }] }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
  });
  const window = async (provider: TravelTimeProvider) => {
    const A = commitment("A", { startsAt: T("10"), endsAt: T("11"), place: { placeId: "pA", point: P } });
    const B = commitment("B", { requiredArrivalAt: T("15"), startsAt: T("15"), place: { placeId: "pB", point: R } });
    const f = await checkFeasibility(provider, { departFrom: T("11"), fromPlace: P }, { toPlace: R, requiredArrivalAt: T("15"), startsAt: T("15"), prepMinutes: 0, latenessToleranceMinutes: 0 });
    const w = computeFreedomWindows({ commitments: [A, B], hops: [{ travelMinutes: f.travelMinutes, confidence: f.confidence, routed: f.routed, unknownReason: f.unknownReason }], participants: ["u"], tripStart: null, tripEnd: null }).windows.find((x) => x.position === "between")!;
    return { f, w };
  };

  it("F1. a real routed answer makes FEASIBLE reachable (TR128) — and certifies NO window (TR341/TR412): MEDIUM is not HIGH", async () => {
    const { f, w } = await window(adapter);
    assert.equal(f.routed, true, "vacuity guard: the hop was routed");
    assert.equal(f.verdict, "FEASIBLE");
    assert.equal(f.confidence, "MEDIUM");
    assert.equal(w.confidence, "MEDIUM");
    assert.equal(w.certified, false, "the code-level cap: certification needs HIGH, and the Routes API gives one number with no spread");
  });

  it("F2. CONTROL: the certified field is computed — the same window over a HIGH travel term IS certified", async () => {
    const high: TravelTimeProvider = { id: "high", routed: true, async estimate() { return { kind: "estimate", estimate: pointTravelEstimate(14, "LIVE", "HIGH", 0, ["t"]), assumption: null }; } };
    const { w } = await window(high);
    assert.equal(w.certified, true);
  });
});

describe("G. §82 the per-read bound: no member drains the day from one read", () => {
  const distinct = (i: number): TravelTimeQuery => ({ ...Q, to: { lat: 38.70 + i * 0.001, lng: -9.14 } });

  it("G1. outside any read nothing is spent: the gate is not asked, the answer is the bound, named `unscoped`", async () => {
    const gate = gateOf("granted"); const routed = routedOf(LIVE_14);
    const r = await createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate }).estimate(Q);
    assert.equal(gate.calls, 0); assert.equal(routed.calls, 0);
    assert.ok(r.kind === "estimate" && r.estimate.sourceRefs.includes("routes-api-fallback:unscoped"));
  });

  it("G2. a read with no user (or no trip) is unscoped too", async () => {
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate });
    const r = await withRoutesRequestBudget({ userId: null, tripId: TRIP }, () => p.estimate(Q));
    assert.equal(gate.calls, 0);
    assert.ok(r.kind === "estimate" && r.estimate.sourceRefs.includes("routes-api-fallback:unscoped"));
  });

  it(`G3. THE POINT, under concurrency: ${3 * ROUTES_MAX_CALLS_PER_REQUEST} hops at once in ONE read ask the gate exactly ${ROUTES_MAX_CALLS_PER_REQUEST} times; the rest are the labelled bound`, async () => {
    const gate = gateOf("granted"); const routed = routedOf(LIVE_14);
    const p = createGatedRoutedTravelTimeProvider({ routed, fallback: straightLineTravelTimeProvider, gate });
    const n = 3 * ROUTES_MAX_CALLS_PER_REQUEST;
    const rs = await inRead(() => Promise.all(Array.from({ length: n }, (_, i) => p.estimate(distinct(i)))));
    assert.equal(gate.calls, ROUTES_MAX_CALLS_PER_REQUEST);
    assert.equal(routed.calls, ROUTES_MAX_CALLS_PER_REQUEST);
    assert.equal(rs.filter((r) => r.kind === "estimate" && r.estimate.sourceRefs.includes("routes-api-fallback:request_hop_cap")).length, n - ROUTES_MAX_CALLS_PER_REQUEST);
    assert.deepEqual(new Set(gate.scopes.map((x) => JSON.stringify(x))), new Set([JSON.stringify(SCOPE)]), "every unit is charged to this user and this trip");
  });

  it("G4. nested reads share ONE budget (Today → Health → Freedom is one read, not three)", async () => {
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate });
    await inRead(async () => {
      for (let i = 0; i < 3; i += 1) {
        await withRoutesRequestBudget({ userId: USER, tripId: TRIP }, () => Promise.all([0, 1, 2, 3, 4, 5].map((k) => p.estimate(distinct(i * 10 + k)))));
      }
    }, { maxCalls: 10 });
    assert.equal(gate.calls, 10);
  });

  it("G5. a cached answer is free and is not counted", async () => {
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate });
    await inRead(async () => { for (let i = 0; i < 5; i += 1) await p.estimate(Q); }, { maxCalls: 1 });
    const again = await inRead(() => p.estimate(Q), { maxCalls: 0 });
    assert.equal(gate.calls, 1);
    assert.ok(again.kind === "estimate" && again.estimate.minutes === 14, "the cached routed answer, inside a read allowed no spend");
  });

  it("G6. the time bound: a routed call that would overrun the read is abandoned for the bound; no call starts after it", async () => {
    const hanging: TravelTimeProvider & { calls: number } = { id: "slow", routed: true, calls: 0, estimate() { hanging.calls += 1; return new Promise(() => {}); } };
    const gate = gateOf("granted");
    const p = createGatedRoutedTravelTimeProvider({ routed: hanging, fallback: straightLineTravelTimeProvider, gate });
    const t0 = Date.now();
    const [a, b] = await inRead(async () => [await p.estimate(distinct(1)), await p.estimate(distinct(2))] as const, { budgetMs: 60 });
    assert.ok(Date.now() - t0 < 2_000, "bounded by the read's budget, not the adapter's 4 s timeout");
    assert.ok(a.kind === "estimate" && a.estimate.sourceRefs.includes("routes-api-fallback:request_time_budget"));
    assert.ok(b.kind === "estimate" && b.estimate.sourceRefs.includes("routes-api-fallback:request_time_budget"));
    assert.equal(hanging.calls, 1, "the second hop never started a call");
  });

  it("G7. a user's or a trip's exhausted share answers the labelled bound", async () => {
    for (const v of ["user_share_exhausted", "trip_share_exhausted"] as const) {
      const p = createGatedRoutedTravelTimeProvider({ routed: routedOf(LIVE_14), fallback: straightLineTravelTimeProvider, gate: gateOf(v) });
      const r = await inRead(() => p.estimate(Q));
      assert.ok(r.kind === "estimate" && r.estimate.sourceRefs.includes(`routes-api-fallback:${v}`), v);
    }
  });
});

describe("H. §82 disclosures are said from the hops returned, never as fixed text", () => {
  const hop = (routed: boolean, boundMinutes: number | null = 10) => ({ travel: { routed, boundMinutes } });
  it("H1. route chain: none routed / all / some", () => {
    assert.match(routeChainDisclosure([hop(false), hop(false)]), /no hop here was answered by a routed provider/);
    assert.doesNotMatch(routeChainDisclosure([hop(false)]), /no routed provider exists on this tree/);
    assert.match(routeChainDisclosure([hop(true), hop(true)]), /^Every travel term is a routed estimate/);
    assert.match(routeChainDisclosure([hop(true), hop(false), hop(false, null)]), /^1 of 2 travel terms are routed/);
  });
  it("H2. freedom: none routed is the old reading word for word; with routing it states the MEDIUM cap", () => {
    assert.equal(freedomReadingFor([{ routed: false, travelMinutes: 10 }]), FREEDOM_READING);
    assert.match(freedomReadingFor([{ routed: true, travelMinutes: 10 }]), /No window is certified: certification needs HIGH-confidence travel, and a routed answer is MEDIUM/);
    assert.match(freedomReadingFor([{ routed: true, travelMinutes: 10 }, { routed: false, travelMinutes: 5 }]), /routed travel term on 1 of 2 hops/);
  });
  it("H0. each projection serves the computed sentence, and each seam opens a routing budget for its viewer", () => {
    const chain = readFileSync(new URL("../domain/trips/projections/TripRouteChainProjection.ts", import.meta.url), "utf8");
    const freedom = readFileSync(new URL("../domain/trips/projections/TripFreedomProjection.ts", import.meta.url), "utf8");
    const feas = readFileSync(new URL("../routes/tripFeasibility.ts", import.meta.url), "utf8");
    assert.match(chain, /disclosure: routeChainDisclosure\(hops\),/);
    assert.match(freedom, /reading: freedomReadingFor\(hops\),/);
    assert.match(chain, /return withRoutesRequestBudget\(\{ userId: opts\.viewerId \?\? null, tripId \}/);
    assert.match(freedom, /return withRoutesRequestBudget\(\{ userId: opts\.viewerId \?\? null, tripId \}/);
    assert.match(feas, /asyncHandler\(async \(req, res\) => withRoutesRequestBudget\(/);
    assert.match(feas, /fillRoutesRequestScope\(\{ userId: user\.id, tripId \}\)/);
  });
  it("H3. the offline bundle's windows reading is computed, not the provider's static flag", () => {
    const src = readFileSync(new URL("../routes/tripOffline.ts", import.meta.url), "utf8");
    assert.doesNotMatch(src, /not routed: no window can be certified/);
    assert.match(src, /certified window\(s\); \$\{f\.disclosure\}/);
  });
});

describe("J. 3973's SQL, statically (no Postgres here; CI executes it)", () => {
  const raw = readFileSync(new URL("../migrations/3973_trip_routes_api_user_trip_shares.sql", import.meta.url), "utf8");
  const fn = raw.slice(raw.indexOf("CREATE OR REPLACE FUNCTION public.routes_api_try_spend_scoped"), raw.indexOf("$fn$;"));
  it("J1. the three rows are locked in ONE order — day, trip, user — before any check", () => {
    const day = fn.indexOf("FROM public.routes_api_daily_usage u WHERE u.usage_day = d FOR UPDATE");
    const trip = fn.indexOf("FROM public.routes_api_daily_trip_usage t WHERE t.usage_day = d AND t.trip_id = p_trip_id FOR UPDATE");
    const user = fn.indexOf("FROM public.routes_api_daily_user_usage s WHERE s.usage_day = d AND s.user_id = p_user_id FOR UPDATE");
    const firstCheck = fn.indexOf("IF day_calls + 1 > p_quota");
    assert.ok(day > 0 && trip > day && user > trip && firstCheck > user, `${day} ${trip} ${user} ${firstCheck}`);
  });
  it("J2. every limit is checked before ANY counter moves; a refusal returns before the first UPDATE", () => {
    const lastCheck = fn.indexOf("RETURN 'user_share_exhausted'");
    const firstUpdate = fn.indexOf("UPDATE public.");
    assert.ok(lastCheck > 0 && firstUpdate > lastCheck);
    for (const v of ["quota_exhausted", "budget_exhausted", "trip_share_exhausted", "user_share_exhausted", "unscoped", "off"]) assert.match(fn, new RegExp(`RETURN '${v}'`));
    assert.equal((fn.match(/UPDATE public\./g) ?? []).length, 3, "all three counters move together");
  });
  it("J3. service_role only; each share row dies with its account or trip", () => {
    assert.match(raw, /REVOKE ALL ON FUNCTION public\.routes_api_try_spend_scoped\(integer, bigint, bigint, uuid, uuid, integer, integer\) FROM PUBLIC, anon, authenticated;/);
    assert.match(raw, /user_id    uuid        NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    assert.match(raw, /trip_id    uuid        NOT NULL REFERENCES public\.trips\(id\) ON DELETE CASCADE/);
  });
});
