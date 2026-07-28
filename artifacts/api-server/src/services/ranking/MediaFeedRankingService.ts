/**
 * MediaFeedRankingService — media-specific ranking for Watch (For You),
 * Grid, and Gems feeds.
 *
 * Architecture:
 *   1. Base scoring via portavaRank.scoreCandidate (unified relevance core).
 *   2. Media-specific signal multipliers (watch completion, qualified views,
 *      re-watches, saves, place actions).
 *   3. Negative feedback penalties (Not Interested, Hide).
 *   4. Creator frequency cap + per-viewer per-session fatigue layer.
 *   5. Boost layer with diminishing returns:
 *        - activeCreatorBoost  (MEDIA_ACTIVE_CREATOR_BOOST_ENABLED)
 *        - newCreatorBoost     (MEDIA_NEW_CREATOR_BOOST_ENABLED)
 *        - returningCreatorBoost (MEDIA_RETURNING_CREATOR_BOOST_ENABLED)
 *        - underexposedBoost   (MEDIA_UNDEREXPOSED_BOOST_ENABLED)
 *   6. Per-viewer per-session fatigue   (MEDIA_CREATOR_FATIGUE_ENABLED)
 *   7. Diversity re-ranking pass (city, category, creator).
 *   8. Gems-specific branch (place accuracy, wrong-place penalty,
 *        add-to-trip, directions, place uniqueness, destination diversity).
 *   9. Ranking snapshot storage for "Why This?" (MEDIA_RANKING_ENABLED).
 *
 * Flag contract:
 *   MEDIA_RANKING_ENABLED          — master switch. When false, returns
 *                                    chronological order with no scoring.
 *   MEDIA_ACTIVE_CREATOR_BOOST_ENABLED
 *   MEDIA_NEW_CREATOR_BOOST_ENABLED
 *   MEDIA_RETURNING_CREATOR_BOOST_ENABLED
 *   MEDIA_UNDEREXPOSED_BOOST_ENABLED
 *   MEDIA_CREATOR_FATIGUE_ENABLED
 *
 * Pure / testable: flags and DB data are injected as parameters so unit
 * tests never need a live DB.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  scoreCandidate,
  diversify,
  DEFAULT_WEIGHTS,
  PUBLISHER_BOOST,
  type RankCandidate,
  type ViewerContext,
  type ScoredCandidate,
  type DiversityOptions,
} from "../../lib/portavaRank.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MediaFeedMode = "for_you" | "following" | "grid" | "gems";

/** Default featured boost multiplier (1.4×). */
export const FEATURED_BOOST_MULTIPLIER = 1.4;
/** Window (ms) during which the featured boost applies after featuring. */
export const FEATURED_BOOST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Extended candidate carrying media-specific signals. */
export interface MediaFeedItem extends RankCandidate {
  /** 0–1 fraction of total duration the average viewer watched. */
  watchCompletionRate?: number | null;
  /** Total qualified views (watched ≥ 3 s). */
  qualifiedViewCount?: number | null;
  /** Re-watch rate: rewatches / qualified views. */
  rewatchRate?: number | null;
  /** Fraction of impressions that were hidden / "Not Interested". */
  hideRate?: number | null;
  /** Raw hide count (for penalty calculation). */
  hideCount?: number | null;
  /** Raw "not interested" count. */
  notInterestedCount?: number | null;
  /** Total impressions served (for rate calculations). */
  totalImpressionCount?: number | null;

  // ── Gems-specific fields ──────────────────────────────────────────────────
  /** 1 = verified, 0.7 = community-verified, 0.4 = pending. */
  placeAccuracyScore?: number | null;
  /** Fraction of impressions that resulted in wrong-place reports. */
  wrongPlaceReportRate?: number | null;
  /** Add-to-Trip engagement rate. */
  addToTripRate?: number | null;
  /** Directions engagement rate. */
  directionsRate?: number | null;
  /**
   * Inverse of how many other Gems items share the same place (0–1).
   * 1 = unique place, 0 = highly saturated.
   */
  placeUniqueness?: number | null;

  // ── Publisher signal ──────────────────────────────────────────────────────
  /**
   * True when the author is the @Portava official publisher account
   * (profiles.is_official = true).  Triggers PUBLISHER_BOOST and exempts
   * the item from per-creator frequency caps.
   */
  isOfficialPublisher?: boolean | null;

  /**
   * ISO timestamp of when this post was featured by Portava.
   * Null/absent when the post has not been featured.
   * Used to apply the FEATURED_BOOST within the 7-day window.
   */
  featuredAt?: string | null;
  /** Feature category (e.g. "best_hidden_gem"). Non-null when featuredAt is set. */
  featuredByPortava?: string | null;

