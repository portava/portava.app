/**
 * Explicit exploration — `06` §7's reserved inventory, census-discovery §85
 * (lane W10-R3), DV-53 and DC-11's exploration stage. Behind
 * `discovery_exploration_inventory_enabled` (3481, seeded FALSE), and NOT
 * behind `discovery_ranking_modifiers_enabled`: this is the exploration stage
 * that exists outside 2289's all-or-nothing (docs/discovery/ranker-hold-designs.md
 * design 1).
 *
 * `06` §7: "Reserve controlled inventory for: new creators, low-exposure
 * content, emerging places, new Trails. Exploration should be relevant, not
 * random." Each clause, and where it is enforced:
 *
 *   reserved      a slot budget of GOVERNOR_BUDGET_MIN_PCT–MAX_PCT of the list
 *                 (the governor's ruled band, clamped by the same function),
 *                 filled ROUND-ROBIN across the four buckets so each bucket
 *                 is reserved a share and none can take the whole budget;
 *   the buckets   new_creator — the row's submitter made their FIRST active
 *                   submission within NEW_CREATOR_WINDOW_MS (the author policy
 *                   already ran: a blocked or inactive submitter's row never
 *                   reached PDE);
 *                 low_exposure — served impressions over LOW_EXPOSURE_WINDOW_MS
 *                   at or below the list's 25th percentile, and below its max
 *                   (a list where everything ties has no low-exposure item);
 *                 emerging_place — the latest place_momentum run says
 *                   `emerging` or `rediscovered` (a state that IS a claim;
 *                   `unknown` never qualifies);
 *                 new_trail — the place is a member of a non-archived Trail
 *                   created within NEW_TRAIL_WINDOW_MS;
 *   relevant      a member qualifies only if its portavaRank score is at or
 *                 above the median score of the list — the relevance floor
 *                 (D-W10-R3-6). Below the floor it is never promoted;
 *   not random    no seeded draw picks a member: within a bucket the highest
 *                 score wins, ties by id. The only seeded value is the slot
 *                 OFFSET, per (viewer, hour), so pagination is stable.
 *
 * It replaces portavaRank's random every-7th slot and the modifiers-stage
 * governor on the PDE path when it is on (one exploration pass per page).
 * It never adds or drops a row: the result is a permutation.
 */
import { clampGovernorBudget, GOVERNOR_MIN_CANDIDATES, GOVERNOR_POOL_START_SHARE } from "../../services/ranking/FeedSlotAllocator.js";
import { IN_LIST_CAP } from "./retrievals.js";

export const INVENTORY_BUCKETS = ["new_creator", "low_exposure", "emerging_place", "new_trail"] as const;
export type InventoryBucket = (typeof INVENTORY_BUCKETS)[number];

const DAY = 24 * 60 * 60 * 1_000;
export const NEW_CREATOR_WINDOW_MS  = 30 * DAY;
export const NEW_TRAIL_WINDOW_MS    = 30 * DAY;
export const LOW_EXPOSURE_WINDOW_MS = 30 * DAY;
/** The budget used when the modifiers (and so city confidence) are off: the band's midpoint. */
export const INVENTORY_DEFAULT_BUDGET_PCT = clampGovernorBudget(Number.NaN);

export interface InventoryCandidate { id: string; score: number; buckets: readonly InventoryBucket[] }

export interface InventoryAllocation { id: string; slotIndex: number; fromIndex: number; bucket: InventoryBucket }

