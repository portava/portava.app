/**
 * CompassFairExposureEngine — Phase 3 fair-exposure boost.
 *
 * Problem: New users with few content items are invisible in a pure score-sort
 * feed because they lack the signal history (bookings, reviews, stamps) that
 * drives high scores. Fair exposure gives them a capped test window.
 *
 * Eligible subjects:
 *   - New verified users: account joined < JOINED_WITHIN_DAYS days ago AND
 *     fewer than APPEARANCE_CAP Compass appearances recorded.
 *   - Newly approved Buddies: buddy profile approved < JOINED_WITHIN_DAYS days ago
 *     AND fewer than APPEARANCE_CAP Compass appearances.
 *
 * Behaviour:
 *   - Up to MAX_FAIR_INSERTS fair-exposure items are inserted per feed build
 *     into eligible sections (any section whose items overlap with the full pool).
 *   - Appearance count for each item is incremented (fire-and-forget to DB).
 *   - If an item hits APPEARANCE_CAP, it is placed on cooldown (visibility boost ends).
 *   - If a report or no-show is recorded for the author, fair-exposure ends immediately.
 *     (Callers pass `isReportedByViewer: true` or `isSuspended: true` → item is
 *      already blocked by the Safety Filter and won't reach this engine.)
 *
 * The engine is mostly PURE — DB writes are fire-and-forget and optional.
 * Exception policy: any exception → item is NOT inserted (safe degradation).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PipelineResult } from "./CompassPipeline.js";
import type { CompassProfile } from "./types.js";

const JOINED_WITHIN_DAYS = 30;
const APPEARANCE_CAP     = 10;
const MAX_FAIR_INSERTS   = 2;
const COOLDOWN_DAYS      = 7;

export interface FairExposureResult {
  items:         PipelineResult[];
  insertedCount: number;
  boostedIds:    string[];
}

/** Returns true when an item's author is new enough to qualify for fair exposure. */
function isNewAuthor(item: PipelineResult): boolean {
  const joined = (item.item.authorJoinedAt ?? item.item.buddyApprovedAt) as string | undefined;
  if (!joined) return false;
  const ageDays = (Date.now() - new Date(joined).getTime()) / (1000 * 60 * 60 * 24);
  return ageDays < JOINED_WITHIN_DAYS;
}

/** Returns true when the item is a buddy type with a newly approved profile. */
function isNewBuddy(item: PipelineResult): boolean {
  if (item.item.type !== "buddy") return false;
  return isNewAuthor(item);
}

/**
 * Determine if an item qualifies for fair-exposure insertion.
 *
 * Disqualifiers (already enforced upstream but double-checked here):
 *   - Author is suspended or has active reports  → Safety Filter blocks
 *   - Item has a cooldown on record              → caller passes isOnCooldown
 *   - Appearance cap already reached             → caller passes appearanceCount
 */
function isFairExposureEligible(
  result: PipelineResult,
  boostRecord: { appearanceCount: number; isOnCooldown: boolean } | null,
): boolean {
  // Already at or above cap
  if (boostRecord && boostRecord.appearanceCount >= APPEARANCE_CAP) return false;
  // On cooldown
  if (boostRecord?.isOnCooldown) return false;
  // Must be a new verified user or new buddy
  if (!(isNewAuthor(result) || isNewBuddy(result))) return false;
  // Author must not have any active suspension / safety signal
  if (result.item.isSuspended) return false;
  // Non-buddy new users must have completed verification (isVerified=true).
  // Buddy approval (buddyApprovedAt) serves as their verification signal.
  if (result.item.type !== "buddy" && !result.item.isVerified) return false;
  return true;
}