  // ── Creator / account metadata ────────────────────────────────────────────
  /** How many days since the creator's account was created. */
  creatorAccountAgeDays?: number | null;
  /** ISO timestamp of the creator's last published post before this one. */
  creatorLastPostAt?: string | null;
  /** Posts published by this creator in the last 7 days. */
  creatorWeeklyPostCount?: number | null;
  /** How many times the viewer has seen THIS creator in this session. */
  sessionCreatorImpressionCount?: number | null;
}

/** Per-session state passed in from the feed endpoint. */
export interface MediaSessionState {
  /** How many times the viewer has seen each creator this session. */
  creatorImpressions: Map<string, number>;
}

/** Flags that control each boost independently. */
export interface MediaRankingFlags {
  rankingEnabled: boolean;
  activeCreatorBoostEnabled: boolean;
  newCreatorBoostEnabled: boolean;
  returningCreatorBoostEnabled: boolean;
  underexposedBoostEnabled: boolean;
  creatorFatigueEnabled: boolean;
  /** When true, official-publisher posts receive PUBLISHER_BOOST and are exempt from per-creator caps. */
  publisherBoostEnabled: boolean;
  /** When true, featured posts receive a 1.4× score multiplier for 7 days after featuring. */
  featuredBoostEnabled: boolean;
}

/** Config thresholds (loaded from rankingConfig or defaulted). */
export interface MediaRankingConfig {
  /** Max consecutive positions from one creator. Default 2. */
  maxConsecutive: number;
  /** Max fraction of a session from one creator (0–1). Default 0.20. */
  maxSessionFraction: number;
  /**
   * Per-viewer per-session impression cap: a creator seen this many times
   * in one session starts receiving fatigue penalty. Default 3.
   */
  sessionFatigueThreshold: number;
  /**
   * Fatigue penalty applied per impression over the session threshold.
   * Stacks up to a cap. Default 0.25 per extra impression.
   */
  sessionFatiguePenaltyPerImpression: number;
  /** Max total session-fatigue penalty. Default 1.5. */
  sessionFatiguePenaltyCap: number;
  /** Creator account age ceiling (days) for new-creator boost. Default 30. */
  newCreatorWindowDays: number;
  /** Minimum days since last post to qualify as "returning". Default 14. */
  returningCreatorInactiveDays: number;
  /** Max boost ceiling for any single boost. Default 0.5. */
  boostCeiling: number;
  /** View count below which underexposed boost applies. Default 500. */
  underexposedViewThreshold: number;
  /** Wrong-place reports per impression that start applying a penalty. Default 0.05. */
  wrongPlaceReportThreshold: number;
  /** Penalty per report above threshold. Default 0.30. */
  wrongPlaceReportPenaltyPerReport: number;
  /** Window size for diversity re-ranking. Default 4. */
  diversityWindow: number;
}

const DEFAULT_MEDIA_CONFIG: MediaRankingConfig = {
  maxConsecutive:                    2,
  maxSessionFraction:                0.20,
  sessionFatigueThreshold:           3,
  sessionFatiguePenaltyPerImpression: 0.25,
  sessionFatiguePenaltyCap:          1.5,
  newCreatorWindowDays:              30,
  returningCreatorInactiveDays:      14,
  boostCeiling:                      0.5,
  underexposedViewThreshold:         500,
  wrongPlaceReportThreshold:         0.05,
  wrongPlaceReportPenaltyPerReport:  0.30,
  diversityWindow:                   4,
};

/** Reason code labels for the ranking snapshot. */
export type MediaRankingReasonCode =
  | "watch_completion"
  | "qualified_views"
  | "rewatches"
  | "saves_shares"
  | "new_creator"
  | "returning_creator"
  | "underexposed"
  | "active_creator"
  | "place_accuracy"
  | "place_uniqueness"
  | "add_to_trip"
  | "following"
  | "relevance"
  | "recency"
  | "not_interested_penalty"
  | "wrong_place_penalty"
  | "session_fatigue_penalty"
  | "featured_by_portava";

export interface MediaRankedItem<T extends MediaFeedItem = MediaFeedItem> {
  item: T;
  finalScore: number;
  baseScore: number;
  /** Top-3 reason codes (for "Why This?" display). */
  reasonCodes: MediaRankingReasonCode[];
  features: Record<string, number>;
}

/** Full input to MediaFeedRankingService.rank(). */
export interface MediaRankingInput<T extends MediaFeedItem = MediaFeedItem> {
  candidates: T[];
  viewer: ViewerContext;
  mode: MediaFeedMode;
  sessionState: MediaSessionState;
  flags: MediaRankingFlags;
  config?: Partial<MediaRankingConfig>;
  nowMs?: number;
}

