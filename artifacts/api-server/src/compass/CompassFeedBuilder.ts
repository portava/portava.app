/**
 * CompassFeedBuilder — Phase 3 feed assembly.
 *
 * Section catalogue (17 sections):
 *   for_you, available_now, during_your_trip, tonight, near_your_area,
 *   compass_picks, people_you_may_vibe_with, rent_a_buddy, hidden_gems,
 *   city_pulse, passport_stamp_opportunities, safety_recommended,
 *   your_circle_may_like, new_in_this_city, budget_friendly,
 *   creator_spots, arrival_help
 *
 * Fair exposure (global cap):
 *   Up to 2 fair-exposure items are inserted per feed build — GLOBAL, not per section.
 *   The two candidates are prepended to the diversified pool so they appear in every
 *   section they naturally qualify for. Appearance counts and cooldowns are preloaded
 *   from DB before any insertion.
 *
 * Active-user rewards:
 *   Each author's own trust/safety data is loaded from DB to compute the reward boost,
 *   never the viewer's profile.
 *
 * Cursor-based pagination:
 *   Cursor = base64url-encoded { section: SectionName, index: number }.
 *   buildFeed returns a global cursor pointing to the first overflowing section.
 *   buildSection returns a section-specific cursor for the requested section only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";
import type { PipelineResult, PipelineTestOverrides } from "./CompassPipeline.js";
import { rankItems as drsRankItems } from "../services/ranking/DiscoveryRankingService.js";
import type { RankingInput, RankingViewerContext } from "../services/ranking/DiscoveryRankingService.js";
import { runPipeline } from "./CompassPipeline.js";
import { diversifySection } from "./CompassDiversityEngine.js";
import { applyFairExposure } from "./CompassFairExposureEngine.js";
import {
  computeActiveUserScore,
  computeItemVisibilityBoost,
  type ActiveUserScoreResult,
} from "./CompassActiveUserRewardEngine.js";
import {
  allocateFeedSlots,
  loadUnderexposedItemIds,
} from "../services/ranking/FeedSlotAllocator.js";
import { enforceCreatorCaps } from "../services/ranking/CreatorCapEnforcer.js";
import { getFeedShares, getCreatorCaps } from "../services/ranking/rankingConfig.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { buildPlaceAffinities } from "../services/ranking/MediaFeedRankingService.js";
import { logger } from "../lib/logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE       = 20;
const MAX_PER_SECTION = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

export const SECTION_NAMES = [
  "for_you",
  "available_now",
  "during_your_trip",
  "tonight",
  "near_your_area",
  "compass_picks",
  "people_you_may_vibe_with",
  "rent_a_buddy",
  "hidden_gems",
  "city_pulse",
  "passport_stamp_opportunities",
  "safety_recommended",
  "your_circle_may_like",
  "new_in_this_city",
  "budget_friendly",
  "creator_spots",
  "arrival_help",
] as const;

export type SectionName = typeof SECTION_NAMES[number];

export interface FeedItem extends PipelineResult {
  explanationKey: string;
  section:        SectionName;
  visibilityBoost?: number;
}

export interface FeedSection {
  name:  SectionName;
  items: FeedItem[];
  total: number;
}

export interface FeedPage {
  sections:     FeedSection[];
  nextCursor:   string | null;
  fallback:     false;
  pipelineMeta: {
    inputCount:    number;
    blockedCount:  number;
    rejectedCount: number;
    passedCount:   number;
  };
}

export interface FeedCursor {
  section: SectionName;
  index:   number;
}

/** Injectable overrides for testing (do not use in production). */
export interface FeedBuilderTestOverrides extends PipelineTestOverrides {
  skipFairExposure?:  boolean;
  skipActiveRewards?: boolean;
  authorScores?:      Map<string, ActiveUserScoreResult>;
  /** Pre-loaded appearance counts (item.id → count) — skip DB load in tests */
  appearanceCounts?:  Map<string, number>;
  /** Pre-built place affinities (placeId → view count) — skips the DB call in tests */
  placeAffinities?:   Record<string, number>;
  /** Pre-loaded author cooldown set — skip DB load in tests */
  cooldownSet?:       Set<string>;
}

