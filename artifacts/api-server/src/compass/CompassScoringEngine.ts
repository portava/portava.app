/**
 * CompassScoringEngine — Phase 2 ranking engine.
 *
 * Runs AFTER Safety + Eligibility + Privacy gates. Only items that have
 * cleared all three gates reach scoring.
 *
 * Score formula (0–100 scale):
 *
 *   finalScore = Σ(positiveComponents) − Σ(penalties)
 *   clamped to [0, 100]
 *
 * Positive components (weights sum to 100):
 *   interestMatch     0–30  — overlap between item tags and viewer's travel styles
 *   cityMatch         0–20  — item city matches viewer's current or preferred city
 *   freshness         0–15  — time decay: score halves every 7 days
 *   trustBoost        0–10  — author's trust score normalised to 0–10
 *   languageMatch     0–10  — item language matches viewer's languages
 *   qualitySignal     0–10  — base quality score on the item (0–10)
 *   contextBoost      0–5   — bonus when item type fits the current context state
 *
 * Penalties (subtracted, never below 0):
 *   reportPenalty     up to 15 — scaled by report count
 *   repetitionPenalty up to 10 — non-zero when repeatCount > 0
 *   spamPenalty       up to 10 — set by isSpam flag
 *
 * Each content type may override component weights via type-specific logic.
 * Top-5 score components are logged to compass_recommendation_scores (fire-and-forget).
 * This function NEVER throws.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";

export interface ScoreComponents {
  interestMatch:     number;
  cityMatch:         number;
  freshness:         number;
  trustBoost:        number;
  languageMatch:     number;
  qualitySignal:     number;
  contextBoost:      number;
  reportPenalty:     number;
  repetitionPenalty: number;
  spamPenalty:       number;
}

export interface ScoreResult {
  finalScore:  number;
  components:  ScoreComponents;
}

const FRESHNESS_HALF_LIFE_DAYS: Record<string, number> = {
  event:        3,
  post:         7,
  notification: 1,
  suggestion:   14,
  stamp:        30,
  user:         90,
  buddy:        90,
  trip:         14,
};

/** Time-decay freshness score (0–15). Halves every half_life days. */
function freshnessScore(createdAt: string | undefined, halfLifeDays: number): number {
  if (!createdAt) return 7; // neutral default
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
  return Math.max(0, 15 * Math.pow(2, -ageDays / halfLifeDays));
}

/** Tag/style overlap score (0–30). Jaccard-like intersection ratio. */
function interestMatchScore(itemTags: string[] | undefined, viewerStyles: string[]): number {
  if (!itemTags || itemTags.length === 0 || viewerStyles.length === 0) return 0;
  const itemSet = new Set(itemTags.map((t) => t.toLowerCase()));
  const viewerSet = new Set(viewerStyles.map((s) => s.toLowerCase()));
  let overlap = 0;
  for (const s of viewerSet) if (itemSet.has(s)) overlap++;
  const union = new Set([...itemSet, ...viewerSet]).size;
  return union > 0 ? Math.min(30, (overlap / union) * 60) : 0;
}

/** City match score (0–20). Checks current city and preferred cities. */
function cityMatchScore(
  itemCity: string | undefined,
  currentCity: string | null,
  preferredCities: string[],
): number {
  if (!itemCity) return 0;
  const itemCityLower = itemCity.toLowerCase();
  if (currentCity && currentCity.toLowerCase() === itemCityLower) return 20;
  if (preferredCities.some((c) => c.toLowerCase() === itemCityLower)) return 10;
  return 0;
}

/** Language match score (0–10). */
function languageMatchScore(
  itemLang: string | undefined,
  viewerLangs: string[],
): number {
  if (!itemLang || viewerLangs.length === 0) return 5; // neutral
  return viewerLangs.map((l) => l.toLowerCase()).includes(itemLang.toLowerCase()) ? 10 : 0;
}

/** Trust boost (0–10). Author trust score normalised from 0–100 to 0–10. */
function trustBoostScore(authorTrustScore: number | undefined | null): number {
  if (authorTrustScore == null) return 3; // neutral for unknown
  return Math.min(10, (authorTrustScore / 100) * 10);
}

