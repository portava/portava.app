/**
 * The LAYOVER spend gate for Google Routes — owner decision R5 (2026-10-18),
 * lane B1-R1.
 *
 * ── THE DECISION THIS FILE CARRIES ───────────────────────────────────────────
 *   (a) A layover read is charged to a LAYOVER-SESSION budget scope, keyed by
 *       the session and the user, with its own caps — built on the existing
 *       RoutesRequestBudget machinery (`withRoutesRequestBudget({ userId,
 *       layoverSessionId })`, opened by `LayoverTravelTime.withLayoverRoutesBudget`).
 *   (b) The caps must allow the per-candidate routing the §8 rows need. D-7's
 *       Trips caps (3 calls per trip per day, 5 per person) cannot: ONE landside
 *       candidate costs two billed calls (the way out, and the way back at the
 *       return instant), so a trip's whole day would route one and a half places.
 *
 * So a layover read is NOT charged to the Trips per-trip or per-person share —
 * not for a trip-less layover (a), and not for a layover that belongs to a trip
 * either, because (b) cannot hold under 3 per trip. The Trips reads keep D-7
 * exactly. What a layover call DOES share with Trips is the day: ONE quota and
 * ONE hard budget per UTC day (3971's `routes_api_daily_usage` row, the owner's
 * $10 / 500-call ceiling), so the Cloud bill has one ceiling, not two.
 *
 * ── THE CAPS, AND THE ARITHMETIC BEHIND THEM ─────────────────────────────────
 * Price (read 2026-10-18 off Google's global price list,
 * developers.google.com/maps/billing-and-pricing/pricing): Compute Routes Pro
 * $10.00 per 1,000 (first 100k; 5,000 free per month) — a DRIVE request asks
 * `routingPreference: TRAFFIC_AWARE`, which is a Pro trigger; Compute Routes
 * Essentials $5.00 per 1,000 (10,000 free) — a WALK request has no Pro feature.
 * The per-call price the gate COUNTS is still `ROUTES_API_COST_PER_CALL_USD`
 * (configuration, never a constant here), so a stale number in this comment
 * cannot under-count the budget; set it to the Pro rate, 0.01.
 *
 *   per READ        12 calls = 6 candidates × 2 legs. `LAYOVER_ROUTES_CAPS.
 *                   candidatesPerRead` is the L260 pre-filter's cut: a city
 *                   read returns at most 8 discovery places, the envelope and
 *                   category filters drop the unreachable and the out-of-hours,
 *                   and the 6 that remain are routed. 12 is also the existing
 *                   per-read hop cap (ROUTES_MAX_CALLS_PER_REQUEST), unchanged.
 *   per SESSION     36 calls, for the session's whole life = THREE fully
 *                   uncached evaluations of 6 candidates. Identical legs inside
 *                   a 5-minute bucket are served from the provider's memo and
 *                   cost nothing, so a traveller who reopens the dashboard
 *                   within minutes spends nothing new; three cold evaluations
 *                   covers "on landing, mid-layover, before heading back".
 *                   Cost: at most 36 × $0.01 = $0.36 per session; a typical
 *                   session (one cold evaluation) 12 × $0.01 = $0.12.
 *   per USER / DAY  60 calls = one fully used session (36) plus a second, shorter
 *                   layover the same day (two cold evaluations, 24). $0.60 at
 *                   most per person per day.
 *   per DAY (all)   the owner's D-7 ceiling, shared with Trips: $10 / 500
 *                   calls. At the per-session cap that is 13 fully-used
 *                   sessions a day, or ~41 typical ones, before the whole
 *                   product falls back — beyond that, every layover answer is
 *                   the named absence, never a straight-line figure presented
 *                   as a route.
 *
 * Configuration may only make these STRICTER (`LAYOVER_ROUTES_SESSION_CAP`,
 * `LAYOVER_ROUTES_USER_DAILY_CAP`); a value above the decided cap, or one that
 * is not a positive integer, is OFF — never clamped, never partly honoured
 * (the census-trips §85 rule `readRoutesSpendConfig` already applies).
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────
 * No key, no day config, a cap above the decision, `layover_routed_corridor_enabled`
 * off / absent / unreadable, no client, an RPC error, an answer outside the
 * vocabulary — each is something other than `granted`, and the provider then
 * asks Google nothing. The counters live in the database (migration 3856's
 * `routes_api_try_spend_layover`, rows locked day → session → user), so the caps
 * hold across every API instance.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "../../lib/featureFlags.js";
import { readRoutesSpendConfig } from "../../domain/trips/contracts/RoutesSpendGate.js";
import { getServiceClient } from "../../lib/supabase.js";

/** Seeded FALSE by migration 3856. The operator's kill switch for every layover Routes call. */
export const LAYOVER_ROUTED_CORRIDOR_FLAG = "layover_routed_corridor_enabled";

/** The spend function migration 3856 creates. */
export const LAYOVER_ROUTES_SPEND_RPC = "routes_api_try_spend_layover";