// ── Explanation key generation ────────────────────────────────────────────────

function buildExplanationKey(
  item:    PipelineResult,
  section: SectionName,
  profile: CompassProfile,
): string {
  const base = `${section}:${item.item.type}`;
  if (item.item.isFairExposureBoosted)       return `${base}:fair_exposure`;
  if (item.item.city && profile.currentCity === item.item.city) return `${base}:local`;
  if ((item.item.diversityScore ?? 0) > 0.5) return `${base}:diversity_pick`;
  return base;
}

// ── Section routing ────────────────────────────────────────────────────────────

function assignSections(
  items:   PipelineResult[],
  profile: CompassProfile,
  context: CompassContext,
): Map<SectionName, PipelineResult[]> {
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const twelveHoursLater = new Date(nowMs + 12 * 60 * 60 * 1_000);

  const sections = new Map<SectionName, PipelineResult[]>(
    SECTION_NAMES.map((n) => [n, []]),
  );

  const push = (name: SectionName, r: PipelineResult) => {
    const sec = sections.get(name)!;
    if (sec.length < MAX_PER_SECTION) sec.push(r);
  };

  for (const r of items) {
    const { item } = r;

    if (item.type === "buddy" && item.buddyStatus === "active") {
      push("available_now", r);
      push("rent_a_buddy", r);
    }

    if (profile.hasActiveTrip && item.visibilityScope === "trip_only") {
      push("during_your_trip", r);
    }

    if (item.type === "event" && item.eventStartsAt) {
      const start = new Date(item.eventStartsAt as string);
      if (start >= now && start <= twelveHoursLater) {
        push("tonight", r);
      }
    }

    if (profile.currentCity && item.city === profile.currentCity) {
      push("near_your_area", r);
    }

    if (item.type === "user" || item.type === "buddy") {
      push("people_you_may_vibe_with", r);
      if (item.type === "buddy") push("rent_a_buddy", r);
    }

    if (item.type === "suggestion") push("hidden_gems", r);
    if (item.type === "post")       push("city_pulse", r);
    if (item.type === "stamp")      push("passport_stamp_opportunities", r);

    if (
      item.safetyTier === "relaxed" ||
      (item.safetyTier === "standard" && profile.safetyPreference === "cautious")
    ) {
      push("safety_recommended", r);
    }

    if (item.authorJoinedAt) {
      const ageDays =
        (nowMs - new Date(item.authorJoinedAt as string).getTime()) /
        (1000 * 60 * 60 * 24);
      if (ageDays < 30) push("new_in_this_city", r);
    }

    if (
      profile.budgetStyle === "budget" ||
      item.interestTags?.includes("budget") ||
      item.interestTags?.includes("free")
    ) {
      push("budget_friendly", r);
    }

    if (context.contextState === "creator_mode" && item.type === "suggestion") {
      push("creator_spots", r);
    }

    if (context.contextState === "arrival_mode") push("arrival_help", r);

    if (item.visibilityScope === "circle_only" && item.viewerIsInCircle) {
      push("your_circle_may_like", r);
    }

    if (r.finalScore >= 70) push("compass_picks", r);

    push("for_you", r); // catch-all
  }

  return sections;
}

// ── Cursor encode/decode ───────────────────────────────────────────────────────

