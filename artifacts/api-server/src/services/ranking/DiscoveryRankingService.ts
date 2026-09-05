/**
 * DiscoveryRankingService — centralized ranking core (shadow mode).
 *
 * All feed surfaces (Pulse, Compass, Discovery, Search, Nearby, Stories,
 * Events, Trips, Profiles) call rankItems() instead of implementing their
 * own scoring.
 *
 * Architecture:
 *   1. Eligibility gate — any failing item is excluded before scoring.
 *   2. Scoring formula — additive components weighted by ranking_config.
 *   3. Surface-specific profiles — weight overrides per surface.
 *   4. Shadow mode — when ACTIVITY_DISCOVERY_BOOST_ENABLED = false, the
 *      new boosts (activity, newContributor, returningUser, underexposure)
 *      are zeroed out and the caller's original order is preserved.
 *   5. Debug sampling — when RANKING_EXPERIMENT_ENABLED = true, sampled
 *      score breakdowns are written to ranking_debug_samples.
 *
 * This module is API-side only; it does not change the mobile app.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkItemEligibility } from "./EligibilityChecker.js";
import { getActivityParams, getWeights, getPenalties } from "./rankingConfig.js";
import { RankingEvent } from "./rankingAnalytics.js";
import { logger } from "../../lib/logger.js";

// ── Surface names ─────────────────────────────────────────────────────────────

export type SurfaceName =
  | "pulse"
  | "compass"
  | "discovery"
  | "search"
  | "nearby"
  | "story"
  | "event"
  | "trip"
  | "profile"
  | "explore";

// ── Input / output types ──────────────────────────────────────────────────────

export interface RankingInput {
  /** Unique item identifier. */
  itemId: string;
  /** Content type: post | event | trip | buddy | place | user | stamp | story */
  itemType: string;
  /** Creator / author user ID. Null for system content. */
  creatorId: string | null;
  /** ISO creation timestamp. */
  createdAt: string | null;
  /** Item's city (lowercase preferred). */
  city: string | null;
  /** Item's country code. */
  country: string | null;
  /** Interest/category tags. */
  tags: string[];
  /** Primary category slug (e.g. "food", "nightlife"). */
  category: string | null;
  /** BCP-47 language code. */
  languageCode: string | null;
  /** Whether the item has at least one media attachment. */
  hasMedia: boolean;
  /** 0–1 completeness fraction (missing fields = lower score). */
  completeness: number;
  /** 0–1 fraction of positive reviews; null = no reviews yet. */
  positiveReviewRate: number | null;
  /** Moderation / report count. */
  flagCount: number;
  /** Viewer-weighted saves. */
  saveCount: number;
  /** Shares. */
  shareCount: number;
  /** Meaningful comment count (not spam). */
  commentCount: number;
  /** Total impressions recorded (for engagement rate). */
  impressionCount: number;
  /** Distinct unique viewer count (weighted more than repeat). */
  uniqueViewerCount: number;
  /** WGS-84 latitude (for geo relevance). */
  lat: number | null;
  /** WGS-84 longitude (for geo relevance). */
  lng: number | null;
  /** Pre-computed haversine distance from viewer in km. */
  distanceKm: number | null;

  // There is deliberately NO per-item `isFollowedByViewer` here. The follow
  // relationship is read from `RankingViewerContext.followedCreatorIds`
  // (calcRelationshipRelevance) — that is the live path, and the only one.
  // A per-item copy of the same fact used to sit here: assigned by all three
  // callers, read by nothing. It was removed rather than wired, because a
  // second source for one fact is a divergence waiting to happen, and because
  // its presence in test fixtures read as coverage of a signal no test touched.

  // ── Eligibility signals ──────────────────────────────────────────────────
  isDeleted: boolean;
  isExpired: boolean;
  isSuspended: boolean;
  isModerated: boolean;
  isPrivate: boolean;
  isAgeRestricted: boolean;
  minAgeRequired: number | null;
  isGeoRestricted: boolean;
  geoRestrictionCountries: string[] | null;
  authorIsBlockedByViewer: boolean;
  authorBlocksViewer: boolean;
  authorIsMutedByViewer: boolean;
  viewerHasReportedItem: boolean;
  viewerHasHiddenItem: boolean;
  viewerHasHiddenCreator: boolean;

  // ── Optional extra signals ────────────────────────────────────────────────
  /** How many times this item has been shown in this session (repetition penalty). */
  repeatCount: number | null;
  /** Item expiry timestamp (for time-sensitive content). */
  expiresAt: string | null;
  /** Creator's account age in days at item creation time. */
  accountAgeDays: number | null;
  /** Item category the viewer has never explored before (for exploration boost). */
  isUnfamiliarCategory: boolean;
  /** True when the viewer has never been served this item before. */
  isFirstImpression: boolean;
}

export interface RankingViewerContext {
  viewerId: string;
  /** Viewer's travel-style + interest slugs (lowercase). */
  travelStyles: string[];
  preferredLanguages: string[];
  preferredCities: string[];
  currentCity: string | null;
  currentCountry: string | null;
  lat: number | null;
  lng: number | null;
  viewerAge: number | null;
  followedCreatorIds: Set<string>;
  mutedCreatorIds: Set<string>;
  blockedCreatorIds: Set<string>;
  /** Item IDs already seen in this session. */
  seenItemIds: Set<string>;
  /** Session UUID (for debug sample grouping). */
  sessionId: string | null;
  /** ISO timestamp of viewer's last-active event (for returning-user boost). */
  lastActiveAt: string | null;
}

export interface ScoreComponents {
  // Positive
  viewerRelevance: number;
  contentRelevance: number;
  geographicRelevance: number;
  freshness: number;
  contentQuality: number;
  qualityEngagementScore: number;
  relationshipRelevance: number;
  explorationBoost: number;
  activityBoost: number;
  newContributorBoost: number;
  returningUserBoost: number;
  underexposureBoost: number;
  // Negative
  repetitionPenalty: number;
  fatiguePenalty: number;
  negativeFeedbackPenalty: number;
  spamPenalty: number;
}

