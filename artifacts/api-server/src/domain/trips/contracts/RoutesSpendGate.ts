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
 *
 * Any of them missing, unparseable or not positive is OFF: no unit is taken and
 * no call is made. So is `trip_routes_api_enabled` OFF, absent or unreadable.
 *
 * THE COUNTER IS IN THE DATABASE (migration 3971, `routes_api_try_spend`), so
 * the allowance is shared by every API instance and taken atomically. An
 * unreachable or absent counter is `unavailable`, never `granted`: a gate that
 * cannot count does not spend.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "../../../lib/featureFlags.js";

export const ROUTES_API_FLAG = "trip_routes_api_enabled";

export const SPEND_VERDICTS = ["granted", "off", "quota_exhausted", "budget_exhausted", "unavailable"] as const;
export type SpendVerdict = (typeof SPEND_VERDICTS)[number];

export interface RoutesSpendConfig {
  dailyQuota: number;
  dailyBudgetMicros: number;
  costPerCallMicros: number;
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

/** The configured allowance, or null (= OFF) when any part is missing or invalid. */
export function readRoutesSpendConfig(env: Record<string, string | undefined> = process.env): RoutesSpendConfig | null {
  if (!env["GOOGLE_MAPS_API_KEY"]) return null;
  const dailyQuota = positiveInt(env["ROUTES_API_DAILY_QUOTA"]);
  const dailyBudgetMicros = usdMicros(env["ROUTES_API_DAILY_BUDGET_USD"]);
  const costPerCallMicros = usdMicros(env["ROUTES_API_COST_PER_CALL_USD"]);
  if (dailyQuota === null || dailyBudgetMicros === null || costPerCallMicros === null) return null;
  if (costPerCallMicros > dailyBudgetMicros) return null;
  return { dailyQuota, dailyBudgetMicros, costPerCallMicros };
}

export interface RoutesSpendGate {
  /** Take one call's allowance, or say why not. Never throws. */
  decide(): Promise<SpendVerdict>;
}

export function dbRoutesSpendGate(opts: {
  client: () => SupabaseClient | null;
  config?: () => RoutesSpendConfig | null;
}): RoutesSpendGate {
  const config = opts.config ?? (() => readRoutesSpendConfig());
  return {
    async decide(): Promise<SpendVerdict> {
      const cfg = config();
      if (!cfg) return "off";
      const sc = opts.client();
      if (!sc) return "unavailable";
      try {
        if (!(await isFlagEnabled(sc, ROUTES_API_FLAG))) return "off";
        const { data, error } = await sc.rpc("routes_api_try_spend", {
          p_quota: cfg.dailyQuota,
          p_budget_micros: cfg.dailyBudgetMicros,
          p_cost_micros: cfg.costPerCallMicros,
        });
        if (error) return "unavailable";
        return (SPEND_VERDICTS as readonly string[]).includes(String(data)) && data !== "unavailable"
          ? (data as SpendVerdict)
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
