/**
 * DISCOVERY_ENGINE_MODE — which discovery execution path handles a request.
 *
 * THE DIRECTIVE THIS SERVES, VERBATIM
 * ===================================
 *   "The flag must control which overall discovery execution path handles the
 *    request, not merely wrap the ranker, because the production cache path can
 *    bypass ranking entirely, and the old-vs-new comparison must measure actual
 *    behaviour users receive rather than new-ranker-vs-old-ranker on traffic
 *    that never reaches either ranker."
 *
 * Why that matters mechanically: the Cache A check at routes/discovery.ts:1113
 * returns BEFORE the Compass block at :1211. The two caches are in series, not
 * parallel, and Cache A's key is user-independent while the ranked output is
 * cached per-user. So for a given (city, category, radius) the ranker runs at
 * most once per 2 h, its output reaches exactly one user, and everyone else gets
 * the raw Overpass order for the next two hours. A flag that wrapped the ranker
 * would switch an engine almost no request reaches.
 *
 * This resolver is therefore consulted ABOVE the cache fork — between the cache
 * key computation and the Cache A check — which is the only position from which
 * a mode can claim a request that would otherwise be answered from cache with no
 * ranking at all.
 *
 * THE RULINGS THIS IMPLEMENTS (operator, 2026-08-14)
 * =================================================
 * D1=B  Named DISCOVERY_ENGINE_MODE and read through lib/featureFlags.ts, NOT
 *       through compass/flags.ts. That module loads flags with
 *       `.like("flag", "COMPASS_%")` (compass/flags.ts:29) and then returns
 *       `flags[flag] ?? false` (:53), so a DISCOVERY_-prefixed flag read through
 *       it would be false with no error, no warning and no log line — and its
 *       30-second cache would hold that false. lib/featureFlags.ts queries
 *       `.eq("flag", flag)` with no prefix constraint, and its getFlagRow is the
 *       only helper at HEAD that reads the `metadata` column at all.
 *
 * D2=A  One row. `enabled` is the master on/off; `metadata.mode` selects the
 *       path. feature_flags.enabled is boolean, so a three-valued mode cannot
 *       ride on it; metadata is jsonb and already exists.
 *
 * D3=B  Every failure state resolves to `legacy`, AND `pde` additionally
 *       requires that the `disable_discovery_pde` stop is not engaged. That stop
 *       is read through isKillSwitchEngaged, whose polarity is inverted on
 *       purpose: a genuine error ENGAGES it. A kill switch that disengages
 *       precisely when the database is unhealthy is not a kill switch, and the
 *       moment you most want to halt PDE is the moment the flag read is least
 *       trustworthy.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ============================
 * It resolves a mode. It does not branch on one. At Stage 1 every mode resolves
 * to the legacy path, which is reached by FALLING THROUGH the existing code
 * rather than by a copy of it (mechanic M2) — a duplicated legacy path would
 * drift from the original and quietly invalidate every comparison the flag
 * exists to produce.
 */
import { getFlagRow, isKillSwitchEngaged } from "./featureFlags.js";
import { logger } from "./logger.js";
import {
  parseDiscoveryCohort, COHORT_NONE,
  type DiscoveryCohort, type CohortParseReason,
} from "./discoveryCohort.js";

export const DISCOVERY_ENGINE_MODE_FLAG = "DISCOVERY_ENGINE_MODE";
export const DISCOVERY_PDE_KILL_SWITCH  = "disable_discovery_pde";

export type DiscoveryEngineMode = "legacy" | "shadow" | "pde";

const VALID_MODES: readonly string[] = ["legacy", "shadow", "pde"];

/**
 * Why the resolver returned what it did. Recorded on every serve observation so
 * a mode can never be inferred from absence — "it was legacy" and "the flag was
 * unreadable" are different facts and must stay distinguishable in the data.
 */
export type ModeReason =
  | "flag_absent"          // no row — the mode has never been configured
  | "flag_disabled"        // row exists, enabled = false
  | "flag_unreadable"      // getFlagRow returned null on error
  | "mode_missing"         // enabled, but metadata carries no mode
  | "mode_invalid"         // enabled, but metadata.mode is not one of the three
  | "kill_switch_engaged"  // mode was pde, but the stop is engaged
  | "no_client"            // no service client available
  | "resolved";            // the configured mode was used as-is

export interface ResolvedMode {
  mode:   DiscoveryEngineMode;
  reason: ModeReason;
  /**
   * WHO the mode applies to (ruling D6). Parsed here so it rides the same
   * 30-second cache as the mode itself and costs no extra read per request.
   *
   * The per-user decision is NOT made here — this resolver is deliberately
   * user-independent, since it sits above the cache fork and is shared across
   * requests. Call `isInDiscoveryCohort(resolved.cohort, userId)` at the point
   * of use.
   *
   * On `legacy` this is always `none`, and that is not a placeholder: legacy is
   * what everyone already gets, so there is no cohort question to answer. A
   * non-`none` cohort on legacy would invite the reading that legacy applies to
   * some users and not others.
   */
  cohort:       DiscoveryCohort;
  cohortReason: CohortParseReason;
}

