/**
 * CreatorCapEnforcer — enforces per-creator frequency caps on a sorted feed
 * and emits fire-and-forget ranking_diversity_reordered analytics for each
 * item that is moved by the diversity pass.
 *
 * Algorithm (greedy, single pass):
 *   For each item in score-descending order:
 *     - If the item's creator is below the cap → accept into the result list.
 *     - If the creator has reached the cap    → defer the item.
 *   Deferred items are appended after all accepted items, preserving their
 *   relative score order so they surface again as soon as the cap window
 *   permits.
 *
 * System content (creatorId = null) is always accepted and never counted
 * against any creator's cap.
 *
 * Privacy rule: analytics writes include only event_type, item_id, surface,
 * content_type, user_id (viewer), and session_id — no score data or PII.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurfaceName, RankingOutput } from "./DiscoveryRankingService.js";
import { RankingEvent } from "./rankingAnalytics.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Maximum items from any single creator allowed in the assembled feed. */
export const DEFAULT_MAX_PER_CREATOR = 2;

// ── Options ───────────────────────────────────────────────────────────────────

export interface CreatorCapOptions {
  /**
   * Maximum number of items from a single creator in the assembled feed.
   * @default DEFAULT_MAX_PER_CREATOR (2)
   */
  maxPerCreator?: number;
}

// ── Internal analytics writer ─────────────────────────────────────────────────

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
        // "analytics" keeps these rows out of impression / outcome queries
        outcome:      "analytics",
      })
      .then(() => {}, () => {});
  } catch { /* non-fatal: analytics must never affect feed latency or correctness */ }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Enforce per-creator frequency caps on a sorted feed.
 *
 * Items that exceed the creator cap are moved to the end of the returned list
 * and a ranking_diversity_reordered event is emitted for each one.
 *
 * @param rankedOutputs  Eligible items sorted by finalScore descending.
 * @param itemTypeMap    itemId → itemType (for analytics content_type field).
 * @param creatorIdMap   itemId → creatorId (null = system/anonymous content).
 * @param surface        Feed surface (for analytics).
 * @param viewerId       Viewer user ID (for analytics).
 * @param sessionId      Session UUID, nullable (for analytics).
 * @param db             Supabase client for analytics writes (nullable → skipped).
 * @param options        Optional cap override.
 * @returns              Re-ordered items with cap-violating items at the tail.
 */
export function enforceCreatorCaps(
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

  // Per-creator count of items already accepted into the result
  const creatorCounts = new Map<string, number>();

  for (const output of rankedOutputs) {
    const creatorId = creatorIdMap.get(output.itemId) ?? null;

    if (!creatorId) {
      // System / anonymous content — always accepted, never counted
      accepted.push(output);
      continue;
    }

    const count = creatorCounts.get(creatorId) ?? 0;

    if (count < maxPerCreator) {
      accepted.push(output);
      creatorCounts.set(creatorId, count + 1);
    } else {
      // Item moved by the diversity pass — defer and emit analytics
      deferred.push(output);

      const itemType = itemTypeMap.get(output.itemId) ?? "unknown";
      writeDiversityAnalytic(db, output.itemId, itemType, surface, viewerId, sessionId);
    }
  }

  // Deferred items appended in their original (score-descending) order
  return [...accepted, ...deferred];
}
