/**
 * WallDiversityService — the Feed Diversity Controller (spec §15).
 *
 * OWNS: the diversity / anti-monotony pass applied AFTER the For You ranker has
 * produced an order. DOES NOT OWN: ranking (WallRankingService), authorization
 * (WallProjectionService gate) or content truth.
 *
 * This controller is what stops For You from degrading into "five videos in a
 * row", a single-creator flood, a wall of intelligence annotations, or a
 * disguised Discovery page (spec §15). It COMPOSES the canonical ranking
 * building blocks rather than inventing new ones:
 *
 *   • actor floods            → services/ranking/CreatorCapEnforcer
 *                               (enforceCreatorCapsGeneric) as the first, hard
 *                               per-creator pass, then a windowed spacing pass.
 *   • object-type monotony    → a sliding-window greedy reorder that never lets
 *                               one objectType exceed maxSameObjectTypeInWindow
 *                               within the visible window (the "5 videos" rule).
 *   • disguised Discovery page → discovery insertions are pruned to
 *                               maxDiscoveryInsertionsInWindow and to keep the
 *                               social-object ratio at/above minSocialObjectRatio.
 *   • annotation overload     → NOT OWNED HERE. See below.
 *   • live-strip repetition   → NOT OWNED HERE. See below.
 *
 * ANNOTATION CAPPING AND §4 LIVE-STRIP DEDUP LIVE IN ContextThreadService
 * ======================================================================
 * This controller used to carry a second copy of both rules, and that copy was a
 * PERMANENT NO-OP: routes/wall.ts calls applyFeedDiversity on the ranked page
 * BEFORE attachContextThreads runs and before the Live For You strip exists, so
 * the copy always saw zero context threads and an empty strip set. It could not
 * fire, and `wallDiversity`'s two tests for it exercised a path production never
 * took.
 *
 * The rules themselves are enforced — earlier, and by the only component that
 * can enforce them cheaply. `attachContextThreads` folds the per-window cap into
 * each candidate's `visualOverload`, and ContextThreadService's §9 gate folds the
 * strip dedup into `duplicatesLiveStrip`, so an over-budget or duplicate thread
 * is never BUILT rather than being built and then stripped. That copy was also
 * the weaker of the two: it deduped `live_place` threads only, where the gate now
 * dedups every place-anchored kind against the same kind of strip item.
 *
 * REORDER-PRESERVING WHERE IT CAN BE. Actor / object-type spacing is a reorder
 * (every item still appears), so ranking is respected as closely as the caps
 * allow. Only ONE thing DROPS an item: an over-budget discovery insertion (it is
 * an insertion, prunable by design) — never a followed-graph social object.
 *
 * Pure and DB-free: it transforms an already-ranked, already-gated projection
 * list. Never throws.
 */
import {
  enforceCreatorCapsGeneric,
  type CreatorCapConfig,
} from "../ranking/CreatorCapEnforcer.js";
import type { WallProjection } from "../../lib/wallProjection.js";

/** The §15 policy. */
export interface FeedDiversityPolicy {
  /** Max items from one actor within the sliding window. */
  maxSameActorInWindow: number;
  /** Max items of one objectType within the sliding window (the "5 videos" cap). */
  maxSameObjectTypeInWindow: number;
  /**
   * Max context-thread annotations within the sliding window. Carried on the
   * policy because it is a §15 diversity number, but ENFORCED by
   * WallProjectionService.attachContextThreads, which is handed this value and
   * refuses to build the excess thread in the first place.
   */
  maxContextThreadsInWindow: number;
  /** Floor on the fraction of window items that are social (non-insertion). */
  minSocialObjectRatio: number;
  /** Max discovery insertions within the sliding window. */
  maxDiscoveryInsertionsInWindow: number;
  /** Soft minimum spacing (in positions) between two Postcards (spec §10 rhythm). */
  postcardSpacingHint?: number;
}

export const DEFAULT_FEED_DIVERSITY_POLICY: FeedDiversityPolicy = {
  maxSameActorInWindow: 2,
  maxSameObjectTypeInWindow: 3,
  maxContextThreadsInWindow: 2,
  minSocialObjectRatio: 0.5,
  maxDiscoveryInsertionsInWindow: 2,
  postcardSpacingHint: 3,
};

/** The visible sliding window over which "…InWindow" caps are evaluated. */
export const DIVERSITY_WINDOW = 6;

export interface ApplyDiversityOptions {
  /** Override the sliding-window size (default DIVERSITY_WINDOW). */
  windowSize?: number;
}