export interface RankingOutput {
  itemId: string;
  finalScore: number;
  components: ScoreComponents;
  eligibilityPassed: boolean;
  eligibilityReason: string | null;
  explanationKey: string;
}

// ── Surface weight profiles ───────────────────────────────────────────────────

/**
 * Per-surface component weight multipliers (0–1).
 * Default weights (from rankingConfig) are multiplied by these to produce
 * surface-specific priorities. Missing keys use default weight.
 */
interface SurfaceWeightProfile {
  viewerRelevance?: number;
  contentRelevance?: number;
  geographicRelevance?: number;
  freshness?: number;
  contentQuality?: number;
  qualityEngagementScore?: number;
  relationshipRelevance?: number;
  explorationBoost?: number;
  activityBoost?: number;
}

const SURFACE_WEIGHT_PROFILES: Record<SurfaceName, SurfaceWeightProfile> = {
  // Search: query-match relevance dominates; activity is tie-breaker only
  search: {
    viewerRelevance: 2.0,
    contentRelevance: 2.0,
    activityBoost: 0.2,
    freshness: 0.5,
    geographicRelevance: 0.5,
  },
  // Pulse (following): freshness + relationship weight; activity is mild ordering
  pulse: {
    freshness: 1.8,
    relationshipRelevance: 2.0,
    viewerRelevance: 1.2,
    activityBoost: 0.5,
    explorationBoost: 0.8,
  },
  // Compass: balanced — default profile
  compass: {},
  // Discovery: quality + relevance + geo; activity secondary
  discovery: {
    contentQuality: 1.5,
    viewerRelevance: 1.3,
    geographicRelevance: 1.3,
    activityBoost: 0.6,
    freshness: 0.8,
  },
  // Nearby: distance + privacy first; activity secondary quality signal
  nearby: {
    geographicRelevance: 2.5,
    contentQuality: 1.2,
    viewerRelevance: 0.8,
    activityBoost: 0.4,
    freshness: 0.8,
  },
  // Story: recency + relationship + creator cap logic
  story: {
    freshness: 2.0,
    relationshipRelevance: 1.8,
    viewerRelevance: 1.0,
    activityBoost: 0.5,
  },
  // Event: relevance + geo + freshness
  event: {
    geographicRelevance: 1.5,
    freshness: 1.5,
    viewerRelevance: 1.3,
    contentQuality: 1.0,
    activityBoost: 0.6,
  },
  // Trip: relevance + quality
  trip: {
    viewerRelevance: 1.5,
    contentQuality: 1.3,
    freshness: 0.8,
    activityBoost: 0.6,
  },
  // Profile: quality + relationship
  profile: {
    contentQuality: 1.5,
    relationshipRelevance: 1.5,
    viewerRelevance: 1.2,
    activityBoost: 0.5,
  },
  // Explore: exploration + diversity; familiar creators less dominant
  explore: {
    explorationBoost: 2.0,
    viewerRelevance: 1.0,
    contentQuality: 1.2,
    activityBoost: 0.4,
    relationshipRelevance: 0.5,
  },
};

// ── DB lookup helpers ─────────────────────────────────────────────────────────

/**
 * Batch-load creator_activity_scores for a set of creator IDs.
 * Returns a map of creatorId → { score, spam_penalty }.
 * Never throws — missing creators get score=0, spam_penalty=0.
 */
async function batchLoadActivityScores(
  db: SupabaseClient | null,
  creatorIds: string[],
): Promise<Map<string, { score: number; spam_penalty: number }>> {
  const result = new Map<string, { score: number; spam_penalty: number }>();
  if (!db || creatorIds.length === 0) return result;
  try {
    const unique = [...new Set(creatorIds)].slice(0, 200);
    const { data } = await db
      .from("creator_activity_scores")
      .select("user_id, score, spam_penalty")
      .in("user_id", unique);
    for (const row of (data as any[]) ?? []) {
      result.set(row.user_id as string, {
        score:        Number(row.score        ?? 0),
        spam_penalty: Number(row.spam_penalty ?? 0),
      });
    }
  } catch { /* non-fatal */ }
  return result;
}

/**
 * Batch-load content_distribution_stats for a set of item IDs.
 * Returns a map of itemId → underexposure_status.
 */
async function batchLoadUnderexposureStatus(
  db: SupabaseClient | null,
  itemIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!db || itemIds.length === 0) return result;
  try {
    const unique = [...new Set(itemIds)].slice(0, 200);
    const { data } = await db
      .from("content_distribution_stats")
      .select("item_id, underexposure_status")
      .in("item_id", unique)
      .eq("underexposure_status", "boosting");
    for (const row of (data as any[]) ?? []) {
      result.set(row.item_id as string, row.underexposure_status as string);
    }
  } catch { /* non-fatal */ }
  return result;
}

/**
 * Batch-load viewer_creator_fatigue rows for the viewer + a set of creator IDs.
 * Returns a set of creator IDs that are currently on fatigue cooldown.
 */
async function batchLoadFatiguedCreators(
  db: SupabaseClient | null,
  viewerId: string,
  creatorIds: string[],
  nowMs: number,
): Promise<Set<string>> {
  const result = new Set<string>();
  if (!db || creatorIds.length === 0) return result;
  try {
    const unique = [...new Set(creatorIds)].slice(0, 200);
    const { data } = await db
      .from("viewer_creator_fatigue")
      .select("creator_id")
      .eq("viewer_id", viewerId)
      .in("creator_id", unique)
      .gt("expires_at", new Date(nowMs).toISOString());
    for (const row of (data as any[]) ?? []) {
      result.add(row.creator_id as string);
    }
  } catch { /* non-fatal */ }
  return result;
}

/**
 * Load all relevant feature flags in one query.
 * Returns a record of flag → enabled.
 */
