/**
 * CompassDiversityEngine — Phase 3 diversity reordering.
 *
 * Takes a list of scored, sanitized PipelineResults and reorders them so the
 * feed feels varied. Rules:
 *
 *   1. No content category (item.type) appears more than twice consecutively.
 *   2. Nightlife and featured/paid items are capped at 25% of the output list.
 *   3. At least one "exploration card" (a type the viewer has rarely seen) is
 *      inserted per every 10 items in the result — capped at MAX_EXPLORATION_INSERTS.
 *
 * The engine is PURE — no DB calls, no side effects.
 * Input items are NOT mutated; the returned array is a new array.
 *
 * "Nightlife" items: type === "event" and interestTags includes a nightlife tag.
 * "Featured/paid" items: item.isFeatured or item.isPaid flags.
 */

import type { PipelineResult } from "./CompassPipeline.js";
import type { CompassProfile } from "./types.js";

const NIGHTLIFE_TAGS = new Set([
  "nightlife", "bar", "pub", "club", "nightclub", "casino", "lounge",
  "cocktails", "drinks", "party", "rave",
]);

const MAX_CONSECUTIVE     = 2;
const MAX_SAME_AUTHOR_RUN = 3;  // max consecutive items from the same author
const PAID_NIGHTLIFE_CAP_RATIO = 0.25;
const EXPLORATION_WINDOW = 10;
const MAX_EXPLORATION_INSERTS = 3;

export interface DiversityResult {
  items:            PipelineResult[];
  explorationCount: number;
  reorderedCount:   number;
}

function isNightlifeOrPaid(r: PipelineResult): boolean {
  const tags = r.item.interestTags ?? [];
  if (tags.some((t) => NIGHTLIFE_TAGS.has(t.toLowerCase()))) return true;
  if (r.item.isFeatured) return true;
  if (r.item.isPaid)     return true;
  return false;
}

/**
 * Reorder items so no category repeats more than MAX_CONSECUTIVE times in a row.
 *
 * Uses a "highest remaining count wins" scheduler (similar to the classic
 * Task Scheduler algorithm). Items are grouped by type; at each step we pick
 * the type with the most remaining items that is not currently blocked by the
 * consecutive-cap. When all types are blocked (only one type left), we accept
 * the violation rather than dropping items.
 */
function breakConsecutiveRuns(items: PipelineResult[]): { out: PipelineResult[]; reorderedCount: number } {
  if (items.length === 0) return { out: [], reorderedCount: 0 };

  // Group items by type, preserving their relative order within each type
  const byType = new Map<string, PipelineResult[]>();
  for (const r of items) {
    const bucket = byType.get(r.item.type) ?? [];
    bucket.push(r);
    byType.set(r.item.type, bucket);
  }

  // Record original positions to count reorderings
  const originalPos = new Map(items.map((r, i) => [r.item.id, i]));

  const out:         PipelineResult[] = [];
  let reorderedCount = 0;

  while (byType.size > 0) {
    // Determine blocked type: if the last MAX_CONSECUTIVE items are all the same type,
    // that type is blocked for this slot.
    let blockedType: string | null = null;
    if (out.length >= MAX_CONSECUTIVE) {
      const tailType = out[out.length - 1]!.item.type;
      let allSame    = true;
      for (let i = out.length - 2; i >= out.length - MAX_CONSECUTIVE; i--) {
        if (out[i]!.item.type !== tailType) { allSame = false; break; }
      }
      if (allSame) blockedType = tailType;
    }

    // Pick type with the most remaining items that is not blocked
    let bestType:  string | null = null;
    let bestCount  = -1;
    for (const [type, bucket] of byType) {
      if (type === blockedType) continue;
      if (bucket.length > bestCount) {
        bestCount = bucket.length;
        bestType  = type;
      }
    }

    // Fallback: all remaining items are the blocked type — accept violation
    if (bestType === null) {
      bestType = blockedType!;
    }

    const bucket  = byType.get(bestType)!;
    const picked  = bucket.shift()!;
    if (bucket.length === 0) byType.delete(bestType);

    // Count reorderings by checking whether we skipped any item with a lower original index
    if (out.length > 0) {
      const pickedOrigIdx = originalPos.get(picked.item.id) ?? 0;
      // Check if any item still in buckets has a smaller original index than picked
      // (approximate: just count non-first-positions)
      for (const [, bkt] of byType) {
        if (bkt[0] && (originalPos.get(bkt[0].item.id) ?? 0) < pickedOrigIdx) {
          reorderedCount++;
          break;
        }
      }
    }

    out.push(picked);
  }

  return { out, reorderedCount };
}