// ── Boost functions with diminishing returns ──────────────────────────────────

/**
 * New-creator boost: logarithmic decay over the evaluation window.
 * Items from brand-new accounts (≤ windowDays) receive a fair-test lift
 * that tapers off as the creator matures. Low view count amplifies it.
 */
export function newCreatorBoost(
  creatorAccountAgeDays: number | null | undefined,
  viewCount: number | null | undefined,
  windowDays: number,
  ceiling: number,
): number {
  if (creatorAccountAgeDays == null || creatorAccountAgeDays > windowDays) return 0;
  const ageFraction = Math.max(0, 1 - creatorAccountAgeDays / windowDays);
  // Amplify when view count is low (underexposure co-signal)
  const views = viewCount ?? 0;
  const viewFactor = views < 50 ? 1 : Math.max(0.3, 1 - Math.log10(views / 50) / 4);
  const raw = ageFraction * viewFactor;
  return Math.min(ceiling, raw * ceiling);
}

/**
 * Returning-creator boost: temporary lift for creators who went quiet and
 * are posting again. Uses logarithmic recovery so very long absences don't
 * dominate.
 */
export function returningCreatorBoost(
  daysSinceLastPost: number | null | undefined,
  inactiveDays: number,
  ceiling: number,
): number {
  if (daysSinceLastPost == null || daysSinceLastPost < inactiveDays) return 0;
  // Log-scale: 14 days → full boost, grows slowly beyond 90 days
  const scale = Math.min(1, Math.log(daysSinceLastPost / inactiveDays + 1) / Math.log(7));
  return Math.min(ceiling, scale * ceiling);
}

/**
 * Underexposed-content boost: items with low view count relative to their
 * age deserve a fair test window. Diminishing returns above the threshold.
 */
export function underexposedBoost(
  viewCount: number | null | undefined,
  ageHours: number,
  viewThreshold: number,
  ceiling: number,
): number {
  const views = viewCount ?? 0;
  if (views >= viewThreshold) return 0;
  // Items younger than 2h get a mild boost even with 0 views (brand new)
  const ageFactor = Math.min(1, ageHours / 2);
  const viewFactor = 1 - views / viewThreshold;
  return Math.min(ceiling, viewFactor * ageFactor * ceiling);
}

/**
 * Active-creator boost: reward consistently active creators, but with
 * logarithmic saturation so prolific creators don't dominate.
 */
export function activeCreatorBoost(
  weeklyPostCount: number | null | undefined,
  ceiling: number,
): number {
  if (!weeklyPostCount || weeklyPostCount <= 0) return 0;
  // Saturates at ~10 posts/week; more posts = diminishing returns
  const raw = Math.log10(1 + weeklyPostCount) / Math.log10(11);
  return Math.min(ceiling, raw * ceiling);
}

// ── Signal multiplier helpers ─────────────────────────────────────────────────

/** Watch-completion multiplier: 0% completion → 0.5×, 100% → 1.5×. */
export function watchCompletionMultiplier(rate: number | null | undefined): number {
  if (rate == null) return 1.0;
  const clamped = Math.max(0, Math.min(1, rate));
  return 0.5 + clamped;
}

/** Qualified-view rate multiplier: log-scaled relative to impressions. */
export function qualifiedViewMultiplier(
  qualifiedViews: number | null | undefined,
  totalImpressions: number | null | undefined,
): number {
  const qv = qualifiedViews ?? 0;
  const total = totalImpressions ?? 1;
  if (total <= 0) return 1.0;
  const rate = qv / total;
  // 0% → 0.8×, 50% → 1.3×, 100% → 1.5×
  return 0.8 + Math.min(0.7, rate * 1.4);
}

/** Re-watch multiplier: strong signal of high-value content. */
export function rewatchMultiplier(rate: number | null | undefined): number {
  if (rate == null) return 1.0;
  const clamped = Math.max(0, Math.min(1, rate));
  // 0% → 1.0×, 10% → 1.2×, 30%+ → 1.5× (log-scaled)
  return 1.0 + Math.min(0.5, Math.log1p(clamped * 10) / Math.log1p(10) * 0.5);
}

/** Hide / Not-Interested penalty: subtracts from base score. */
export function notInterestedPenalty(
  hideRate: number | null | undefined,
  notInterestedCount: number | null | undefined,
  totalImpressions: number | null | undefined,
): number {
  const total = totalImpressions ?? 1;
  if (total <= 0) return 0;
  const hideR = hideRate ?? (notInterestedCount != null ? notInterestedCount / total : 0);
  // 0% → 0, 5% → 0.25, 15%+ → 0.6 (log-scaled)
  return Math.min(0.6, Math.log1p(hideR * 20) / Math.log1p(20) * 0.6);
}

