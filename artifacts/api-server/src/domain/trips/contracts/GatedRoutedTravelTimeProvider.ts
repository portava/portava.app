/**
 * The routed travel-time provider the Trips seams use: Google Routes behind a
 * daily quota and a hard budget, with the straight-line bound as the graceful
 * fallback (census-trips TR128/TR267/TR341/TR412; owner decision 2026-10-04:
 * "Routes API: Yes, for a bounded rollout ... behind a server-side provider
 * interface, set daily quotas and a hard budget, and fall back gracefully when
 * the limit is reached").
 *
 * ONE ESTIMATE, IN ORDER
 *   1. A cached routed answer for the same rounded route in the same 5-minute
 *      bucket (GoogleRoutesTravelTimeProvider.cacheKeyFor) is returned and
 *      spends nothing.
 *   2. Otherwise the READ's budget (RoutesRequestBudget.ts) is consulted: no
 *      budget, no user or trip, the read's call cap reached, or its time budget
 *      spent — the FALLBACK, named (`routes-api-fallback:unscoped` /
 *      `request_hop_cap` / `request_time_budget`). Census-trips §82.
 *   3. Otherwise the spend gate is asked for one unit for this user and trip.
 *      Anything but `granted` — off, quota or budget exhausted, the user's or
 *      the trip's daily share exhausted, the counter unreachable — answers with
 *      the FALLBACK, which names why in its sourceRefs
 *      (`routes-api-fallback:<reason>`).
 *   4. A granted unit makes ONE routed call, abandoned if it would overrun the
 *      read's time budget. An answer is cached and returned; a ROUTED one
 *      carries `assumption: null` — the contract's "a routed provider answered
 *      for the departure it was given", which tells withDepartureAssumptions
 *      not to stack a static band on it. Any answer that is NOT routed (the
 *      adapter's straight-line walk substitution) has `assumption` REMOVED, so
 *      the wrapper gives it the band a static answer needs (census-trips §82;
 *      verifier finding 5 — it was passed through as null and lost the band).
 *      A failure falls back the same way.
 *
 * `routed` IS FALSE ON PURPOSE. This provider does not guarantee a routed
 * answer; whether one IS routed is per result (the engines read
 * `isRoutedSourceClass(estimate.sourceClass)`, and the assumptions wrapper reads
 * `assumption === null`). Claiming `routed: true` statically would strip the
 * departure band from every fallback answer and understate travel time.
 */
import type { TravelTimeProvider, TravelTimeQuery, TravelTimeResult } from "./TravelTimeProvider.js";
import { cacheKeyFor, ROUTED_ESTIMATE_TTL_MS } from "./GoogleRoutesTravelTimeProvider.js";
import type { RoutesSpendGate } from "./RoutesSpendGate.js";
import { currentRoutesRequestBudget } from "./RoutesRequestBudget.js";
import { isRoutedSourceClass } from "../../../lib/travelEstimate.js";

const TIMED_OUT = Symbol("routes-request-time-budget");

/** A routed answer that is not routed must not say "answered for this departure": drop the key. */
function withoutAssumption(r: TravelTimeResult): TravelTimeResult {
  if (r.kind !== "estimate" || !("assumption" in r)) return r;
  const { assumption: _dropped, expectedMinutes: _alsoDropped, ...rest } = r as TravelTimeResult & { assumption?: unknown; expectedMinutes?: unknown };
  return rest as TravelTimeResult;
}

export const GATED_ROUTED_PROVIDER_ID = "google-routes-v2-gated";
export const ROUTED_CACHE_MAX = 2_000;

export function createGatedRoutedTravelTimeProvider(opts: {
  routed: TravelTimeProvider;
  fallback: TravelTimeProvider;
  gate: RoutesSpendGate;
  now?: () => number;
  cacheMax?: number;
}): TravelTimeProvider {
  const now = opts.now ?? (() => Date.now());
  const cacheMax = opts.cacheMax ?? ROUTED_CACHE_MAX;
  const cache = new Map<string, { at: number; result: TravelTimeResult }>();

  const fallbackFor = async (q: TravelTimeQuery, reason: string): Promise<TravelTimeResult> => {
    const r = await opts.fallback.estimate(q);
    if (r.kind !== "estimate") return r;
    return {
      ...r,
      estimate: { ...r.estimate, sourceRefs: [...r.estimate.sourceRefs, `routes-api-fallback:${reason}`] },
    };
  };

  return {
    id: GATED_ROUTED_PROVIDER_ID,
    routed: false,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      const key = cacheKeyFor(q);
      if (key === null) return opts.fallback.estimate(q); // no coordinates: nothing to route, nothing to spend
      const hit = cache.get(key);
      if (hit && now() - hit.at < ROUTED_ESTIMATE_TTL_MS) return hit.result;
      if (hit) cache.delete(key);

      // §82: the read's own bound, before anything is asked of the gate. The
      // attempt is counted BEFORE the first await, so concurrent estimates in
      // one read cannot all slip under the cap.
      const budget = currentRoutesRequestBudget();
      if (!budget || !budget.userId || !budget.tripId) return fallbackFor(q, "unscoped");
      if (budget.counter.attempts >= budget.maxCalls) return fallbackFor(q, "request_hop_cap");
      const remainingMs = budget.budgetMs - (now() - budget.counter.startedAt);
      if (remainingMs <= 0) return fallbackFor(q, "request_time_budget");
      budget.counter.attempts += 1;

      const verdict = await opts.gate.decide({ userId: budget.userId, tripId: budget.tripId });
      if (verdict !== "granted") return fallbackFor(q, verdict);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        opts.routed.estimate(q),
        new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, budget.budgetMs - (now() - budget.counter.startedAt))); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (raced === TIMED_OUT) return fallbackFor(q, "request_time_budget");
      const r = raced;
      if (r.kind !== "estimate") return fallbackFor(q, r.reason);
      // Only a ROUTED source class is "answered for this departure". The Routes
      // adapter substitutes a straight-line walk when walking is faster over a
      // short hop; that answer is static and keeps its departure band — so its
      // `assumption` key is removed, never passed through.
      const answer: TravelTimeResult = isRoutedSourceClass(r.estimate.sourceClass)
        ? { ...r, assumption: null, expectedMinutes: r.estimate.minutes }
        : withoutAssumption(r);
      if (cache.size >= cacheMax) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: now(), result: answer });
      return answer;
    },
  };
}
