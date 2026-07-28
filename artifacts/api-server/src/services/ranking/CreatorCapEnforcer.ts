/**
 * CreatorCapEnforcer — two complementary roles:
 *
 * 1. ANALYTICS (emitCreatorCapAnalytics) — fire-and-forget diversity analytics.
 *    Works on RankingOutput[] (DRS output); emits ranking_diversity_reordered
 *    events for items moved by the cap.  Never affects feed order.
 *
 * 2. FEED COMPOSITION — enforces creator-frequency caps on an assembled feed.
 *    Three exports:
 *      enforceCreatorCaps        — for PipelineResult[] (Compass feed builder)
 *      enforceCreatorCapsGeneric — generic variant for pulse/discovery feeds
 *      enforceStoryTrayCaps      — story-tray consecutive-cap variant
 *
 *    Two configurable caps (from ranking_config):
 *      maxConsecutive (default 2) — at most N items from one creator in a row.
 *      maxPerPage     (default 3) — at most N items from one creator per page.
 *
 *    Algorithm (two phases):
 *      Phase 1 — Per-page cap: items beyond maxPerPage for a creator are marked
 *                as overflow.  Main items come first, overflow is appended at tail.
 *      Phase 2 — Consecutive cap: a greedy scheduler runs over the full combined
 *                array (main + overflow) and pushes any item that would create a
 *                run of > maxConsecutive to the nearest valid slot.  When no valid
 *                slot exists (mathematically impossible), it falls back to best-effort.
 *
 *    Reorder-only: every item the caller supplies appears exactly once in the output.
 *
 * Privacy rule: analytics writes include only event_type, item_id, surface,
 * content_type, user_id (viewer), and session_id — no score data or PII.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurfaceName, RankingOutput } from "./DiscoveryRankingService.js";
import type { PipelineResult } from "../../compass/CompassPipeline.js";
import { RankingEvent } from "./rankingAnalytics.js";

// ─────────────────────────────────────────────────────────────────────────────
// ── Part 1: Analytics (works with RankingOutput[]) ────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_PER_CREATOR = 2;

export interface CreatorCapOptions {
  /** Maximum number of items from a single creator in the assembled feed. */
  maxPerCreator?: number;
}

/**
 * Write a diversity-reordered analytics event to rank_events.
 * Fire-and-forget — never throws or blocks the caller.
 */
function writeDiversityAnalytic(
  db:        SupabaseClient | null,
  itemId:    string,
  itemType:  string,
  surface:   SurfaceName,
  viewerId:  string,
  sessionId: string | null,
): void {
  if (!db) return;
  try {
    void db
      .from("rank_events")
      .insert({
        event_type:   RankingEvent.DIVERSITY_REORDERED,
        item_id:      itemId,
        content_type: itemType,
        surface,
        user_id:      viewerId,
        session_id:   sessionId ?? null,
        served_at:    new Date().toISOString(),
        outcome:      "analytics",
      })
      .then(() => {}, () => {});
  } catch { /* non-fatal */ }
}

/**
 * Enforce per-creator frequency caps on a sorted DRS feed and emit
 * ranking_diversity_reordered analytics for each moved item.
 *
 * Fire-and-forget analytics path — does not affect feed order in callers
 * that use it as a side-effect only.
 */
