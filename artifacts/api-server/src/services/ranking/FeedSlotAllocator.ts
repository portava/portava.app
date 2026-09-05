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

// ─────────────────────────────────────────────────────────────────────────────
// ── Part 3: Exploration GOVERNOR (ROADMAP step 8) ────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//
// "Exploration and diversity ALLOCATOR — budget ~15-25 % with REASON CODES,
//  not fixed positions."
//
// What was here before, and why it is not enough for the discovery surface:
//
//   - Part 1 classifies every 7th slot as "exploration" AFTER the fact
//     (EXPLORATION_INTERVAL). It is an analytics label on a position; it does
//     not choose what goes there.
//   - portavaRank.injectExploration fills every Nth position from the long
//     tail. It has a fixed cadence (every 7th ⇒ ~14 %), no budget, and no
//     record of WHY a given item was surfaced — the pick is uniform over the
//     tail. A reader of rank_events cannot tell an exploration pick from a
//     ranking mistake.
//
// The governor is the step-8 shape: a BUDGET (a share of the page, clamped to
// 15-25 %), SLOTS spread across the page rather than pinned to one cadence,
// and a REASON CODE per pick stating what the system expects to learn from it.
// The reasons are drawn only from signals the discovery ranker already holds
// for a candidate — nothing is fetched — and each is a statement of absence:
//
//   unfamiliar_category   the viewer's learned category affinities carry no
//                         (or a weak, < 0.25) preference for this category —
//                         the system does not know whether they like it
//   low_social_proof      the place has no saves — nobody has told the system
//                         anything about it yet
//   rising_momentum       the place is surging locally (momentum ≥ 0.5) and
//                         the viewer's taste model has not caught up
//   long_tail             none of the above applied; the pick is there
//                         because the pool is the bottom two-thirds and the
//                         budget had a slot to spend
//
// DETERMINISM: seeded per (viewer, hour), the same seed portavaRank uses, so a
// paginating session sees a stable allocation.
//
// APPLY vs OBSERVE: `apply=false` computes everything and changes nothing —
// the returned order IS the input order. NOTE that this is not how the OFF
// state of `discovery_ranking_modifiers_enabled` is expressed: with that flag
// off lib/discoveryPde.ts does not call this function at all, because the
// allocation would otherwise be stamped into the impression feature vector and
// persisted to rank_events for a feature nobody enabled. `apply=false` is a
// mode for callers that have the feature ON and want observation only.

/** The budget bounds, as the roadmap states them. Clamped, not configurable past. */
export const GOVERNOR_BUDGET_MIN_PCT = 15;
export const GOVERNOR_BUDGET_MAX_PCT = 25;
/** Fewer candidates than this and there is nothing to govern — no slots. */
export const GOVERNOR_MIN_CANDIDATES = 5;
/** Pool = candidates ranked at or below this share of the list (the "tail"). */
export const GOVERNOR_POOL_START_SHARE = 1 / 3;
/** A category affinity below this reads as "the viewer's taste is unknown here". */
export const GOVERNOR_UNFAMILIAR_AFFINITY = 0.25;
/** Momentum at or above this is "rising". */
export const GOVERNOR_RISING_MOMENTUM = 0.5;

export const GOVERNOR_REASONS = [
  "unfamiliar_category", "low_social_proof", "rising_momentum", "long_tail",
] as const;
export type GovernorReason = (typeof GOVERNOR_REASONS)[number];

/** The structural subset of a ranked candidate the governor reads. */
export interface GovernorCandidate {
  id: string;
  category?: string | null;
  /** Saves (or the surface's social-proof proxy). null/0 ⇒ no proof. */
  socialProof?: number | null;
  /** Local momentum in [0,1], when the modifiers supplied one. */
  momentum?: number | null;
}

export interface GovernorInputs {
  userId: string;
  /** Requested budget; clamped to [GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT]. */
  budgetPct: number;
  /** Viewer's normalised category affinities (0-1), when known. */
  categoryAffinities?: Record<string, number>;
  /** Epoch ms; injectable so tests are deterministic. */
  nowMs?: number;
}

export interface GovernorAllocation {
  id: string;
  /** Position in the governed order (0-based). Reported even when not applied. */
  slotIndex: number;
  /** Position the item held in the input order. */
  fromIndex: number;
  reasons: GovernorReason[];
}

