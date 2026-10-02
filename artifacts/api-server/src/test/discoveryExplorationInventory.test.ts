/**
 * discoveryExplorationInventory — census-discovery §85 (lane W10-R3), DV-53
 * and DC-11's exploration stage: `06` §7's reserved inventory, behind
 * `discovery_exploration_inventory_enabled` (3481, seeded FALSE) and OUTSIDE
 * `discovery_ranking_modifiers_enabled` (2289).
 *
 * CONTROLLED DATA. The tests are ranker-hold-designs.md design 1's (a)–(f),
 * plus the two this build adds:
 *
 *   E1  (a) flag off: the order is exactly today's (the golden holds the rest)
 *   E2  (b) no reserved slot is filled below the relevance floor
 *   E3  (c) the budget never exceeds 25 % of the list
 *   E4  (d) a blocked, inactive or established author is never a new-creator pick
 *   E5  (e) the allocation is deterministic per (viewer, hour)
 *   E6  (f) with every bucket empty nothing is invented and nothing moves
 *   E7  each of the four buckets is reserved a share (round robin)
 *   E8  it runs with the MODIFIERS OFF — outside 2289's all-or-nothing — and
 *       with them on it owns exploration: the governor and portavaRank's
 *       random slot stand down
 *   E9  the four bucket reads, over the controlled corpus
 *
 * Runtime: node:test + node:assert/strict.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rankForViewer } from "../lib/discoveryPde.js";
import { inertModifiers, invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { PIPELINE_FLAGS_OFF, type PipelineFlags } from "../lib/discoveryCandidates/pipelineFlags.js";
import {
  allocateReservedInventory, loadInventoryBuckets, medianScore, INVENTORY_BUCKETS,
  type InventoryCandidate, type InventoryBucket,
} from "../lib/discoveryCandidates/explorationInventory.js";
import { GOVERNOR_BUDGET_MAX_PCT } from "../services/ranking/FeedSlotAllocator.js";
import { pdeFeatureProvenanceFeatures } from "../lib/discoveryRankProvenance.js";
import { makeFakeCandidateDb } from "./helpers/fakeCandidateDb.js";
import { NOW, P, u, VIEWER, AUTHOR_FOLLOWED, AUTHOR_NEW, pool, viewer, world, iso } from "./helpers/candidateWorld.js";

const INV: PipelineFlags = { ...PIPELINE_FLAGS_OFF, explorationInventory: true };

/** 30 candidates, scores descending, with buckets on chosen positions. */
function list(buckets: Record<number, InventoryBucket[]> = {}): InventoryCandidate[] {
  return Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, score: 3 - i * 0.1, buckets: buckets[i] ?? [] }));
}

beforeEach(() => invalidateDiscoveryModifiersFlagCache());

