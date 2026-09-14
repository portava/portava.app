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
 *   trailAffinity          [0, 1] per place FOR THIS VIEWER, contribution capped
 *                          in portavaRank at TRAIL_AFFINITY_MAX_CONTRIBUTION
 *                          (0.10 — the owner's approved initial setting,
 *                          2026-09-14, provisional). Already scaled by `02` §11
 *                          Trail health and DV-25 Trail momentum before it
 *                          leaves TrailService.
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
 * existed — and the exploration governor does not run at all.
 *
 * The governor used to run in "observe" mode with the flag off, recording its
 * hypothetical allocation in the impression feature vector. That was not inert:
 * logImpression writes the feature vector verbatim into `rank_events.features`
 * against the viewer's user_id, so an OFF flag was still shaping per-user rows
 * in production. The OFF path now stamps nothing — the feature vector is
 * byte-identical to the pre-governor pipeline's, which is what "off" has to
 * mean before a flag can be trusted as a rollback.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { loadLocalMomentum, readLocalTrendStates } from "./discoveryLocalMomentum.js";
import type { TrendReading } from "./discoveryTrendState.js";
import { getCityConfidence, type CityConfidence } from "../compass/CompassGraphEngine.js";
import { loadViewerTrailModifier } from "../services/trails/TrailService.js";
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
  /**
   * place id → Trail affinity in [0,1] for THIS VIEWER
   * (services/trails/TrailService.loadViewerTrailModifier), already scaled by
   * `02` §11 Trail health and DV-25 Trail momentum. Empty when the modifiers
   * are off, when no viewer id was supplied, and — the normal case today —
   * when migration 2910 is not applied to the deployment, which the Trail
   * service reports as a refusal rather than as an empty catalogue.
   *
   * THIS ONE IS USER-DEPENDENT, and it is the only field here that is. The
   * momentum map and the city confidence describe the world; this describes the
   * viewer's own follow graph, so a record carrying it must never be shared
   * between viewers or cached across them (`06` §4: "Candidate caches may be
   * user-independent. Final ranking must not be.").
   */
  trailAffinity: Record<string, number>;
  /**
   * `03` §9 place-momentum stage per place — unknown · emerging · trending ·
   * established · cooling · rediscovered — with the three window rates behind
   * it. Empty when the modifiers are off, for the same reason `localMomentum`
   * is: nothing was read, so nothing is known, and an empty map says exactly
   * that. UNSCALED and never fed to the ranker: a stage is an explanation
   * (`03` §11 / `01` §11), not a score, and turning one into a weight would
   * re-open the momentum cap this module exists to respect.
   */
  trendStates: Record<string, TrendReading>;
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
    trailAffinity: {},
    trendStates: {},
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
  /**
   * The viewer this request is being ranked FOR. Drives the Trail modifier and
   * nothing else. Null/absent means no Trail read happens at all — which is the
   * honest behaviour for an anonymous or unidentified request, because a
   * follow-graph modifier with no viewer has nothing to be about.
   */
  viewerId?: string | null;
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

  // `02` Trails as a bounded MODIFIER — the fourth input, and the only
  // user-dependent one. Individually non-fatal on the same principle as the two
  // reads above: a Trail read that refuses (no table, no client, a db error)
  // means "no Trail evidence for this viewer", which is an empty map, not a
  // failed request. In production today that refusal is `trails_unavailable`
  // because migration 2910 is applied to the `portava-ci` rehearsal project
  // only, and this path is the reason that state costs one read and changes no
  // served order.
  //
  // There is deliberately NO `if (!t.refusal)` here. Every refusal branch of
  // loadViewerTrailModifier returns the same empty map, so such a guard could
  // not change an outcome — and a branch nothing can reach is a claim about
  // the code that is not true, which the next reader would take for the reason
  // the map can be empty. The invariant it would have asserted is pinned where
  // it is actually decided, by "every refusal path yields an EMPTY affinity
  // map" in test/discoveryTrailRoutes.test.ts, so a future change that returns
  // rows alongside a refusal fails there rather than leaking through here.
  let trailAffinity: Record<string, number> = {};
  if (typeof params.viewerId === "string" && params.viewerId.length > 0) {
    try {
      trailAffinity = (await loadViewerTrailModifier(
        sc, params.viewerId, params.placeIds, { nowMs },
      )).trailAffinity;
    } catch { trailAffinity = {}; }
  }

  // `03` §9 stages, read out of the SAME cache entry the momentum load just
  // populated — no second query, and no possibility of the stage and the scalar
  // describing different corpora. Unscaled on purpose: see `trendStates` above.
  let trendStates: Record<string, TrendReading> = {};
  try { trendStates = readLocalTrendStates(params.cacheKey, nowMs); } catch { trendStates = {}; }

  return {
    enabled: true, reason: "flag_on",
    localMomentum, trailAffinity, trendStates, cityConfidence, momentumScale, explorationBudgetPct,
  };
}
