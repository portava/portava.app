/**
 * discoveryModifiers — the ROADMAP step 7/8 modifiers, assembled per request
 * behind ONE capability flag, seeded OFF (migration 2289).
 *
 * WHAT A "MODIFIER" IS ALLOWED TO BE
 * ==================================
 * ROADMAP step 7: "Taste as the spine; graph, behaviour, trails and CAPPED
 * local_momentum as modifiers only." Step 8: "Exploration and diversity
 * ALLOCATOR — budget ~15-25 % with reason codes, not fixed positions."
 *
 * Every input this module hands the ranker is BOUNDED, and the bound is a
 * constant in code rather than a configuration value:
 *
 *   localMomentum          [0, 1] per place, contribution capped in portavaRank
 *                          at LOCAL_MOMENTUM_MAX_CONTRIBUTION (0.15)
 *   momentumScale          [0.5, 1]   from city confidence — thin cities halve
 *                          the momentum signal, because velocity computed over
 *                          little data is mostly noise
 *   explorationBudgetPct   [15, 25]   from city confidence — thin cities explore
 *                          MORE, because exploration is what the system runs
 *                          when it still needs to learn (the redirect, verbatim)
 *
 * WHY CITY CONFIDENCE, AND WHY ONLY LIKE THIS
 * ===========================================
 * `compass_city_confidence` (Phase 15, CompassGraphEngine.computeCityConfidence-
 * Index) is a per-city DATA-DEPTH score, 0-100, built from aggregate graph
 * signals — visitors, returners, events, outcomes, slice coverage. It says how
 * much the world model knows about a city. It does not say anything about a
 * place, so it is NEVER a per-candidate feature here. It is consumed for the
 * one thing a data-depth score can honestly inform: how far to trust
 * behavioural velocity, and how much of the page to spend on learning. Both
 * uses are monotone, bounded, and default to the THIN end when the record is
 * absent — absence of a confidence row is absence of evidence, and the honest
 * reading of that is "we know little", not "we know enough".
 *
 * BEHAVIOUR WITH THE FLAG OFF — the invariant the ranker HOLD requires
 * ===================================================================
 * `loadDiscoveryModifiers` performs ONE read (the flag, cached 30 s) and
 * returns an inert record: no momentum map, no confidence read, the default
 * budget. lib/discoveryPde.ts then ranks exactly as it did before this module
 * existed. The governor still computes what it WOULD have done — it is pure
 * CPU over data the ranker already holds — and records that in the impression
 * feature vector, so the allocation is observable before it is ever applied.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { loadLocalMomentum } from "./discoveryLocalMomentum.js";
import { getCityConfidence, type CityConfidence } from "../compass/CompassGraphEngine.js";
import {
  GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT,
} from "../services/ranking/FeedSlotAllocator.js";

/** The one flag. Literal name so check-flag-polarity resolves the read. */
export const DISCOVERY_MODIFIERS_FLAG = "discovery_ranking_modifiers_enabled";

/** Momentum is scaled by this at the thin end of city confidence. */
export const MOMENTUM_SCALE_MIN = 0.5;
export const MOMENTUM_SCALE_MAX = 1.0;

export type ModifiersReason = "flag_on" | "flag_off" | "no_client";

export interface DiscoveryModifiers {
  /** True only when the flag read TRUE. Everything below is inert when false. */
  enabled: boolean;
  reason: ModifiersReason;
  /** place id → momentum in [0,1], already scaled by `momentumScale`. Empty when off. */
  localMomentum: Record<string, number>;
  /** The confidence record consulted, or null (not read when off, or absent). */
  cityConfidence: CityConfidence | null;
  /** [MOMENTUM_SCALE_MIN, MOMENTUM_SCALE_MAX] when enabled; 0 in the inert record (nothing to scale). */
  momentumScale: number;
  /** [GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT]. */
  explorationBudgetPct: number;
}

/** The record every caller gets when the modifiers are off. */
export function inertModifiers(reason: ModifiersReason): DiscoveryModifiers {
  return {
    enabled: false,
    reason,
    localMomentum: {},
    cityConfidence: null,
    momentumScale: 0,
    explorationBudgetPct: GOVERNOR_BUDGET_MIN_PCT + (GOVERNOR_BUDGET_MAX_PCT - GOVERNOR_BUDGET_MIN_PCT) / 2,
  };
}

