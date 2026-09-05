/**
 * feedSlotAllocator.test.ts
 *
 * Unit tests for FeedSlotAllocator.
 *
 * Covers:
 *   A. Standard slot — emits ranking_item_selected.
 *   B. Exploration slot (position % 7 === 6) — emits ranking_item_exploration_selected.
 *   C. Underexposed slot — emits ranking_item_underexposed_selected.
 *   D. New-creator slot — emits ranking_new_creator_selected.
 *   E. Returning-creator slot — emits ranking_returning_creator_selected.
 *   F. Exploration takes priority over score-component labels.
 *   G. Ineligible items are excluded from the allocated feed.
 *   H. No analytics write when db is null.
 *   I. slotIndex is 0-based and contiguous across the assembled feed.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emitFeedSlotAnalytics as allocateFeedSlots,
  EXPLORATION_INTERVAL,
  type AllocatedFeedItem,
} from "../services/ranking/FeedSlotAllocator.js";
import {
  allocateExplorationBudget, clampGovernorBudget, governorReasonsFor,
  GOVERNOR_BUDGET_MIN_PCT, GOVERNOR_BUDGET_MAX_PCT, GOVERNOR_MIN_CANDIDATES, GOVERNOR_REASONS,
  GOVERNOR_POOL_START_SHARE, GOVERNOR_RISING_MOMENTUM,
  type GovernorCandidate, type GovernorInputs,
} from "../services/ranking/FeedSlotAllocator.js";
import { RankingEvent } from "../services/ranking/rankingAnalytics.js";
import type { RankingInput, RankingOutput } from "../services/ranking/DiscoveryRankingService.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VIEWER_ID  = "viewer-001";
const SESSION_ID = "session-abc";
const SURFACE    = "compass" as const;

const ZERO_COMPONENTS = {
  viewerRelevance: 0, contentRelevance: 0, geographicRelevance: 0,
  freshness: 0, contentQuality: 0, qualityEngagementScore: 0,
  relationshipRelevance: 0, explorationBoost: 0,
  activityBoost: 0, newContributorBoost: 0, returningUserBoost: 0,
  underexposureBoost: 0, repetitionPenalty: 0, fatiguePenalty: 0,
  negativeFeedbackPenalty: 0, spamPenalty: 0,
};

function makeOutput(
  itemId: string,
  overrides: Partial<RankingOutput["components"]> = {},
  eligible = true,
): RankingOutput {
  return {
    itemId,
    finalScore:        50,
    components:        { ...ZERO_COMPONENTS, ...overrides },
    eligibilityPassed: eligible,
    eligibilityReason: eligible ? null : "test_ineligible",
    explanationKey:    "compass:post",
  };
}

function makeInput(itemId: string): RankingInput {
  return {
    itemId,
    itemType:    "post",
    creatorId:   `creator-${itemId}`,
    createdAt:   new Date().toISOString(),
    city:        null, country: null,
    tags:        [], category: null, languageCode: null,
    hasMedia:    false, completeness: 0.8,
    positiveReviewRate: null, flagCount: 0,
    saveCount: 0, shareCount: 0, commentCount: 0,
    impressionCount: 0, uniqueViewerCount: 0,
    lat: null, lng: null, distanceKm: null,
    isDeleted: false, isExpired: false, isSuspended: false,
    isModerated: false, isPrivate: false, isAgeRestricted: false,
    minAgeRequired: null, isGeoRestricted: false,
    geoRestrictionCountries: null,
    authorIsBlockedByViewer: false, authorBlocksViewer: false,
    authorIsMutedByViewer: false,
    viewerHasReportedItem: false, viewerHasHiddenItem: false,
    viewerHasHiddenCreator: false,
    repeatCount: null, expiresAt: null,
    accountAgeDays: null, isUnfamiliarCategory: false, isFirstImpression: true,
  };
}

/** Fake Supabase client that records all inserts. */
function makeFakeDb() {
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        return { then: (ok: () => void) => { ok(); } };
      },
    }),
    _inserts: inserts,
  };
  return db as unknown as import("@supabase/supabase-js").SupabaseClient & {
    _inserts: Record<string, unknown>[];
  };
}

// ── A. Standard slot ──────────────────────────────────────────────────────────

describe("A. Standard slot emits ranking_item_selected", () => {
  it("slot 0 is standard and emits ITEM_SELECTED", () => {
    const db = makeFakeDb();
    const output = makeOutput("item-1");
    const input  = makeInput("item-1");

    const feed = allocateFeedSlots([output], [input], SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed.length, 1);
    assert.equal(feed[0].slotKind, "standard");
    assert.equal(feed[0].slotIndex, 0);
    assert.equal(db._inserts.length, 1);
    assert.equal(db._inserts[0].event_type, RankingEvent.ITEM_SELECTED);
    assert.equal(db._inserts[0].item_id, "item-1");
  });
});

