/**
 * FeedSlotAllocator — two complementary roles:
 *
 * 1. ANALYTICS (emitFeedSlotAnalytics) — fire-and-forget assembly-phase analytics.
 *    Works on RankingOutput[] (DRS output); emits rank_events per slot kind.
 *    Slot kinds: exploration | underexposed | new_creator | returning_creator | standard.
 *
 * 2. FEED COMPOSITION (allocateFeedSlots) — slot-based feed ordering.
 *    Works on PipelineResult[] (Compass pipeline output); divides into five buckets
 *    and interleaves them according to configurable share percentages:
 *      relevance    (~52 %) — highest-scoring ranked content
 *      activeCreator (~15 %) — items whose author has an active activity boost
 *      underexposed  (~15 %) — items in underexposure_status = 'boosting'
 *      newUser       (~13 %) — items from new contributors (joined < 30 days)
 *      exploration   (~ 5 %) — items from categories/types the viewer rarely sees
 *
 * Surface bypass rules (for allocateFeedSlots):
 *   • "search" → return input unchanged (query relevance, no slot split)
 *
 * Privacy rule: analytics writes include only event_type, item_id, surface,
 * content_type, user_id (viewer), and session_id — never score components,
 * private profile data, or raw feature vectors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurfaceName, RankingInput, RankingOutput } from "./DiscoveryRankingService.js";
import type { PipelineResult } from "../../compass/CompassPipeline.js";
import type { FeedShares } from "./rankingConfig.js";
import { RankingEvent } from "./rankingAnalytics.js";

// ─────────────────────────────────────────────────────────────────────────────
// ── Part 1: Analytics infrastructure (works with RankingOutput[]) ─────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exploration slots are placed at every EXPLORATION_INTERVAL-th position
 * (0-indexed positions 6, 13, 20 … — i.e. position % 7 === 6).
 * Must stay in sync with the adminRankingMetrics exploration_slot query.
 */
export const EXPLORATION_INTERVAL = 7;

export type SlotKind =
  | "standard"
  | "exploration"
  | "underexposed"
  | "new_creator"
  | "returning_creator";

export interface AllocatedFeedItem {
  itemId:    string;
  itemType:  string;
  slotIndex: number;
  slotKind:  SlotKind;
}

/**
 * Write a single assembly-phase analytics event to rank_events.
 * Fire-and-forget — never throws or blocks the caller.
 */
function writeSlotAnalytic(
  db:        SupabaseClient | null,
  eventType: string,
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
        event_type:   eventType,
        item_id:      itemId,
        content_type: itemType,
        surface,
        user_id:      viewerId,
        session_id:   sessionId ?? null,
        served_at:    new Date().toISOString(),
        // "analytics" keeps these rows out of impression / outcome queries
        outcome:      "analytics",
      })
      .then(() => {}, () => {});
  } catch { /* non-fatal: analytics must never affect feed latency or correctness */ }
}

function classifySlot(
  slotIndex: number,
  output: RankingOutput,
): { slotKind: SlotKind; eventType: string } {
  if (slotIndex % EXPLORATION_INTERVAL === EXPLORATION_INTERVAL - 1) {
    return { slotKind: "exploration", eventType: RankingEvent.ITEM_EXPLORATION_SELECTED };
  }
  if (output.components.underexposureBoost > 0) {
    return { slotKind: "underexposed", eventType: RankingEvent.ITEM_UNDEREXPOSED_SELECTED };
  }
  if (output.components.newContributorBoost > 0) {
    return { slotKind: "new_creator", eventType: RankingEvent.NEW_CREATOR_SELECTED };
  }
  if (output.components.returningUserBoost > 0) {
    return { slotKind: "returning_creator", eventType: RankingEvent.RETURNING_CREATOR_SELECTED };
  }
  return { slotKind: "standard", eventType: RankingEvent.ITEM_SELECTED };
}

/**
 * Emit assembly-phase analytics events for each slot in a ranked DRS output.
 * Fire-and-forget — never affects feed order, response shape, or latency.
 *
 * @param rankedOutputs  Items sorted by finalScore descending (from rankItems).
 * @param inputs         Original ranking inputs (used for itemType lookup).
 * @param surface        Feed surface (compass, discovery, …).
 * @param viewerId       Viewer user ID.
 * @param sessionId      Session UUID (nullable).
 * @param db             Supabase client for analytics writes (nullable → skipped).
 * @returns              Allocated feed items in display order.
 */