const LEGACY = (reason: ModeReason): ResolvedMode => ({
  mode: "legacy", reason, cohort: COHORT_NONE, cohortReason: "absent",
});

// ── Cache (mechanic M5) ───────────────────────────────────────────────────────
//
// Unlike the serve log, this read sits ON the response path: it happens before
// the Cache A check, so an uncached read adds a round trip to that request. A
// 30-second TTL — mirroring compass/flags.ts:9, the TTL this codebase already
// uses for flag reads — bounds that to roughly two reads a minute per instance.
// The cost is real and is stated rather than hidden: on the 30-second boundary,
// one otherwise-instant L1 cache hit pays for a flag lookup.

const MODE_TTL_MS = 30_000;
let _cache: { value: ResolvedMode; at: number } | null = null;

/** Invalidate the resolved-mode cache. Exported for tests and admin flag writes. */
export function invalidateDiscoveryEngineModeCache(): void {
  _cache = null;
}

/**
 * Resolve the discovery engine mode for this request.
 *
 * Never throws. Every unexpected state resolves to `legacy`, which is the
 * current production behaviour, so a failure here can only preserve what users
 * already get.
 */
export async function resolveDiscoveryEngineMode(sc: any): Promise<ResolvedMode> {
  if (_cache && Date.now() - _cache.at < MODE_TTL_MS) return _cache.value;

  const resolved = await resolveUncached(sc);
  _cache = { value: resolved, at: Date.now() };
  return resolved;
}

async function resolveUncached(sc: any): Promise<ResolvedMode> {
  try {
    if (!sc) return LEGACY("no_client");

    // getFlagRow is fail-closed: it returns null on error AND on a missing row,
    // so those two cases are not distinguishable here. Both mean "no usable
    // configuration", and both resolve to legacy — the distinction would matter
    // if they resolved differently, and they do not.
    const row = await getFlagRow(sc, DISCOVERY_ENGINE_MODE_FLAG);
    if (!row) return LEGACY("flag_absent");
    if (!row.enabled) return LEGACY("flag_disabled");

    const raw = (row.metadata as Record<string, unknown> | null)?.mode;
    if (raw === undefined || raw === null) return LEGACY("mode_missing");
    if (typeof raw !== "string" || !VALID_MODES.includes(raw)) {
      logger.warn(
        { mode: raw, flag: DISCOVERY_ENGINE_MODE_FLAG },
        "discoveryEngineMode: metadata.mode is not one of legacy|shadow|pde — falling back to legacy",
      );
      return LEGACY("mode_invalid");
    }

    const mode = raw as DiscoveryEngineMode;

    // D3=B — the stop is consulted ONLY for pde. Reading it on every request
    // would double the flag traffic to protect a path that is not running, and
    // its inverted polarity (error ⇒ engaged) would then turn any database
    // hiccup into a forced fallback for modes that never needed the protection.
    if (mode === "pde" && (await isKillSwitchEngaged(sc, DISCOVERY_PDE_KILL_SWITCH))) {
      logger.warn(
        { flag: DISCOVERY_PDE_KILL_SWITCH },
        "discoveryEngineMode: PDE stop engaged — serving legacy",
      );
      return LEGACY("kill_switch_engaged");
    }

    // D6 — parse WHO this mode applies to. Fail-closed in the opposite
    // direction from the mode itself: an unreadable cohort includes NOBODY,
    // because "shadow, but I could not read who for" must never mean "shadow
    // everyone". That failure would arrive as load, not as an error.
    // Legacy carries no cohort, ever. Legacy is what everyone already receives,
    // so there is no "who" to answer, and a populated cohort sitting on legacy
    // would invite exactly one misreading: that legacy applies to some users
    // and not others. Forced here rather than left to every call site to
    // remember.
    if (mode === "legacy") {
      return { mode, reason: "resolved", cohort: COHORT_NONE, cohortReason: "absent" };
    }

    const parsed = parseDiscoveryCohort((row.metadata as Record<string, unknown> | null)?.cohort);
    if (parsed.reason !== "parsed") {
      logger.warn(
        { mode, cohortReason: parsed.reason, flag: DISCOVERY_ENGINE_MODE_FLAG },
        "discoveryEngineMode: mode is non-legacy but metadata.cohort is unusable — cohort is NOBODY, so no request will be affected",
      );
    }

    return { mode, reason: "resolved", cohort: parsed.cohort, cohortReason: parsed.reason };
  } catch (err) {
    // isKillSwitchEngaged already fails closed internally; this catch covers
    // anything else and keeps the resolver total.
    logger.warn({ err }, "discoveryEngineMode: resolution threw — serving legacy");
    return LEGACY("flag_unreadable");
  }
}
