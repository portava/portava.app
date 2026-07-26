/**
 * FeedSlotAllocator — assembles the final feed from ranked outputs,
 * allocating exploration, underexposed, and bucket slots, and emitting
 * fire-and-forget assembly-phase analytics for each slot.
 *
 * Slot kinds (mutually exclusive, checked in priority order):
 *   exploration     — every EXPLORATION_INTERVAL-th position (0-indexed: 6, 13, …)
 *   underexposed    — item has a non-zero underexposureBoost component
 *   new_creator     — item has a non-zero newContributorBoost component
 *   returning_creator — item has a non-zero returningUserBoost component
 *   standard        — all other eligible items
 *
 * Privacy rule: analytics writes include only event_type, item_id, surface,
 * content_type, user_id (viewer), and session_id — never score components,
 * private profile data, or raw feature vectors.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurfaceName, RankingInput, RankingOutput } from "./DiscoveryRankingService.js";
import { RankingEvent } from "./rankingAnalytics.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Exploration slots are placed at every EXPLORATION_INTERVAL-th position
 * (0-indexed positions 6, 13, 20 … — i.e. position % 7 === 6).
 * Must stay in sync with the adminRankingMetrics exploration_slot query.
 */
export const EXPLORATION_INTERVAL = 7;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SlotKind =
  | "standard"
  | "exploration"
  | "underexposed"
  | "new_creator"
  | "returning_creator";

export interface AllocatedFeedItem {
  itemId: string;
  itemType: string;
  slotIndex: number;
  slotKind: SlotKind;
}

// ── Internal analytics writer ─────────────────────────────────────────────────

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

// ── Slot classifier ───────────────────────────────────────────────────────────

function classifySlot(
  slotIndex: number,
  output: RankingOutput,
): { slotKind: SlotKind; eventType: string } {
  // Exploration slots take priority (they override score-component labels)
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Allocate feed slots from sorted ranking outputs and emit per-slot analytics.
 *
 * Only eligibility-passed items enter the feed.  The slotIndex reflects the
 * position in the final assembled feed (0-based), not the position in the
 * input array.
 *
 * @param rankedOutputs  Items sorted by finalScore descending (from rankItems).
 * @param inputs         Original ranking inputs (used for itemType lookup).
 * @param surface        Feed surface (compass, discovery, …).
 * @param viewerId       Viewer user ID.
 * @param sessionId      Session UUID (nullable).
 * @param db             Supabase client for analytics writes (nullable → skipped).
 * @returns              Allocated feed items in display order.
 */
export function allocateFeedSlots(
  rankedOutputs: RankingOutput[],
  inputs:        RankingInput[],
  surface:       SurfaceName,
  viewerId:      string,
  sessionId:     string | null,
  db:            SupabaseClient | null,
): AllocatedFeedItem[] {
  // Build a fast itemId → itemType lookup from the original inputs
  const itemTypeByItemId = new Map<string, string>();
  for (const input of inputs) {
    itemTypeByItemId.set(input.itemId, input.itemType);
  }

  const feed: AllocatedFeedItem[] = [];

  for (const output of rankedOutputs) {
    // Ineligible items are excluded from the assembled feed
    if (!output.eligibilityPassed) continue;

    const slotIndex = feed.length;
    const { slotKind, eventType } = classifySlot(slotIndex, output);
    const itemType = itemTypeByItemId.get(output.itemId) ?? "unknown";

    feed.push({ itemId: output.itemId, itemType, slotIndex, slotKind });

    // Fire-and-forget analytics — must not throw or delay the caller
    writeSlotAnalytic(db, eventType, output.itemId, itemType, surface, viewerId, sessionId);
  }

  return feed;
}