/** The decided caps (owner decision R5(b)). See the header for the arithmetic. */
export const LAYOVER_ROUTES_CAPS = Object.freeze({
  /** Calls one layover read may ask the gate for — 6 candidates × 2 legs. */
  perReadCalls: 12,
  /** L260: landside candidates routed per read, after the cheap pre-filters. */
  candidatesPerRead: 6,
  /** Calls one layover session may take over its whole life. */
  perSessionCalls: 36,
  /** Calls one person's layover sessions may take per UTC day, all together. */
  perUserDailyCalls: 60,
});

export const LAYOVER_SPEND_VERDICTS = [
  "granted", "off", "quota_exhausted", "budget_exhausted",
  "session_share_exhausted", "user_share_exhausted", "unscoped", "unavailable",
] as const;
export type LayoverSpendVerdict = (typeof LAYOVER_SPEND_VERDICTS)[number];

export interface LayoverSpendScope {
  userId: string | null;
  layoverSessionId: string | null;
}

export interface LayoverRoutesSpendConfig {
  dailyQuota: number;
  dailyBudgetMicros: number;
  costPerCallMicros: number;
  sessionCap: number;
  userDailyCap: number;
}

function capFrom(v: string | undefined, ceiling: number): number | null {
  if (v === undefined) return ceiling;
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n > 0 && n <= ceiling ? n : null;
}

/**
 * The layover allowance, or null (= OFF).
 *
 * The DAY's quota, budget, price and key are read by the ONE parser Trips uses
 * (`readRoutesSpendConfig`), against the owner's ceiling. Its two Trips-only
 * terms — the per-person and per-trip shares — are not a layover's caps (R5),
 * so they are pinned to 1 in the view handed to it: they are validated against
 * nothing a layover spends, and a deployment that has not configured them is
 * not thereby refused layover routing.
 */
export function readLayoverRoutesSpendConfig(
  env: Record<string, string | undefined> = process.env,
): LayoverRoutesSpendConfig | null {
  const day = readRoutesSpendConfig({ ...env, ROUTES_API_USER_DAILY_SHARE: "1", ROUTES_API_TRIP_DAILY_SHARE: "1" });
  if (!day) return null;
  const sessionCap = capFrom(env["LAYOVER_ROUTES_SESSION_CAP"], LAYOVER_ROUTES_CAPS.perSessionCalls);
  const userDailyCap = capFrom(env["LAYOVER_ROUTES_USER_DAILY_CAP"], LAYOVER_ROUTES_CAPS.perUserDailyCalls);
  if (sessionCap === null || userDailyCap === null) return null;
  if (sessionCap > day.dailyQuota || userDailyCap > day.dailyQuota) return null;
  return {
    dailyQuota: day.dailyQuota,
    dailyBudgetMicros: day.dailyBudgetMicros,
    costPerCallMicros: day.costPerCallMicros,
    sessionCap,
    userDailyCap,
  };
}

export interface LayoverRoutesSpendGate {
  /** Take one call's allowance for this session and person, or say why not. Never throws. */
  decide(scope: LayoverSpendScope): Promise<LayoverSpendVerdict>;
}

export function dbLayoverRoutesSpendGate(opts: {
  client: () => SupabaseClient | null;
  config?: () => LayoverRoutesSpendConfig | null;
}): LayoverRoutesSpendGate {
  const config = opts.config ?? (() => readLayoverRoutesSpendConfig());
  return {
    async decide(scope: LayoverSpendScope): Promise<LayoverSpendVerdict> {
      const cfg = config();
      if (!cfg) return "off";
      if (!scope?.userId || !scope?.layoverSessionId) return "unscoped";
      const sc = opts.client();
      if (!sc) return "unavailable";
      try {
        if (!(await isFlagEnabled(sc, LAYOVER_ROUTED_CORRIDOR_FLAG))) return "off";
        const { data, error } = await sc.rpc(LAYOVER_ROUTES_SPEND_RPC, {
          p_quota: cfg.dailyQuota,
          p_budget_micros: cfg.dailyBudgetMicros,
          p_cost_micros: cfg.costPerCallMicros,
          p_user_id: scope.userId,
          p_session_id: scope.layoverSessionId,
          p_session_cap: cfg.sessionCap,
          p_user_daily_cap: cfg.userDailyCap,
        });
        if (error) { logger.warn({ rpc: LAYOVER_ROUTES_SPEND_RPC, code: error.code, message: error.message }, "layover Routes spend gate: the spend function failed; answering unavailable (no call is made)"); return "unavailable"; }
        return (LAYOVER_SPEND_VERDICTS as readonly string[]).includes(String(data)) && data !== "unavailable"
          ? (data as LayoverSpendVerdict)
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}

/** The gate on the service client, built once on first use (no client is read at import). */
let defaultGate: LayoverRoutesSpendGate | null = null;
export function layoverRoutesSpendGate(): LayoverRoutesSpendGate {
  defaultGate ??= dbLayoverRoutesSpendGate({ client: () => getServiceClient() });
  return defaultGate;
}

// Imported at the TAIL so no cited line above moves; ESM hoists it. C2 (L294): a failed spend is logged, never silent.
import { logger } from "../../lib/logger.js";