/**
 * Reorder items so no single author appears more than MAX_SAME_AUTHOR_RUN
 * times consecutively.  Items with no authorId are treated as individually
 * distinct so they never block each other.
 *
 * Uses the same "highest remaining count wins" scheduler as breakConsecutiveRuns.
 */
function breakAuthorRuns(items: PipelineResult[]): { out: PipelineResult[]; reorderedCount: number } {
  if (items.length === 0) return { out: [], reorderedCount: 0 };

  // Group by authorId; items without one get a unique synthetic key
  const byAuthor = new Map<string, PipelineResult[]>();
  for (const r of items) {
    const key = r.item.authorId ?? `__anon_${r.item.id}`;
    const bucket = byAuthor.get(key) ?? [];
    bucket.push(r);
    byAuthor.set(key, bucket);
  }

  const originalPos = new Map(items.map((r, i) => [r.item.id, i]));
  const out: PipelineResult[] = [];
  let reorderedCount = 0;

  while (byAuthor.size > 0) {
    // Determine blocked author: last MAX_SAME_AUTHOR_RUN items all from same author
    let blockedAuthor: string | null = null;
    if (out.length >= MAX_SAME_AUTHOR_RUN) {
      const tailKey = out[out.length - 1]!.item.authorId ?? `__anon_${out[out.length - 1]!.item.id}`;
      let allSame = true;
      for (let i = out.length - 2; i >= out.length - MAX_SAME_AUTHOR_RUN; i--) {
        const k = out[i]!.item.authorId ?? `__anon_${out[i]!.item.id}`;
        if (k !== tailKey) { allSame = false; break; }
      }
      if (allSame) blockedAuthor = tailKey;
    }

    // Pick author-bucket with the most remaining items that is not blocked
    let bestKey: string | null = null;
    let bestCount = -1;
    for (const [key, bucket] of byAuthor) {
      if (key === blockedAuthor) continue;
      if (bucket.length > bestCount) {
        bestCount = bucket.length;
        bestKey   = key;
      }
    }
    // Forced accept: only blocked author left
    if (bestKey === null) bestKey = blockedAuthor!;

    const bucket = byAuthor.get(bestKey)!;
    const picked = bucket.shift()!;
    if (bucket.length === 0) byAuthor.delete(bestKey);

    if (out.length > 0) {
      const pickedOrigIdx = originalPos.get(picked.item.id) ?? 0;
      for (const [, bkt] of byAuthor) {
        if (bkt[0] && (originalPos.get(bkt[0]!.item.id) ?? 0) < pickedOrigIdx) {
          reorderedCount++;
          break;
        }
      }
    }

    out.push(picked);
  }

  return { out, reorderedCount };
}

/**
 * Cap nightlife + paid items so they represent at most 25% of the OUTPUT list.
 * Items beyond the cap are dropped from this section — they may still appear
 * in section-specific lists (e.g. `tonight`, `rent_a_buddy`).
 *
 * The cap is derived from the number of non-nightlife/paid items (which are
 * never dropped) so the OUTPUT ratio is guaranteed to be ≤ PAID_NIGHTLIFE_CAP_RATIO:
 *
 *   k / (others + k) ≤ R  →  k ≤ others * R / (1 - R)
 *
 * e.g. R=0.25, others=8: maxCap = floor(8 * 0.25 / 0.75) = 2 → ratio 2/10 = 20%
 */
function applyNightlifePaidCap(items: PipelineResult[]): PipelineResult[] {
  const otherCount = items.filter((i) => !isNightlifeOrPaid(i)).length;
  const R = PAID_NIGHTLIFE_CAP_RATIO;
  const maxCap = Math.floor(otherCount * R / (1 - R));
  let capCount = 0;
  return items.filter((item) => {
    if (!isNightlifeOrPaid(item)) return true;
    if (capCount >= maxCap) return false; // true drop — output ratio stays ≤ 25%
    capCount++;
    return true;
  });
}

