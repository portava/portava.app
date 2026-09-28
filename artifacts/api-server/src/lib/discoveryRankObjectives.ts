/**
 * discoveryRankObjectives — `06` §3's eleven feature families, and `01` §9's
 * five surface objectives expressed as weights over them.
 * census-discovery §78 (lane W10-R2): rows DC-13 and DV-09.
 *
 * WHAT `06` §3 ASKS, VERBATIM
 * ===========================
 *   "Maintain feature families: relevance, travel_intent, freshness, quality,
 *    trust, novelty, social_relevance, place_relevance, trail_relevance,
 *    exploration_value, negative_feedback. Do not collapse everything into one
 *    permanent universal score."
 *
 * portavaRank scores a flat record of feature keys. This module is the VIEW that
 * names which family each key belongs to (`FEATURE_FAMILY`), so the eleven
 * families exist as families — every scored key has exactly one, and every
 * family has at least one term (`src/test/discoveryRankObjectives.test.ts` F1,
 * F2). The two families that had no term before §78 now have one:
 *
 *   trail_relevance    `trailAffinity` (lib/discoveryTrailAffinity.ts, capped 0.10);
 *   negative_feedback  `negativeFeedback` — the viewer's own "Not interested"
 *                      dismissals, at CATEGORY level (portavaRank
 *                      NEGATIVE_FEEDBACK_WEIGHT). A dismissed PLACE is still
 *                      removed by lib/discoveryDismissed.ts and never merely
 *                      down-weighted; this term is what the dismissal says
 *                      about the place's neighbours in the same category.
 *   exploration_value  `explorationValue` — novelty to this viewer, discounted
 *                      by exposure (portavaRank EXPLORATION_VALUE_WEIGHT).
 *
 * WHAT `01` §9 ASKS, VERBATIM, AND HOW EACH SURFACE READS IT
 * ==========================================================
 * Each surface is a vector of FAMILY multipliers (1 = as scored). "Do not
 * collapse everything into one permanent universal score" is exactly this: one
 * scored feature record, five different weightings of it.
 *
 *   Pulse          freshness, local relevance, live context, social context,
 *                  event timing           → freshness ↑, place ↑, social ↑,
 *                                            travel_intent ↑ (availability fit)
 *   Discovery      personalized relevance, novelty, usefulness, diversity,
 *                  travel intent          → relevance ↑, novelty ↑,
 *                                            exploration_value ↑, travel_intent ↑
 *   Trail          Trail relevance, freshness appropriate to content type,
 *                  diversity of contributors, variety of place/experience,
 *                  confidence             → trail ↑, quality/trust ↑; recency
 *                                            per KIND (events fresher, places
 *                                            evergreen); author and place
 *                                            diversity penalties
 *   Trip Planning  itinerary utility, trip fit, route fit, budget/availability,
 *                  save/add-to-trip       → travel_intent ↑↑ (trip fit,
 *                                            availability), place ↑ (route fit
 *                                            ≈ proximity), social ↑ (saves),
 *                                            freshness ↓ (plannable future)
 *   Trending       velocity, independent convergence, confidence, freshness,
 *                  anti-manipulation      → freshness ↑, place ↑ (momentum,
 *                                            still under its owner cap), trust
 *                                            ↑, quality ↑, social ↓ (raw
 *                                            engagement is not convergence)
 *
 * The multipliers are 1.25 for "favour", 1.5 for the surface's defining family,
 * 2 for Trip Planning's trip fit, and 0.75 for "de-emphasise": one step grid,
 * no fitted values, stated as such (decision D-W10-R2-1). v2's fitted weights
 * (portavaRank header) replace them along with everything else. The owner may
 * override any surface's family weights through the flag row's metadata
 * without a deploy (`parseObjectiveOverrides`).
 *
 * THE OWNER-RULED CAPS HOLD UNDER EVERY OBJECTIVE. `localMomentum` and
 * `trailAffinity` are clamped to their caps after re-weighting
 * (portavaRank.rescoreForObjective), so a Trending multiplier on
 * place_relevance cannot turn momentum into a driver.
 *
 * NOTHING HERE IMPORTS services/ranking/rankingConfig.ts (census-discovery
 * §41.4, DC-13 hazard): the families are a view over portavaRank's own keys.
 *
 * PURE. No I/O; the flag read lives in lib/discoveryRankDesigns.ts.
 */