// ── B. Exploration slot ───────────────────────────────────────────────────────

describe("B. Exploration slot at position % EXPLORATION_INTERVAL === INTERVAL-1", () => {
  it(`slot ${EXPLORATION_INTERVAL - 1} is exploration`, () => {
    const db = makeFakeDb();
    // Build EXPLORATION_INTERVAL items
    const outputs = Array.from({ length: EXPLORATION_INTERVAL }, (_, i) =>
      makeOutput(`item-${i}`),
    );
    const inputs = outputs.map((o) => makeInput(o.itemId));

    const feed = allocateFeedSlots(outputs, inputs, SURFACE, VIEWER_ID, SESSION_ID, db);

    const explorationSlot = feed.find((f) => f.slotIndex === EXPLORATION_INTERVAL - 1);
    assert.ok(explorationSlot, "exploration slot must exist");
    assert.equal(explorationSlot!.slotKind, "exploration");

    const explorationWrite = db._inserts.find(
      (r) => r.event_type === RankingEvent.ITEM_EXPLORATION_SELECTED,
    );
    assert.ok(explorationWrite, "must emit ITEM_EXPLORATION_SELECTED");
    assert.equal(explorationWrite!.item_id, `item-${EXPLORATION_INTERVAL - 1}`);
  });

  it("slots before the interval are standard", () => {
    const db = makeFakeDb();
    const outputs = Array.from({ length: EXPLORATION_INTERVAL - 1 }, (_, i) =>
      makeOutput(`item-${i}`),
    );
    const inputs = outputs.map((o) => makeInput(o.itemId));

    const feed = allocateFeedSlots(outputs, inputs, SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.ok(feed.every((f) => f.slotKind === "standard"));
  });
});

// ── C. Underexposed slot ──────────────────────────────────────────────────────

describe("C. Underexposed slot emits ranking_item_underexposed_selected", () => {
  it("item with underexposureBoost > 0 at a non-exploration position gets underexposed kind", () => {
    const db = makeFakeDb();
    const output = makeOutput("item-u", { underexposureBoost: 5 });
    const input  = makeInput("item-u");

    const feed = allocateFeedSlots([output], [input], SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed[0].slotKind, "underexposed");
    assert.equal(db._inserts[0].event_type, RankingEvent.ITEM_UNDEREXPOSED_SELECTED);
  });
});

// ── D. New-creator slot ───────────────────────────────────────────────────────

describe("D. New-creator slot emits ranking_new_creator_selected", () => {
  it("item with newContributorBoost > 0 gets new_creator kind", () => {
    const db = makeFakeDb();
    const output = makeOutput("item-nc", { newContributorBoost: 3 });
    const input  = makeInput("item-nc");

    const feed = allocateFeedSlots([output], [input], SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed[0].slotKind, "new_creator");
    assert.equal(db._inserts[0].event_type, RankingEvent.NEW_CREATOR_SELECTED);
  });
});

// ── E. Returning-creator slot ─────────────────────────────────────────────────

describe("E. Returning-creator slot emits ranking_returning_creator_selected", () => {
  it("item with returningUserBoost > 0 gets returning_creator kind", () => {
    const db = makeFakeDb();
    const output = makeOutput("item-rc", { returningUserBoost: 2 });
    const input  = makeInput("item-rc");

    const feed = allocateFeedSlots([output], [input], SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed[0].slotKind, "returning_creator");
    assert.equal(db._inserts[0].event_type, RankingEvent.RETURNING_CREATOR_SELECTED);
  });
});

// ── F. Exploration takes priority ─────────────────────────────────────────────

describe("F. Exploration slot takes priority over score-component labels", () => {
  it("an underexposed item in position INTERVAL-1 is labelled exploration, not underexposed", () => {
    const db = makeFakeDb();
    // 7 items; last one has underexposureBoost but falls on the exploration slot
    const outputs = Array.from({ length: EXPLORATION_INTERVAL }, (_, i) =>
      makeOutput(`item-${i}`, i === EXPLORATION_INTERVAL - 1 ? { underexposureBoost: 5 } : {}),
    );
    const inputs = outputs.map((o) => makeInput(o.itemId));

    const feed = allocateFeedSlots(outputs, inputs, SURFACE, VIEWER_ID, SESSION_ID, db);

    const slot6 = feed[EXPLORATION_INTERVAL - 1];
    assert.equal(slot6.slotKind, "exploration");

    const explWrite = db._inserts.find(
      (r) => r.item_id === `item-${EXPLORATION_INTERVAL - 1}`,
    );
    assert.equal(explWrite!.event_type, RankingEvent.ITEM_EXPLORATION_SELECTED);
  });
});

// ── G. Ineligible items excluded ──────────────────────────────────────────────

describe("G. Ineligible items are excluded from the assembled feed", () => {
  it("ineligible items produce no slot and no analytics write", () => {
    const db = makeFakeDb();
    const ineligible = makeOutput("item-bad", {}, false);
    const input      = makeInput("item-bad");

    const feed = allocateFeedSlots([ineligible], [input], SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed.length, 0);
    assert.equal(db._inserts.length, 0);
  });

  it("mix of eligible and ineligible: only eligible items appear, slotIndex is contiguous", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a"),
      makeOutput("item-b", {}, false), // ineligible
      makeOutput("item-c"),
    ];
    const inputs = outputs.map((o) => makeInput(o.itemId));

    const feed = allocateFeedSlots(outputs, inputs, SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed.length, 2);
    assert.equal(feed[0].itemId, "item-a");
    assert.equal(feed[0].slotIndex, 0);
    assert.equal(feed[1].itemId, "item-c");
    assert.equal(feed[1].slotIndex, 1);
    assert.equal(db._inserts.length, 2);
  });
});

