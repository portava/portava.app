/**
 * The daily quota and hard budget in front of every paid Routes API call
 * (census-trips TR128/TR267/TR341/TR412; owner decision 2026-10-04: "set daily
 * quotas and a hard budget, and fall back gracefully when the limit is
 * reached").
 *
 * WHERE THE NUMBERS COME FROM. Deployment configuration, and nowhere else:
 *
 *   ROUTES_API_DAILY_QUOTA         calls per UTC day, a positive integer
 *   ROUTES_API_DAILY_BUDGET_USD    the hard ceiling per UTC day, in USD
 *   ROUTES_API_COST_PER_CALL_USD   the per-request price to count against it —
 *                                  read off Google's own billing page for the
 *                                  SKU in use; this file deliberately carries
 *                                  no price, because a stale one would look
 *                                  like a fact
 *   GOOGLE_MAPS_API_KEY            without a key nothing is spent
 *   ROUTES_API_USER_DAILY_SHARE    calls one USER may take per UTC day, a
 *                                  positive integer no larger than the quota
 *   ROUTES_API_TRIP_DAILY_SHARE    calls one TRIP may take per UTC day, likewise
 *                                  (census-trips §82: without these one member
 *                                  could drain the day's quota for everyone)
 *
 * Any of them missing, unparseable or not positive is OFF: no unit is taken and
 * no call is made. So is `trip_routes_api_enabled` OFF, absent or unreadable.
 *
 * THE COUNTER IS IN THE DATABASE (migration 3971's day row; migration 3973's
 * `routes_api_try_spend_scoped`, which takes the day's unit AND the user's AND
 * the trip's under row locks in one statement sequence, or none of them), so
 * the allowance is shared by every API instance and taken atomically. An
 * unreachable or absent counter is `unavailable`, never `granted`: a gate that
 * cannot count does not spend. A spend with no user or no trip is `unscoped`:
 * there is no share to charge it to.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "../../../lib/featureFlags.js";

export const ROUTES_API_FLAG = "trip_routes_api_enabled";

export const SPEND_VERDICTS = ["granted", "off", "quota_exhausted", "budget_exhausted", "user_share_exhausted", "trip_share_exhausted", "unscoped", "unavailable"] as const;
export type SpendVerdict = (typeof SPEND_VERDICTS)[number];

export interface RoutesSpendConfig {
  dailyQuota: number;
  dailyBudgetMicros: number;
  costPerCallMicros: number;
  userDailyShare: number;
  tripDailyShare: number;
}

/** Whose read a spend is for. Both are required to spend. */
export interface SpendScope {
  userId: string | null;
  tripId: string | null;
}

function positiveInt(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** USD with up to six decimals → micro-USD. Anything else is null, never a guess. */
function usdMicros(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) return null;
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

/**
 * The owner's ceiling (Trips, D-7: "≤ $10/day, 500 requests/day, 5 per person
 * per day, 3 per trip per day"). Configuration may be STRICTER; a value above
 * any of these is not a configuration this deployment may run, so it reads as
 * OFF — never clamped, never partly honoured (census-trips §85).
 */
export const OWNER_ROUTES_CEILING = Object.freeze({
  dailyBudgetMicros: 10_000_000,
  dailyQuota: 500,
  userDailyShare: 5,
  tripDailyShare: 3,
});

/** The configured allowance, or null (= OFF) when any part is missing or invalid, or above the owner's ceiling. */
export function readRoutesSpendConfig(env: Record<string, string | undefined> = process.env): RoutesSpendConfig | null {
  if (!env["GOOGLE_MAPS_API_KEY"]) return null;
  const dailyQuota = positiveInt(env["ROUTES_API_DAILY_QUOTA"]);
  const dailyBudgetMicros = usdMicros(env["ROUTES_API_DAILY_BUDGET_USD"]);
  const costPerCallMicros = usdMicros(env["ROUTES_API_COST_PER_CALL_USD"]);
  const userDailyShare = positiveInt(env["ROUTES_API_USER_DAILY_SHARE"]);
  const tripDailyShare = positiveInt(env["ROUTES_API_TRIP_DAILY_SHARE"]);
  if (dailyQuota === null || dailyBudgetMicros === null || costPerCallMicros === null) return null;
  if (userDailyShare === null || tripDailyShare === null) return null;
  if (costPerCallMicros > dailyBudgetMicros) return null;
  if (userDailyShare > dailyQuota || tripDailyShare > dailyQuota) return null;
  if (dailyBudgetMicros > OWNER_ROUTES_CEILING.dailyBudgetMicros || dailyQuota > OWNER_ROUTES_CEILING.dailyQuota) return null;
  if (userDailyShare > OWNER_ROUTES_CEILING.userDailyShare || tripDailyShare > OWNER_ROUTES_CEILING.tripDailyShare) return null;
  return { dailyQuota, dailyBudgetMicros, costPerCallMicros, userDailyShare, tripDailyShare };
}

export interface RoutesSpendGate {
  /** Take one call's allowance for this user and trip, or say why not. Never throws. */
  decide(scope: SpendScope): Promise<SpendVerdict>;
}

export function dbRoutesSpendGate(opts: {
  client: () => SupabaseClient | null;
  config?: () => RoutesSpendConfig | null;
}): RoutesSpendGate {
  const config = opts.config ?? (() => readRoutesSpendConfig());
  return {
    async decide(scope: SpendScope): Promise<SpendVerdict> {
      const cfg = config();
      if (!cfg) return "off";
      if (!scope?.userId || !scope?.tripId) return "unscoped";
      const sc = opts.client();
      if (!sc) return "unavailable";
      try {
        if (!(await isFlagEnabled(sc, ROUTES_API_FLAG))) return "off";
        const { data, error } = await sc.rpc("routes_api_try_spend_scoped", {
          p_quota: cfg.dailyQuota,
          p_budget_micros: cfg.dailyBudgetMicros,
          p_cost_micros: cfg.costPerCallMicros,
          p_user_id: scope.userId,
          p_trip_id: scope.tripId,
          p_user_share: cfg.userDailyShare,
          p_trip_share: cfg.tripDailyShare,
        });
        if (error) return "unavailable";
        return (SPEND_VERDICTS as readonly string[]).includes(String(data)) && data !== "unavailable" && data !== "unscoped"
          ? (data as SpendVerdict)
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