/** Quality signal (0–10). Item-level quality rating passed as 0–10. */
function qualitySignalScore(quality: number | undefined | null): number {
  if (quality == null) return 5;
  return Math.min(10, Math.max(0, quality));
}

/** Context boost (0–5). Bonus when item type is specially relevant to context. */
function contextBoostScore(
  itemType: string,
  contextState: string,
): number {
  const boosts: Record<string, string[]> = {
    arrival_mode:       ["event", "user", "stamp"],
    exploring_now:      ["event", "post", "stamp"],
    planning_ahead:     ["trip", "event", "buddy"],
    active_trip_mode:   ["event", "post", "user"],
    night_mode:         ["event", "buddy"],
    safety_mode:        ["notification"],
    active_booking_mode:["buddy", "notification"],
    budget_mode:        ["event", "stamp"],
    creator_mode:       ["suggestion", "post"],
  };
  const relevant = boosts[contextState] ?? [];
  return relevant.includes(itemType) ? 5 : 0;
}

/** Report penalty (0–15). Scaled by report count. */
function reportPenalty(reportCount: number | undefined): number {
  if (!reportCount || reportCount <= 0) return 0;
  return Math.min(15, reportCount * 3);
}

/** Repetition penalty (0–10). Applied when an item has been seen before. */
function repetitionPenalty(repeatCount: number | undefined): number {
  if (!repeatCount || repeatCount <= 0) return 0;
  return Math.min(10, repeatCount * 2);
}

/** Spam penalty (0–10). */
function spamPenalty(isSpam: boolean | undefined): number {
  return isSpam ? 10 : 0;
}

function computeComponents(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
): ScoreComponents {
  const halfLife = FRESHNESS_HALF_LIFE_DAYS[item.type] ?? 7;
  return {
    interestMatch:     interestMatchScore(item.interestTags, [
      ...profile.travelStyles,
      ...(profile.preferredLanguages ?? []),
    ]),
    cityMatch:         cityMatchScore(item.city, profile.currentCity, profile.preferredCities),
    freshness:         freshnessScore(item.createdAt, halfLife),
    trustBoost:        trustBoostScore(item.authorTrustScore),
    languageMatch:     languageMatchScore(item.languageCode, profile.preferredLanguages),
    qualitySignal:     qualitySignalScore(item.qualityScore),
    contextBoost:      contextBoostScore(item.type, context.contextState),
    reportPenalty:     reportPenalty(item.reportCount),
    repetitionPenalty: repetitionPenalty(item.repeatCount),
    spamPenalty:       spamPenalty(item.isSpam),
  };
}

function finalizeScore(c: ScoreComponents): number {
  const raw =
    c.interestMatch +
    c.cityMatch +
    c.freshness +
    c.trustBoost +
    c.languageMatch +
    c.qualitySignal +
    c.contextBoost -
    c.reportPenalty -
    c.repetitionPenalty -
    c.spamPenalty;
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
  // Log top-5 component breakdown as JSONB
  const top5 = Object.entries(result.components)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
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
export function scoreItem(
  item: CompassItem,
  profile: CompassProfile,
  context: CompassContext,
  db: SupabaseClient | null = null,
): ScoreResult {
  try {
    const components = computeComponents(item, profile, context);
    const finalScore = finalizeScore(components);
    const result: ScoreResult = { finalScore, components };
    logScore(db, profile.userId, item, result, context.contextState);
    return result;
  } catch {
    return { finalScore: 0, components: emptyComponents() };
  }
}

function emptyComponents(): ScoreComponents {
  return {
    interestMatch: 0, cityMatch: 0, freshness: 0, trustBoost: 0,
    languageMatch: 0, qualitySignal: 0, contextBoost: 0,
    reportPenalty: 0, repetitionPenalty: 0, spamPenalty: 0,
  };
}

/** Convenience type-specific scorers (all delegate to scoreItem). */
export const scoreEvent       = scoreItem;
export const scorePost        = scoreItem;
export const scoreUser        = scoreItem;
export const scoreBuddy       = scoreItem;
export const scoreTrip        = scoreItem;
export const scoreStamp       = scoreItem;
export const scoreNotification = scoreItem;
export const scoreSuggestion  = scoreItem;