async function loadRankingFlags(db: SupabaseClient | null): Promise<Record<string, boolean>> {
  if (!db) return {};
  try {
    const { data } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .in("flag", [
        "ACTIVITY_DISCOVERY_BOOST_ENABLED",
        "NEW_CONTRIBUTOR_BOOST_ENABLED",
        "RETURNING_USER_BOOST_ENABLED",
        "UNDEREXPOSED_CONTENT_BOOST_ENABLED",
        "RANKING_EXPERIMENT_ENABLED",
      ]);
    const out: Record<string, boolean> = {};
    for (const row of (data as any[]) ?? []) {
      out[row.flag as string] = Boolean(row.enabled);
    }
    return out;
  } catch {
    return {};
  }
}

// ── Score component calculators ───────────────────────────────────────────────

/**
 * Time-decay freshness (0–max). Score halves every halfLifeDays days.
 *
 * `nowMs` is the caller's evaluation instant, NOT the wall clock: a surface that
 * pages one ranked set has to score every page at the same moment or this decay
 * moves under it between calls (see RankItemsOptions.nowMs).
 */
function calcFreshness(
  createdAt: string | null,
  halfLifeDays: number,
  max: number,
  nowMs: number,
): number {
  if (!createdAt) return max * 0.5;
  const ageDays = (nowMs - new Date(createdAt).getTime()) / 86_400_000;
  return Math.max(0, max * Math.pow(2, -ageDays / halfLifeDays));
}

/** Jaccard-like interest overlap. */
function calcViewerRelevance(
  itemTags: string[],
  itemLang: string | null,
  viewer: RankingViewerContext,
  max: number,
): number {
  if (max <= 0) return 0;
  const viewerSet = new Set([
    ...viewer.travelStyles.map((s) => s.toLowerCase()),
    ...viewer.preferredLanguages.map((l) => l.toLowerCase()),
    ...viewer.preferredCities.map((c) => c.toLowerCase()),
  ]);
  if (viewerSet.size === 0) return max * 0.3;
  const itemSet = new Set(itemTags.map((t) => t.toLowerCase()));
  if (itemLang) itemSet.add(itemLang.toLowerCase());
  let overlap = 0;
  for (const s of viewerSet) if (itemSet.has(s)) overlap++;
  const union = new Set([...itemSet, ...viewerSet]).size;
  const jaccard = union > 0 ? overlap / union : 0;
  return Math.min(max, jaccard * max * 2);
}

/** Content-relevance: tags + category match. */
function calcContentRelevance(
  itemTags: string[],
  itemCategory: string | null,
  viewer: RankingViewerContext,
  max: number,
): number {
  if (max <= 0) return 0;
  const viewerInterests = new Set(viewer.travelStyles.map((s) => s.toLowerCase()));
  if (viewerInterests.size === 0) return max * 0.3;
  let hits = 0;
  for (const tag of itemTags) {
    if (viewerInterests.has(tag.toLowerCase())) hits++;
  }
  if (itemCategory && viewerInterests.has(itemCategory.toLowerCase())) hits++;
  return Math.min(max, (hits / Math.max(1, viewerInterests.size)) * max * 1.5);
}

/** Distance decay: 0 km = max, 100 km ≈ 0. */
function calcGeographicRelevance(
  distanceKm: number | null,
  city: string | null,
  viewer: RankingViewerContext,
  max: number,
): number {
  if (max <= 0) return 0;
  // Prefer city match when distance not available
  if (distanceKm == null) {
    if (!city || !viewer.currentCity) return max * 0.3;
    return city.toLowerCase() === viewer.currentCity.toLowerCase() ? max * 0.8 : 0;
  }
  // Distance decay: half-life 10 km
  return Math.max(0, max * Math.pow(2, -distanceKm / 10));
}

/** Content quality score. */
function calcContentQuality(input: RankingInput, max: number): number {
  if (max <= 0) return 0;
  const mediaBonus      = input.hasMedia          ? 0.25 : 0;
  const completeness    = input.completeness       * 0.35;
  const reviewBonus     = (input.positiveReviewRate ?? 0.5) * 0.25;
  const flagPenalty     = Math.min(0.15, (input.flagCount / 10) * 0.15);
  return Math.min(max, max * (mediaBonus + completeness + reviewBonus - flagPenalty));
}

/**
 * Weighted engagement rate.
 * Saves > shares > meaningful comments > passive views.
 * Distinct-user count weighted more than repeat engagement.
 */
function calcQualityEngagementScore(input: RankingInput, max: number): number {
  if (max <= 0) return 0;
  const totalImpressions = Math.max(1, input.impressionCount);
  const weightedActions =
    input.saveCount    * 4 +
    input.shareCount   * 3 +
    input.commentCount * 2;
  const actionRate = weightedActions / totalImpressions;
  // Distinct-user bonus (≤50% of score)
  const uniqueRatio = Math.min(
    1,
    input.uniqueViewerCount / Math.max(1, totalImpressions),
  );
  const raw = actionRate * 0.6 + uniqueRatio * 0.4;
  // Saturating transform: 5% engagement ≈ 70% of max
  const saturated = 1 - Math.exp(-raw / 0.05);
  return Math.min(max, max * saturated);
}

/** Relationship relevance: followed accounts score higher. */
function calcRelationshipRelevance(
  input: RankingInput,
  viewer: RankingViewerContext,
  max: number,
): number {
  if (max <= 0) return 0;
  if (!input.creatorId) return 0;
  return viewer.followedCreatorIds.has(input.creatorId) ? max : 0;
}

/** Exploration boost: content from unfamiliar categories the viewer hasn't seen. */
function calcExplorationBoost(input: RankingInput, max: number): number {
  if (max <= 0) return 0;
  if (input.isFirstImpression && input.isUnfamiliarCategory) return max;
  if (input.isFirstImpression) return max * 0.5;
  return 0;
}

/**
 * Activity boost: value read from creator_activity_scores.score,
 * scaled to ACTIVITY_SCORE_MAX_BOOST ceiling.
 * Only applied when ACTIVITY_DISCOVERY_BOOST_ENABLED = true.
 */