export function emitFeedSlotAnalytics(
  rankedOutputs: RankingOutput[],
  inputs:        RankingInput[],
  surface:       SurfaceName,
  viewerId:      string,
  sessionId:     string | null,
  db:            SupabaseClient | null,
): AllocatedFeedItem[] {
  const itemTypeByItemId = new Map<string, string>();
  for (const input of inputs) {
    itemTypeByItemId.set(input.itemId, input.itemType);
  }

  const feed: AllocatedFeedItem[] = [];

  for (const output of rankedOutputs) {
    if (!output.eligibilityPassed) continue;

    const slotIndex = feed.length;
    const { slotKind, eventType } = classifySlot(slotIndex, output);
    const itemType = itemTypeByItemId.get(output.itemId) ?? "unknown";

    feed.push({ itemId: output.itemId, itemType, slotIndex, slotKind });
    writeSlotAnalytic(db, eventType, output.itemId, itemType, surface, viewerId, sessionId);
  }

  return feed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Part 2: Feed composition (works with PipelineResult[]) ───────────────────
// ─────────────────────────────────────────────────────────────────────────────

const NEW_CREATOR_MAX_DAYS  = 30;
const EXPLORATION_SCORE_MIN = 0.5;

export type SlotBucket =
  | "relevance"
  | "activeCreator"
  | "underexposed"
  | "newUser"
  | "exploration";

/**
 * Classify a single item into its primary (non-relevance) bucket, or null
 * when it belongs only to the relevance pool.
 *
 * Priority order: activeCreator > underexposed > newUser > exploration
 */
function classifyItem(
  item: PipelineResult,
  underexposedItemIds: Set<string>,
): SlotBucket | null {
  if ((item.item.activeVisibilityBoost as number | undefined ?? 0) > 0) {
    return "activeCreator";
  }
  if (underexposedItemIds.has(item.item.id)) {
    return "underexposed";
  }
  const joined = (item.item.authorJoinedAt ?? item.item.buddyApprovedAt) as string | undefined;
  if (joined) {
    const ageDays = (Date.now() - new Date(joined).getTime()) / 86_400_000;
    if (ageDays < NEW_CREATOR_MAX_DAYS) return "newUser";
  }
  if ((item.item.diversityScore as number | undefined ?? 0) >= EXPLORATION_SCORE_MIN) {
    return "exploration";
  }
  return null;
}

/**
 * Interleave multiple buckets into one sequence using a weighted round-robin
 * (error-accumulation / Bresenham-like) algorithm.
 */
function weightedInterleave(
  buckets: PipelineResult[][],
  weights: number[],
): PipelineResult[] {
  const cursors      = buckets.map(() => 0);
  const accumulators = weights.map((w) => w);
  const totalItems   = buckets.reduce((s, b) => s + b.length, 0);
  const result: PipelineResult[] = [];

  for (let _i = 0; _i < totalItems; _i++) {
    for (let b = 0; b < buckets.length; b++) {
      accumulators[b]! += weights[b]!;
    }
    let best = -1, bestAcc = -Infinity;
    for (let b = 0; b < buckets.length; b++) {
      if (cursors[b]! >= buckets[b]!.length) continue;
      if (accumulators[b]! > bestAcc) { bestAcc = accumulators[b]!; best = b; }
    }
    if (best === -1) break;
    result.push(buckets[best]![cursors[best]!]!);
    cursors[best]!++;
    accumulators[best]! -= 1;
  }

  return result;
}

export interface SlotAllocatorOptions {
  /** Feed surface. "search" bypasses all slot allocation. */
  surface: string;
  /** Item IDs currently in underexposure_status = 'boosting'. */
  underexposedItemIds?: Set<string>;
}

/**
 * Allocate feed slots and interleave items according to share percentages.
 * Non-mutating: returns a new array. Input items are not modified.
 */
export function allocateFeedSlots(
  items:  PipelineResult[],
  shares: FeedShares,
  opts:   SlotAllocatorOptions,
): PipelineResult[] {
  if (opts.surface === "search" || items.length === 0) return items;

  const underexposedIds = opts.underexposedItemIds ?? new Set<string>();

  const buckets: Record<SlotBucket, PipelineResult[]> = {
    activeCreator: [],
    underexposed:  [],
    newUser:       [],
    exploration:   [],
    relevance:     [],
  };

  for (const item of items) {
    const bucket = classifyItem(item, underexposedIds) ?? "relevance";
    buckets[bucket].push(item);
  }

  const total          = items.length;
  const targetActive   = Math.round(total * shares.activeCreator / 100);
  const targetUnder    = Math.round(total * shares.underexposed   / 100);
  const targetNew      = Math.round(total * shares.newUser        / 100);
  const targetExplore  = Math.round(total * shares.exploration    / 100);

  const activeSlice  = buckets.activeCreator.slice(0, targetActive);
  const underSlice   = buckets.underexposed .slice(0, targetUnder);
  const newSlice     = buckets.newUser      .slice(0, targetNew);
  const exploreSlice = buckets.exploration  .slice(0, targetExplore);

  const specialIds = new Set<string>();
  for (const it of [...activeSlice, ...underSlice, ...newSlice, ...exploreSlice]) {
    specialIds.add(it.item.id);
  }
  const relevancePool = items.filter((it) => !specialIds.has(it.item.id));

  const present = [
    { b: relevancePool, w: shares.relevance     / 100 },
    { b: activeSlice,   w: shares.activeCreator / 100 },
    { b: underSlice,    w: shares.underexposed  / 100 },
    { b: newSlice,      w: shares.newUser       / 100 },
    { b: exploreSlice,  w: shares.exploration   / 100 },
  ].filter((s) => s.b.length > 0);

  if (present.length === 0) return items;

  const totalWeight  = present.reduce((s, p) => s + p.w, 0);
  const usedBuckets  = present.map((p) => p.b);
  const usedWeights  = present.map((p) => totalWeight > 0 ? p.w / totalWeight : 1 / present.length);

  return weightedInterleave(usedBuckets, usedWeights);
}

/**
 * Batch-load the set of underexposed item IDs from content_distribution_stats.
 * Non-fatal: returns empty set on error.
 */
export async function loadUnderexposedItemIds(
  db: SupabaseClient | null,
  itemIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (!db || itemIds.length === 0) return result;
  try {
    const unique = [...new Set(itemIds)].slice(0, 200);
    const { data } = await db
      .from("content_distribution_stats")
      .select("item_id")
      .in("item_id", unique)
      .eq("underexposure_status", "boosting");
    for (const row of (data as any[]) ?? []) {
      result.add(row.item_id as string);
    }
  } catch { /* non-fatal */ }
  return result;
}
