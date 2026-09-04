/**
 * CompassScoringEngine — Phase 2 ranking engine.
 *
 * Runs AFTER Safety + Eligibility + Privacy gates. Only items that have
 * cleared all three gates reach scoring.
 *
 * Each content type has its own weight profile so different signals dominate
 * for different surfaces (e.g. freshness dominates notifications, city match
 * dominates stamps, trust dominates buddy profiles).
 *
 * Positive components (max contribution per type defined in TYPE_WEIGHTS):
 *   interestMatch       — overlap between item tags and viewer's travel styles
 *   cityMatch           — item city vs viewer's current or preferred city
 *   freshness           — time decay; half-life varies by type
 *   trustBoost          — author's trust score normalised to component max
 *   languageMatch       — item language vs viewer's languages
 *   qualitySignal       — base quality score carried on item (0–10 scale)
 *   contextBoost        — bonus when item type fits the current context state
 *   socialCompatibility — item's group type matches viewer's social style
 *   safetyCompatibility — item's safety level matches viewer's safety preference
 *   diversityBoost      — bonus for underrepresented item types
 *   fairExposureBoost   — bonus for authors who haven't appeared recently
 *
 * Penalties (subtracted, final score never below 0):
 *   reportPenalty       — scaled by report count (up to 15)
 *   repetitionPenalty   — scaled by repeatCount (up to 10)
 *   spamPenalty         — flat 10 when isSpam is true
 *   expiredSoonPenalty  — for events expiring within 12h (up to 5)
 *   riskPenalty         — for items with unresolved risk signals (up to 10)
 *
 * Top-5 score components are logged to compass_recommendation_scores (fire-and-forget).
 * This function NEVER throws.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";
import { intentBoost } from "./CompassTemporaryIntent.js";

// ── Per-type weight profiles ──────────────────────────────────────────────────
// Each key is the max contribution of that component for the given content type.
// All maxWeights within a type should sum to 100 (the ceiling before penalties).

interface TypeWeights {
  freshnessHalfLifeDays:  number;
  interestMatch:          number;
  cityMatch:              number;
  freshness:              number;
  trustBoost:             number;
  languageMatch:          number;
  qualitySignal:          number;
  contextBoost:           number;
  socialCompatibility:    number;
  safetyCompatibility:    number;
  diversityBoost:         number;
  fairExposureBoost:      number;
  /** Boost for events where followed users or trip crew are attending. */
  attendanceBoost:        number;
}