function calcActivityBoost(
  activityScore: number,
  maxBoost: number,
): number {
  if (activityScore <= 0) return 0;
  // Activity score is 0–100; scale linearly to maxBoost
  return Math.min(maxBoost, (activityScore / 100) * maxBoost);
}

/** New contributor boost: accounts ≤ 30 days old with meaningful onboarding. */
function calcNewContributorBoost(
  accountAgeDays: number | null,
  completeness: number,
  maxBoost: number,
): number {
  if (accountAgeDays == null || accountAgeDays > 30) return 0;
  if (completeness < 0.3) return 0; // must have completed meaningful onboarding
  // Linear decay from maxBoost at day 0 to 0 at day 30
  const decay = 1 - accountAgeDays / 30;
  return Math.min(maxBoost, maxBoost * decay * Math.min(1, completeness / 0.5));
}

/** Returning-user boost: modest boost when viewer returns after ≥ 14 days. */
function calcReturningUserBoost(
  lastActiveAt: string | null,
  relevanceScore: number,
  maxBoost: number,
  nowMs: number,
): number {
  if (!lastActiveAt) return 0;
  const daysSince = (nowMs - new Date(lastActiveAt).getTime()) / 86_400_000;
  if (daysSince < 14) return 0;
  // Relevance-constrained: only high-relevance items get the returning boost
  const relevanceFraction = Math.min(1, relevanceScore / 20);
  return Math.min(maxBoost, maxBoost * relevanceFraction);
}

/** Repetition penalty: same item shown multiple times this session. */
function calcRepetitionPenalty(repeatCount: number | null, max: number): number {
  if (!repeatCount || repeatCount <= 0) return 0;
  return Math.min(max, repeatCount * (max / 5));
}

/** Fatigue penalty: same creator shown too recently. */
function calcFatiguePenalty(isFatigued: boolean, max: number): number {
  return isFatigued ? max : 0;
}

/** Negative-feedback penalty: hides, reports, or mutes on this item/creator. */
function calcNegativeFeedbackPenalty(
  viewerHasHiddenItem: boolean,
  viewerHasReportedItem: boolean,
  max: number,
): number {
  // These should be excluded at eligibility; this is an extra safety net
  let penalty = 0;
  if (viewerHasHiddenItem)   penalty += max * 0.5;
  if (viewerHasReportedItem) penalty += max * 0.5;
  return Math.min(max, penalty);
}

/** Spam penalty from creator_activity_scores.spam_penalty (0–25). */
function calcSpamPenalty(rawSpamPenalty: number, max: number): number {
  // spam_penalty from CreatorActivityScoreService is already 0–25
  return Math.min(max, (rawSpamPenalty / 25) * max);
}

// ── Analytics event writer ────────────────────────────────────────────────────

/**
 * Write a single ranking analytics event to rank_events asynchronously.
 * Fire-and-forget — never throws.  Errors are logged but never propagate.
 *
 * Safe fields only: event_type, item_id, surface, content_type,
 * user_id (viewer), session_id.  No score components or private PII.
 */
function writeRankAnalyticAsync(
  db:           SupabaseClient | null,
  eventType:    string,
  itemId:       string,
  itemType:     string,
  surface:      SurfaceName,
  viewerId:     string,
  sessionId:    string | null,
): void {
  if (!db) return;
  try {
    void db
      .from("rank_events")
      .insert({
        event_type:   eventType,
        item_id:      itemId,
        content_type: itemType,
        surface,
        user_id:      viewerId,
        session_id:   sessionId ?? null,
        served_at:    new Date().toISOString(),
        // Analytics rows use outcome='analytics' so the impression-finding
        // query (.eq("outcome","impression")) never accidentally matches them.
        outcome:      "analytics",
      })
      .then(
        // A PostgREST rejection RESOLVES with { error } — it does not throw — so
        // the success path has to inspect it. Discarding it here is how a
        // rejected analytics insert became invisible: the failure never reached
        // the error handler, and the error handler said nothing anyway. Same
        // defect class as the one fixed in rankLog.
        (res: { error?: unknown } | null) => {
          if (res?.error) {
            logger.warn(
              { err: res.error, eventType, surface },
              "rankingAnalytics: rank_events insert rejected",
            );
          }
        },
        (err: unknown) => {
          // Non-fatal: analytics must never affect feed latency or correctness.
          logger.warn({ err, eventType, surface }, "rankingAnalytics: rank_events insert threw");
        },
      );
  } catch { /* non-fatal */ }
}

// ── Debug sample writer ───────────────────────────────────────────────────────

const SAMPLE_RATE = 10; // 1-in-10

function writeSampleAsync(
  db: SupabaseClient,
  viewerId: string,
  surface: SurfaceName,
  sessionId: string | null,
  output: RankingOutput,
): void {
  // 1-in-N sampling (deterministic by item position modulo)
  if (Math.random() * SAMPLE_RATE >= 1) return;
  const now = new Date().toISOString();
  db.from("ranking_debug_samples")
    .insert({
      viewer_id:       viewerId,
      item_id:         output.itemId,
      surface,
      session_id:      sessionId ?? null,
      final_score:     output.finalScore,
      components:      output.components,
      explanation_key: output.explanationKey,
      sampled_at:      now,
    })
    .then(() => {}, () => {});
}

// ── Explanation key builder ───────────────────────────────────────────────────

function buildExplanationKey(
  input: RankingInput,
  surface: SurfaceName,
  components: ScoreComponents,
): string {
  const type = input.itemType;
  const base = `${surface}:${type}`;
  if (components.activityBoost > 3)          return `${base}:activity_boost`;
  if (components.newContributorBoost > 0)    return `${base}:new_contributor`;
  if (components.underexposureBoost > 0)     return `${base}:underexposed`;
  if (components.explorationBoost > 0)       return `${base}:exploration`;
  if (components.relationshipRelevance > 0)  return `${base}:following`;
  if (input.city && input.city === "nearby") return `${base}:local`;
  return base;
}

// ── Main service ──────────────────────────────────────────────────────────────

/**
 * Per-call behaviour switches. Unlike RankingServiceTestOverrides these are
 * production settings, chosen by the calling surface.
 */
