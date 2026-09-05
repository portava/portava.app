/**
 * CompassSearchDecayService
 *
 * Manages time-decay for search-signal category weights so that a one-time
 * curiosity search doesn't permanently skew the Compass For You feed.
 *
 * ## Design
 *
 * Each call to POST /compass/signals/search nudges a category weight by the
 * effective applied delta (0 when the weight was already at the ±10 clamp).
 * When the delta is positive, `logSearchNudge` atomically increments the
 * matching row in `compass_search_signal_log` via the
 * `upsert_compass_search_signal` RPC function (single INSERT … ON CONFLICT
 * DO UPDATE — avoids lost-update races from concurrent search signals).
 *
 * The log stores:
 *   - `last_nudge_at`  — timestamp of the most recent effective nudge
 *   - `search_weight`  — cumulative EFFECTIVE search contribution (never
 *                        inflated by clamped-at-max nudges)
 *
 * When `getDecayedWeights` is called (from CompassProfileService on every
 * profile build), it:
 *   1. Reads the search signal log for the user.
 *   2. Reads `SEARCH_SIGNAL_DECAY_DAYS` from feature_flags (default 7).
 *      If the flag is disabled, decay is skipped entirely.
 *   3. For each logged category computes:
 *        age_days       = (now − last_nudge_at) / 86_400_000
 *        decay_factor   = 0.5 ^ (age_days / half_life_days)
 *        effective_sw   = Math.round(search_weight × decay_factor)
 *        weight_to_shed = search_weight − effective_sw
 *      and subtracts `weight_to_shed` from the stored category weight,
 *      clamped to [−10, +10].
 *
 * ## Guarantees
 *
 * - Never throws — all DB errors are caught; a stale weight is always
 *   preferable to a broken profile build.
 * - Decay is read-side only — no background job required, no double-apply risk.
 * - `search_weight` only tracks effective contribution, so decay subtraction
 *   never over-corrects a category that was already capped.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";

/** Default half-life used when the feature_flags row is absent. */
const DEFAULT_DECAY_DAYS = 7;

/** Cap for clamping category weights. */
const WEIGHT_MAX = 10;
const WEIGHT_MIN = -10;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchSignalRow {
  category:      string;
  last_nudge_at: string; // ISO timestamp
  search_weight: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Atomically record an effective search-nudge delta in the signal log.
 *
 * @param delta - The actual weight delta that was applied to category_weights.
 *   Must be > 0; a delta of 0 (weight was already at ±10 clamp) is a no-op
 *   and is silently ignored so `search_weight` only tracks real contribution.
 *
 * Uses the `upsert_compass_search_signal` RPC (single-statement
 * INSERT … ON CONFLICT DO UPDATE) so the increment is atomic.  Never throws.
 */
export async function logSearchNudge(
  db: SupabaseClient,
  userId: string,
  category: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return; // weight was already at cap — nothing contributed
  try {
    // supabase-js RESOLVES (does not throw) on a DB error, so the try/catch alone
    // is dead for the failure that matters (e.g. the RPC/table absent in an
    // under-migrated environment — 42883/42P01). Destructure and log the error
    // so the drift is observable instead of silently swallowed (audit M2). Still
    // non-fatal: the search nudge itself already succeeded.
    const { error } = await (db as any).rpc("upsert_compass_search_signal", {
      p_user_id:  userId,
      p_category: category,
      p_delta:    delta,
    });
    if (error) {
      logger.warn({ err: error, userId, category }, "logSearchNudge: upsert_compass_search_signal failed");
    }
  } catch (err) {
    logger.warn({ err, userId, category }, "logSearchNudge: unexpected error");
  }
}

/**
 * Pure function: given the raw category_weights map and the search signal
 * rows for a user, return a new weights map with time-decayed search
 * contributions subtracted.
 *
 * @param weights     Raw category_weights from compass_user_preferences.
 * @param signalRows  Rows from compass_search_signal_log for this user.
 * @param halfLifeDays  Half-life in days (from SEARCH_SIGNAL_DECAY_DAYS flag).
 * @param nowMs       Current time in ms (injectable for testing).
 */
export function applySearchDecay(
  weights: Record<string, number>,
  signalRows: SearchSignalRow[],
  halfLifeDays: number,
  nowMs: number = Date.now(),
): Record<string, number> {
  if (halfLifeDays <= 0 || signalRows.length === 0) return { ...weights };

  const result = { ...weights };

  for (const row of signalRows) {
    const { category, last_nudge_at, search_weight } = row;
    if (!category || search_weight <= 0) continue;

    const nudgeMs = new Date(last_nudge_at).getTime();
    if (isNaN(nudgeMs)) continue;

    const ageDays      = Math.max(0, (nowMs - nudgeMs) / 86_400_000);
    const decayFactor  = Math.pow(0.5, ageDays / halfLifeDays);
    const effectiveSw  = Math.round(search_weight * decayFactor);
    const weightToShed = search_weight - effectiveSw;

    if (weightToShed <= 0) continue;

    const current = result[category] ?? 0;
    result[category] = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, current - weightToShed));
  }

  return result;
}