export function emitCreatorCapAnalytics(
  rankedOutputs: RankingOutput[],
  itemTypeMap:   Map<string, string>,
  creatorIdMap:  Map<string, string | null>,
  surface:       SurfaceName,
  viewerId:      string,
  sessionId:     string | null,
  db:            SupabaseClient | null,
  options:       CreatorCapOptions = {},
): RankingOutput[] {
  const maxPerCreator = options.maxPerCreator ?? DEFAULT_MAX_PER_CREATOR;

  const accepted: RankingOutput[] = [];
  const deferred: RankingOutput[] = [];
  const creatorCounts = new Map<string, number>();

  for (const output of rankedOutputs) {
    const creatorId = creatorIdMap.get(output.itemId) ?? null;

    if (!creatorId) {
      accepted.push(output);
      continue;
    }

    const count = creatorCounts.get(creatorId) ?? 0;

    if (count < maxPerCreator) {
      accepted.push(output);
      creatorCounts.set(creatorId, count + 1);
    } else {
      deferred.push(output);
      const itemType = itemTypeMap.get(output.itemId) ?? "unknown";
      writeDiversityAnalytic(db, output.itemId, itemType, surface, viewerId, sessionId);
    }
  }

  return [...accepted, ...deferred];
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Part 2: Feed composition (works with PipelineResult[]) ───────────────────
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatorCapConfig {
  /** Max consecutive positions from the same author. Default: 2. */
  maxConsecutive: number;
  /** Max items from one author per page / assembled list. Default: 3. */
  maxPerPage: number;
}

export const DEFAULT_CREATOR_CAP: CreatorCapConfig = {
  maxConsecutive: 2,
  maxPerPage: 3,
};

// ── Internal: greedy consecutive-cap scheduler ────────────────────────────────

/**
 * Greedy scheduler that enforces a consecutive-author cap across a list.
 *
 * At each output position:
 *   1. Determine if an author is currently "blocked" (last maxConsecutive
 *      placed items are all from the same author).
 *   2. Pick the first item in `remaining` whose author is not blocked.
 *   3. If no unblocked item exists (mathematically impossible given the input),
 *      fall back to the first remaining item (best-effort).
 *
 * Reorder-only: every item appears exactly once in the output.
 * O(n²) worst case; acceptable for typical feed sizes (≤ 200 items).
 */
function applyConsecutiveCap<T>(
  items:       T[],
  getAuthorId: (item: T) => string | null | undefined,
  maxConsecutive: number,
): T[] {
  if (maxConsecutive <= 0 || items.length === 0) return [...items];

  const remaining = [...items];
  const result: T[] = [];

  while (remaining.length > 0) {
    // Determine the currently-blocked author (if any).
    let blockedAuthor: string | null = null;
    if (result.length >= maxConsecutive) {
      const tail = result.slice(-maxConsecutive);
      const first = getAuthorId(tail[0]!) ?? null;
      if (first !== null && tail.every((item) => (getAuthorId(item) ?? null) === first)) {
        blockedAuthor = first;
      }
    }

    // Find the first eligible (non-blocked) item.
    let idx = blockedAuthor !== null
      ? remaining.findIndex((r) => (getAuthorId(r) ?? null) !== blockedAuthor)
      : 0;

    // Best-effort fallback when no valid item exists.
    if (idx === -1) idx = 0;

    result.push(remaining.splice(idx, 1)[0]!);
  }

  return result;
}

/**
 * Enforce per-page and consecutive creator caps on an assembled Compass feed.
 *
 * Two-phase algorithm:
 *   Phase 1 — Per-page cap: items beyond maxPerPage are marked as overflow
 *              and placed at the end of the candidate pool.
 *   Phase 2 — Consecutive cap: a greedy scheduler runs over the full combined
 *              list (main + overflow) to ensure no author exceeds maxConsecutive
 *              consecutive positions anywhere in the output.
 *
 * Reorder-only: every item the caller supplies appears exactly once in the output.
 * Non-mutating: returns a new array.
 */
export function enforceCreatorCaps(
  items:  PipelineResult[],
  config: CreatorCapConfig = DEFAULT_CREATOR_CAP,
): PipelineResult[] {
  if (items.length === 0) return items;
  const { maxConsecutive, maxPerPage } = config;

  // Phase 1: Per-page cap — split into main (within-budget) and overflow.
  const pageCount = new Map<string, number>();
  const main:     PipelineResult[] = [];
  const overflow: PipelineResult[] = [];

  for (const item of items) {
    const authorId = item.item.authorId ?? null;
    if (!authorId) { main.push(item); continue; }

    const count = pageCount.get(authorId) ?? 0;
    if (count < maxPerPage) {
      main.push(item);
      pageCount.set(authorId, count + 1);
    } else {
      overflow.push(item);
    }
  }

  // Phase 2: Consecutive cap — greedy scheduler over the full combined list.
  // Overflow items appear at the tail but are still subject to the consecutive cap
  // so the full output sequence is valid everywhere.
  return applyConsecutiveCap(
    [...main, ...overflow],
    (item) => item.item.authorId ?? null,
    maxConsecutive,
  );
}

/**
 * Generic variant of enforceCreatorCaps that works on any item type.
 * Useful for pulse/discovery feeds that use types other than PipelineResult.
 *
 * Optional `isOfficialPublisher` predicate: when provided and returns true for
 * an item, that item is exempt from the per-page cap (official-publisher items
 * such as @Portava posts always pass through to main so they are never fully
 * suppressed by the diversity limiter).  The consecutive cap still applies to
 * all items including official publishers.
 */
export function enforceCreatorCapsGeneric<T>(
  items:               T[],
  getAuthorId:         (item: T) => string | null | undefined,
  config:              CreatorCapConfig = DEFAULT_CREATOR_CAP,
  isOfficialPublisher: ((item: T) => boolean) | undefined = undefined,
): T[] {
  if (items.length === 0) return items;
  const { maxConsecutive, maxPerPage } = config;

  // Phase 1: Per-page cap.
  // Official-publisher items bypass the cap and always enter main.
  const pageCount = new Map<string, number>();
  const main:     T[] = [];
  const overflow: T[] = [];

  for (const item of items) {
    const authorId  = getAuthorId(item) ?? null;
    const isPublish = isOfficialPublisher ? isOfficialPublisher(item) : false;
    if (!authorId || isPublish) { main.push(item); continue; }

    const count = pageCount.get(authorId) ?? 0;
    if (count < maxPerPage) {
      main.push(item);
      pageCount.set(authorId, count + 1);
    } else {
      overflow.push(item);
    }
  }

  // Phase 2: Consecutive cap over the full combined list.
  return applyConsecutiveCap(
    [...main, ...overflow],
    getAuthorId,
    maxConsecutive,
  );
}

/**
 * Story-tray variant: no single creator occupies more than 2 consecutive
 * positions. Works on any array where items carry an authorId getter.
 * No per-page cap — only the consecutive cap is enforced.
 */
export function enforceStoryTrayCaps<T>(
  items: T[],
  getAuthorId: (item: T) => string | null | undefined,
  maxConsecutive = 2,
): T[] {
  return applyConsecutiveCap(items, getAuthorId, maxConsecutive);
}
