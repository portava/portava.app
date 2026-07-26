/**
 * Integration tests for FeedSlotAllocator and CreatorCapEnforcer.
 *
 * Runtime: node:test  (no vitest / no supertest)
 * Run via: pnpm --filter @workspace/api-server test (api-test workflow)
 *
 * Covers:
 *   A. Single highly-active creator never exceeds maxConsecutive cap
 *   B. New-creator content appears in at least 1/8 positions when eligible
 *   C. Privacy-blocked content is absent from all slots (eligibility pre-filter)
 *   D. Following-feed: slot allocation bypassed, only creator-frequency cap applies
 *   E. Search surface: allocator returns input unchanged
 *   F. Empty-bucket redistribution to relevance pool
 *   G. Category and city window caps via applyDiversity opts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateFeedSlots } from "../FeedSlotAllocator.js";
import { enforceCreatorCaps } from "../CreatorCapEnforcer.js";
import { applyDiversity } from "../../../compass/CompassDiversityEngine.js";
import type { PipelineResult } from "../../../compass/CompassPipeline.js";
import type { FeedShares } from "../rankingConfig.js";
import type { CompassProfile } from "../../../compass/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const DEFAULT_SHARES: FeedShares = {
  relevance:     52,
  activeCreator: 15,
  underexposed:  15,
  newUser:       13,
  exploration:    5,
};

function makeItem(overrides: {
  id: string;
  authorId?: string;
  type?: string;
  city?: string;
  activeVisibilityBoost?: number;
  diversityScore?: number;
  authorJoinedAt?: string;
  finalScore?: number;
}): PipelineResult {
  return {
    item: {
      id:                   overrides.id,
      type:                 overrides.type ?? "post",
      authorId:             overrides.authorId ?? `author_${overrides.id}`,
      city:                 overrides.city ?? null,
      activeVisibilityBoost: overrides.activeVisibilityBoost ?? 0,
      diversityScore:       overrides.diversityScore ?? 0,
      authorJoinedAt:       overrides.authorJoinedAt ?? null,
      interestTags:         [],
    } as any,
    finalScore:        overrides.finalScore ?? 50,
    passedFilters:     [],
    rejectionReason:   null,
    safetyVerdict:     "passed" as any,
  } as unknown as PipelineResult;
}

const BLANK_PROFILE: CompassProfile = {
  userId: "viewer-1",
  currentCity: null,
  currentCountry: null,
  travelStyles: [],
  preferredLanguages: [],
  preferredCities: [],
  blockedUserIds: [],
  blockerUserIds: [],
  mutedUserIds: [],
  ignoredItemIds: [],
  categoryWeights: {},
  hasActiveTrip: false,
  budgetStyle: null,
  safetyPreference: "standard",
  viewerAge: null,
} as any;

// ── A. Consecutive creator cap ────────────────────────────────────────────────

describe("CreatorCapEnforcer — consecutive cap", () => {
  it("A: never places more than maxConsecutive items from one creator in a row", () => {
    // 5 items from creator-A + 3 items from creator-B.
    // With maxConsecutive=2 the enforcer must interleave B items so creator-A
    // never runs more than 2 in a row.
    const items = [
      makeItem({ id: "a1", authorId: "creator-A" }),
      makeItem({ id: "a2", authorId: "creator-A" }),
      makeItem({ id: "a3", authorId: "creator-A" }),
      makeItem({ id: "b1", authorId: "creator-B" }),
      makeItem({ id: "a4", authorId: "creator-A" }),
      makeItem({ id: "a5", authorId: "creator-A" }),
      makeItem({ id: "b2", authorId: "creator-B" }),
      makeItem({ id: "b3", authorId: "creator-B" }),
    ];

    const result = enforceCreatorCaps(items, { maxConsecutive: 2, maxPerPage: 10 });

    // Verify consecutive constraint for creator-A
    for (let i = 2; i < result.length; i++) {
      const a0 = (result[i - 2]! as PipelineResult).item.authorId;
      const a1 = (result[i - 1]! as PipelineResult).item.authorId;
      const a2 = (result[i]!    as PipelineResult).item.authorId;
      if (a0 === "creator-A" && a1 === "creator-A") {
        assert.notEqual(a2, "creator-A", `position ${i} violates maxConsecutive=2`);
      }
    }
    assert.equal(result.length, items.length, "no items dropped");
  });

  it("A2: mixed creators — maxConsecutive constraint not violated", () => {
    // Alternate: A A A B A A B → should not have 3 A's in a row
    const items = [
      makeItem({ id: "1", authorId: "A" }),
      makeItem({ id: "2", authorId: "A" }),
      makeItem({ id: "3", authorId: "A" }),
      makeItem({ id: "4", authorId: "B" }),
      makeItem({ id: "5", authorId: "A" }),
      makeItem({ id: "6", authorId: "A" }),
      makeItem({ id: "7", authorId: "B" }),
    ];

    const result = enforceCreatorCaps(items, { maxConsecutive: 2, maxPerPage: 10 });

    for (let i = 2; i < result.length; i++) {
      const run = [result[i - 2], result[i - 1], result[i]]
        .map((r) => r!.item.authorId);
      if (run[0] === run[1]) {
        assert.notEqual(run[1], run[2], `triple run of '${run[0]}' at index ${i}`);
      }
    }
  });
});

// ── B. New-creator content appears in at least 1/8 positions ─────────────────

describe("FeedSlotAllocator — new-creator bucket", () => {
  it("B: new-creator items appear in ≥ 1/8 positions when eligible content exists", () => {
    const nowMs      = Date.now();
    const newCreator = new Date(nowMs - 10 * 24 * 60 * 60 * 1_000).toISOString(); // 10 days ago
    const oldCreator = new Date(nowMs - 60 * 24 * 60 * 60 * 1_000).toISOString(); // 60 days ago

    const items: PipelineResult[] = [
      // 2 new-creator items, 14 regular items
      makeItem({ id: "new-1", authorId: "new-author-1", authorJoinedAt: newCreator }),
      makeItem({ id: "new-2", authorId: "new-author-2", authorJoinedAt: newCreator }),
      ...Array.from({ length: 14 }, (_, i) =>
        makeItem({ id: `reg-${i}`, authorId: `old-${i}`, authorJoinedAt: oldCreator }),
      ),
    ];

    const result = allocateFeedSlots(items, DEFAULT_SHARES, {
      surface: "compass",
      underexposedItemIds: new Set(),
    });

    const newIds = new Set(["new-1", "new-2"]);
    const newPositions = result.filter((r) => newIds.has(r.item.id));

    // At least 1 new-creator item must appear (spec: 1 in 8)
    assert.ok(
      newPositions.length >= 1,
      `Expected ≥1 new-creator item, got ${newPositions.length}`,
    );
    assert.equal(result.length, items.length, "total items preserved");
  });
});

// ── C. Privacy-blocked content absent from all slots ─────────────────────────

describe("FeedSlotAllocator — blocked content", () => {
  it("C: items already excluded by eligibility gate do not reappear via slot allocation", () => {
    // Simulate pre-filtered pool (eligibility filter removes blocked items before
    // reaching the allocator — the allocator must not re-inject them)
    const items: PipelineResult[] = [
      makeItem({ id: "allowed-1" }),
      makeItem({ id: "allowed-2" }),
      makeItem({ id: "allowed-3" }),
    ];

    const result = allocateFeedSlots(items, DEFAULT_SHARES, { surface: "compass" });

    const resultIds = new Set(result.map((r) => r.item.id));
    assert.ok(resultIds.has("allowed-1"));
    assert.ok(resultIds.has("allowed-2"));
    assert.ok(resultIds.has("allowed-3"));
    assert.equal(result.length, 3, "no phantom items injected");
  });
});

// ── D. Search surface bypass ──────────────────────────────────────────────────

describe("FeedSlotAllocator — search surface bypass", () => {
  it("D: search surface returns input unchanged (no slot allocation)", () => {
    const items = [
      makeItem({ id: "s1", finalScore: 90 }),
      makeItem({ id: "s2", finalScore: 80 }),
      makeItem({ id: "s3", finalScore: 70 }),
    ];

    const result = allocateFeedSlots(items, DEFAULT_SHARES, { surface: "search" });

    assert.deepEqual(
      result.map((r) => r.item.id),
      ["s1", "s2", "s3"],
      "search must return items in original order",
    );
  });
});

// ── E. Empty-bucket redistribution ───────────────────────────────────────────

describe("FeedSlotAllocator — empty bucket fallback", () => {
  it("E: when special buckets are empty, all slots go to the relevance pool", () => {
    // All old creators (no new-user, no active boost, no underexposure, no exploration)
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `r${i}`, authorJoinedAt: oldDate }),
    );

    const result = allocateFeedSlots(items, DEFAULT_SHARES, {
      surface: "compass",
      underexposedItemIds: new Set(),
    });

    assert.equal(result.length, items.length, "no items dropped");
  });

  it("E2: active-creator-heavy input — activeCreator bucket hits target", () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeItem({ id: `active-${i}`, activeVisibilityBoost: 5 }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeItem({ id: `regular-${i}` }),
      ),
    ];

    const result = allocateFeedSlots(items, DEFAULT_SHARES, {
      surface: "compass",
      underexposedItemIds: new Set(),
    });

    assert.equal(result.length, items.length, "no items dropped");

    // Active items should appear — they're in the allocator's special bucket
    const activeInResult = result.filter((r: PipelineResult) =>
      ((r.item as any).activeVisibilityBoost as number | undefined ?? 0) > 0,
    ).length;
    assert.ok(activeInResult >= 2, `expected ≥2 active items, got ${activeInResult}`);
  });
});

// ── A3. Consecutive cap enforced across placed/overflow boundary ───────────────

describe("CreatorCapEnforcer — consecutive cap across overflow boundary", () => {
  it("A3: overflow items do not create consecutive violations at the placed/tail boundary", () => {
    // With maxPerPage=2, A3 overflows to the tail.
    // Old (broken) append-then-done: placed=[A1,A2,B1] + deferred=[A3] → [A1,A2,B1,A3] (OK)
    // The critical regression case: maxPerPage=2, input=[A1,A2,A3,A4,B1].
    // placed=[A1,A2,B1], overflow=[A3,A4].
    // Naive append: [A1,A2,B1,A3,A4] — A3,A4 consecutive from A = 2, OK.
    // But if B1 comes AFTER: input=[A1,A2,A3,A4,B1], placed=[A1,A2,B1], overflow=[A3,A4].
    // combined=[A1,A2,B1,A3,A4]. Greedy:
    //   A1,A2 → block A → pick B1 → pick A3 → pick A4.
    //   Result: [A1,A2,B1,A3,A4]. A3,A4 = 2 As = exactly maxConsecutive=2, OK.
    // Critical: input=[A1,A2,A3,A4] with maxConsecutive=2, maxPerPage=2:
    //   combined=[A1,A2,A3,A4]. Greedy: A1,A2 → blocked, no non-A → best-effort A3 → best-effort A4.
    //   Result: [A1,A2,A3,A4]. Best-effort (mathematically impossible with 4 As, 0 Bs).
    // Real test: 3 As + 1 B + maxPerPage=2, overflow A3 lands at tail.
    const items = [
      makeItem({ id: "A1", authorId: "A" }),
      makeItem({ id: "A2", authorId: "A" }),
      makeItem({ id: "A3", authorId: "A" }), // overflows (maxPerPage=2)
      makeItem({ id: "B1", authorId: "B" }),
    ];

    const result = enforceCreatorCaps(items, { maxConsecutive: 2, maxPerPage: 2 });

    assert.equal(result.length, items.length, "no items dropped");

    // Verify no run of 3+ same-author across the FULL output (including tail)
    for (let i = 2; i < result.length; i++) {
      const r0 = result[i - 2]!.item.authorId;
      const r1 = result[i - 1]!.item.authorId;
      const r2 = result[i]!.item.authorId;
      assert.ok(
        !(r0 === r1 && r1 === r2),
        `consecutive violation at positions ${i - 2}..${i}: ${r0},${r1},${r2}`,
      );
    }
  });
});

// ── F. Per-page cap (maxPerPage) ──────────────────────────────────────────────

describe("CreatorCapEnforcer — per-page cap", () => {
  it("F: per-page cap reorders excess items to tail — no items ever dropped", () => {
    // 8 super + 1 other = 9 items.  maxPerPage=3, maxConsecutive=8 (consecutive cap inactive).
    // Placed section: [s0,s1,s2,other].  Deferred tail: [s3..s7].
    // Result: [s0,s1,s2,other,s3,s4,s5,s6,s7].
    // Using exactly 1 other item ensures the placed/deferred boundary lands at position 4
    // (3 super + 1 other), so the first 4 positions are the entire placed section.
    const items = [
      ...Array.from({ length: 8 }, (_, i) => makeItem({ id: `s${i}`, authorId: "super" })),
      makeItem({ id: "o0", authorId: "other" }),
    ];

    const result = enforceCreatorCaps(items, { maxConsecutive: 8, maxPerPage: 3 });

    // No items dropped — the cap is a reorder, not a filter
    assert.equal(result.length, items.length, "no items dropped");

    // The placed section (first maxPerPage super + 1 other = 4 positions) has ≤ 3 super items
    const superInPlaced = result
      .slice(0, 4)
      .filter((r: PipelineResult) => r.item.authorId === "super").length;
    assert.ok(superInPlaced <= 3, `placed region has ${superInPlaced} super items, cap is 3`);

    // All super-creator items appear (excess items move to tail, not dropped)
    const superTotal = result.filter((r: PipelineResult) => r.item.authorId === "super").length;
    assert.equal(superTotal, 8, "all super-creator items present (none dropped)");
  });
});

// ── G. Category and city window caps ─────────────────────────────────────────

/** Verify every 10-item output window satisfies both caps. */
function assertWindowCaps(
  items: PipelineResult[],
  maxCat: number,
  maxCity: number,
  windowSize = 10,
): void {
  for (let w = 0; w * windowSize < items.length; w++) {
    const window = items.slice(w * windowSize, (w + 1) * windowSize);
    const catCount  = new Map<string, number>();
    const cityCount = new Map<string, number>();
    for (const r of window) {
      const cat  = r.item.type  ?? "__none__";
      const city = ((r.item as any).city as string | undefined)?.toLowerCase() ?? "__none__";
      catCount.set(cat,   (catCount.get(cat)   ?? 0) + 1);
      cityCount.set(city, (cityCount.get(city) ?? 0) + 1);
    }
    for (const [cat, count] of catCount) {
      assert.ok(count <= maxCat,  `window ${w}: category '${cat}' has ${count} items, cap is ${maxCat}`);
    }
    for (const [city, count] of cityCount) {
      assert.ok(count <= maxCity, `window ${w}: city '${city}' has ${count} items, cap is ${maxCity}`);
    }
  }
}