// ── H. No write when db is null ───────────────────────────────────────────────

describe("H. No analytics write when db is null", () => {
  it("allocateFeedSlots with null db does not throw and still returns feed items", () => {
    const output = makeOutput("item-x");
    const input  = makeInput("item-x");

    let feed: AllocatedFeedItem[] = [];
    assert.doesNotThrow(() => {
      feed = allocateFeedSlots([output], [input], SURFACE, VIEWER_ID, SESSION_ID, null);
    });
    assert.equal(feed.length, 1);
  });
});

// ── I. slotIndex is 0-based and contiguous ────────────────────────────────────

describe("I. slotIndex is 0-based and contiguous", () => {
  it("N eligible items produce slotIndex 0..N-1", () => {
    const db = makeFakeDb();
    const N = 5;
    const outputs = Array.from({ length: N }, (_, i) => makeOutput(`item-${i}`));
    const inputs  = outputs.map((o) => makeInput(o.itemId));

    const feed = allocateFeedSlots(outputs, inputs, SURFACE, VIEWER_ID, SESSION_ID, db);

    assert.equal(feed.length, N);
    for (let i = 0; i < N; i++) {
      assert.equal(feed[i].slotIndex, i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exploration GOVERNOR (ROADMAP step 8)
// ─────────────────────────────────────────────────────────────────────────────

describe("exploration GOVERNOR — a 15-25 % budgeted allocator with reason codes", () => {
  const NOW_MS = Date.parse("2026-09-04T12:00:00Z");
  const CATS = ["food", "nightlife", "culture", "nature", "wellness"];
  function list(n: number, over: (i: number) => Partial<GovernorCandidate> = () => ({})): GovernorCandidate[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, category: CATS[i % CATS.length], socialProof: i * 2, momentum: 0, ...over(i),
    }));
  }
  const inputs = (over: Partial<GovernorInputs> = {}): GovernorInputs =>
    ({ userId: "u-1", budgetPct: 20, nowMs: NOW_MS, ...over });
  const ids = (l: readonly GovernorCandidate[]) => l.map((c) => c.id);

  it("the budget is clamped to the roadmap band; a non-finite request falls to the midpoint", () => {
    assert.equal(clampGovernorBudget(5), GOVERNOR_BUDGET_MIN_PCT);
    assert.equal(clampGovernorBudget(40), GOVERNOR_BUDGET_MAX_PCT);
    assert.equal(clampGovernorBudget(20), 20);
    assert.equal(clampGovernorBudget(Number.NaN), 20);
    assert.equal(allocateExplorationBudget(list(20), inputs({ budgetPct: 99 }), true).budgetPct, GOVERNOR_BUDGET_MAX_PCT);
  });

  it("too few candidates ⇒ nothing to govern: 0 slots, order untouched, not applied", () => {
    const l = list(GOVERNOR_MIN_CANDIDATES - 1);
    const out = allocateExplorationBudget(l, inputs(), true);
    assert.equal(out.applied, false);
    assert.equal(out.slotCount, 0);
    assert.deepEqual(out.order, ids(l));
    assert.deepEqual(out.allocations, []);
  });

  it("OBSERVE (apply=false) computes the whole allocation and changes NOTHING", () => {
    const l = list(20);
    const out = allocateExplorationBudget(l, inputs(), false);
    assert.equal(out.applied, false);
    assert.deepEqual(out.order, ids(l), "the returned order IS the input order");
    assert.equal(out.slotCount, Math.floor((20 * 20) / 100));
    assert.equal(out.allocations.length, out.slotCount);
    const poolStart = Math.ceil(20 * GOVERNOR_POOL_START_SHARE);
    for (const a of out.allocations) {
      assert.ok(a.slotIndex >= 1, "the top slot stays the ranker's");
      assert.ok(a.fromIndex >= poolStart, "picks come from the tail");
      assert.ok(a.reasons.length >= 1, "every pick carries a reason");
      for (const r of a.reasons) assert.ok((GOVERNOR_REASONS as readonly string[]).includes(r));
    }
  });

  it("APPLY is a permutation: every pick sits at its slot, non-picks keep their relative order, slot 0 is untouched", () => {
    const l = list(20);
    const out = allocateExplorationBudget(l, inputs({ budgetPct: 25 }), true);
    assert.equal(out.applied, true);
    assert.equal(out.slotCount, 5);
    assert.deepEqual([...out.order].sort(), [...ids(l)].sort());
    for (const a of out.allocations) assert.equal(out.order[a.slotIndex], a.id);
    assert.equal(out.order[0], "p0");
    const picks = new Set(out.allocations.map((a) => a.id));
    assert.deepEqual(out.order.filter((id) => !picks.has(id)), ids(l).filter((id) => !picks.has(id)));
  });

  it("the share of the page spent on exploration stays inside the budget at every list size", () => {
    for (const n of [5, 6, 7, 10, 13, 20, 33, 50, 100]) {
      for (const b of [GOVERNOR_BUDGET_MIN_PCT, 20, GOVERNOR_BUDGET_MAX_PCT]) {
        const out = allocateExplorationBudget(list(n), inputs({ budgetPct: b }), true);
        const ceiling = Math.max(1, Math.floor((n * b) / 100));
        assert.ok(out.slotCount <= ceiling, `n=${n} b=${b}: ${out.slotCount} > ${ceiling}`);
        assert.ok(out.slotCount >= 1);
        assert.equal(new Set(out.allocations.map((a) => a.slotIndex)).size, out.allocations.length, "slots are distinct");
        assert.equal(out.order.length, n);
        assert.equal(new Set(out.order).size, n);
      }
    }
  });

  it("reason codes name what the system expects to learn from the pick", () => {
    const aff = { food: 0.9, nightlife: 0.1 };
    assert.deepEqual(governorReasonsFor({ id: "x", category: "nightlife", socialProof: 5, momentum: 0 }, aff), ["unfamiliar_category"]);
    assert.deepEqual(governorReasonsFor({ id: "x", category: "food", socialProof: 0, momentum: 0 }, aff), ["low_social_proof"]);
    assert.deepEqual(governorReasonsFor({ id: "x", category: "food", socialProof: 5, momentum: GOVERNOR_RISING_MOMENTUM }, aff), ["rising_momentum"]);
    assert.deepEqual(governorReasonsFor({ id: "x", category: "food", socialProof: 5, momentum: 0 }, aff), ["long_tail"]);
    assert.deepEqual(
      governorReasonsFor({ id: "x", category: "culture", socialProof: null, momentum: 1 }, aff),
      ["unfamiliar_category", "low_social_proof", "rising_momentum"],
    );
    // With no learned affinities at all the system cannot call a category unfamiliar.
    assert.deepEqual(governorReasonsFor({ id: "x", category: "culture", socialProof: 5 }, undefined), ["long_tail"]);
  });

  it("the pick with the most to learn wins a slot, and reasonCounts tallies every reason", () => {
    const l = list(20, (i) => (i === 19 ? { category: "mystery", socialProof: 0, momentum: 1 } : {}));
    const aff = Object.fromEntries(CATS.map((c) => [c, 0.9]));
    const out = allocateExplorationBudget(l, inputs({ budgetPct: 15, categoryAffinities: aff }), true);
    assert.ok(out.allocations.some((a) => a.id === "p19"), "the unfamiliar + unproven + rising item must be picked");
    const p19 = out.allocations.find((a) => a.id === "p19")!;
    assert.deepEqual(p19.reasons, ["unfamiliar_category", "low_social_proof", "rising_momentum"]);
    const total = Object.values(out.reasonCounts).reduce((a, b) => a + b, 0);
    assert.ok(total >= out.slotCount);
    assert.ok(out.reasonCounts.rising_momentum >= 1);
  });

  it("deterministic per (viewer, hour): a paginating session sees one allocation", () => {
    const l = list(30);
    const a = allocateExplorationBudget(l, inputs(), true);
    const b = allocateExplorationBudget(l, inputs({ nowMs: NOW_MS + 5 * 60_000 }), true);
    assert.deepEqual(a.order, b.order);
    assert.deepEqual(a.allocations, b.allocations);
  });

  it("the exploration share is itself diverse: no category repeats while others remain", () => {
    const l = list(30);
    const out = allocateExplorationBudget(l, inputs({ budgetPct: 15 }), true);
    const cats = out.allocations.map((a) => l.find((c) => c.id === a.id)!.category);
    assert.equal(new Set(cats).size, cats.length);
  });
});