export interface ApplyDiversityResult {
  items: WallProjection[];
  /** Discovery insertions dropped to preserve the social ratio / discovery cap. */
  droppedDiscovery: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function actorId(p: WallProjection): string | null {
  return p.actor?.userId ?? null;
}

/** A "social object" is anything that is not a prunable insertion. Discovery and
 *  contextual_opportunity are insertions; everything else is social content. */
function isSocialObject(p: WallProjection): boolean {
  return p.objectType !== "discovery" && p.objectType !== "contextual_opportunity";
}

function isDiscovery(p: WallProjection): boolean {
  return p.objectType === "discovery";
}

// ── Step 1: prune discovery insertions (disguised-Discovery-page defense) ─────

/**
 * Drop discovery insertions so that within every sliding window neither the
 * discovery cap nor the social-ratio floor is violated. A forward single pass:
 * an out-of-budget discovery item is dropped; social objects are never dropped.
 */
function pruneDiscovery(
  items: WallProjection[],
  policy: FeedDiversityPolicy,
  windowSize: number,
): { items: WallProjection[]; dropped: number } {
  const out: WallProjection[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!isDiscovery(item)) {
      out.push(item);
      continue;
    }
    // Evaluate the window that WOULD end at this new position.
    const window = out.slice(Math.max(0, out.length - (windowSize - 1)));
    const discoveryInWindow = window.filter(isDiscovery).length;
    const prospectiveLen = window.length + 1;
    const socialInWindow = window.filter(isSocialObject).length;
    const prospectiveSocialRatio = socialInWindow / prospectiveLen; // the new item is NOT social
    if (
      discoveryInWindow + 1 > policy.maxDiscoveryInsertionsInWindow ||
      prospectiveSocialRatio < policy.minSocialObjectRatio
    ) {
      dropped++;
      continue; // drop this insertion
    }
    out.push(item);
  }
  return { items: out, dropped };
}

// ── Step 2: actor + object-type spacing (reorder; no floods, no 5-in-a-row) ──

/**
 * Greedy windowed reorder. Walks the ranked list and, for each output slot,
 * takes the HIGHEST-ranked remaining item whose placement keeps the window
 * within both the actor cap and the object-type cap; if none qualifies it
 * relaxes (best-effort) rather than dropping. Applies postcardSpacingHint as a
 * soft preference. Rank order is preserved wherever the caps allow.
 */
function spaceByActorAndType(
  items: WallProjection[],
  policy: FeedDiversityPolicy,
  windowSize: number,
): WallProjection[] {
  const remaining = [...items];
  const out: WallProjection[] = [];

  while (remaining.length > 0) {
    const window = out.slice(Math.max(0, out.length - (windowSize - 1)));
    const actorCount = new Map<string, number>();
    const typeCount = new Map<string, number>();
    let lastPostcardPos = -Infinity;
    window.forEach((w, idx) => {
      const a = actorId(w);
      if (a) actorCount.set(a, (actorCount.get(a) ?? 0) + 1);
      typeCount.set(w.objectType, (typeCount.get(w.objectType) ?? 0) + 1);
      if (w.objectType === "postcard") lastPostcardPos = out.length - window.length + idx;
    });

    let chosenIdx = -1;
    let softChosenIdx = -1; // passes caps but violates the postcard spacing hint
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const a = actorId(cand);
      const actorOk = !a || (actorCount.get(a) ?? 0) < policy.maxSameActorInWindow;
      const typeOk = (typeCount.get(cand.objectType) ?? 0) < policy.maxSameObjectTypeInWindow;
      if (!actorOk || !typeOk) continue;
      // Postcard spacing is a soft hint — prefer a candidate that respects it.
      if (
        cand.objectType === "postcard" &&
        policy.postcardSpacingHint &&
        out.length - lastPostcardPos < policy.postcardSpacingHint
      ) {
        if (softChosenIdx === -1) softChosenIdx = i;
        continue;
      }
      chosenIdx = i;
      break;
    }
    if (chosenIdx === -1) chosenIdx = softChosenIdx;
    // Relax: no candidate satisfies the caps ⇒ take the highest-ranked remaining
    // (best-effort; we never drop a social object for spacing).
    if (chosenIdx === -1) chosenIdx = 0;
    out.push(remaining.splice(chosenIdx, 1)[0]);
  }
  return out;
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Apply the Feed Diversity Controller over a ranked For You order. Returns the
 * diversified items plus counts of what was pruned/stripped (for analytics).
 * Never throws — on any internal inconsistency it returns the input untouched.
 */
export function applyFeedDiversity(
  items: WallProjection[],
  policy: FeedDiversityPolicy = DEFAULT_FEED_DIVERSITY_POLICY,
  opts: ApplyDiversityOptions = {},
): ApplyDiversityResult {
  if (items.length === 0) {
    return { items: [], droppedDiscovery: 0 };
  }
  const windowSize = Math.max(2, opts.windowSize ?? DIVERSITY_WINDOW);
  try {
    // 1. Prune out-of-budget discovery insertions (disguised-Discovery defense).
    const pruned = pruneDiscovery(items, policy, windowSize);

    // 2. Break one-creator floods (compose CreatorCapEnforcer as a consecutive-
    //    run breaker), then the windowed pass enforces the per-window caps. The
    //    per-page ceiling is left generous (no page cap) so a creator may still
    //    appear several times across a long feed — just never bunched.
    const capConfig: CreatorCapConfig = {
      maxConsecutive: Math.max(1, policy.maxSameActorInWindow),
      maxPerPage: Math.max(pruned.items.length, 1),
    };
    const capped = enforceCreatorCapsGeneric(pruned.items, actorId, capConfig);
    const spaced = spaceByActorAndType(capped, policy, windowSize);

    return { items: spaced, droppedDiscovery: pruned.dropped };
  } catch {
    return { items, droppedDiscovery: 0 };
  }
}

// Test seam — the pure step functions, exercised directly by the diversity tests.
export const _internal = {
  pruneDiscovery,
  spaceByActorAndType,
  isSocialObject,
  isDiscovery,
};