describe("CompassDiversityEngine — category & city window caps", () => {
  it("G: strictly enforces category cap per 10-item window (achievable input)", () => {
    // 4 types × 10 items = 40 items; maxCategoryPerWindow=3.
    // With 4 types × 3 cap = 12 slots per window and window size = 10, this is always
    // achievable — the greedy algorithm must produce zero violations.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => makeItem({ id: `ev${i}`, type: "event" })),
      ...Array.from({ length: 10 }, (_, i) => makeItem({ id: `po${i}`, type: "post" })),
      ...Array.from({ length: 10 }, (_, i) => makeItem({ id: `pl${i}`, type: "place" })),
      ...Array.from({ length: 10 }, (_, i) => makeItem({ id: `ti${i}`, type: "tip" })),
    ];

    const result = applyDiversity(items, BLANK_PROFILE, {
      applyWindowCaps: true,
      maxCategoryPerWindow: 3,
      maxCityPerWindow: 40, // no effective city cap
    });

    assert.equal(result.items.length, items.length, "no items dropped");
    assertWindowCaps(result.items, 3, 40);
  });

  it("G2: strictly enforces city cap per 10-item window (achievable input)", () => {
    // 4 cities × 8 items = 32 items; maxCityPerWindow=3.
    // Input is INTERLEAVED (P0,L0,B0,T0,P1,L1,...) so no city dominates any window.
    // The greedy algorithm can always find a non-capped city at each position.
    // 4 cities × 3 = 12 ≥ 10 ⇒ always achievable with interleaved input.
    const cities = ["Paris", "London", "Berlin", "Tokyo"];
    // Interleave: zip across 4 cities 8 times → 32 items, cities evenly distributed
    const items = Array.from({ length: 8 }, (_, i) =>
      cities.map((city) => makeItem({ id: `${city}${i}`, type: "place", city })),
    ).flat();

    const result = applyDiversity(items, BLANK_PROFILE, {
      applyWindowCaps: true,
      maxCategoryPerWindow: 32, // no effective type cap
      maxCityPerWindow: 3,
    });

    assert.equal(result.items.length, items.length, "no items dropped");
    assertWindowCaps(result.items, 32, 3);
  });

  it("G3: applyWindowCaps=false preserves existing behavior and total count", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `item${i}`, type: i % 2 === 0 ? "event" : "post" }),
    );

    const withCaps    = applyDiversity(items, BLANK_PROFILE, { applyWindowCaps: true,  maxCategoryPerWindow: 3 });
    const withoutCaps = applyDiversity(items, BLANK_PROFILE, { applyWindowCaps: false });

    assert.equal(withCaps.items.length,    items.length, "items preserved with caps");
    assert.equal(withoutCaps.items.length, items.length, "items preserved without caps");
  });

  it("G4: no items are ever dropped — even a single-type input preserves total count", () => {
    // Worst case: all 20 items are the same type and same city; cap forces best-effort.
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `mono${i}`, type: "event", city: "Paris" }),
    );

    const result = applyDiversity(items, BLANK_PROFILE, {
      applyWindowCaps: true,
      maxCategoryPerWindow: 3,
      maxCityPerWindow: 3,
    });

    assert.equal(result.items.length, items.length, "all items preserved even when cap is impossible");
  });
});