export interface InventoryOutcome {
  applied: boolean;
  budgetPct: number;
  slotCount: number;
  /** The relevance floor: the median portavaRank score of the list. */
  floor: number | null;
  order: string[];
  allocations: InventoryAllocation[];
  /** Members of each bucket on the list, before the floor. */
  bucketMembers: Record<InventoryBucket, number>;
  /** Members of each bucket that cleared the floor and were eligible. */
  eligible: Record<InventoryBucket, number>;
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
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

const zeroCounts = (): Record<InventoryBucket, number> => ({ new_creator: 0, low_exposure: 0, emerging_place: 0, new_trail: 0 });

export function medianScore(scores: readonly number[]): number | null {
  const s = scores.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Pure. Allocate the reserved inventory over a ranked list. */
export function allocateReservedInventory(
  ranked: readonly InventoryCandidate[],
  inputs: { userId: string; budgetPct: number; nowMs: number },
): InventoryOutcome {
  const budgetPct = clampGovernorBudget(inputs.budgetPct);
  const n = ranked.length;
  const order = ranked.map((c) => c.id);
  const bucketMembers = zeroCounts();
  for (const c of ranked) for (const b of new Set(c.buckets)) bucketMembers[b]++;
  const floor = medianScore(ranked.map((c) => c.score));
  const none: InventoryOutcome = { applied: false, budgetPct, slotCount: 0, floor, order, allocations: [], bucketMembers, eligible: zeroCounts() };
  if (n < GOVERNOR_MIN_CANDIDATES || floor === null) return none;

  const slotCount = Math.max(1, Math.floor((n * budgetPct) / 100));
  const poolStart = Math.max(slotCount, Math.ceil(n * GOVERNOR_POOL_START_SHARE));
  const eligible = zeroCounts();
  const queues = new Map<InventoryBucket, Array<{ c: InventoryCandidate; fromIndex: number }>>(INVENTORY_BUCKETS.map((b) => [b, []]));
  for (let i = poolStart; i < n; i++) {
    const c = ranked[i]!;
    if (!(c.score >= floor)) continue;
    for (const b of new Set(c.buckets)) { queues.get(b)!.push({ c, fromIndex: i }); eligible[b]++; }
  }
  for (const q of queues.values()) q.sort((a, z) => (z.c.score - a.c.score) || (a.c.id < z.c.id ? -1 : a.c.id > z.c.id ? 1 : 0));

  const picks: Array<{ c: InventoryCandidate; fromIndex: number; bucket: InventoryBucket }> = [];
  const picked = new Set<string>();
  let progressed = true;
  while (picks.length < slotCount && progressed) {
    progressed = false;
    for (const b of INVENTORY_BUCKETS) {
      if (picks.length >= slotCount) break;
      const q = queues.get(b)!;
      while (q.length > 0) {
        const next = q.shift()!;
        if (picked.has(next.c.id)) continue;
        picks.push({ ...next, bucket: b }); picked.add(next.c.id); progressed = true;
        break;
      }
    }
  }
  if (picks.length === 0) return { ...none, slotCount, eligible };

  // Slot positions: evenly spread at the budget's spacing, rotated by a
  // per-(viewer, hour) offset, never position 0 (the top slot is the ranker's).
  const rand = mulberry32(fnv1a(inputs.userId) ^ Math.floor(inputs.nowMs / 3_600_000));
  const stride = n / slotCount;
  const offset = rand() * stride;
  const used = new Set<number>();
  const allocations: InventoryAllocation[] = [];
  // Highest-scoring pick takes the earliest slot.
  const byScore = [...picks].sort((a, z) => (z.c.score - a.c.score) || (a.fromIndex - z.fromIndex));
  byScore.forEach((p, k) => {
    let pos = Math.min(n - 1, Math.max(1, Math.floor(k * stride + offset)));
    while (used.has(pos) && pos < n - 1) pos += 1;
    while (used.has(pos) && pos > 1) pos -= 1;
    // A reserved slot only ever PROMOTES: a member already at or above its slot stays where it is.
    const slot = Math.min(pos, p.fromIndex);
    used.add(slot);
    allocations.push({ id: p.c.id, slotIndex: slot, fromIndex: p.fromIndex, bucket: p.bucket });
  });

  const moving = allocations.filter((a) => a.slotIndex < a.fromIndex);
  if (moving.length === 0) return { applied: false, budgetPct, slotCount, floor, order, allocations, bucketMembers, eligible };
  const moveIds = new Set(moving.map((a) => a.id));
  const governed = order.filter((id) => !moveIds.has(id));
  for (const a of [...moving].sort((x, y) => x.slotIndex - y.slotIndex)) governed.splice(Math.min(a.slotIndex, governed.length), 0, a.id);
  return { applied: true, budgetPct, slotCount, floor, order: governed, allocations, bucketMembers, eligible };
}

export interface InventoryReadResult {
  buckets: Map<string, InventoryBucket[]>;
  failedReads: string[];
}

const add = (m: Map<string, InventoryBucket[]>, id: string, b: InventoryBucket) => {
  const l = m.get(id) ?? []; if (!l.includes(b)) l.push(b); m.set(id, l);
};

/**
 * Read which bucket(s) each listed id belongs to. Each read is independent and
 * non-fatal: a failed read leaves its bucket empty and is named in `failedReads`,
 * so "no new creators" and "could not tell" stay distinguishable.
 */
export async function loadInventoryBuckets(
  sc: any, ids: readonly string[],
  opts: { nowMs: number; submitterById?: ReadonlyMap<string, string> },
): Promise<InventoryReadResult> {
  const buckets = new Map<string, InventoryBucket[]>();
  const failedReads: string[] = [];
  if (!sc || ids.length === 0) return { buckets, failedReads };
  const list = [...new Set(ids)].slice(0, IN_LIST_CAP);
  const dbUuids = list.filter((i) => i.startsWith("db/")).map((i) => i.slice(3));
  const iso = (ms: number) => new Date(ms).toISOString();

  // new_creator — who submitted each listed DB row, then each submitter's FIRST active submission.
  try {
    const submitter = new Map<string, string>(opts.submitterById ?? []);
    const unknown = dbUuids.filter((u) => !submitter.has(`db/${u}`));
    if (unknown.length > 0) {
      const { data, error } = await sc.from("discovery_places").select("id, submitted_by").in("id", unknown).order("id", { ascending: true });
      if (error) throw new Error("discovery_places.submitter");
      for (const r of (data ?? []) as any[]) if (typeof r.submitted_by === "string" && r.submitted_by) submitter.set(`db/${r.id}`, r.submitted_by);
    }
    const authors = [...new Set(submitter.values())].sort().slice(0, IN_LIST_CAP);
    if (authors.length > 0) {
      const { data, error } = await sc.from("discovery_places")
        .select("submitted_by, created_at")
        .in("submitted_by", authors)
        .eq("status", "active")
        .lt("created_at", iso(opts.nowMs - NEW_CREATOR_WINDOW_MS))
        .order("submitted_by", { ascending: true })
        .limit(IN_LIST_CAP * 5);
      if (error) throw new Error("discovery_places.first_submission");
      // An author with ANY active submission older than the window is not new.
      const established = new Set(((data ?? []) as any[]).map((r) => r.submitted_by as string));
      for (const [id, a] of submitter) if (list.includes(id) && !established.has(a)) add(buckets, id, "new_creator");
    }
  } catch (e) { failedReads.push(e instanceof Error && e.message ? e.message : "new_creator"); }

  // low_exposure — served impressions per listed id over the window.
  try {
    const { data, error } = await sc.from("rank_events")
      .select("item_id, served_at")
      .eq("surface", "discovery")
      .neq("outcome", "analytics")
      .in("item_id", list)
      .gte("served_at", iso(opts.nowMs - LOW_EXPOSURE_WINDOW_MS))
      .order("served_at", { ascending: false })
      .limit(5_000);
    if (error) throw new Error("rank_events.exposure");
    const count = new Map<string, number>(list.map((id) => [id, 0]));
    for (const r of (data ?? []) as any[]) if (count.has(r.item_id)) count.set(r.item_id, count.get(r.item_id)! + 1);
    const sorted = [...count.values()].sort((a, b) => a - b);
    const p25 = sorted[Math.floor((sorted.length - 1) * 0.25)] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    for (const [id, c] of count) if (c <= p25 && c < max) add(buckets, id, "low_exposure");
  } catch (e) { failedReads.push(e instanceof Error && e.message ? e.message : "low_exposure"); }

  // emerging_place — the latest place_momentum run's claim.
  try {
    const head = await sc.from("place_momentum").select("computed_at").order("computed_at", { ascending: false }).limit(1);
    if (head.error) throw new Error("place_momentum.head");
    const run = ((head.data ?? []) as any[])[0]?.computed_at;
    if (typeof run === "string" && run) {
      const ids = [...new Set([...list, ...dbUuids])];
      const { data, error } = await sc.from("place_momentum")
        .select("place_id, trend_state")
        .eq("computed_at", run)
        .in("place_id", ids)
        .in("trend_state", ["emerging", "rediscovered"])
        .order("place_id", { ascending: true });
      if (error) throw new Error("place_momentum.emerging");
      for (const r of (data ?? []) as any[]) {
        const id = String(r.place_id);
        add(buckets, list.includes(id) ? id : `db/${id}`, "emerging_place");
      }
    }
  } catch (e) { failedReads.push(e instanceof Error && e.message ? e.message : "emerging_place"); }

  // new_trail — a member of a non-archived Trail created within the window.
  try {
    if (dbUuids.length > 0) {
      const m = await sc.from("content_trails").select("trail_id, source_id")
        .eq("source_type", "place").in("source_id", dbUuids).order("trail_id", { ascending: true }).limit(IN_LIST_CAP * 5);
      if (m.error) throw new Error("content_trails.new_trail");
      const members = (m.data ?? []) as any[];
      const trailIds = [...new Set(members.map((r) => r.trail_id as string))].slice(0, IN_LIST_CAP);
      if (trailIds.length > 0) {
        const t = await sc.from("trails").select("id, created_at, lifecycle_status")
          .in("id", trailIds).neq("lifecycle_status", "archived").eq("review_state", "approved").gte("created_at", iso(opts.nowMs - NEW_TRAIL_WINDOW_MS)).order("id", { ascending: true });
        if (t.error) throw new Error("trails.new_trail");
        const fresh = new Set(((t.data ?? []) as any[]).map((r) => r.id as string));
        for (const r of members) if (fresh.has(r.trail_id)) add(buckets, `db/${r.source_id}`, "new_trail");
      }
    }
  } catch (e) { failedReads.push(e instanceof Error && e.message ? e.message : "new_trail"); }

  return { buckets, failedReads };
}