export interface RankItemsOptions {
  /**
   * Emit ITEM_SCORED, the one remaining UNCONDITIONAL per-candidate analytics
   * row. Default true; Compass and Pulse leave it alone.
   *
   * This is the second half of the reduction #202 began. That change removed
   * ITEM_ELIGIBLE everywhere, on the grounds that it was reconstructable from
   * ITEM_SCORED and had no reader. The same inventory found no reader for
   * ITEM_SCORED either; #202 kept it as the record that scoring happened, and
   * on a surface with a live gate it doubles as proof the item passed.
   *
   * Set false only where the gate is a structural no-op — every eligibility
   * input on that surface is a hardcoded constant. There, the "it passed the
   * gate" half of ITEM_SCORED's meaning records an outcome that could not have
   * been otherwise, and the scoring half is a row nothing reads.
   *
   * It is not free: one single-row PostgREST insert per candidate, un-batched
   * and un-awaited, over the FULL candidate set rather than the served page. On
   * Discovery that set reaches ~180 (60 OSM + 60 curated + 60 canonical), so
   * ~180 fire-and-forget requests per ranked request.
   *
   * NOTHING ELSE is affected. ITEM_INELIGIBLE still fires on every rejection —
   * it is the gate's only informative outcome and costs nothing while the gate
   * rejects nothing. ACTIVITY_BOOST_APPLIED, ACTIVITY_BOOST_CAPPED,
   * FATIGUE_PENALTY_APPLIED and the debug samples are likewise untouched: they
   * fire only when something actually happened.
   */
  emitPerCandidateAnalytics?: boolean;

  /**
   * The instant this ranking is evaluated AT, in epoch ms. Defaults to
   * Date.now(), which is right for a one-shot ranked request.
   *
   * A surface that PAGES one ranked set must pass the same value for every page
   * of the session. Ranking is not a pure function of the candidate set: the
   * freshness half-life decays continuously and creator-fatigue cooldowns
   * expire, so two calls seconds apart score the same items differently. The
   * full set is re-ranked per page and sliced at an offset, so any pair of items
   * whose scores cross between two calls swaps across the slice boundary — and
   * an item that crosses the boundary itself is then served twice, or skipped.
   *
   * This does NOT pin observability timestamps (served_at, debug samples): those
   * record when a row was written, and pinning them would falsify the log.
   */
  nowMs?: number;
}

/**
 * Injectable overrides for unit tests (never use in production).
 */
export interface RankingServiceTestOverrides {
  /** Pre-loaded activity scores keyed by creatorId — skip DB fetch. */
  activityScores?: Map<string, { score: number; spam_penalty: number }>;
  /** Pre-loaded underexposure statuses keyed by itemId — skip DB fetch. */
  underexposureStatus?: Map<string, string>;
  /** Pre-loaded fatigued creator IDs — skip DB fetch. */
  fatiguedCreators?: Set<string>;
  /** Feature flag overrides — skip DB fetch. */
  flags?: Record<string, boolean>;
}

/**
 * Score and sort a batch of items for a given surface.
 *
 * Always runs eligibility first.  Ineligible items are returned with
 * eligibilityPassed=false and finalScore=0, sorted AFTER eligible items so
 * callers can choose to drop them or log them.
 *
 * In shadow mode (ACTIVITY_DISCOVERY_BOOST_ENABLED = false), the items are
 * returned in their ORIGINAL input order with the new-boost components zeroed
 * out so existing ranking behaviour is preserved while scores are computed
 * for offline evaluation.
 *
 * @param inputs       Candidate items to rank.
 * @param surface      Feed surface requesting the ranking.
 * @param viewer       Viewer context (preferences, location, social graph).
 * @param db           Optional Supabase client for DB lookups and debug logging.
 * @param _overrides   Test-only overrides.
 * @param options      Per-call behaviour switches (see RankItemsOptions).
 */