/**
 * Pure: city confidence → the two bounded inputs. Documented bounds:
 *
 *   depthScore   0 → momentumScale 0.5, budget 25 %
 *   depthScore 100 → momentumScale 1.0, budget 15 %
 *   absent/null    → treated as depthScore 0 (thin)
 *
 * Linear in between; clamped at both ends so an out-of-range score (the column
 * is numeric with no CHECK) cannot push either input outside its bound.
 */
export function cityConfidenceInputs(conf: CityConfidence | null): {
  momentumScale: number;
  explorationBudgetPct: number;
} {
  const raw = conf?.depthScore;
  const depth = typeof raw === "number" && Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0;
  const t = depth / 100;
  const momentumScale = MOMENTUM_SCALE_MIN + (MOMENTUM_SCALE_MAX - MOMENTUM_SCALE_MIN) * t;
  const explorationBudgetPct = GOVERNOR_BUDGET_MAX_PCT - (GOVERNOR_BUDGET_MAX_PCT - GOVERNOR_BUDGET_MIN_PCT) * t;
  return {
    momentumScale:        Math.round(Math.min(MOMENTUM_SCALE_MAX, Math.max(MOMENTUM_SCALE_MIN, momentumScale)) * 1000) / 1000,
    explorationBudgetPct: Math.round(Math.min(GOVERNOR_BUDGET_MAX_PCT, Math.max(GOVERNOR_BUDGET_MIN_PCT, explorationBudgetPct)) * 100) / 100,
  };
}

// ── Flag read, 30 s TTL (the discoveryServeLog / engine-mode pattern) ────────

const FLAG_TTL_MS = 30_000;
let _flagCache: { value: boolean; at: number } | null = null;

/** Test hook: forget the cached flag value. */
export function invalidateDiscoveryModifiersFlagCache(): void {
  _flagCache = null;
}

async function modifiersEnabled(sc: any, nowMs: number): Promise<boolean> {
  if (_flagCache && nowMs - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  const value = await isFlagEnabled(sc, DISCOVERY_MODIFIERS_FLAG);
  _flagCache = { value, at: nowMs };
  return value;
}

export interface LoadModifiersParams {
  /** Lowercased destination city, or null. Drives the confidence read. */
  city: string | null;
  /** Candidate place ids — the momentum read is scoped to exactly these. */
  placeIds: readonly string[];
  /** Candidate-set key (destination:category) — the momentum cache key. */
  cacheKey: string;
  nowMs?: number;
}

/**
 * Assemble the modifiers for one request. Never throws. With the flag off this
 * costs one cached flag read and returns `inertModifiers("flag_off")`.
 */
export async function loadDiscoveryModifiers(
  sc: any,
  params: LoadModifiersParams,
): Promise<DiscoveryModifiers> {
  const nowMs = params.nowMs ?? Date.now();
  if (!sc) return inertModifiers("no_client");

  let on = false;
  try { on = await modifiersEnabled(sc, nowMs); } catch { on = false; }
  if (!on) return inertModifiers("flag_off");

  // Both reads are individually non-fatal: a failed confidence read is THIN
  // (the honest default), a failed momentum read is "no surge anywhere".
  let cityConfidence: CityConfidence | null = null;
  try { cityConfidence = await getCityConfidence(sc, params.city); } catch { cityConfidence = null; }
  const { momentumScale, explorationBudgetPct } = cityConfidenceInputs(cityConfidence);

  let rawMomentum: Record<string, number> = {};
  try {
    rawMomentum = await loadLocalMomentum(sc, params.placeIds, { cacheKey: params.cacheKey, nowMs });
  } catch { rawMomentum = {}; }

  const localMomentum: Record<string, number> = {};
  for (const [id, m] of Object.entries(rawMomentum)) {
    const scaled = Math.round(Math.min(1, Math.max(0, m)) * momentumScale * 1000) / 1000;
    if (scaled > 0) localMomentum[id] = scaled;
  }

  return { enabled: true, reason: "flag_on", localMomentum, cityConfidence, momentumScale, explorationBudgetPct };
}