const TYPE_WEIGHTS: Record<string, TypeWeights> = {
  event: {
    freshnessHalfLifeDays: 3,
    interestMatch:         25,
    cityMatch:             20,
    freshness:             15,
    trustBoost:             8,
    languageMatch:          7,
    qualitySignal:         10,
    contextBoost:           3,
    socialCompatibility:    4,
    safetyCompatibility:    2,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        6,
  },
  post: {
    freshnessHalfLifeDays: 7,
    interestMatch:         20,
    cityMatch:              8,
    freshness:             20,
    trustBoost:             8,
    languageMatch:          8,
    qualitySignal:         20,
    contextBoost:           5,
    socialCompatibility:    3,
    safetyCompatibility:    3,
    diversityBoost:         2,
    fairExposureBoost:      3,
    attendanceBoost:        0,
  },
  user: {
    freshnessHalfLifeDays: 90,
    interestMatch:         25,
    cityMatch:             15,
    freshness:              5,
    trustBoost:            20,
    languageMatch:         15,
    qualitySignal:          5,
    contextBoost:           5,
    socialCompatibility:    5,
    safetyCompatibility:    5,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
  buddy: {
    freshnessHalfLifeDays: 90,
    interestMatch:         10,
    cityMatch:             25,
    freshness:              5,
    trustBoost:            25,
    languageMatch:         10,
    qualitySignal:         15,
    contextBoost:           5,
    socialCompatibility:    3,
    safetyCompatibility:    2,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
  trip: {
    freshnessHalfLifeDays: 14,
    interestMatch:         20,
    cityMatch:             25,
    freshness:             10,
    trustBoost:            15,
    languageMatch:         10,
    qualitySignal:         10,
    contextBoost:           8,
    socialCompatibility:    0,
    safetyCompatibility:    2,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
  stamp: {
    freshnessHalfLifeDays: 30,
    interestMatch:         15,
    cityMatch:             35,
    freshness:              5,
    trustBoost:             5,
    languageMatch:          5,
    qualitySignal:         20,
    contextBoost:          13,
    socialCompatibility:    0,
    safetyCompatibility:    0,
    diversityBoost:         2,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
  notification: {
    freshnessHalfLifeDays: 1,
    interestMatch:          5,
    cityMatch:              5,
    freshness:             45,
    trustBoost:             5,
    languageMatch:         10,
    qualitySignal:         20,
    contextBoost:          10,
    socialCompatibility:    0,
    safetyCompatibility:    0,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
  suggestion: {
    freshnessHalfLifeDays: 14,
    interestMatch:         30,
    cityMatch:             10,
    freshness:             20,
    trustBoost:             5,
    languageMatch:         15,
    qualitySignal:         15,
    contextBoost:           5,
    socialCompatibility:    0,
    safetyCompatibility:    0,
    diversityBoost:         0,
    fairExposureBoost:      0,
    attendanceBoost:        0,
  },
};

/** Default weights when type is unknown. */
const DEFAULT_WEIGHTS: TypeWeights = {
  freshnessHalfLifeDays: 7,
  interestMatch:         20,
  cityMatch:             15,
  freshness:             15,
  trustBoost:            10,
  languageMatch:         10,
  qualitySignal:         15,
  contextBoost:           5,
  socialCompatibility:    5,
  safetyCompatibility:    3,
  diversityBoost:         1,
  fairExposureBoost:      1,
  attendanceBoost:        0,
};

// ── Component calculation functions ──────────────────────────────────────────

/** Time-decay freshness (0–max). Score halves every half_life days. */
function calcFreshness(createdAt: string | undefined, halfLifeDays: number, max: number): number {
  if (!createdAt) return max * 0.5; // neutral default
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.max(0, max * Math.pow(2, -ageDays / halfLifeDays));
}

/** Jaccard-like tag/style overlap score (0–max). */
function calcInterestMatch(
  itemTags: string[] | undefined,
  viewerStyles: string[],
  max: number,
): number {
  if (max === 0) return 0;
  if (!itemTags || itemTags.length === 0 || viewerStyles.length === 0) return 0;
  const itemSet = new Set(itemTags.map((t) => t.toLowerCase()));
  const viewerSet = new Set(viewerStyles.map((s) => s.toLowerCase()));
  let overlap = 0;
  for (const s of viewerSet) if (itemSet.has(s)) overlap++;
  const union = new Set([...itemSet, ...viewerSet]).size;
  return union > 0 ? Math.min(max, (overlap / union) * max * 2) : 0;
}

/** City match score (0–max). Exact current city > preferred city. */
function calcCityMatch(
  itemCity: string | undefined,
  currentCity: string | null,
  preferredCities: string[],
  max: number,
): number {
  if (max === 0 || !itemCity) return 0;
  const lower = itemCity.toLowerCase();
  if (currentCity && currentCity.toLowerCase() === lower) return max;
  if (preferredCities.some((c) => c.toLowerCase() === lower)) return max * 0.5;
  return 0;
}

/** Language match score (0–max). Exact match = max, no match = 0, unknown = half. */
function calcLanguageMatch(
  itemLang: string | undefined,
  viewerLangs: string[],
  max: number,
): number {
  if (max === 0) return 0;
  if (!itemLang || viewerLangs.length === 0) return max * 0.5;
  return viewerLangs.map((l) => l.toLowerCase()).includes(itemLang.toLowerCase())
    ? max
    : 0;
}

/** Trust boost (0–max). Normalised from author trust score 0–100. */
function calcTrustBoost(authorTrust: number | undefined | null, max: number): number {
  if (max === 0) return 0;
  if (authorTrust == null) return max * 0.3; // neutral for unknown
  return Math.min(max, (authorTrust / 100) * max);
}

/** Quality signal (0–max). Item-level qualityScore is 0–10. */
function calcQualitySignal(quality: number | undefined | null, max: number): number {
  if (max === 0) return 0;
  if (quality == null) return max * 0.5;
  return Math.min(max, Math.max(0, (quality / 10) * max));
}

/** Context boost (0–max). Bonus when item type fits context state. */
const CONTEXT_AFFINITY: Record<string, string[]> = {
  arrival_mode:        ["event", "user", "stamp"],
  exploring_now:       ["event", "post"],
  planning_ahead:      ["trip", "event", "buddy"],
  active_trip_mode:    ["event", "post", "user"],
  night_mode:          ["event", "buddy"],
  safety_mode:         ["notification"],
  active_booking_mode: ["buddy", "notification"],
  budget_mode:         ["event", "stamp"],
  creator_mode:        ["suggestion", "post"],
};
function calcContextBoost(itemType: string, contextState: string, max: number): number {
  if (max === 0) return 0;
  const affinity = CONTEXT_AFFINITY[contextState] ?? [];
  return affinity.includes(itemType) ? max : 0;
}

/**
 * Social compatibility (0–max).
 * Match viewer's socialStyle (solo/group/couple/family) against item's groupType.
 */
function calcSocialCompatibility(
  itemGroupType: string | undefined,
  viewerSocialStyle: string | null,
  max: number,
): number {
  if (max === 0 || !itemGroupType || !viewerSocialStyle) return max * 0.5;
  return itemGroupType.toLowerCase() === viewerSocialStyle.toLowerCase() ? max : 0;
}

/**
 * Safety compatibility (0–max).
 * Higher score when item's safety tier matches viewer's safety preference.
 *
 * safetyTier on item: "standard" | "cautious" | "relaxed" | undefined
 * safetyPreference on profile: "standard" | "cautious" | "relaxed"
 */
function calcSafetyCompatibility(
  itemSafetyTier: string | undefined,
  viewerSafetyPref: string,
  max: number,
): number {
  if (max === 0) return max;
  if (!itemSafetyTier) return max * 0.5;
  if (itemSafetyTier === viewerSafetyPref) return max;
  // cautious viewer seeing relaxed item or vice versa → 0
  if (viewerSafetyPref === "cautious" && itemSafetyTier === "relaxed") return 0;
  // relaxed viewer seeing cautious item → still fine but not optimum
  if (viewerSafetyPref === "relaxed" && itemSafetyTier === "cautious") return max * 0.4;
  return max * 0.6;
}

/**
 * Diversity boost (0–max).
 * Bonus when this item type is underrepresented in the viewer's recent feed.
 * Passed in via item.diversityScore (pre-computed by feed builder in Phase 3).
 */
function calcDiversityBoost(diversityScore: number | undefined, max: number): number {
  if (max === 0) return 0;
  if (diversityScore == null) return 0;
  return Math.min(max, Math.max(0, diversityScore) * max);
}

/**
 * Fair-exposure boost (0–max).
 * Bonus for authors who haven't appeared in the viewer's recent feed.
 * Passed in via item.fairExposureScore (pre-computed by feed builder in Phase 3).
 */
function calcFairExposureBoost(fairExposureScore: number | undefined, max: number): number {
  if (max === 0) return 0;
  if (fairExposureScore == null) return 0;
  return Math.min(max, Math.max(0, fairExposureScore) * max);
}

/**
 * Attendance boost (0–max, events only).
 * Rewards events where followed users or trip crew members are attending.
 * The boost scales logarithmically: 1 friend → 50%, 3+ → 75–100%.
 * Passed in via item.attendingFriendCount (optional numeric field on the item).
 */
function calcAttendanceBoost(attendingFriendCount: number | undefined | null, max: number): number {
  if (max === 0 || !attendingFriendCount || attendingFriendCount <= 0) return 0;
  // log₂(count+1) / log₂(6) → saturates at ~5 friends
  const ratio = Math.min(1, Math.log2(attendingFriendCount + 1) / Math.log2(6));
  return Math.min(max, max * ratio);
}

// ── Penalty calculation functions ─────────────────────────────────────────────

/** Report penalty (0–15). Scaled by report count. */
function calcReportPenalty(reportCount: number | undefined): number {
  if (!reportCount || reportCount <= 0) return 0;
  return Math.min(15, reportCount * 3);
}

/** Repetition penalty (0–10). Applied when item has been shown before. */
function calcRepetitionPenalty(repeatCount: number | undefined): number {
  if (!repeatCount || repeatCount <= 0) return 0;
  return Math.min(10, repeatCount * 2);
}

/** Spam penalty (0–10). */
function calcSpamPenalty(isSpam: boolean | undefined): number {
  return isSpam ? 10 : 0;
}

/**
 * Expired-soon penalty (0–5). For events expiring within 12 hours.
 * Uses item.expiresAt (ISO string).
 */
function calcExpiredSoonPenalty(expiresAt: string | undefined, itemType: string): number {
  if (itemType !== "event" || !expiresAt) return 0;
  const msUntilExpiry = new Date(expiresAt).getTime() - Date.now();
  if (msUntilExpiry < 0) return 5; // already expired (safety should have caught this)
  const hoursUntilExpiry = msUntilExpiry / 3_600_000;
  if (hoursUntilExpiry < 12) return Math.round((1 - hoursUntilExpiry / 12) * 5);
  return 0;
}

/**
 * Risk penalty (0–10). Applied when item has risk signals set.
 * riskScore on item: 0.0–1.0 (higher = more risky)
 */
function calcRiskPenalty(riskScore: number | undefined): number {
  if (riskScore == null || riskScore <= 0) return 0;
  return Math.min(10, Math.round(riskScore * 10));
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ScoreComponents {
  interestMatch:        number;
  cityMatch:            number;
  freshness:            number;
  trustBoost:           number;
  languageMatch:        number;
  qualitySignal:        number;
  contextBoost:         number;
  socialCompatibility:  number;
  safetyCompatibility:  number;
  diversityBoost:       number;
  fairExposureBoost:    number;
  attendanceBoost:      number;
  /**
   * §13 TemporaryIntent addend (0…INTENT_BOOST_MAX). Non-zero only when the
   * request carried a live intent AND the item matches it. Like the
   * place-affinity multiplier, it is a request-scoped signal that lives OUTSIDE
   * the per-type 100 budget — it is added to the raw sum and re-clamped, so a
   * strong intent match reorders mid-ranked candidates without ever exceeding
   * the 0–100 contract.
   */
  temporaryIntentBoost: number;
  reportPenalty:        number;
  repetitionPenalty:    number;
  spamPenalty:          number;
  expiredSoonPenalty:   number;
  riskPenalty:          number;
}

export interface ScoreResult {
  finalScore:  number;
  components:  ScoreComponents;
}

// ── Main scoring function ─────────────────────────────────────────────────────

function computeComponents(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
): ScoreComponents {
  const w = TYPE_WEIGHTS[item.type] ?? DEFAULT_WEIGHTS;
  // Travel styles only — languages have their own component (languageMatch).
  // Mixing preferredLanguages in here diluted interestMatch: language codes
  // never appear in interestTags, so they only inflated the denominator.
  const viewerStyles = profile.travelStyles;

  return {
    // Positive components
    interestMatch:       calcInterestMatch(item.interestTags, viewerStyles, w.interestMatch),
    cityMatch:           calcCityMatch(item.city, profile.currentCity, profile.preferredCities, w.cityMatch),
    freshness:           calcFreshness(item.createdAt, w.freshnessHalfLifeDays, w.freshness),
    trustBoost:          calcTrustBoost(item.authorTrustScore, w.trustBoost),
    languageMatch:       calcLanguageMatch(item.languageCode, profile.preferredLanguages, w.languageMatch),
    qualitySignal:       calcQualitySignal(item.qualityScore, w.qualitySignal),
    contextBoost:        calcContextBoost(item.type, context.contextState, w.contextBoost),
    socialCompatibility: calcSocialCompatibility(item.groupType as string | undefined, profile.socialStyle, w.socialCompatibility),
    safetyCompatibility: calcSafetyCompatibility(item.safetyTier as string | undefined, profile.safetyPreference, w.safetyCompatibility),
    diversityBoost:      calcDiversityBoost(item.diversityScore as number | undefined, w.diversityBoost),
    fairExposureBoost:   calcFairExposureBoost(item.fairExposureScore as number | undefined, w.fairExposureBoost),
    attendanceBoost:     calcAttendanceBoost(item.attendingFriendCount as number | undefined, w.attendanceBoost),
    // §13 intent addend — 0 when the request carried no live intent.
    temporaryIntentBoost: intentBoost(item, context.temporaryIntent),
    // Penalties
    reportPenalty:       calcReportPenalty(item.reportCount),
    repetitionPenalty:   calcRepetitionPenalty(item.repeatCount),
    spamPenalty:         calcSpamPenalty(item.isSpam),
    expiredSoonPenalty:  calcExpiredSoonPenalty(item.expiresAt as string | undefined, item.type),
    riskPenalty:         calcRiskPenalty(item.riskScore as number | undefined),
  };
}

function finalizeScore(c: ScoreComponents): number {
  const raw =
    c.interestMatch + c.cityMatch + c.freshness + c.trustBoost +
    c.languageMatch + c.qualitySignal + c.contextBoost +
    c.socialCompatibility + c.safetyCompatibility +
    c.diversityBoost + c.fairExposureBoost + c.attendanceBoost +
    c.temporaryIntentBoost -
    c.reportPenalty - c.repetitionPenalty - c.spamPenalty -
    c.expiredSoonPenalty - c.riskPenalty;
  return Math.min(100, Math.max(0, raw));
}

/** Fire-and-forget log to DB. Never throws. */
function logScore(
  db: SupabaseClient | null,
  viewerId: string,
  item: CompassItem,
  result: ScoreResult,
  contextState: string,
): void {
  if (!db) return;
  const top5 = Object.entries(result.components)
    .filter(([k]) => !k.includes("Penalty") && !k.includes("penalty"))
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .reduce((acc, [k, v]) => ({ ...acc, [k]: Math.round(v * 100) / 100 }), {});

  db.from("compass_recommendation_scores")
    .insert({
      viewer_id:        viewerId,
      item_id:          item.id,
      item_type:        item.type,
      final_score:      result.finalScore,
      score_components: top5,
      context_state:    contextState,
    })
    .then(() => {}, () => {});
}

/**
 * Score a single item.
 * Only call this after Safety + Eligibility + Privacy gates have passed.
 *
 * @param item      The sanitized item to score
 * @param profile   The calling user's Compass profile
 * @param context   Current Compass context
 * @param db        Optional Supabase client for logging
 */
/** Minimum place_view count required to earn the place-affinity boost. */
const PLACE_AFFINITY_THRESHOLD = 2;
/** Multiplier applied to finalScore when the viewer has place affinity. */
const PLACE_AFFINITY_BOOST = 1.15;

export function scoreItem(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
): ScoreResult {
  try {
    const components = computeComponents(item, profile, context);
    let finalScore = finalizeScore(components);

    // Place-affinity boost: ×1.15 when the viewer has ≥2 place_view events for
    // this item's canonical place in the last 30 days.  Only fires when both
    // item.placeId and context.placeAffinities are present — surfaces that do
    // not build placeAffinities contribute 0 boost cleanly.
    const placeId = item.placeId as string | null | undefined;
    if (placeId && context.placeAffinities) {
      const views = context.placeAffinities[placeId] ?? 0;
      if (views >= PLACE_AFFINITY_THRESHOLD) {
        // Re-clamp after the multiplier: the boost is applied after
        // finalizeScore's 0–100 clamp, so without this cap boosted scores
        // could reach 115 and break the 0–100 score contract.
        finalScore = Math.min(100, finalScore * PLACE_AFFINITY_BOOST);
      }
    }

    const result: ScoreResult = { finalScore, components };
    logScore(db, profile.userId, item, result, context.contextState);
    return result;
  } catch {
    return {
      finalScore: 0,
      components: {
        interestMatch: 0, cityMatch: 0, freshness: 0, trustBoost: 0,
        languageMatch: 0, qualitySignal: 0, contextBoost: 0,
        socialCompatibility: 0, safetyCompatibility: 0,
        diversityBoost: 0, fairExposureBoost: 0, attendanceBoost: 0,
        temporaryIntentBoost: 0,
        reportPenalty: 0, repetitionPenalty: 0, spamPenalty: 0,
        expiredSoonPenalty: 0, riskPenalty: 0,
      },
    };
  }
}

// ── Type-specific named exports (distinct weight profiles loaded above) ────────

export const scoreEvent        = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "event" },        p, c, db ?? null);
export const scorePost         = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "post" },         p, c, db ?? null);
export const scoreUser         = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "user" },         p, c, db ?? null);
export const scoreBuddy        = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "buddy" },        p, c, db ?? null);
export const scoreTrip         = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "trip" },         p, c, db ?? null);
export const scoreStamp        = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "stamp" },        p, c, db ?? null);
export const scoreNotification = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "notification" }, p, c, db ?? null);
export const scoreSuggestion   = (item: CompassItem, p: CompassProfile, c: CompassContext, db?: SupabaseClient | null) =>
  scoreItem({ ...item, type: "suggestion" },   p, c, db ?? null);