// ── Gems-specific signal helpers ──────────────────────────────────────────────

/** Place-accuracy multiplier based on verification status. */
export function placeAccuracyMultiplier(score: number | null | undefined): number {
  if (score == null) return 0.85; // unknown = slightly penalised
  return Math.max(0.3, Math.min(1, score));
}

/** Wrong-place report penalty (subtracts from score). */
export function wrongPlacePenalty(
  reportRate: number | null | undefined,
  threshold: number,
  penaltyPerReport: number,
): number {
  if (reportRate == null || reportRate <= threshold) return 0;
  const excess = reportRate - threshold;
  return Math.min(1.0, excess / threshold * penaltyPerReport);
}

/** Place-uniqueness multiplier: unique places rank higher in Gems. */
export function placeUniquenessMultiplier(uniqueness: number | null | undefined): number {
  if (uniqueness == null) return 0.9;
  return 0.5 + 0.5 * Math.max(0, Math.min(1, uniqueness));
}

// ── Session-fatigue helpers ───────────────────────────────────────────────────

/** Per-viewer per-session fatigue penalty for a given creator. */
export function sessionFatiguePenalty(
  impressionsThisSession: number,
  threshold: number,
  penaltyPerImpression: number,
  cap: number,
): number {
  if (impressionsThisSession <= threshold) return 0;
  const excess = impressionsThisSession - threshold;
  return Math.min(cap, excess * penaltyPerImpression);
}

// ── Diversity re-ranking (city + category + creator) ─────────────────────────

export interface MediaDiversifyOptions extends DiversityOptions {
  /** Penalty per consecutive same-city position. Default 0.25. */
  cityPenalty?: number;
  /** Penalty per consecutive same-category position. Default 0.15. */
  categoryPenalty?: number;
}

/**
 * Extended greedy MMR re-rank that also penalises consecutive same-city and
 * same-category positions. For Gems, enforces geographic + category diversity.
 */
export function diversifyMedia<T extends MediaFeedItem>(
  scored: MediaRankedItem<T>[],
  opts: MediaDiversifyOptions = {},
): MediaRankedItem<T>[] {
  const authorPenalty   = opts.authorPenalty  ?? 0.35;
  const kindPenalty     = opts.kindPenalty    ?? 0.0;   // all posts in media feed
  const cityPenalty     = opts.cityPenalty    ?? 0.25;
  const categoryPenalty = opts.categoryPenalty ?? 0.15;
  const windowSize      = Math.max(1, opts.window ?? 4);

  const pool = [...scored].sort((a, b) => b.finalScore - a.finalScore);
  const out: MediaRankedItem<T>[] = [];

  while (pool.length > 0) {
    const recent = out.slice(-windowSize);
    let bestIdx = 0;
    let bestVal = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      let penalty = 0;
      for (const r of recent) {
        if (c.item.authorId && r.item.authorId === c.item.authorId) penalty += authorPenalty;
        if (c.item.kind !== r.item.kind) penalty += kindPenalty;
        if (c.item.city && r.item.city && c.item.city.toLowerCase() === r.item.city.toLowerCase()) {
          penalty += cityPenalty;
        }
        if (c.item.category && r.item.category && c.item.category === r.item.category) {
          penalty += categoryPenalty;
        }
      }
      const val = c.finalScore - penalty;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }

    out.push(pool.splice(bestIdx, 1)[0]!);
  }

  return out;
}

// ── Creator cap enforcement ───────────────────────────────────────────────────

/**
 * Enforce per-page creator cap and consecutive cap on a ranked media feed.
 * Extends CreatorCapEnforcer logic with a per-session fraction cap.
 */
