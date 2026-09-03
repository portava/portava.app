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
 *   • annotation overload     → context threads are capped per window
 *                               (maxContextThreadsInWindow) by STRIPPING the
 *                               excess annotation (the object stays; §15).
 *   • live-strip repetition   → a context thread that merely re-states a live
 *                               fact already in the Live For You strip is removed
 *                               (liveStripDeduplication, spec §4/§15).
 *
 * REORDER-PRESERVING WHERE IT CAN BE. Actor / object-type spacing is a reorder
 * (every item still appears), so ranking is respected as closely as the caps
 * allow. Only two things DROP an item: an over-budget discovery insertion (it is
 * an insertion, prunable by design) — never a followed-graph social object.
 * Context-thread capping strips the ANNOTATION, never the object.
 *
 * Pure and DB-free: it transforms an already-ranked, already-gated projection
 * list. Never throws.
 */
import {
  enforceCreatorCapsGeneric,
  type CreatorCapConfig,
} from "../ranking/CreatorCapEnforcer.js";
import type { ContextThread, WallProjection } from "../../lib/wallProjection.js";

/** The §15 policy. */
export interface FeedDiversityPolicy {
  /** Max items from one actor within the sliding window. */
  maxSameActorInWindow: number;
  /** Max items of one objectType within the sliding window (the "5 videos" cap). */
  maxSameObjectTypeInWindow: number;
  /** Max context-thread annotations within the sliding window. */
  maxContextThreadsInWindow: number;
  /** Floor on the fraction of window items that are social (non-insertion). */
  minSocialObjectRatio: number;
  /** Max discovery insertions within the sliding window. */
  maxDiscoveryInsertionsInWindow: number;
  /** Soft minimum spacing (in positions) between two Postcards (spec §10 rhythm). */
  postcardSpacingHint?: number;
  /** Remove a context thread that duplicates a Live For You strip subject. */
  liveStripDeduplication: boolean;
}

export const DEFAULT_FEED_DIVERSITY_POLICY: FeedDiversityPolicy = {
  maxSameActorInWindow: 2,
  maxSameObjectTypeInWindow: 3,
  maxContextThreadsInWindow: 2,
  minSocialObjectRatio: 0.5,
  maxDiscoveryInsertionsInWindow: 2,
  postcardSpacingHint: 3,
  liveStripDeduplication: true,
};

/** The visible sliding window over which "…InWindow" caps are evaluated. */
export const DIVERSITY_WINDOW = 6;

export interface ApplyDiversityOptions {
  /** Live For You subjects to dedup context threads against (spec §4/§15). */
  liveStripSubjectIds?: Set<string>;
  /** Override the sliding-window size (default DIVERSITY_WINDOW). */
  windowSize?: number;
}

export interface ApplyDiversityResult {
  items: WallProjection[];
  /** Discovery insertions dropped to preserve the social ratio / discovery cap. */
  droppedDiscovery: number;
  /** Context-thread annotations stripped (window cap + live-strip dedup). */
  strippedThreads: number;
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

/** The place subject a context thread points at (for live-strip dedup). */
function threadSubjectId(p: WallProjection): string | null {
  const t = p.contextThread;
  if (!t) return null;
  return t.action?.targetId ?? p.place?.placeId ?? null;
}

function withoutThread(p: WallProjection): WallProjection {
  if (!p.contextThread) return p;
  const clone = { ...p } as WallProjection & { contextThread?: ContextThread };
  delete clone.contextThread;
  return clone;
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

// ── Step 3: annotation caps (live-strip dedup + context-thread window cap) ───

/**
 * Strip context-thread annotations that (a) merely repeat a Live For You strip
 * subject, or (b) exceed maxContextThreadsInWindow within the sliding window.
 * The OBJECT always stays — only the annotation is removed (spec §15).
 */
function capAnnotations(
  items: WallProjection[],
  policy: FeedDiversityPolicy,
  windowSize: number,
  liveStripSubjectIds: Set<string>,
): { items: WallProjection[]; stripped: number } {
  const out: WallProjection[] = [];
  let stripped = 0;
  for (const item of items) {
    let current = item;
    if (current.contextThread) {
      // (a) live-strip dedup — a live_place thread already shown in the strip.
      if (policy.liveStripDeduplication && current.contextThread.kind === "live_place") {
        const subj = threadSubjectId(current);
        if (subj && liveStripSubjectIds.has(subj)) {
          current = withoutThread(current);
          stripped++;
        }
      }
    }
    if (current.contextThread) {
      // (b) per-window annotation cap.
      const window = out.slice(Math.max(0, out.length - (windowSize - 1)));
      const threadsInWindow = window.filter((w) => !!w.contextThread).length;
      if (threadsInWindow + 1 > policy.maxContextThreadsInWindow) {
        current = withoutThread(current);
        stripped++;
      }
    }
    out.push(current);
  }
  return { items: out, stripped };
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
    return { items: [], droppedDiscovery: 0, strippedThreads: 0 };
  }
  const windowSize = Math.max(2, opts.windowSize ?? DIVERSITY_WINDOW);
  const liveStrip = opts.liveStripSubjectIds ?? new Set<string>();
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

    // 3. Annotation caps on the FINAL positions (window is post-reorder).
    const annotated = capAnnotations(spaced, policy, windowSize, liveStrip);

    return {
      items: annotated.items,
      droppedDiscovery: pruned.dropped,
      strippedThreads: annotated.stripped,
    };
  } catch {
    return { items, droppedDiscovery: 0, strippedThreads: 0 };
  }
}

// Test seam — the pure step functions, exercised directly by the diversity tests.
export const _internal = {
  pruneDiscovery,
  spaceByActorAndType,
  capAnnotations,
  isSocialObject,
  isDiscovery,
  threadSubjectId,
};