export async function rankItems(
  inputs:     RankingInput[],
  surface:    SurfaceName,
  viewer:     RankingViewerContext,
  db:         SupabaseClient | null = null,
  _overrides: RankingServiceTestOverrides = {},
  options:    RankItemsOptions = {},
): Promise<RankingOutput[]> {
  if (inputs.length === 0) return [];

  // Defaults to ON, so every existing caller keeps writing exactly what it
  // wrote before and only a surface that opts out changes behaviour.
  const emitPerCandidateAnalytics = options.emitPerCandidateAnalytics ?? true;

  // ONE evaluation instant for the whole call. Read once, never per item: the
  // clock ticks mid-loop otherwise, and two items with identical createdAt get
  // different freshness purely from where the millisecond boundary fell.
  // Defaults to now, so a caller that does not page is unaffected.
  const nowMs = options.nowMs ?? Date.now();

  // ── Step 1: load flags + config in parallel ───────────────────────────────
  const [flags, weights, penalties, activityParams] = await Promise.all([
    _overrides.flags != null
      ? Promise.resolve(_overrides.flags)
      : loadRankingFlags(db),
    db ? getWeights(db) : Promise.resolve({
      relevance: 35, freshness: 20, quality: 15,
      activity: 10, engagement: 10, exploration: 5, underexposure: 5,
    }),
    db ? getPenalties(db) : Promise.resolve({
      repetition: 10, fatigue: 8, negativeFeedback: 15,
    }),
    db ? getActivityParams(db) : Promise.resolve({
      maxBoost: 10, decayHalfLifeDays: 14, capScore: 100,
    }),
  ]);

  const shadowMode = !flags["ACTIVITY_DISCOVERY_BOOST_ENABLED"];
  const experimentEnabled = flags["RANKING_EXPERIMENT_ENABLED"] ?? false;
  const newContributorEnabled = !shadowMode && (flags["NEW_CONTRIBUTOR_BOOST_ENABLED"] ?? false);
  const returningUserEnabled  = !shadowMode && (flags["RETURNING_USER_BOOST_ENABLED"] ?? false);
  const underexposureEnabled  = !shadowMode && (flags["UNDEREXPOSED_CONTENT_BOOST_ENABLED"] ?? false);

  // ── Step 2: batch-load DB data for all items in parallel ──────────────────
  const creatorIds = inputs
    .map((i) => i.creatorId)
    .filter((id): id is string => id != null);

  const itemIds = inputs.map((i) => i.itemId);

  const [activityScores, underexposureStatusMap, fatiguedCreators] = await Promise.all([
    _overrides.activityScores != null
      ? Promise.resolve(_overrides.activityScores)
      : batchLoadActivityScores(db, creatorIds),
    underexposureEnabled && _overrides.underexposureStatus == null
      ? batchLoadUnderexposureStatus(db, itemIds)
      : Promise.resolve(_overrides.underexposureStatus ?? new Map<string, string>()),
    _overrides.fatiguedCreators != null
      ? Promise.resolve(_overrides.fatiguedCreators)
      : batchLoadFatiguedCreators(db, viewer.viewerId, creatorIds, nowMs),
  ]);

  // ── Step 3: surface weight profile ────────────────────────────────────────
  const profile = SURFACE_WEIGHT_PROFILES[surface] ?? {};

  const wRelevance      = weights.relevance    * (profile.viewerRelevance      ?? 1);
  const wContent        = weights.relevance    * (profile.contentRelevance     ?? 0.8);
  const wGeo            = weights.relevance    * (profile.geographicRelevance  ?? 0.7);
  const wFreshness      = weights.freshness    * (profile.freshness            ?? 1);
  const wQuality        = weights.quality      * (profile.contentQuality       ?? 1);
  const wEngagement     = weights.engagement   * (profile.qualityEngagementScore ?? 1);
  const wRelationship   = weights.relevance    * (profile.relationshipRelevance  ?? 0.5);
  const wExploration    = weights.exploration  * (profile.explorationBoost       ?? 1);
  const wActivity       = weights.activity     * (profile.activityBoost          ?? 1);
  const wUnderexposure  = weights.underexposure;
  const FRESHNESS_HALF_LIFE = 7; // days

  // ── Step 4: score each item ───────────────────────────────────────────────
  const outputs: RankingOutput[] = [];

  for (const input of inputs) {
    // Eligibility gate (always runs regardless of shadow mode)
    // Build a minimal RankingViewerContext for the checker
    const eligibility = checkItemEligibility(input, viewer);

    if (!eligibility.eligible) {
      outputs.push({
        itemId:            input.itemId,
        finalScore:        0,
        components:        ZERO_COMPONENTS,
        eligibilityPassed: false,
        eligibilityReason: eligibility.reason,
        explanationKey:    `${surface}:${input.itemType}:ineligible`,
      });

      // Analytics: the gate REJECTED this item (fire-and-forget).
      //
      // Until 2026-08-29 a rejection wrote nothing at all, so the gate's only
      // interesting outcome was its only invisible one: "the gate rejected five
      // items" was indistinguishable from "five items were never candidates".
      // Cost is proportional to rejections, which is currently zero on every
      // surface — this is free until the gate does something, and it is the
      // evidence required to show that it did.
      writeRankAnalyticAsync(
        db, RankingEvent.ITEM_INELIGIBLE,
        input.itemId, input.itemType, surface,
        viewer.viewerId, viewer.sessionId ?? null,
      );
      continue;
    }

    // ITEM_ELIGIBLE is deliberately NOT written here any more.
    //
    // It was one row per candidate that carried no information ITEM_SCORED did
    // not already carry. No control flow separates this point from the
    // ITEM_SCORED write below — no return, break, second continue or guard — so
    // every item that emitted ITEM_ELIGIBLE also emitted ITEM_SCORED, with an
    // identical field set (event_type aside). Production confirmed the pairing
    // exactly: 46,677 = 46,677 on pulse, 11,367 = 11,367 on compass.
    //
    // And the inference runs the other way too: an ineligible item is never
    // scored, so the PRESENCE of an ITEM_SCORED row already proves the item
    // passed the gate. Nothing read ITEM_ELIGIBLE — a whole-tree inventory of
    // every rank_events read found no consumer filtering on it — so dropping it
    // halves the per-candidate analytics cost at zero information loss.
    //
    // The constant itself is retained in rankingAnalytics.ts because ~116,000
    // historical rows carry it.

    // Activity data for this item's creator
    const activityData = input.creatorId
      ? (activityScores.get(input.creatorId) ?? { score: 0, spam_penalty: 0 })
      : { score: 0, spam_penalty: 0 };

    const isFatigued = input.creatorId
      ? fatiguedCreators.has(input.creatorId)
      : false;

    const underexposureStatus = underexposureStatusMap.get(input.itemId) ?? null;

    // Component scores (pure functions — no DB I/O)
    const viewerRelevance      = calcViewerRelevance(input.tags, input.languageCode, viewer, wRelevance);
    const contentRelevance     = calcContentRelevance(input.tags, input.category, viewer, wContent);
    const geographicRelevance  = calcGeographicRelevance(input.distanceKm, input.city, viewer, wGeo);
    const freshness            = calcFreshness(input.createdAt, FRESHNESS_HALF_LIFE, wFreshness, nowMs);
    const contentQuality       = calcContentQuality(input, wQuality);
    const qualityEngagement    = calcQualityEngagementScore(input, wEngagement);
    const relationshipRel      = calcRelationshipRelevance(input, viewer, wRelationship);
    const explorationBoost     = calcExplorationBoost(input, wExploration);

    // Shadow-mode-gated boosts (zero when shadow mode is on).
    // The surface profile multiplier scales the boost AFTER the absolute cap
    // (ACTIVITY_SCORE_MAX_BOOST) is applied so the cap never changes per surface —
    // only the contribution to the final score does.
    const rawActivityBoost = shadowMode
      ? 0
      : calcActivityBoost(activityData.score, activityParams.maxBoost);
    const activityBoost = rawActivityBoost * (profile.activityBoost ?? 1);

    const newContributorBoost = newContributorEnabled
      ? calcNewContributorBoost(input.accountAgeDays, input.completeness, activityParams.maxBoost * 0.8)
      : 0;

    const returningUserBoost = returningUserEnabled
      ? calcReturningUserBoost(viewer.lastActiveAt, viewerRelevance, activityParams.maxBoost * 0.5, nowMs)
      : 0;

    const underexposureBoost = underexposureEnabled && underexposureStatus === "boosting"
      ? wUnderexposure
      : 0;

    // Penalties
    const repetitionPenalty      = calcRepetitionPenalty(input.repeatCount, penalties.repetition);
    const fatiguePenalty         = calcFatiguePenalty(isFatigued, penalties.fatigue);
    const negativeFeedbackPenalty = calcNegativeFeedbackPenalty(
      input.viewerHasHiddenItem,
      input.viewerHasReportedItem,
      penalties.negativeFeedback,
    );
    const spamPenalty = calcSpamPenalty(activityData.spam_penalty, penalties.negativeFeedback * 0.5);

    const components: ScoreComponents = {
      viewerRelevance,
      contentRelevance,
      geographicRelevance,
      freshness,
      contentQuality,
      qualityEngagementScore: qualityEngagement,
      relationshipRelevance:  relationshipRel,
      explorationBoost,
      activityBoost,
      newContributorBoost,
      returningUserBoost,
      underexposureBoost,
      repetitionPenalty,
      fatiguePenalty,
      negativeFeedbackPenalty,
      spamPenalty,
    };

    const raw =
      viewerRelevance + contentRelevance + geographicRelevance +
      freshness + contentQuality + qualityEngagement +
      relationshipRel + explorationBoost +
      activityBoost + newContributorBoost + returningUserBoost + underexposureBoost -
      repetitionPenalty - fatiguePenalty - negativeFeedbackPenalty - spamPenalty;

    const finalScore = Math.min(100, Math.max(0, raw));
    const explanationKey = buildExplanationKey(input, surface, components);

    const output: RankingOutput = {
      itemId:            input.itemId,
      finalScore,
      components,
      eligibilityPassed: true,
      eligibilityReason: null,
      explanationKey,
    };

    outputs.push(output);

    // Analytics: item received a final score (fire-and-forget)
    if (emitPerCandidateAnalytics) {
      writeRankAnalyticAsync(
        db, RankingEvent.ITEM_SCORED,
        input.itemId, input.itemType, surface,
        viewer.viewerId, viewer.sessionId ?? null,
      );
    }

    // Analytics: activity boost events (fire-and-forget)
    if (!shadowMode && activityBoost > 0) {
      const boostedEvent =
        rawActivityBoost >= activityParams.maxBoost
          ? RankingEvent.ACTIVITY_BOOST_CAPPED
          : RankingEvent.ACTIVITY_BOOST_APPLIED;
      writeRankAnalyticAsync(
        db, boostedEvent,
        input.itemId, input.itemType, surface,
        viewer.viewerId, viewer.sessionId ?? null,
      );
    }

    // Analytics: fatigue penalty (fire-and-forget)
    if (fatiguePenalty > 0) {
      writeRankAnalyticAsync(
        db, RankingEvent.FATIGUE_PENALTY_APPLIED,
        input.itemId, input.itemType, surface,
        viewer.viewerId, viewer.sessionId ?? null,
      );
    }

    // Debug sample (fire-and-forget)
    if (experimentEnabled && db) {
      writeSampleAsync(db, viewer.viewerId, surface, viewer.sessionId ?? null, output);
    }
  }

  // ── Step 5: sort ──────────────────────────────────────────────────────────
  // In shadow mode: preserve original input order for eligible items so
  // existing ranking is unchanged. Ineligible items still go to the end.
  if (shadowMode) {
    // Separate eligible (original order) from ineligible
    const eligible   = outputs.filter((o) => o.eligibilityPassed);
    const ineligibles = outputs.filter((o) => !o.eligibilityPassed);
    return [...eligible, ...ineligibles];
  }

  // Active mode: sort eligible items by finalScore descending; ineligible at end
  const eligible   = outputs.filter((o) => o.eligibilityPassed).sort((a, b) => b.finalScore - a.finalScore);
  const ineligibles = outputs.filter((o) => !o.eligibilityPassed);
  return [...eligible, ...ineligibles];
}