/**
 * Read the SEARCH_SIGNAL_DECAY_DAYS flag.
 *
 * Returns `{ enabled: boolean; halfLifeDays: number }`.
 * Falls back to `{ enabled: true, halfLifeDays: DEFAULT_DECAY_DAYS }` on any error.
 */
export async function getDecayConfig(
  db: SupabaseClient,
): Promise<{ enabled: boolean; halfLifeDays: number }> {
  try {
    // `metadata`, not `numeric_value`. feature_flags is (flag, enabled,
    // description, updated_at, metadata jsonb) — there is no numeric column and
    // never was, so naming one failed this read PGRST100 and `data` came back
    // null on EVERY call: the service could not read its own flag, and both the
    // enabled bit and the half-life silently fell through to the defaults.
    //
    // jsonb `metadata` is where every other numeric/structured flag setting in
    // this repo already lives (lib/featureFlags.getFlagRow, discoveryCohort,
    // discoveryEngineMode) — one row per flag, one source of truth, no new
    // column. The key keeps the name the dead column had, so an operator
    // configuring this flag writes { "numeric_value": 30 }.
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled, metadata")
      .eq("flag", "SEARCH_SIGNAL_DECAY_DAYS")
      .maybeSingle();

    if (error) {
      logger.warn({ err: error }, "getDecayConfig: feature_flags read failed — using default decay config");
    }
    if (!data) return { enabled: true, halfLifeDays: DEFAULT_DECAY_DAYS };

    const enabled      = Boolean((data as any).enabled);
    const metadata     = (data as any).metadata as Record<string, unknown> | null | undefined;
    const rawValue     = metadata?.["numeric_value"];
    const halfLifeDays =
      typeof rawValue === "number" && rawValue > 0 ? rawValue : DEFAULT_DECAY_DAYS;

    return { enabled, halfLifeDays };
  } catch {
    return { enabled: true, halfLifeDays: DEFAULT_DECAY_DAYS };
  }
}

/**
 * Fetch signal log rows for a user and return time-decayed category weights.
 *
 * Intended to be called from CompassProfileService after reading
 * category_weights from compass_user_preferences.  Never throws.
 */
export async function getDecayedWeights(
  db: SupabaseClient,
  userId: string,
  weights: Record<string, number>,
): Promise<Record<string, number>> {
  try {
    const config = await getDecayConfig(db);
    if (!config.enabled) return { ...weights };

    const { data, error } = await db
      .from("compass_search_signal_log")
      .select("category, last_nudge_at, search_weight")
      .eq("user_id", userId);

    if (error) {
      // e.g. the whole table absent (42P01) in an under-migrated env — the boost
      // then never decays. Surface it rather than silently returning undecayed.
      logger.warn({ err: error, userId }, "getDecayedWeights: signal log read failed — returning undecayed weights");
    }
    const rows: SearchSignalRow[] = (data as any[]) ?? [];
    if (rows.length === 0) return { ...weights };

    return applySearchDecay(weights, rows, config.halfLifeDays);
  } catch {
    // Non-fatal — return original weights on any failure.
    return { ...weights };
  }
}