export interface GovernorOutcome {
  /** Whether `order` differs from the input because the governor reordered it. */
  applied: boolean;
  /** The clamped budget actually used. */
  budgetPct: number;
  /** Slots allocated — 0 when the list is too short to govern. */
  slotCount: number;
  /** Item ids in served order. Identical to the input when `applied` is false. */
  order: string[];
  allocations: GovernorAllocation[];
  reasonCounts: Record<GovernorReason, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Clamp a requested budget to the roadmap's band. */
export function clampGovernorBudget(pct: number): number {
  if (!Number.isFinite(pct)) return GOVERNOR_BUDGET_MIN_PCT + (GOVERNOR_BUDGET_MAX_PCT - GOVERNOR_BUDGET_MIN_PCT) / 2;
  return Math.min(GOVERNOR_BUDGET_MAX_PCT, Math.max(GOVERNOR_BUDGET_MIN_PCT, pct));
}

/** Reason codes for one pool candidate, in priority order. Pure. */
export function governorReasonsFor(
  c: GovernorCandidate,
  affinities: Record<string, number> | undefined,
): GovernorReason[] {
  const out: GovernorReason[] = [];
  const cat = (c.category ?? "").toLowerCase();
  if (cat && affinities && Object.keys(affinities).length > 0) {
    const a = affinities[cat] ?? affinities[c.category ?? ""] ?? 0;
    if (a < GOVERNOR_UNFAMILIAR_AFFINITY) out.push("unfamiliar_category");
  }
  if (!(typeof c.socialProof === "number" && c.socialProof > 0)) out.push("low_social_proof");
  if (typeof c.momentum === "number" && c.momentum >= GOVERNOR_RISING_MOMENTUM) out.push("rising_momentum");
  if (out.length === 0) out.push("long_tail");
  return out;
}

/**
 * Allocate the exploration budget over a ranked list.
 *
 * Non-mutating. With `apply=false` the returned `order` is the input order and
 * `allocations` describes the slots that WOULD have been filled. With
 * `apply=true` the picks are moved into their slots (everything else keeps its
 * relative order), and the result is still a permutation — nothing is added
 * or dropped, which is what keeps the PDE divergence comparison readable.
 */
export function allocateExplorationBudget(
  ranked: readonly GovernorCandidate[],
  inputs: GovernorInputs,
  apply: boolean,
): GovernorOutcome {
  const budgetPct = clampGovernorBudget(inputs.budgetPct);
  const n = ranked.length;
  const inputOrder = ranked.map((c) => c.id);
  const zero: Record<GovernorReason, number> = { unfamiliar_category: 0, low_social_proof: 0, rising_momentum: 0, long_tail: 0 };

  if (n < GOVERNOR_MIN_CANDIDATES) {
    return { applied: false, budgetPct, slotCount: 0, order: inputOrder, allocations: [], reasonCounts: zero };
  }

  // floor, never round: the budget is a ceiling on the share of the page.
  const slotCount = Math.max(1, Math.floor((n * budgetPct) / 100));
  const poolStart = Math.max(slotCount, Math.ceil(n * GOVERNOR_POOL_START_SHARE));
  const nowMs = inputs.nowMs ?? Date.now();
  const rand = mulberry32(fnv1a(inputs.userId) ^ Math.floor(nowMs / 3_600_000));

  // Score the pool: more reasons ⇒ more to learn. Ties broken by seeded random,
  // and a category already chosen for a slot is deferred until the others are
  // exhausted (diversity within the exploration share itself).
  const pool = ranked.slice(poolStart).map((c, i) => ({
    c, fromIndex: poolStart + i,
    reasons: governorReasonsFor(c, inputs.categoryAffinities),
    tie: rand(),
  }));
  const strength = (rs: GovernorReason[]) =>
    rs.reduce((s, r) => s + (r === "unfamiliar_category" ? 2 : r === "rising_momentum" ? 2 : r === "low_social_proof" ? 1 : 0), 0);
  pool.sort((a, b) => (strength(b.reasons) - strength(a.reasons)) || (a.tie - b.tie));

  const picks: typeof pool = [];
  const usedCats = new Set<string>();
  const deferred: typeof pool = [];
  for (const p of pool) {
    if (picks.length >= slotCount) break;
    const cat = (p.c.category ?? "").toLowerCase();
    if (cat && usedCats.has(cat)) { deferred.push(p); continue; }
    picks.push(p);
    if (cat) usedCats.add(cat);
  }
  for (const p of deferred) {
    if (picks.length >= slotCount) break;
    picks.push(p);
  }

  // Slot positions: spread evenly across the page, rotated by a seeded offset
  // so they are not the same fixed positions for every viewer and hour. Never
  // position 0 — the top slot stays the ranker's.
  const stride = n / slotCount;
  const offset = rand() * stride;
  const positions = Array.from({ length: slotCount }, (_, k) =>
    Math.min(n - 1, Math.max(1, Math.floor(k * stride + offset))),
  );
  // De-duplicate positions that collided after flooring (short lists). Walk
  // up, then down; both walks are bounded by the list, so this terminates
  // even in the degenerate case where every position is taken.
  const seen = new Set<number>();
  for (let i = 0; i < positions.length; i++) {
    let p = positions[i]!;
    while (seen.has(p) && p < n - 1) p += 1;
    while (seen.has(p) && p > 1) p -= 1;
    positions[i] = p;
    seen.add(p);
  }
  positions.sort((a, b) => a - b);

  const reasonCounts = { ...zero };
  const allocations: GovernorAllocation[] = picks.map((p, k) => {
    for (const r of p.reasons) reasonCounts[r] += 1;
    return { id: p.c.id, slotIndex: positions[k]!, fromIndex: p.fromIndex, reasons: p.reasons };
  });

  if (!apply || allocations.length === 0) {
    return { applied: false, budgetPct, slotCount: allocations.length, order: inputOrder, allocations, reasonCounts };
  }

  // Build the governed order: remove picks, then insert each at its slot,
  // ascending, so earlier insertions do not shift later targets.
  const pickIds = new Set(allocations.map((a) => a.id));
  const rest = inputOrder.filter((id) => !pickIds.has(id));
  const order = [...rest];
  for (const a of [...allocations].sort((x, y) => x.slotIndex - y.slotIndex)) {
    order.splice(Math.min(a.slotIndex, order.length), 0, a.id);
  }
  return { applied: true, budgetPct, slotCount: allocations.length, order, allocations, reasonCounts };
}