describe("DV-53 — the reserved inventory (pure allocation)", () => {
  it("E2. no pick below the relevance floor (the list's median score)", () => {
    const l = list({ 12: ["new_creator"], 20: ["low_exposure"], 25: ["emerging_place"], 29: ["new_trail"] });
    const o = allocateReservedInventory(l, { userId: VIEWER, budgetPct: 25, nowMs: NOW });
    const floor = medianScore(l.map((c) => c.score))!;
    assert.equal(o.floor, floor);
    for (const a of o.allocations) assert.ok(l.find((c) => c.id === a.id)!.score >= floor, `${a.id} clears the floor`);
    assert.deepEqual(o.allocations.map((a) => a.id), ["c12"], "only the member above the median is reserved");
    assert.equal(o.eligible.low_exposure, 0);
  });

  it("E3. the budget never exceeds 25 % of the list, whatever is asked", () => {
    const all: Record<number, InventoryBucket[]> = {};
    for (let i = 10; i < 16; i++) all[i] = [INVENTORY_BUCKETS[i % 4]!];
    const o = allocateReservedInventory(list(all), { userId: VIEWER, budgetPct: 90, nowMs: NOW });
    assert.equal(o.budgetPct, GOVERNOR_BUDGET_MAX_PCT);
    assert.ok(o.allocations.length <= Math.floor(30 * 0.25));
  });

  it("E5. deterministic per (viewer, hour); the order is a permutation", () => {
    const l = list({ 10: ["new_creator"], 11: ["low_exposure"], 12: ["emerging_place"], 13: ["new_trail"] });
    const a = allocateReservedInventory(l, { userId: VIEWER, budgetPct: 20, nowMs: NOW });
    const b = allocateReservedInventory(l, { userId: VIEWER, budgetPct: 20, nowMs: NOW + 60_000 });
    assert.deepEqual(a, b);
    assert.deepEqual([...a.order].sort(), l.map((c) => c.id).sort());
  });

  it("E6. with every bucket empty nothing is invented and nothing moves", () => {
    const o = allocateReservedInventory(list(), { userId: VIEWER, budgetPct: 20, nowMs: NOW });
    assert.equal(o.applied, false);
    assert.equal(o.allocations.length, 0);
    assert.deepEqual(o.order, list().map((c) => c.id));
  });

  it("E7. each bucket is reserved a share: round robin, not the biggest bucket first", () => {
    // Three new-creator members ranked highest; one member each of the others.
    const b: Record<number, InventoryBucket[]> = { 10: ["new_creator"], 11: ["new_creator", "new_trail"], 12: ["new_creator"], 13: ["low_exposure"], 14: ["emerging_place"] };
    const o = allocateReservedInventory(list(b), { userId: VIEWER, budgetPct: 15, nowMs: NOW });   // 4 slots
    const buckets = new Set(o.allocations.map((a) => a.bucket));
    assert.equal(o.allocations.length, 4);
    for (const k of ["new_creator", "low_exposure", "emerging_place", "new_trail"] as const) assert.ok(buckets.has(k), `${k} reserved`);
    for (const a of o.allocations) assert.ok(a.slotIndex >= 1 && a.slotIndex <= a.fromIndex, "a reserved slot only promotes, never to position 0");
  });
});

describe("DV-53 — on the PDE path", () => {
  const placesWithBuckets = () => {
    const w = world();
    // Make the list long enough to govern and give each bucket a member.
    return { w, places: pool() };
  };

  it("E1. flag OFF: the order is today's (portavaRank's epsilon slot included)", async () => {
    const { w, places } = placesWithBuckets();
    const a = await rankForViewer(places, viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: { ...PIPELINE_FLAGS_OFF } });
    const b = await rankForViewer(places, viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW });
    assert.deepEqual(a.ranked.map((p) => p.id), b.ranked.map((p) => p.id));
    assert.equal(a.stages.explorationInventory, undefined);
  });

  it("E8. it runs with the modifiers OFF, and with them ON the governor stands down", async () => {
    const { w, places } = placesWithBuckets();
    const off = await rankForViewer(places, viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: INV });
    assert.equal(off.stages.modifiers, "flag_off");
    assert.ok(off.stages.explorationInventory, "the inventory stage ran with 2289 off");
    assert.equal(off.stages.explorationInventory!.budgetPct, 20, "the band's midpoint when city confidence is off");
    const mods = { ...inertModifiers("flag_off"), enabled: true, reason: "flag_on" as const, explorationBudgetPct: 15 };
    const on = await rankForViewer(places, viewer(), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: INV, modifiers: mods });
    assert.equal(on.stages.governor, "skipped", "one exploration pass per page");
    assert.equal(on.governor, null);
    assert.equal(on.stages.explorationInventory!.budgetPct, 15, "the city-confidence budget, when the modifiers supply one");
  });

  it("E8b. a reserved row carries its bucket to rank_events", async () => {
    const w = world();
    // Three impressions on every pool row except db/POOL (ranked first) and
    // node/102 (ranked fifth, just above the median score): both are low
    // exposure, and only node/102 sits in the governable tail above the floor.
    for (const id of ["node/5", "node/100", "node/101", "node/103", "node/104", "node/105", "node/106", "node/107"]) {
      for (let k = 0; k < 3; k++) w["rank_events"]!.push({ item_id: id, surface: "discovery", outcome: "impression", served_at: iso(1000 * (k + 1)) });
    }
    const o = await rankForViewer(pool(), viewer({ categoryAffinities: undefined }), { sc: makeFakeCandidateDb(w), served: true, nowMs: NOW, pipelineFlags: INV });
    const inv = o.stages.explorationInventory!;
    assert.equal(inv.bucketMembers.low_exposure, 2, "the low-exposure bucket was read");
    assert.equal(inv.eligible.low_exposure, 1, "only the tail member above the floor is eligible");
    assert.equal(inv.placed, 1);
    assert.equal(pdeFeatureProvenanceFeatures(o.scoredById.get("node/102")!)["explorationReserve"], "low_exposure");
    assert.equal(pdeFeatureProvenanceFeatures(o.scoredById.get(o.ranked[0]!.id)!)["explorationReserve"], undefined, "the head row is not a reserve pick");
  });
});