/**
 * Build a set of types the viewer has "seen a lot" based on items already placed.
 * "A lot" = appears in the top 50% of placed items.
 */
function familiarTypes(placed: PipelineResult[]): Set<string> {
  const counts: Record<string, number> = {};
  for (const r of placed) {
    counts[r.item.type] = (counts[r.item.type] ?? 0) + 1;
  }
  const total  = placed.length;
  const result = new Set<string>();
  for (const [type, count] of Object.entries(counts)) {
    if (count / total >= 0.4) result.add(type);
  }
  return result;
}

/**
 * Insert up to MAX_EXPLORATION_INSERTS "exploration" items — items of a type
 * not heavily represented — once per EXPLORATION_WINDOW.
 *
 * Exploration items are pulled from the existing pool (not invented); they are
 * moved up to the insertion position from their natural score-sorted position.
 *
 * Guarantee: at least one exploration card per 10 items when the feed contains
 * two or more distinct content types.
 *
 * First-window handling:
 *   When no items have been placed yet (first window), "familiar" types are
 *   computed from the items within the window itself (dominant types). A
 *   candidate is first sought beyond the window; if none exists, one is sought
 *   within the window (after position 0) of a non-dominant type.
 */
function insertExplorationCards(
  items:   PipelineResult[],
  profile: CompassProfile,
): { out: PipelineResult[]; explorationCount: number } {
  if (items.length < EXPLORATION_WINDOW) {
    return { out: items, explorationCount: 0 };
  }

  const out: PipelineResult[] = [...items];
  let explorationCount = 0;
  let insertions       = 0;

  for (
    let windowStart = 0;
    windowStart < out.length && insertions < MAX_EXPLORATION_INSERTS;
    windowStart += EXPLORATION_WINDOW
  ) {
    const windowEnd = Math.min(windowStart + EXPLORATION_WINDOW, out.length);
    const placed    = out.slice(0, windowStart);

    // For the first window, determine "familiar" from items WITHIN the window;
    // for subsequent windows, use all already-placed items.
    const familiar =
      placed.length > 0
        ? familiarTypes(placed)
        : familiarTypes(out.slice(windowStart, windowEnd));

    // Primary: find a candidate beyond the current window
    let candidateIdx = out.findIndex(
      (r, i) => i >= windowEnd && !familiar.has(r.item.type),
    );

    // First-window fallback: look inside the window (after position 0)
    if (candidateIdx === -1 && placed.length === 0) {
      candidateIdx = out.findIndex(
        (r, i) => i > windowStart && i < windowEnd && !familiar.has(r.item.type),
      );
    }

    if (candidateIdx === -1) continue;

    const insertAt = Math.min(windowStart + 1, windowEnd - 1);
    const [candidate] = out.splice(candidateIdx, 1);
    out.splice(insertAt, 0, candidate!);

    explorationCount++;
    insertions++;
  }

  return { out, explorationCount };
}

/**
 * Run the full diversity pass on a sorted PipelineResult array.
 *
 * @param items    Sorted PipelineResults (scored, sanitized)
 * @param profile  The viewer's Compass profile (for future personalised exploration)
 * @returns        DiversityResult — reordered items + metadata
 */
export function applyDiversity(
  items: PipelineResult[],
  profile: CompassProfile,
): DiversityResult {
  if (items.length === 0) {
    return { items: [], explorationCount: 0, reorderedCount: 0 };
  }

  // Step 1: Cap nightlife/paid at 25%
  const capped = applyNightlifePaidCap(items);

  // Step 2: Break consecutive same-type runs
  const { out: broken, reorderedCount: typeReorder } = breakConsecutiveRuns(capped);

  // Step 3: Break consecutive same-author runs (≤ MAX_SAME_AUTHOR_RUN in a row)
  const { out: authorBroken, reorderedCount: authorReorder } = breakAuthorRuns(broken);

  // Step 4: Insert exploration cards
  const { out: diversified, explorationCount } = insertExplorationCards(authorBroken, profile);

  return { items: diversified, explorationCount, reorderedCount: typeReorder + authorReorder };
}

/**
 * Apply diversity within a named section. This is the primary call site from
 * the FeedBuilder — each section is diversified independently.
 */
export function diversifySection(
  sectionItems: PipelineResult[],
  profile: CompassProfile,
): PipelineResult[] {
  return applyDiversity(sectionItems, profile).items;
}