export function enforceMediaCreatorCaps<T extends MediaFeedItem>(
  items: MediaRankedItem<T>[],
  config: MediaRankingConfig,
  sessionState: MediaSessionState,
  sessionSize: number,
  publisherBoostEnabled = false,
): MediaRankedItem<T>[] {
  if (items.length === 0) return items;

  const maxConsecutive = config.maxConsecutive;
  const maxPerSession  = Math.max(1, Math.round(config.maxSessionFraction * sessionSize));

  // Phase 1: session-fraction cap (items over limit go to overflow).
  // Official-publisher items are exempt when publisherBoostEnabled is true —
  // they always pass through to main regardless of session count.
  const sessionCount = new Map<string, number>(sessionState.creatorImpressions);
  const main:     MediaRankedItem<T>[] = [];
  const overflow: MediaRankedItem<T>[] = [];

  for (const item of items) {
    const authorId = item.item.authorId ?? null;
    const isPublisher = publisherBoostEnabled && item.item.isOfficialPublisher === true;
    if (!authorId || isPublisher) { main.push(item); continue; }

    const count = sessionCount.get(authorId) ?? 0;
    if (count < maxPerSession) {
      main.push(item);
      sessionCount.set(authorId, count + 1);
    } else {
      overflow.push(item);
    }
  }

  // Phase 2: consecutive cap via greedy scheduler
  const combined = [...main, ...overflow];
  const result: MediaRankedItem<T>[] = [];

  while (combined.length > 0) {
    // Determine blocked author (if any)
    let blockedAuthor: string | null = null;
    if (result.length >= maxConsecutive) {
      const tail  = result.slice(-maxConsecutive);
      const first = tail[0]!.item.authorId ?? null;
      if (first !== null && tail.every((r) => (r.item.authorId ?? null) === first)) {
        blockedAuthor = first;
      }
    }

    let idx = blockedAuthor !== null
      ? combined.findIndex((r) => (r.item.authorId ?? null) !== blockedAuthor)
      : 0;

    if (idx === -1) idx = 0; // best-effort fallback
    result.push(combined.splice(idx, 1)[0]!);
  }

  return result;
}

// ── Top-N reason code extractor ───────────────────────────────────────────────

function topReasonCodes(
  features: Record<string, number>,
  maxCodes = 3,
): MediaRankingReasonCode[] {
  const ranked = Object.entries(features)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  const codes: MediaRankingReasonCode[] = [];
  const knownKeys: Partial<Record<string, MediaRankingReasonCode>> = {
    watchCompletion:      "watch_completion",
    qualifiedViews:       "qualified_views",
    rewatches:            "rewatches",
    savesShares:          "saves_shares",
    newCreator:           "new_creator",
    returningCreator:     "returning_creator",
    underexposed:         "underexposed",
    activeCreator:        "active_creator",
    placeAccuracy:        "place_accuracy",
    placeUniqueness:      "place_uniqueness",
    addToTrip:            "add_to_trip",
    followedAuthor:       "following",
    categoryAffinity:     "relevance",
    interestTag:          "relevance",
    recency:              "recency",
    notInterestedPenalty: "not_interested_penalty",
    wrongPlacePenalty:    "wrong_place_penalty",
    sessionFatigue:       "session_fatigue_penalty",
    featuredByPortava:    "featured_by_portava",
  };

  for (const [key] of ranked) {
    const code = knownKeys[key];
    if (code && !codes.includes(code)) {
      codes.push(code);
      if (codes.length >= maxCodes) break;
    }
  }

  return codes;
}

// ── Snapshot storage ──────────────────────────────────────────────────────────

/**
 * Store a compact ranking-reason snapshot for each served item.
 * Enables "Why This?" to read stored reasons without recomputing.
 * Fire-and-forget — never throws.
 */
export async function storeRankingSnapshots(
  db: SupabaseClient | null,
  viewerId: string,
  sessionId: string | null,
  surface: string,
  ranked: MediaRankedItem[],
): Promise<void> {
  if (!db || ranked.length === 0) return;
  const now = new Date().toISOString();
  const rows = ranked.map((r, idx) => ({
    viewer_id:    viewerId,
    item_id:      r.item.id,
    surface,
    session_id:   sessionId,
    position:     idx,
    final_score:  r.finalScore,
    reason_codes: r.reasonCodes,
    served_at:    now,
  }));
  const { error } = await db
    .from("media_ranking_snapshots")
    .upsert(rows, { onConflict: "viewer_id,item_id,session_id" });
  if (error) throw error;
}

// ── Main service ──────────────────────────────────────────────────────────────

/**
 * Score, cap, and diversify a list of media candidates.
 *
 * When MEDIA_RANKING_ENABLED is false, items are returned in their original
 * (chronological) order with score=0 and no snapshot stored.
 *
 * @param input  Full ranking input including candidates, viewer, flags, config.
 * @returns      Ordered MediaRankedItem list (eligible items first).
 */