describe("DV-53 — the four bucket reads", () => {
  it("E4/E9. new creator: a first submission inside the window; an established author is not new; low exposure; emerging; new Trail", async () => {
    const w = world();
    w["rank_events"] = [
      ...Array.from({ length: 5 }, (_, k) => ({ item_id: `db/${P.SIMILAR}`, surface: "discovery", outcome: "impression", served_at: iso(1000 * (k + 1)) })),
      { item_id: `db/${P.TRENDING}`, surface: "discovery", outcome: "impression", served_at: iso(1000) },
    ];
    const ids = [`db/${P.NEW_CREATOR_ROW}`, `db/${P.FOLLOWED}`, `db/${P.SIMILAR}`, `db/${P.EMERGING}`, `db/${P.TRAIL_MEMBER}`, `db/${P.TRENDING}`];
    const r = await loadInventoryBuckets(makeFakeCandidateDb(w), ids, { nowMs: NOW });
    assert.deepEqual(r.failedReads, []);
    assert.ok(r.buckets.get(`db/${P.NEW_CREATOR_ROW}`)?.includes("new_creator"), `${AUTHOR_NEW}'s first submission is new`);
    assert.ok(!r.buckets.get(`db/${P.FOLLOWED}`)?.includes("new_creator"), `${AUTHOR_FOLLOWED} has a 400-day-old submission: established`);
    assert.ok(!r.buckets.get(`db/${P.SIMILAR}`)?.includes("low_exposure"), "the most-served row is not low exposure");
    assert.ok(r.buckets.get(`db/${P.EMERGING}`)?.includes("low_exposure"));
    assert.ok(r.buckets.get(`db/${P.EMERGING}`)?.includes("emerging_place"));
    assert.ok(!r.buckets.get(`db/${P.TRENDING}`)?.includes("emerging_place"), "trending is not emerging");
    assert.ok(r.buckets.get(`db/${P.TRAIL_MEMBER}`)?.includes("new_trail"), "a member of a 5-day-old active Trail");
  });

  it("E4. a blocked or inactive submitter never reaches the inventory: its row is never a candidate", async () => {
    const o = await rankForViewer(pool(), viewer(), {
      sc: makeFakeCandidateDb(world()), served: true, nowMs: NOW, category: "food",
      pipelineFlags: { ...PIPELINE_FLAGS_OFF, candidateSources: true, explorationInventory: true },
    });
    const ids = new Set(o.ranked.map((p) => p.id));
    assert.ok(!ids.has(`db/${P.BLOCKED}`) && !ids.has(`db/${P.INACTIVE}`));
  });

  it("a failed bucket read is named and leaves only its bucket empty", async () => {
    const r = await loadInventoryBuckets(makeFakeCandidateDb(world(), { erroring: ["place_momentum"] }), [`db/${P.EMERGING}`, `db/${u(99)}`], { nowMs: NOW });
    assert.deepEqual(r.failedReads, ["place_momentum.head"]);
    assert.ok(!r.buckets.get(`db/${P.EMERGING}`)?.includes("emerging_place"));
  });
});