// ── Zero components constant ──────────────────────────────────────────────────

const ZERO_COMPONENTS: ScoreComponents = {
  viewerRelevance: 0, contentRelevance: 0, geographicRelevance: 0,
  freshness: 0, contentQuality: 0, qualityEngagementScore: 0,
  relationshipRelevance: 0, explorationBoost: 0,
  activityBoost: 0, newContributorBoost: 0, returningUserBoost: 0,
  underexposureBoost: 0, repetitionPenalty: 0, fatiguePenalty: 0,
  negativeFeedbackPenalty: 0, spamPenalty: 0,
};

// ── Exposure denominator: content_distribution_stats on IMPRESSION ────────────
//
// `content_distribution_stats.eligible_impressions` is the exposure denominator
// the underexposure classification divides by (migration 2059, RPC
// increment_distribution_stats): once an item has been SERVED p_threshold times
// its negative-signal rate decides whether it is 'boosting' or 'normal'.
//
// THE DEFECT THIS REPLACES (docs/architecture/00_STATUS.md defect 4,
// docs/fact-layer-20260810/00_VERIFIED_STATE.md §4.6): the only caller of the
// increment was POST /api/rank-events/outcome, so the column counted
// CONVERSIONS, not exposures. An item needed 100 taps/saves — not 100 serves —
// before it was ever classified, and anything normalised by the column
// returned ≈1.0. The outcome handler no longer touches the counter.
//
// SETTLED SEMANTICS: eligible_impressions mirrors the rank_events impression
// rows written for an item on the ranked-corpus surfaces — one increment per
// distinct item per impression batch that actually landed:
//   • lib/rankLog.ts        logImpression        (pulse / discovery / events)
//   • lib/rankLog.ts        logCompassImpression (compass)
//   • lib/discoveryServeLog logDiscoveryServe    (the discovery serve points)
// Not counted: Live Pulse serve rows (urgency-assembled, never ranked), the
// living_page place_view direct write (a view event, not a serve) and media
// watch impressions (their own stats pipeline).
//
// NEGATIVE SIGNALS are the numerator, and they are a different write. An
// impression is never one, so `p_negative_signal` is always false on this path
// — that literal is correct and must stay. The numerator is written by
// recordNegativeDistributionSignal below, from the outcome route, when a viewer
// reports outcome='dismiss'.
//
// THE DEFECT THAT FIXES: until migration 2297 there was NO writer of
// negative_signal_count at all. Nothing anywhere incremented it, so v_negatives
// was 0 for every row, 0/N is never >= the 0.3 suppression rate, and every item
// that crossed the 100-impression threshold classified 'boosting'
// unconditionally. The classifier could not produce a negative verdict — it was
// a constant that read like a measurement, and both FeedSlotAllocator and
// applyModifiers grant a real ranking boost off it.