function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): FeedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed.section === "string" &&
      typeof parsed.index === "number"
    ) {
      return parsed as FeedCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Fair exposure data preloader ──────────────────────────────────────────────

async function preloadFairExposureData(
  db:    SupabaseClient | null,
  items: PipelineResult[],
): Promise<{ counts: Map<string, number>; cooldowns: Set<string> }> {
  const counts    = new Map<string, number>();
  const cooldowns = new Set<string>();
  if (!db || items.length === 0) return { counts, cooldowns };

  try {
    const itemIds   = items.map((r) => r.item.id).slice(0, 100);
    const authorIds = [
      ...new Set(items.map((r) => r.item.authorId).filter(Boolean) as string[]),
    ].slice(0, 100);

    const [boostsRes, cooldownsRes] = await Promise.allSettled([
      db.from("compass_visibility_boosts")
        .select("item_id, appearance_count")
        .in("item_id", itemIds),
      authorIds.length > 0
        ? db.from("compass_visibility_cooldowns")
            .select("author_id")
            .in("author_id", authorIds)
            .gt("ends_at", new Date().toISOString())
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (boostsRes.status === "fulfilled") {
      for (const row of (boostsRes.value.data as any[]) ?? []) {
        counts.set(row.item_id as string, row.appearance_count as number);
      }
    }
    if (cooldownsRes.status === "fulfilled") {
      for (const row of (cooldownsRes.value.data as any[]) ?? []) {
        cooldowns.add(row.author_id as string);
      }
    }
    if (boostsRes.status === "rejected" || cooldownsRes.status === "rejected") {
      logger.warn(
        { boostsFailed: boostsRes.status === "rejected", cooldownsFailed: cooldownsRes.status === "rejected" },
        "Compass feed: fair-exposure boosts/cooldowns fetch failed — degraded to no fair-exposure preload",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Compass feed: fair-exposure preload failed — degraded to no fair-exposure preload");
  }

  return { counts, cooldowns };
}

// ── Shared pipeline runner ─────────────────────────────────────────────────────

interface FeedPipelineOutput {
  sectionMap:   Map<SectionName, PipelineResult[]>;
  pipelineMeta: {
    inputCount:    number;
    blockedCount:  number;
    rejectedCount: number;
    passedCount:   number;
  };
}

/**
 * Run the full pipeline → boost → diversity → fair-exposure → section-assignment
 * chain. Called by both buildFeed and buildSection to avoid duplicated logic.
 */
async function runFeedPipeline(
  items:      CompassItem[],
  profile:    CompassProfile,
  context:    CompassContext,
  db:         SupabaseClient | null,
  _overrides: FeedBuilderTestOverrides,
): Promise<FeedPipelineOutput> {
  // ── Place-affinity enrichment ─────────────────────────────────────────────
  // Build place affinities once per feed/section build and inject them into
  // the context so scoreItem can apply the ×1.15 boost for items whose
  // canonical place the viewer has recently viewed.  Fail-soft: an empty map
  // simply means no boost fires, which is identical to the pre-change
  // behaviour for all callers.  Tests may inject pre-built affinities via
  // _overrides.placeAffinities to skip the DB call.
  const placeAffinities =
    _overrides.placeAffinities ?? await buildPlaceAffinities(db, profile.userId);
  const enrichedContext: CompassContext = { ...context, placeAffinities };

  // ── Phase 2 pipeline ────────────────────────────────────────────────────────
  const { results, inputCount, blockedCount, rejectedCount, passedCount } =
    await runPipeline(items, profile, enrichedContext, db, _overrides);

  // ── Active-user reward boosts ──────────────────────────────────────────────
  // Each author's own trust/safety data is fetched from DB — NEVER the viewer's.
  const authorScores: Map<string, ActiveUserScoreResult> =
    _overrides.authorScores ?? new Map();

  if (db && !_overrides.skipActiveRewards) {
    const authorIds = [
      ...new Set(
        results.map((r) => r.item.authorId).filter(Boolean) as string[],
      ),
    ];
    await Promise.allSettled(
      authorIds.map(async (authorId) => {
        if (authorScores.has(authorId)) return;
        // computeActiveUserScore fetches the AUTHOR's own trust data internally
        const score = await computeActiveUserScore(db, authorId);
        if (score) authorScores.set(authorId, score);
      }),
    );
  }

  // Apply boosts and re-sort
  const boosted: PipelineResult[] = results.map((r) => {
    if (!r.item.authorId) return r;
    const authorScore = authorScores.get(r.item.authorId!);
    const boost       = computeItemVisibilityBoost(authorScore ?? null);
    if (boost <= 0) return r;
    return {
      ...r,
      finalScore: r.finalScore + boost,
      item: { ...r.item, activeVisibilityBoost: boost },
    };
  });
  boosted.sort((a, b) => b.finalScore - a.finalScore);

  // ── DiscoveryRankingService additional boost pass ─────────────────────────
  // Applies activity boost, new-contributor boost, underexposure boost, and
  // fatigue penalties sourced from the centralized ranking service on top of
  // the Compass pipeline score.  Non-fatal; shadow mode preserves sort order.
  if (db) {
    try {
      const drsInputs: RankingInput[] = boosted.map((r): RankingInput => ({
        itemId:             r.item.id,
        itemType:           r.item.type,
        creatorId:          r.item.authorId ?? null,
        createdAt:          r.item.createdAt ?? null,
        city:               r.item.city ?? null,
        country:            (r.item as any).country ?? null,
        tags:               Array.isArray(r.item.interestTags) ? r.item.interestTags : [],
        category:           (r.item as any).category ?? null,
        languageCode:       r.item.languageCode ?? null,
        hasMedia:           !!(r.item as any).hasMedia,
        completeness:       typeof (r.item as any).completeness === "number" ? (r.item as any).completeness : 0.7,
        positiveReviewRate: null,
        flagCount:          r.item.reportCount ?? 0,
        saveCount:          0,
        shareCount:         0,
        commentCount:       0,
        impressionCount:    1,
        uniqueViewerCount:  1,
        lat: null, lng: null,
        distanceKm:         null,
        isDeleted:          false,
        isExpired:          false,
        isSuspended:        !!(r.item.isSuspended),
        isModerated:        false,
        isPrivate:          r.item.visibilityScope === "private",
        isAgeRestricted:    !!(r.item.minAgeRequired && r.item.minAgeRequired > 0),
        minAgeRequired:     r.item.minAgeRequired ?? null,
        isGeoRestricted:    false,
        geoRestrictionCountries: null,
        authorIsBlockedByViewer: profile.blockedUserIds.includes(r.item.authorId ?? ""),
        authorBlocksViewer:      profile.blockerUserIds.includes(r.item.authorId ?? ""),
        authorIsMutedByViewer:   profile.mutedUserIds.includes(r.item.authorId ?? ""),
        viewerHasReportedItem:   !!(r.item.isReportedByViewer),
        viewerHasHiddenItem:     false,
        viewerHasHiddenCreator:  false,
        repeatCount:        r.item.repeatCount ?? null,
        expiresAt:          (r.item as any).expiresAt ?? null,
        accountAgeDays:     r.item.authorJoinedAt
          ? Math.floor((Date.now() - new Date(r.item.authorJoinedAt as string).getTime()) / 86_400_000)
          : null,
        isUnfamiliarCategory: false,
        isFirstImpression:  false,
      }));

      // The viewer's follow graph. Without it `followedCreatorIds` below was a
      // hardcoded empty Set, and since calcRelationshipRelevance reads ONLY
      // that set, `relationshipRelevance` — a weighted component of the compass
      // score — was permanently 0 for every item and every viewer. The weight
      // existed, the profile carried blocks and mutes, and this one signal was
      // never loaded.
      //
      // Loaded here rather than in CompassProfileService because the profile is
      // shared by a dozen engines that do not need it, and non-fatally for the
      // same reason loadPdeViewer treats it so: a viewer whose follows fail to
      // load ranks as following nobody — degraded, not broken.
      const followedCreatorIds = new Set<string>();
      try {
        const { data: followRows } = await db
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", profile.userId);
        for (const row of (followRows as any[]) ?? []) {
          if (row?.following_id) followedCreatorIds.add(row.following_id as string);
        }
      } catch { /* non-fatal */ }

      const drsViewer: RankingViewerContext = {
        viewerId:           profile.userId,
        travelStyles:       profile.travelStyles ?? [],
        preferredLanguages: profile.preferredLanguages ?? [],
        preferredCities:    profile.preferredCities ?? [],
        currentCity:        profile.currentCity ?? null,
        currentCountry:     profile.currentCountry ?? null,
        lat: null, lng: null,
        viewerAge:          profile.viewerAge ?? null,
        followedCreatorIds,
        mutedCreatorIds:    new Set(profile.mutedUserIds ?? []),
        blockedCreatorIds:  new Set(profile.blockedUserIds ?? []),
        seenItemIds:        new Set(profile.ignoredItemIds ?? []),
        sessionId:          null,
        lastActiveAt:       null,
      };

      const drsResults = await drsRankItems(drsInputs, "compass", drsViewer, db);
      // Re-order boosted according to DRS output position.
      // Shadow mode preserves current order; active mode applies DRS finalScore ordering.
      if (drsResults.length > 0) {
        const drsOrder = new Map(drsResults.map((r, idx) => [r.itemId, idx]));
        boosted.sort((a, b) => {
          const aIdx = drsOrder.get(a.item.id) ?? boosted.length;
          const bIdx = drsOrder.get(b.item.id) ?? boosted.length;
          return aIdx - bIdx;
        });
      }
    } catch (err) {
      logger.warn({ err, userId: profile.userId }, "Compass feed: DiscoveryRankingService boost pass failed — order preserved on DRS error");
    }
  }

  // ── Fair exposure — global cap (≤2 per feed build) ────────────────────────
  // Applied on the scored+boosted pool BEFORE section assignment so fair-
  // exposure items appear naturally in the sections they qualify for.
  let finalPool = boosted;
  if (!_overrides.skipFairExposure && boosted.length > 0) {
    // Preload in a single call (never twice)
    const preloaded = await preloadFairExposureData(db, boosted);
    const appearanceCounts = _overrides.appearanceCounts ?? preloaded.counts;
    const cooldownSet      = _overrides.cooldownSet      ?? preloaded.cooldowns;

    // Call with empty sectionItems to get only the fair-exposure candidates.
    // The engine returns [fairInsert1?, fairInsert2?] (up to 2 items total).
    const { items: fairInserts } = applyFairExposure(
      [],      // empty → returned array contains ONLY the new inserts
      boosted,
      profile,
      db,
      appearanceCounts,
      cooldownSet,
    );

    if (fairInserts.length > 0) {
      // Prepend the fair-exposure candidates, removing their natural position
      const fairIds = new Set(fairInserts.map((r) => r.item.id));
      const rest = boosted.filter((r) => !fairIds.has(r.item.id));
      finalPool = [...fairInserts, ...rest];
    }
  }

  // ── DISCOVERY_DIVERSITY_ENABLED: slot allocation + category/city caps ────────
  // When the flag is on, apply the FeedSlotAllocator on the scored pool before
  // section assignment so each section's candidate pool is already diversity-
  // balanced. Creator caps are applied per-section after the diversity pass.
  let diversityEnabled = false;
  let creatorCapConfig = { maxPerPage: 3, maxConsecutive: 2 };

  if (db) {
    try {
      [diversityEnabled, creatorCapConfig] = await Promise.all([
        isFlagEnabled(db, "DISCOVERY_DIVERSITY_ENABLED"),
        getCreatorCaps(db),
      ]);
    } catch (err) {
      logger.warn({ err, userId: profile.userId }, "Compass feed: diversity flag/creator-cap config load failed — preserving default config");
    }
  }

  let allocatedPool = finalPool;
  if (diversityEnabled && finalPool.length > 0 && db) {
    try {
      const shares = await getFeedShares(db);
      const itemIds = finalPool.map((r) => r.item.id);
      const underexposedItemIds = await loadUnderexposedItemIds(db, itemIds);
      allocatedPool = allocateFeedSlots(finalPool, shares, {
        surface: "compass",
        underexposedItemIds,
      });
    } catch (err) {
      logger.warn({ err, userId: profile.userId }, "Compass feed: slot allocation/underexposure fetch failed — using unallocated pool");
    }
  }

  // ── Section assignment (raw — no diversity yet) ────────────────────────────
  const rawSectionMap = assignSections(allocatedPool, profile, context);

  // ── Per-section diversity ──────────────────────────────────────────────────
  // Diversity — including the 25% nightlife/paid cap, exploration cards, and
  // (when enabled) category + city window caps — is applied independently to
  // each section. Creator frequency caps are enforced after diversity.
  const sectionMap = new Map<SectionName, PipelineResult[]>();
  for (const [name, sectionItems] of rawSectionMap) {
    const diversified = diversifySection(sectionItems, profile, {
      sectionName:         name,
      applyWindowCaps:     diversityEnabled,
    });
    const capped = diversityEnabled
      ? enforceCreatorCaps(diversified, creatorCapConfig)
      : diversified;
    sectionMap.set(name, capped);
  }

  return {
    sectionMap,
    pipelineMeta: { inputCount, blockedCount, rejectedCount, passedCount },
  };
}

// ── rankItemsForDiscovery ──────────────────────────────────────────────────────

/**
 * Run the full feed-intelligence stack (Phase 2 pipeline → active-user reward
 * boosts → fair-exposure injection) and return a flat list of all passed items
 * sorted by finalScore descending, with no section split and no pagination.
 *
 * Use this instead of buildFeed when the caller needs to rank the entire
 * candidate set and apply its own pagination (e.g. the Discovery route).
 */
export async function rankItemsForDiscovery(
  items:      CompassItem[],
  profile:    CompassProfile,
  context:    CompassContext,
  db:         SupabaseClient | null,
  _overrides: FeedBuilderTestOverrides = {},
): Promise<PipelineResult[]> {
  // Reuse the internal feed pipeline — stops before section assignment
  const { results, inputCount: _i, blockedCount: _b, rejectedCount: _r, passedCount: _p } =
    await runPipeline(items, profile, context, db, _overrides);

  // Active-user reward boosts
  const authorScores: Map<string, ActiveUserScoreResult> =
    _overrides.authorScores ?? new Map();
  if (db && !_overrides.skipActiveRewards) {
    const authorIds = [...new Set(results.map((r) => r.item.authorId).filter(Boolean) as string[])];
    await Promise.allSettled(
      authorIds.map(async (aid) => {
        const score = await computeActiveUserScore(db, aid);
        if (score) authorScores.set(aid, score);
      }),
    );
  }
  const boosted: PipelineResult[] = results.map((r) => {
    if (!r.item.authorId) return r;
    const score = authorScores.get(r.item.authorId!);
    const boost = computeItemVisibilityBoost(score ?? null);
    if (boost <= 0) return r;
    return { ...r, finalScore: r.finalScore + boost, item: { ...r.item, activeVisibilityBoost: boost } };
  });
  boosted.sort((a, b) => b.finalScore - a.finalScore);

  // Fair exposure
  let finalPool = boosted;
  if (!_overrides.skipFairExposure && boosted.length > 0) {
    const preloaded = await preloadFairExposureData(db, boosted);
    const { items: fairInserts } = applyFairExposure([], boosted, profile, db, preloaded.counts, preloaded.cooldowns);
    if (fairInserts.length > 0) {
      const fairIds = new Set(fairInserts.map((r) => r.item.id));
      finalPool = [...fairInserts, ...boosted.filter((r) => !fairIds.has(r.item.id))];
    }
  }

  // ── DISCOVERY_DIVERSITY_ENABLED: slot allocation + creator caps ───────────
  // Applied here so the Discovery route (which calls this function) benefits
  // from the same diversity controls as the Compass feed builder.
  let discoveryDiversityEnabled = false;
  let discoveryCreatorCaps = { maxPerPage: 3, maxConsecutive: 2 };
  if (db) {
    try {
      [discoveryDiversityEnabled, discoveryCreatorCaps] = await Promise.all([
        isFlagEnabled(db, "DISCOVERY_DIVERSITY_ENABLED"),
        getCreatorCaps(db),
      ]);
    } catch (err) {
      logger.warn({ err, userId: profile.userId }, "Discovery ranking: diversity flag/creator-cap config load failed — preserving default config");
    }
  }
  if (discoveryDiversityEnabled && finalPool.length > 0 && db) {
    try {
      const shares = await getFeedShares(db);
      const underexposedItemIds = await loadUnderexposedItemIds(db, finalPool.map((r) => r.item.id));
      finalPool = allocateFeedSlots(finalPool, shares, { surface: "discovery", underexposedItemIds });
    } catch (err) {
      logger.warn({ err, userId: profile.userId }, "Discovery ranking: slot allocation/underexposure fetch failed — using unallocated pool");
    }
  }
  if (discoveryDiversityEnabled && finalPool.length > 0) {
    finalPool = enforceCreatorCaps(finalPool, discoveryCreatorCaps);
  }

  return finalPool;
}

// ── buildFeed ─────────────────────────────────────────────────────────────────

/**
 * Build a paginated Compass feed for the calling user.
 * Returns all non-empty sections with a GLOBAL pagination cursor.
 */
export async function buildFeed(
  items:      CompassItem[],
  profile:    CompassProfile,
  context:    CompassContext,
  db:         SupabaseClient | null = null,
  cursor:     string | null = null,
  _overrides: FeedBuilderTestOverrides = {},
): Promise<FeedPage> {
  // ── Feedback-preference pre-filtering ─────────────────────────────────────
  // Items the user explicitly dismissed are removed before the pipeline runs so
  // they consume no scoring budget and never appear in any section.
  const ignoredSet = new Set(profile.ignoredItemIds);
  const filteredItems = ignoredSet.size > 0
    ? items.filter((it) => !ignoredSet.has(String(it.id ?? "")))
    : items;

  const { sectionMap, pipelineMeta } = await runFeedPipeline(
    filteredItems, profile, context, db, _overrides,
  );

  // ── Category-weight post-adjustment ───────────────────────────────────────
  // Apply user's category weight preferences (from hide_category / show_more
  // feedback) by scaling finalScore after the pipeline. This lets the user's
  // expressed preferences move items within each section on the VERY NEXT build.
  const weights = profile.categoryWeights;
  if (weights && Object.keys(weights).length > 0) {
    for (const [name, sectionItems] of sectionMap) {
      const adjusted = sectionItems.map((r) => {
        // Look up weight by item type (e.g. "event", "post") AND by each
        // interest/activity tag (e.g. "nightlife", "food") so both
        // itemType-keyed and category-keyed feedback entries take effect.
        const typeWeight = weights[r.item.type ?? ""] ?? 0;
        const tagWeight  = (r.item.interestTags ?? []).reduce(
          (acc: number, tag: string) => acc + (weights[tag] ?? 0),
          0,
        );
        const delta = typeWeight + tagWeight;
        if (delta === 0) return r;
        return { ...r, finalScore: Math.max(0, r.finalScore + delta * 10) };
      });
      if (adjusted.some((r, i) => r.finalScore !== sectionItems[i]!.finalScore)) {
        adjusted.sort((a, b) => b.finalScore - a.finalScore);
        sectionMap.set(name, adjusted);
      }
    }
  }

  const parsedCursor = cursor ? decodeCursor(cursor) : null;
  const sections: FeedSection[] = [];
  let nextCursor: string | null = null;

  for (const name of SECTION_NAMES) {
    const allItems = sectionMap.get(name) ?? [];
    const startIdx = parsedCursor?.section === name ? parsedCursor.index : 0;
    const endIdx   = startIdx + PAGE_SIZE;
    const pageItems = allItems.slice(startIdx, endIdx);

    const feedItems: FeedItem[] = pageItems.map((r) => ({
      ...r,
      section:         name,
      explanationKey:  buildExplanationKey(r, name, profile),
      visibilityBoost: r.item.activeVisibilityBoost as number | undefined,
    }));

    if (feedItems.length > 0) {
      sections.push({ name, items: feedItems, total: allItems.length });

      // Track first overflowing section for global next cursor
      if (endIdx < allItems.length && !nextCursor) {
        nextCursor = encodeCursor({ section: name, index: endIdx });
      }
    }
  }

  return { sections, nextCursor, fallback: false, pipelineMeta };
}

// ── buildSection ──────────────────────────────────────────────────────────────

/**
 * Build a single named section with section-specific pagination.
 * The returned nextCursor always points within this section only.
 * Used by `GET /api/compass/feed/section/:section`.
 */
export async function buildSection(
  sectionName: SectionName,
  items:       CompassItem[],
  profile:     CompassProfile,
  context:     CompassContext,
  db:          SupabaseClient | null = null,
  cursor:      string | null = null,
  _overrides:  FeedBuilderTestOverrides = {},
): Promise<{ section: FeedSection; nextCursor: string | null; fallback: false }> {
  const ignoredSet = new Set(profile.ignoredItemIds);
  const filteredItems = ignoredSet.size > 0
    ? items.filter((it) => !ignoredSet.has(String(it.id ?? "")))
    : items;
  const { sectionMap } = await runFeedPipeline(
    filteredItems, profile, context, db, _overrides,
  );

  // ── Category-weight post-adjustment (mirrors buildFeed) ───────────────────
  const rankWeights = profile.categoryWeights;
  if (rankWeights && Object.keys(rankWeights).length > 0) {
    for (const [name, sectionItems] of sectionMap) {
      const adjusted = sectionItems.map((r) => {
        const typeWeight = rankWeights[r.item.type ?? ""] ?? 0;
        const tagWeight  = (r.item.interestTags ?? []).reduce(
          (acc: number, tag: string) => acc + (rankWeights[tag] ?? 0),
          0,
        );
        const delta = typeWeight + tagWeight;
        if (delta === 0) return r;
        return { ...r, finalScore: Math.max(0, r.finalScore + delta * 10) };
      });
      if (adjusted.some((r, i) => r.finalScore !== sectionItems[i]!.finalScore)) {
        adjusted.sort((a, b) => b.finalScore - a.finalScore);
        sectionMap.set(name, adjusted);
      }
    }
  }

  const allItems     = sectionMap.get(sectionName) ?? [];
  const parsedCursor = cursor ? decodeCursor(cursor) : null;

  // Use section-specific offset — ignore any section field in the cursor
  const startIdx = parsedCursor?.section === sectionName ? parsedCursor.index : 0;
  const endIdx   = startIdx + PAGE_SIZE;
  const pageItems = allItems.slice(startIdx, endIdx);

  const feedItems: FeedItem[] = pageItems.map((r) => ({
    ...r,
    section:         sectionName,
    explanationKey:  buildExplanationKey(r, sectionName, profile),
    visibilityBoost: r.item.activeVisibilityBoost as number | undefined,
  }));

  const nextCursor =
    endIdx < allItems.length
      ? encodeCursor({ section: sectionName, index: endIdx })
      : null;

  return {
    section:    { name: sectionName, items: feedItems, total: allItems.length },
    nextCursor,
    fallback:   false,
  };
}