/** Fire-and-forget increment of appearance count + optional cooldown creation. */
function recordAppearance(
  db: SupabaseClient | null,
  result: PipelineResult,
  newCount: number,
): void {
  if (!db) return;
  const now = new Date().toISOString();
  const boostType = result.item.type === "buddy" ? "new_buddy" : "new_verified_user";

  db.from("compass_visibility_boosts")
    .upsert(
      {
        item_id:          result.item.id,
        item_type:        result.item.type,
        author_id:        result.item.authorId,
        appearance_count: newCount,
        cap:              APPEARANCE_CAP,
        boost_type:       boostType,
        last_seen_at:     now,
        ...(newCount >= APPEARANCE_CAP ? { cap_hit_at: now } : {}),
      },
      { onConflict: "item_id,item_type" },
    )
    .then(() => {}, () => {});

  // If cap hit → create cooldown record
  if (newCount >= APPEARANCE_CAP && result.item.authorId) {
    const endsAt = new Date(Date.now() + COOLDOWN_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    db.from("compass_visibility_cooldowns")
      .upsert(
        {
          author_id:     result.item.authorId,
          cooldown_type: "fair_exposure_cap",
          started_at:    now,
          ends_at:       endsAt,
          reason:        "appearance_cap_reached",
        },
        { onConflict: "author_id,cooldown_type" },
      )
      .then(() => {}, () => {});
  }
}

/**
 * Apply fair-exposure insertions to a list of feed items.
 *
 * Fair-exposure candidates are taken from `allPoolItems` (the full pipeline
 * output, pre-diversity) and inserted near the top of `sectionItems`.
 *
 * @param sectionItems    Already-diversity-reordered items for this section
 * @param allPoolItems    All items that passed the Phase 2 pipeline
 * @param profile         The viewing user's Compass profile
 * @param db              Optional DB client for appearance tracking
 * @param appearanceCounts Map of itemId → current appearance count (from DB pre-load)
 * @param cooldownSet     Set of authorIds currently on cooldown
 */
export function applyFairExposure(
  sectionItems: PipelineResult[],
  allPoolItems:  PipelineResult[],
  profile:       CompassProfile,
  db:            SupabaseClient | null = null,
  appearanceCounts: Map<string, number> = new Map(),
  cooldownSet:   Set<string> = new Set(),
): FairExposureResult {
  try {
    // Already-inserted item IDs in this section (avoid duplicates)
    const alreadyIn = new Set(sectionItems.map((r) => r.item.id));

    const candidates = allPoolItems.filter((r) => {
      if (alreadyIn.has(r.item.id)) return false;
      if (!r.item.authorId) return false;
      if (profile.blockedUserIds.includes(r.item.authorId!)) return false;
      const count = appearanceCounts.get(r.item.id) ?? 0;
      const onCooldown = cooldownSet.has(r.item.authorId!);
      return isFairExposureEligible(r, { appearanceCount: count, isOnCooldown: onCooldown });
    });

    if (candidates.length === 0) {
      return { items: sectionItems, insertedCount: 0, boostedIds: [] };
    }

    // Take up to MAX_FAIR_INSERTS candidates
    const toInsert = candidates.slice(0, MAX_FAIR_INSERTS);
    const boostedIds: string[] = [];

    // Mark each as fair-exposure boosted and insert at position 2 (index 1)
    // so the #1 slot stays organic but new contributors appear early
    const enhanced = toInsert.map((r) => {
      const count = (appearanceCounts.get(r.item.id) ?? 0) + 1;
      recordAppearance(db, r, count);
      boostedIds.push(r.item.id);
      return {
        ...r,
        item: {
          ...r.item,
          fairExposureScore: 1.0,
          isFairExposureBoosted: true,
        },
      } as PipelineResult;
    });

    // Insert at position 1 (after the top organic item)
    const out = [...sectionItems];
    const insertAt = Math.min(1, out.length);
    out.splice(insertAt, 0, ...enhanced);

    return { items: out, insertedCount: enhanced.length, boostedIds };
  } catch {
    // Safe degradation — return original items unchanged
    return { items: sectionItems, insertedCount: 0, boostedIds: [] };
  }
}

/**
 * Immediately end fair-exposure for an author (report or no-show received).
 * Fire-and-forget — never throws.
 */
export function endFairExposure(
  db:       SupabaseClient | null,
  authorId: string,
  reason:   "report" | "no_show",
): void {
  if (!db) return;
  const now = new Date().toISOString();
  db.from("compass_visibility_boosts")
    .update({ report_ended_at: now })
    .eq("author_id", authorId)
    .is("report_ended_at", null)
    .then(() => {}, () => {});

  // Immediately create a cooldown (much shorter for no_show, standard for report)
  const cooldownDays = reason === "report" ? COOLDOWN_DAYS : Math.ceil(COOLDOWN_DAYS / 2);
  const endsAt = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1_000).toISOString();
  db.from("compass_visibility_cooldowns")
    .upsert(
      {
        author_id:     authorId,
        cooldown_type: "fair_exposure_cap",
        started_at:    now,
        ends_at:       endsAt,
        reason:        `fair_exposure_ended_by_${reason}`,
      },
      { onConflict: "author_id,cooldown_type" },
    )
    .then(() => {}, () => {});
}