const UNDEREXPOSURE_THRESHOLD_IMPRESSIONS = 100;
const SUPPRESSION_NEGATIVE_SIGNAL_RATE    = 0.3;

/**
 * Upper bound on increment_distribution_stats calls in flight for one batch.
 *
 * The RPC is per-item, and an impression batch can still be large — a served
 * discovery page runs to 100 items — so the batch is drained through a small
 * worker pool rather than fired all at once. (routes/pulse.ts used to log every
 * RANKED candidate, ~60, rather than the served page; it now logs the page.)
 */
const DISTRIBUTION_STATS_CONCURRENCY = 6;

/**
 * Record one served impression per distinct item against the exposure
 * denominator. Fire-and-forget: never throws, never rejects.
 *
 * Call only for rows that were actually written — a rejected rank_events
 * insert must not move the counter, or the denominator drifts away from the
 * impression log it is supposed to mirror.
 *
 * Returns a promise so the impression loggers (themselves `void`-called by the
 * routes) can await it and tests can observe completion; the caller's response
 * path is never on this promise.
 */
export async function recordImpressionDistributionStats(
  db:       SupabaseClient | null,
  itemIds:  readonly string[],
  viewerId: string,
): Promise<void> {
  try {
    if (!db || typeof (db as any).rpc !== "function") return;
    const unique = [...new Set(
      itemIds.filter((id): id is string => typeof id === "string" && id.length > 0),
    )];
    if (unique.length === 0) return;

    let next = 0;
    let failures = 0;
    let firstError: unknown = null;
    const drain = async (): Promise<void> => {
      while (next < unique.length) {
        const itemId = unique[next++]!;
        try {
          // Atomic INSERT … ON CONFLICT DO UPDATE SET eligible_impressions + 1
          // (2059). Never an upsert with literal values — that reset the
          // counters to 1 on every call once before.
          //
          // supabase-js RESOLVES with { error } on a DB error; inspect it so a
          // rejected increment is visible (one warning per batch, below) instead
          // of the denominator silently drifting under the impression log.
          const { error } = await db.rpc("increment_distribution_stats", {
            p_item_id:          itemId,
            p_viewer_id:        viewerId,
            p_negative_signal:  false,
            p_threshold:        UNDEREXPOSURE_THRESHOLD_IMPRESSIONS,
            p_suppression_rate: SUPPRESSION_NEGATIVE_SIGNAL_RATE,
          });
          if (error) { failures += 1; firstError ??= error; }
        } catch (err) {
          // One item's failure must not stop the batch.
          failures += 1; firstError ??= err;
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(DISTRIBUTION_STATS_CONCURRENCY, unique.length) },
      () => drain(),
    );
    await Promise.all(workers);

    if (failures > 0) {
      logger.warn(
        { err: firstError, failures, count: unique.length },
        "distributionStats: increment_distribution_stats rejected",
      );
    }
  } catch (err) {
    // Never throws into the caller — but never silently either.
    logger.warn({ err }, "distributionStats: recording impressions threw");
  }
}

/**
 * RPC that writes the underexposure NUMERATOR (migration 2297).
 *
 * Deliberately a different function from `increment_distribution_stats`: that
 * one moves eligible_impressions and negative_signal_count in the same
 * statement, so reusing it here would make an outcome inflate the exposure
 * DENOMINATOR — the defect PR #365 removed. Two names, two jobs.
 */
export const NEGATIVE_SIGNAL_RPC = "record_distribution_negative_signal";

/**
 * Record one negative signal against an item's underexposure classification.
 *
 * The ONLY writer of `content_distribution_stats.negative_signal_count`. Called
 * from POST /api/rank-events/outcome when the reported outcome is 'dismiss',
 * which is the only negative outcome the vocabulary carries (2297).
 *
 * Fire-and-forget: never throws, never rejects, and never touches
 * eligible_impressions. A failure is warned once and dropped — a lost negative
 * signal must not fail the outcome write that produced it.
 */
export async function recordNegativeDistributionSignal(
  db:       SupabaseClient | null,
  itemId:   string,
  viewerId: string,
): Promise<void> {
  try {
    if (!db || typeof (db as any).rpc !== "function") return;
    if (typeof itemId !== "string" || itemId.length === 0) return;

    // supabase-js RESOLVES with { error } on a DB error rather than throwing,
    // so the returned error must be inspected or a rejected numerator write is
    // invisible — the failure mode that let living_page impressions vanish for
    // months (migration 0202).
    const { error } = await db.rpc(NEGATIVE_SIGNAL_RPC, {
      p_item_id:          itemId,
      p_viewer_id:        viewerId,
      p_threshold:        UNDEREXPOSURE_THRESHOLD_IMPRESSIONS,
      p_suppression_rate: SUPPRESSION_NEGATIVE_SIGNAL_RATE,
    });
    if (error) {
      logger.warn({ err: error, itemId }, "distributionStats: negative signal rejected");
    }
  } catch (err) {
    logger.warn({ err }, "distributionStats: recording a negative signal threw");
  }
}