import type { CandidateKind, DiversityOptions, RankObjective } from "./portavaRank.js";

/** `06` §3's eleven families, in the specification's own order. */
export const FEATURE_FAMILIES = [
  "relevance",
  "travel_intent",
  "freshness",
  "quality",
  "trust",
  "novelty",
  "social_relevance",
  "place_relevance",
  "trail_relevance",
  "exploration_value",
  "negative_feedback",
] as const;
export type FeatureFamily = (typeof FEATURE_FAMILIES)[number];

/**
 * Every feature key portavaRank can write → its family. Verbatim keys: a rename
 * in portavaRank that is not made here fails F1 rather than silently dropping a
 * term out of every family.
 */
export const FEATURE_FAMILY: Readonly<Record<string, FeatureFamily>> = Object.freeze({
  // relevance — the viewer's own taste
  interestTag: "relevance",
  categoryAffinity: "relevance",
  kindPrior: "relevance",
  // travel_intent — what the viewer is trying to do now or on this trip
  intentMatch: "travel_intent",
  tripMatch: "travel_intent",
  availabilityFit: "travel_intent",
  capacityOpen: "travel_intent",
  // freshness — age and time-to-start
  recency: "freshness",
  actionability: "freshness",
  // quality
  verifiedBonus: "quality",
  officialPublisher: "quality",
  // trust
  trust: "trust",
  // novelty — already-seen is the negative side of novelty
  seenPenalty: "novelty",
  // social_relevance
  followedAuthor: "social_relevance",
  mutualAuthor: "social_relevance",
  engagedAuthor: "social_relevance",
  socialProof: "social_relevance",
  // place_relevance — where it is, and what is happening there
  cityMatch: "place_relevance",
  neighborhoodMatch: "place_relevance",
  distance: "place_relevance",
  placeEngagement: "place_relevance",
  localMomentum: "place_relevance",
  // trail_relevance
  trailAffinity: "trail_relevance",
  // exploration_value
  explorationValue: "exploration_value",
  // negative_feedback
  negativeFeedback: "negative_feedback",
});

/** The keys of one family. */
export function featuresOfFamily(family: FeatureFamily): string[] {
  return Object.keys(FEATURE_FAMILY).filter((k) => FEATURE_FAMILY[k] === family);
}

/**
 * A scored feature record, summed per family. Keys this module does not know
 * (the governor's annotations, a surface's own extras) are returned under
 * `unfamilied` rather than dropped, so a sum over families plus `unfamilied`
 * always equals the sum over features.
 */
export function familyBreakdown(features: Readonly<Record<string, number>>): Record<FeatureFamily | "unfamilied", number> {
  const out = Object.fromEntries([...FEATURE_FAMILIES, "unfamilied"].map((f) => [f, 0])) as Record<FeatureFamily | "unfamilied", number>;
  for (const [k, v] of Object.entries(features)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[FEATURE_FAMILY[k] ?? "unfamilied"] += v;
  }
  return out;
}

/** `01` §9's five surfaces. */
export const RANK_SURFACES = ["pulse", "discovery", "trail", "trip_planning", "trending"] as const;
export type RankSurface = (typeof RANK_SURFACES)[number];

export type FamilyWeights = Readonly<Partial<Record<FeatureFamily, number>>>;

export interface SurfaceObjectiveSpec {
  surface: RankSurface;
  /** `01` §9's list for this surface, verbatim — what the weights below answer to. */
  favours: readonly string[];
  families: FamilyWeights;
  /** Per-kind family weights (Trail's "freshness appropriate to content type"). */
  kindFamilies?: Readonly<Partial<Record<CandidateKind, FamilyWeights>>>;
  diversity?: DiversityOptions;
}

const FAVOUR = 1.25;
const DEFINING = 1.5;
const DE_EMPHASISE = 0.75;
const TIME_BOUND: readonly CandidateKind[] = ["event", "plan"];
const EVERGREEN: readonly CandidateKind[] = ["place", "gem"];