export function rankMediaFeed<T extends MediaFeedItem>(
  input: MediaRankingInput<T>,
): MediaRankedItem<T>[] {
  const {
    candidates,
    viewer,
    mode,
    sessionState,
    flags,
    nowMs = Date.now(),
  } = input;

  // Master switch: return chronological order when ranking disabled
  if (!flags.rankingEnabled) {
    return candidates.map((item) => ({
      item,
      finalScore: 0,
      baseScore: 0,
      reasonCodes: ["recency"],
      features: {},
    }));
  }

  const cfg: MediaRankingConfig = { ...DEFAULT_MEDIA_CONFIG, ...(input.config ?? {}) };
  const isGems = mode === "gems";

  const scored: MediaRankedItem<T>[] = candidates.map((item) => {
    // ── 1. Base score via portavaRank ─────────────────────────────────────
    const portava = scoreCandidate(
      item,
      { ...viewer, nowMs },
      DEFAULT_WEIGHTS,
      flags.publisherBoostEnabled,
    );
    let score = portava.score;
    const features: Record<string, number> = { ...portava.features };

    // ── 2. Media-specific signal multipliers ──────────────────────────────
    const completionMult  = watchCompletionMultiplier(item.watchCompletionRate);
    const qualifiedMult   = qualifiedViewMultiplier(item.qualifiedViewCount, item.totalImpressionCount);
    const rewatchMult     = rewatchMultiplier(item.rewatchRate);
    const combinedMediaMult = (completionMult + qualifiedMult + rewatchMult) / 3;

    // Apply combined multiplier to the base score
    score = score * combinedMediaMult;

    // Track as features
    if (item.watchCompletionRate != null) features.watchCompletion = (completionMult - 1) * score;
    if (item.qualifiedViewCount != null)  features.qualifiedViews  = (qualifiedMult - 1) * score;
    if (item.rewatchRate != null)         features.rewatches        = (rewatchMult - 1) * score;

    // Saves and shares contribute directly
    const savesSharesSignal = ((item.likeCount ?? 0) * 0.5 + (item.joinCount ?? 0)) / 100;
    if (savesSharesSignal > 0) {
      features.savesShares = Math.min(0.5, savesSharesSignal);
      score += features.savesShares;
    }

    // ── 3. Negative feedback penalties ────────────────────────────────────
    const niPenalty = notInterestedPenalty(
      item.hideRate,
      item.notInterestedCount,
      item.totalImpressionCount,
    );
    if (niPenalty > 0) {
      features.notInterestedPenalty = niPenalty;
      score -= niPenalty;
    }

    // ── 4. Creator frequency cap + session fatigue ────────────────────────
    if (flags.creatorFatigueEnabled && item.authorId) {
      const sessionImpressions = sessionState.creatorImpressions.get(item.authorId) ?? 0;
      const sFatigue = sessionFatiguePenalty(
        sessionImpressions,
        cfg.sessionFatigueThreshold,
        cfg.sessionFatiguePenaltyPerImpression,
        cfg.sessionFatiguePenaltyCap,
      );
      if (sFatigue > 0) {
        features.sessionFatigue = sFatigue;
        score -= sFatigue;
      }
    }

    // ── 5. Boosts with diminishing returns ────────────────────────────────

    // Active-creator boost
    if (flags.activeCreatorBoostEnabled) {
      const acBoost = activeCreatorBoost(item.creatorWeeklyPostCount, cfg.boostCeiling);
      if (acBoost > 0) {
        features.activeCreator = acBoost;
        score += acBoost;
      }
    }

    // New-creator boost
    if (flags.newCreatorBoostEnabled) {
      const viewCount = item.qualifiedViewCount ?? item.totalImpressionCount ?? 0;
      const ncBoost = newCreatorBoost(
        item.creatorAccountAgeDays,
        viewCount,
        cfg.newCreatorWindowDays,
        cfg.boostCeiling,
      );
      if (ncBoost > 0) {
        features.newCreator = ncBoost;
        score += ncBoost;
      }
    }

    // Returning-creator boost
    if (flags.returningCreatorBoostEnabled && item.creatorLastPostAt) {
      const daysSince = (nowMs - new Date(item.creatorLastPostAt).getTime()) / 86_400_000;
      const rcBoost = returningCreatorBoost(daysSince, cfg.returningCreatorInactiveDays, cfg.boostCeiling);
      if (rcBoost > 0) {
        features.returningCreator = rcBoost;
        score += rcBoost;
      }
    }

    // Featured-by-Portava boost (1.4× for 7 days post-featuring)
    if (flags.featuredBoostEnabled && item.featuredAt) {
      const featuredAgeMs = nowMs - new Date(item.featuredAt).getTime();
      if (featuredAgeMs >= 0 && featuredAgeMs <= FEATURED_BOOST_WINDOW_MS) {
        const boost = (FEATURED_BOOST_MULTIPLIER - 1) * score;
        if (boost > 0) {
          features.featuredByPortava = boost;
          score += boost;
        }
      }
    }

    // Underexposed-content boost
    if (flags.underexposedBoostEnabled) {
      const ageHours = item.createdAt
        ? (nowMs - new Date(item.createdAt).getTime()) / 3_600_000
        : 0;
      const viewCount = item.qualifiedViewCount ?? item.totalImpressionCount ?? 0;
      const ueBoost = underexposedBoost(viewCount, ageHours, cfg.underexposedViewThreshold, cfg.boostCeiling);
      if (ueBoost > 0) {
        features.underexposed = ueBoost;
        score += ueBoost;
      }
    }

    // ── 6. Gems-specific signals ──────────────────────────────────────────
    if (isGems) {
      // Place accuracy multiplier
      const accMult = placeAccuracyMultiplier(item.placeAccuracyScore);
      if (accMult !== 1) {
        features.placeAccuracy = (accMult - 1) * Math.abs(score);
        score *= accMult;
      }

      // Wrong-place report penalty
      const wpPenalty = wrongPlacePenalty(
        item.wrongPlaceReportRate,
        cfg.wrongPlaceReportThreshold,
        cfg.wrongPlaceReportPenaltyPerReport,
      );
      if (wpPenalty > 0) {
        features.wrongPlacePenalty = wpPenalty;
        score -= wpPenalty;
      }

      // Place uniqueness multiplier
      const uniqueMult = placeUniquenessMultiplier(item.placeUniqueness);
      if (uniqueMult !== 1) {
        features.placeUniqueness = (uniqueMult - 1) * Math.abs(score);
        score *= uniqueMult;
      }

      // Add-to-trip / directions engagement
      const tripRate  = item.addToTripRate  ?? 0;
      const dirRate   = item.directionsRate ?? 0;
      const placeEngagement = (tripRate * 2 + dirRate) / 3;
      if (placeEngagement > 0) {
        features.addToTrip = Math.min(0.4, placeEngagement);
        score += features.addToTrip;
      }
    }

    const baseScore   = portava.score;
    const finalScore  = Math.max(0, score);
    const reasonCodes = topReasonCodes(features);

    return { item, finalScore, baseScore, reasonCodes, features };
  });

  // ── 7. Creator cap + session-fraction enforcement ─────────────────────────
  // Official-publisher items (when boost is enabled) are exempt from the
  // per-creator frequency cap so @Portava content is never fully suppressed
  // by the diversity limiter; they always appear at least once per page.
  const sessionSize = Math.max(candidates.length, 20);
  const capped = enforceMediaCreatorCaps(
    scored.sort((a, b) => b.finalScore - a.finalScore),
    cfg,
    sessionState,
    sessionSize,
    flags.publisherBoostEnabled,
  );

  // ── 8. Diversity re-ranking pass ──────────────────────────────────────────
  const diversified = diversifyMedia(capped, {
    authorPenalty:   0.35,
    cityPenalty:     0.25,
    categoryPenalty: 0.15,
    window:          cfg.diversityWindow,
  });

  return diversified;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Load all MEDIA_* ranking flags in a single query.
 * Returns safe defaults (all false except rankingEnabled) on any error.
 */
export async function loadMediaRankingFlags(
  db: SupabaseClient | null,
): Promise<MediaRankingFlags> {
  const defaults: MediaRankingFlags = {
    rankingEnabled:               false,
    activeCreatorBoostEnabled:    false,
    newCreatorBoostEnabled:       false,
    returningCreatorBoostEnabled: false,
    underexposedBoostEnabled:     false,
    creatorFatigueEnabled:        false,
    publisherBoostEnabled:        false,
    featuredBoostEnabled:         false,
  };
  if (!db) return defaults;
  try {
    const { data } = await db
      .from("feature_flags")
      .select("flag, enabled")
      .in("flag", [
        "MEDIA_RANKING_ENABLED",
        "MEDIA_ACTIVE_CREATOR_BOOST_ENABLED",
        "MEDIA_NEW_CREATOR_BOOST_ENABLED",
        "MEDIA_RETURNING_CREATOR_BOOST_ENABLED",
        "MEDIA_UNDEREXPOSED_BOOST_ENABLED",
        "MEDIA_CREATOR_FATIGUE_ENABLED",
        "PORTAVA_PUBLISHER_BOOST_ENABLED",
        "PORTAVA_FEATURED_BOOST_ENABLED",
      ]);
    for (const row of (data as any[]) ?? []) {
      const flag = row.flag as string;
      const val  = Boolean(row.enabled);
      if (flag === "MEDIA_RANKING_ENABLED")               defaults.rankingEnabled               = val;
      if (flag === "MEDIA_ACTIVE_CREATOR_BOOST_ENABLED")  defaults.activeCreatorBoostEnabled    = val;
      if (flag === "MEDIA_NEW_CREATOR_BOOST_ENABLED")     defaults.newCreatorBoostEnabled       = val;
      if (flag === "MEDIA_RETURNING_CREATOR_BOOST_ENABLED") defaults.returningCreatorBoostEnabled = val;
      if (flag === "MEDIA_UNDEREXPOSED_BOOST_ENABLED")    defaults.underexposedBoostEnabled     = val;
      if (flag === "MEDIA_CREATOR_FATIGUE_ENABLED")       defaults.creatorFatigueEnabled        = val;
      if (flag === "PORTAVA_PUBLISHER_BOOST_ENABLED")     defaults.publisherBoostEnabled        = val;
      if (flag === "PORTAVA_FEATURED_BOOST_ENABLED")      defaults.featuredBoostEnabled         = val;
    }
  } catch { /* return defaults */ }
  return defaults;
}

/**
 * Load media-specific engagement signals for a batch of post IDs.
 * Returns a map of postId → partial MediaFeedItem signals.
 * Non-fatal: missing data defaults to null.
 *
 * Aggregates per-item watch_completion_rate and rewatch_rate from rank_events
 * (event_type IN ('watch_completion','watch_rewatch','watch_qualified_view')).
 * Rates are expressed as fractions of qualified views:
 *   watchCompletionRate = completions / qualifiedViews
 *   rewatchRate         = rewatches  / qualifiedViews
 * When an item has no qualified-view rows the rates remain null so the ranking
 * service falls back to neutral multipliers (1.0×).
 */
export async function loadMediaSignals(
  db: SupabaseClient | null,
  postIds: string[],
): Promise<Map<string, Partial<MediaFeedItem>>> {
  const result = new Map<string, Partial<MediaFeedItem>>();
  if (!db || postIds.length === 0) return result;

  try {
    const { data, error } = await db
      .from("rank_events")
      .select("item_id, event_type")
      .in("item_id", postIds)
      .in("event_type", ["watch_completion", "watch_rewatch", "watch_qualified_view"]);

    if (error || !data) return result;

    // Aggregate counts per item_id
    const counts = new Map<string, { completions: number; rewatches: number; qualifiedViews: number }>();
    for (const row of (data as { item_id: string; event_type: string }[])) {
      if (!counts.has(row.item_id)) {
        counts.set(row.item_id, { completions: 0, rewatches: 0, qualifiedViews: 0 });
      }
      const c = counts.get(row.item_id)!;
      if (row.event_type === "watch_completion")      c.completions++;
      else if (row.event_type === "watch_rewatch")    c.rewatches++;
      else if (row.event_type === "watch_qualified_view") c.qualifiedViews++;
    }

    // Derive rates: only set when there is at least one qualified-view event
    for (const [itemId, c] of counts) {
      if (c.qualifiedViews > 0) {
        result.set(itemId, {
          watchCompletionRate: c.completions / c.qualifiedViews,
          rewatchRate:         c.rewatches  / c.qualifiedViews,
        });
      } else {
        // Has completion/rewatch rows but no qualified-view anchor — leave null
        result.set(itemId, { watchCompletionRate: null, rewatchRate: null });
      }
    }
  } catch { /* non-fatal: returns empty map; ranking falls back to 1.0× multipliers */ }

  return result;
}

/**
 * Load creator-level signals for a batch of creator IDs.
 * Returns a map of creatorId → partial MediaFeedItem signals.
 *
 * Currently loads:
 *   - `isOfficialPublisher` — derived from profiles.is_official so the
 *     publisher boost and cap-exemption mechanics work without callers needing
 *     to query profiles themselves.
 *
 * NOTE: weekly_post_count, last_post_at, and account_age_days are not yet
 * columns in the live creator_activity_scores schema. Only score and
 * spam_penalty exist live (verified by DiscoveryRankingService usage).
 * The extended creator signals are a follow-up migration; until then,
 * the boost functions receive null and apply no boost (safe default).
 */
export async function loadCreatorSignals(
  db: SupabaseClient | null,
  creatorIds: string[],
): Promise<Map<string, Partial<MediaFeedItem>>> {
  const result = new Map<string, Partial<MediaFeedItem>>();
  if (!db || creatorIds.length === 0) return result;

  try {
    // Load is_official from profiles so the publisher-boost signal is
    // available to rankMediaFeed without requiring callers to do a separate
    // join.  Non-fatal: missing rows default to isOfficialPublisher = false.
    const { data, error } = await db
      .from("profiles")
      .select("id, is_official")
      .in("id", creatorIds);

    if (!error && data) {
      for (const row of (data as { id: string; is_official: boolean | null }[])) {
        result.set(row.id, { isOfficialPublisher: row.is_official === true });
      }
    }
  } catch { /* non-fatal: ranking falls back to isOfficialPublisher = undefined */ }

  return result;
}
