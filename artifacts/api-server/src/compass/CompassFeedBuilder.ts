/**
 * CompassFeedBuilder — Phase 3 feed assembly.
 *
 * Calls the Phase 2 pipeline, then applies diversity, fair exposure, and active-
 * user-reward boosts to produce a final paginated feed of named sections.
 *
 * Section catalogue (17 sections, each can be empty):
 *   for_you                    — personalised catch-all
 *   available_now              — buddies available today
 *   during_your_trip           — events/places during active trip dates
 *   tonight                    — events starting in the next 12 h
 *   near_your_area             — items in the viewer's current city
 *   compass_picks              — high-scoring items of mixed types
 *   people_you_may_vibe_with   — user/buddy cards with social compat
 *   rent_a_buddy               — buddy items only
 *   hidden_gems                — suggestion type items
 *   city_pulse                 — post items tagged to current city
 *   passport_stamp_opportunities — stamp type items
 *   safety_recommended         — items with high safety tier
 *   your_circle_may_like       — items from or near trust-circle members
 *   new_in_this_city           — items by recent arrivals
 *   budget_friendly            — items matching budget_mode / budget budgetStyle
 *   creator_spots              — suggestion items in creator_mode context
 *   arrival_help               — arrival_mode targeted items
 *
 * Each FeedItem carries an explanationKey string (used in Phase 5 explanations).
 *
 * Cursor-based pagination:
 *   The cursor is a base64-encoded JSON { section, index } pointer.
 *   First request: no cursor → returns first page of all sections.
 *   Subsequent requests: cursor → returns next page within that section.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile, CompassContext } from "./types.js";
import type { PipelineResult, PipelineTestOverrides } from "./CompassPipeline.js";
import { runPipeline } from "./CompassPipeline.js";
import { applyDiversity } from "./CompassDiversityEngine.js";
import { applyFairExposure } from "./CompassFairExposureEngine.js";
import {
  computeActiveUserScore,
  computeItemVisibilityBoost,
  type ActiveUserScoreResult,
} from "./CompassActiveUserRewardEngine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE    = 20;
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
  name:     SectionName;
  items:    FeedItem[];
  total:    number;
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
  skipFairExposure?:    boolean;
  skipActiveRewards?:   boolean;
  authorScores?:        Map<string, ActiveUserScoreResult>;
}

// ── Explanation key generation ─────────────────────────────────────────────────

function buildExplanationKey(item: PipelineResult, section: SectionName, profile: CompassProfile): string {
  const base = `${section}:${item.item.type}`;
  if (item.item.city && profile.currentCity === item.item.city) return `${base}:local`;
  if (item.item.fairExposureScore) return `${base}:fair_exposure`;
  if ((item.item.diversityScore ?? 0) > 0.5)  return `${base}:diversity_pick`;
  return base;
}

// ── Section routing ────────────────────────────────────────────────────────────

function assignSections(
  items: PipelineResult[],
  profile: CompassProfile,
  context: CompassContext,
): Map<SectionName, PipelineResult[]> {
  const now = new Date();
  const tonightEnd = new Date(now);
  tonightEnd.setHours(23, 59, 59, 999);
  const twelveHoursLater = new Date(now.getTime() + 12 * 60 * 60 * 1_000);

  const sections = new Map<SectionName, PipelineResult[]>(
    SECTION_NAMES.map((n) => [n, []]),
  );

  const push = (name: SectionName, r: PipelineResult) => {
    const sec = sections.get(name)!;
    if (sec.length < MAX_PER_SECTION) sec.push(r);
  };

  for (const r of items) {
    const { item } = r;
    let assigned = false;

    // available_now — buddy items with active status
    if (item.type === "buddy" && item.buddyStatus === "active") {
      push("available_now", r);
      push("rent_a_buddy", r);
      assigned = true;
    }

    // during_your_trip — items with trip scope when viewer has active trip
    if (profile.hasActiveTrip && item.visibilityScope === "trip_only") {
      push("during_your_trip", r);
      assigned = true;
    }

    // tonight — events starting within next 12 hours
    if (item.type === "event" && item.eventStartsAt) {
      const start = new Date(item.eventStartsAt as string);
      if (start >= now && start <= twelveHoursLater) {
        push("tonight", r);
        assigned = true;
      }
    }

    // near_your_area — items in viewer's current city
    if (profile.currentCity && item.city === profile.currentCity) {
      push("near_your_area", r);
      assigned = true;
    }

    // people_you_may_vibe_with — user or buddy types
    if (item.type === "user" || item.type === "buddy") {
      push("people_you_may_vibe_with", r);
      if (item.type === "buddy" && !assigned) push("rent_a_buddy", r);
      assigned = true;
    }

    // hidden_gems — suggestion type
    if (item.type === "suggestion") {
      push("hidden_gems", r);
      assigned = true;
    }

    // city_pulse — posts
    if (item.type === "post") {
      push("city_pulse", r);
      assigned = true;
    }

    // passport_stamp_opportunities — stamps
    if (item.type === "stamp") {
      push("passport_stamp_opportunities", r);
      assigned = true;
    }

    // safety_recommended — high safety tier items
    if (item.safetyTier === "relaxed" || (item.safetyTier === "standard" && profile.safetyPreference === "cautious")) {
      push("safety_recommended", r);
      assigned = true;
    }

    // new_in_this_city — items by recently joined authors
    if (item.authorJoinedAt) {
      const joinedDays = (Date.now() - new Date(item.authorJoinedAt as string).getTime()) / (1000 * 60 * 60 * 24);
      if (joinedDays < 30) {
        push("new_in_this_city", r);
        assigned = true;
      }
    }

    // budget_friendly
    if (profile.budgetStyle === "budget" || item.interestTags?.includes("budget") || item.interestTags?.includes("free")) {
      push("budget_friendly", r);
      assigned = true;
    }

    // creator_spots — suggestions in creator context
    if (context.contextState === "creator_mode" && item.type === "suggestion") {
      push("creator_spots", r);
      assigned = true;
    }

    // arrival_help — arrival mode context
    if (context.contextState === "arrival_mode") {
      push("arrival_help", r);
      assigned = true;
    }

    // your_circle_may_like — circle_only scope items visible to viewer
    if (item.visibilityScope === "circle_only" && item.viewerIsInCircle) {
      push("your_circle_may_like", r);
      assigned = true;
    }

    // compass_picks — top-scoring items of any type
    if (r.finalScore >= 70) {
      push("compass_picks", r);
      assigned = true;
    }

    // for_you — everything (catch-all)
    push("for_you", r);
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
    if (parsed && typeof parsed.section === "string" && typeof parsed.index === "number") {
      return parsed as FeedCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Main feed builder ─────────────────────────────────────────────────────────

/**
 * Build a paginated Compass feed for the calling user.
 *
 * @param items          Raw CompassItems to run through the pipeline
 * @param profile        The viewer's Compass profile
 * @param context        The resolved Compass context
 * @param db             Supabase service client (optional in tests)
 * @param cursor         Pagination cursor from a previous call (null = first page)
 * @param _overrides     Test injection hooks
 */