export const SURFACE_OBJECTIVES: Readonly<Record<RankSurface, SurfaceObjectiveSpec>> = Object.freeze({
  pulse: {
    surface: "pulse",
    favours: ["freshness", "local relevance", "live context", "social context", "event timing"],
    families: { freshness: DEFINING, place_relevance: FAVOUR, social_relevance: FAVOUR, travel_intent: FAVOUR },
  },
  discovery: {
    surface: "discovery",
    favours: ["personalized relevance", "novelty", "usefulness", "diversity", "travel intent"],
    families: { relevance: FAVOUR, novelty: FAVOUR, exploration_value: FAVOUR, travel_intent: FAVOUR },
  },
  trail: {
    surface: "trail",
    favours: ["Trail relevance", "freshness appropriate to content type", "diversity of contributors", "variety of place/experience", "confidence"],
    families: { trail_relevance: DEFINING, quality: FAVOUR, trust: FAVOUR },
    kindFamilies: {
      ...Object.fromEntries(TIME_BOUND.map((k) => [k, { freshness: DEFINING }])),
      ...Object.fromEntries(EVERGREEN.map((k) => [k, { freshness: DE_EMPHASISE }])),
    },
    // Contributors: the creator axis at DEFINING × its v1 magnitude; variety of
    // place: the place axis, which is otherwise off. Kept on the objective so a
    // Trail consumer gets it without a second switch.
    diversity: { authorPenalty: 0.35 * DEFINING, placePenalty: 0.35 },
  },
  trip_planning: {
    surface: "trip_planning",
    favours: ["itinerary utility", "trip fit", "route fit", "budget/availability", "save/add-to-trip behavior"],
    families: { travel_intent: 2, place_relevance: FAVOUR, social_relevance: FAVOUR, freshness: DE_EMPHASISE },
  },
  trending: {
    surface: "trending",
    favours: ["velocity", "independent convergence", "confidence", "freshness", "anti-manipulation"],
    families: { freshness: DEFINING, place_relevance: DEFINING, trust: DEFINING, quality: FAVOUR, social_relevance: DE_EMPHASISE },
  },
});

function familiesToFeatureWeights(f: FamilyWeights): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, fam] of Object.entries(FEATURE_FAMILY)) {
    const m = f[fam];
    if (m !== undefined && m !== 1) out[key] = m;
  }
  return out;
}

/** Resolve a surface to the per-feature multipliers portavaRank applies. */
export function objectiveForSurface(surface: RankSurface, override?: FamilyWeights | null): RankObjective {
  const spec = SURFACE_OBJECTIVES[surface];
  const families = override ? { ...spec.families, ...override } : spec.families;
  const kindFeatureWeights: Partial<Record<CandidateKind, Record<string, number>>> = {};
  for (const [kind, kf] of Object.entries(spec.kindFamilies ?? {}) as Array<[CandidateKind, FamilyWeights]>) {
    kindFeatureWeights[kind] = familiesToFeatureWeights({ ...families, ...kf });
  }
  return {
    surface,
    featureWeights: familiesToFeatureWeights(families),
    ...(spec.kindFamilies ? { kindFeatureWeights } : {}),
    ...(spec.diversity ? { diversity: { ...spec.diversity } } : {}),
  };
}

/** Owner overrides must stay inside [0, 3]; anything else in the metadata is ignored, never guessed at. */
export const OBJECTIVE_MULTIPLIER_MAX = 3;

/**
 * Read `{"surfaces": {"discovery": {"novelty": 1.5}, …}}` from the flag row's
 * metadata. A surface that is absent, null or malformed uses the code's
 * defaults; a family value outside [0, OBJECTIVE_MULTIPLIER_MAX] is dropped.
 */
export function parseObjectiveOverrides(metadata: unknown): Partial<Record<RankSurface, FamilyWeights>> {
  const out: Partial<Record<RankSurface, FamilyWeights>> = {};
  const surfaces = (metadata as { surfaces?: unknown } | null)?.surfaces;
  if (!surfaces || typeof surfaces !== "object") return out;
  for (const s of RANK_SURFACES) {
    const raw = (surfaces as Record<string, unknown>)[s];
    if (!raw || typeof raw !== "object") continue;
    const fw: Partial<Record<FeatureFamily, number>> = {};
    for (const fam of FEATURE_FAMILIES) {
      const v = (raw as Record<string, unknown>)[fam];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= OBJECTIVE_MULTIPLIER_MAX) fw[fam] = v;
    }
    if (Object.keys(fw).length > 0) out[s] = fw;
  }
  return out;
}