export async function buildFeed(
  items:      CompassItem[],
  profile:    CompassProfile,
  context:    CompassContext,
  db:         SupabaseClient | null = null,
  cursor:     string | null = null,
  _overrides: FeedBuilderTestOverrides = {},
): Promise<FeedPage> {
  // ── Phase 2 pipeline ────────────────────────────────────────────────────────
  const pipelineResult = await runPipeline(items, profile, context, db, _overrides);
  const { results, inputCount, blockedCount, rejectedCount, passedCount } = pipelineResult;

  // ── Active user reward scores (batch, best-effort) ─────────────────────────
  const authorScores: Map<string, ActiveUserScoreResult> = _overrides.authorScores ?? new Map();

  if (db && !_overrides.skipActiveRewards) {
    const authorIds = [...new Set(results.map((r) => r.item.authorId).filter(Boolean))] as string[];
    await Promise.allSettled(
      authorIds.map(async (authorId) => {
        if (authorScores.has(authorId)) return;
        const score = await computeActiveUserScore(db, authorId, profile);
        if (score) authorScores.set(authorId, score);
      }),
    );
  }

  // Apply active-user visibility boosts to finalScore
  const boosted: PipelineResult[] = results.map((r) => {
    if (!r.item.authorId) return r;
    const authorScore  = authorScores.get(r.item.authorId!);
    const boost        = computeItemVisibilityBoost(authorScore ?? null);
    if (boost <= 0) return r;
    return {
      ...r,
      finalScore: r.finalScore + boost,
      item: { ...r.item, activeVisibilityBoost: boost },
    };
  });

  // Re-sort after boost
  boosted.sort((a, b) => b.finalScore - a.finalScore);

  // ── Diversity pass ─────────────────────────────────────────────────────────
  const { items: diversified } = applyDiversity(boosted, profile);

  // ── Assign sections ────────────────────────────────────────────────────────
  const sectionMap = assignSections(diversified, profile, context);

  // ── Fair exposure per section ──────────────────────────────────────────────
  if (!_overrides.skipFairExposure) {
    for (const [name, sectionItems] of sectionMap) {
      const fairResult = applyFairExposure(sectionItems, diversified, profile, db);
      sectionMap.set(name, fairResult.items);
    }
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  const parsedCursor = cursor ? decodeCursor(cursor) : null;

  // Determine page slices per section
  const sections: FeedSection[] = [];
  let nextCursor: string | null = null;

  for (const name of SECTION_NAMES) {
    const allItems = sectionMap.get(name) ?? [];
    const startIdx  = parsedCursor?.section === name ? parsedCursor.index : 0;
    const endIdx    = startIdx + PAGE_SIZE;
    const pageItems = allItems.slice(startIdx, endIdx);

    const feedItems: FeedItem[] = pageItems.map((r) => ({
      ...r,
      section:         name,
      explanationKey:  buildExplanationKey(r, name, profile),
      visibilityBoost: r.item.activeVisibilityBoost as number | undefined,
    }));

    if (feedItems.length > 0) {
      sections.push({ name, items: feedItems, total: allItems.length });

      // Emit cursor pointing to next batch in this section
      if (endIdx < allItems.length && !nextCursor) {
        nextCursor = encodeCursor({ section: name, index: endIdx });
      }
    }
  }

  return {
    sections,
    nextCursor,
    fallback: false,
    pipelineMeta: { inputCount, blockedCount, rejectedCount, passedCount },
  };
}

/**
 * Build a single named section.
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
  const feed = await buildFeed(items, profile, context, db, cursor, _overrides);
  const found = feed.sections.find((s) => s.name === sectionName);
  const empty: FeedSection = { name: sectionName, items: [], total: 0 };
  return {
    section:    found ?? empty,
    nextCursor: feed.nextCursor,
    fallback:   false,
  };
}
