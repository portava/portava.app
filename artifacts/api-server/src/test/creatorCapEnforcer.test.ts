/**
 * creatorCapEnforcer.test.ts
 *
 * Unit tests for CreatorCapEnforcer.
 *
 * Covers:
 *   A. Items within the creator cap are accepted in score order.
 *   B. Items that exceed the cap are deferred to the tail.
 *   C. ranking_diversity_reordered is emitted for each deferred item.
 *   D. System content (creatorId = null) is never capped and never counted.
 *   E. Custom maxPerCreator override is respected.
 *   F. No analytics write when db is null.
 *   G. Deferred items preserve their relative score order at the tail.
 *   H. When no creator exceeds the cap, output order equals input order.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emitCreatorCapAnalytics as enforceCreatorCaps,
  DEFAULT_MAX_PER_CREATOR,
} from "../services/ranking/CreatorCapEnforcer.js";
import { RankingEvent } from "../services/ranking/rankingAnalytics.js";
import type { RankingOutput } from "../services/ranking/DiscoveryRankingService.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VIEWER_ID  = "viewer-001";
const SESSION_ID = "session-xyz";
const SURFACE    = "discovery" as const;

const ZERO_COMPONENTS = {
  viewerRelevance: 0, contentRelevance: 0, geographicRelevance: 0,
  freshness: 0, contentQuality: 0, qualityEngagementScore: 0,
  relationshipRelevance: 0, explorationBoost: 0,
  activityBoost: 0, newContributorBoost: 0, returningUserBoost: 0,
  underexposureBoost: 0, repetitionPenalty: 0, fatiguePenalty: 0,
  negativeFeedbackPenalty: 0, spamPenalty: 0,
};

function makeOutput(itemId: string, score = 50): RankingOutput {
  return {
    itemId,
    finalScore:        score,
    components:        { ...ZERO_COMPONENTS },
    eligibilityPassed: true,
    eligibilityReason: null,
    explanationKey:    "discovery:post",
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

function buildMaps(
  items: Array<{ itemId: string; itemType: string; creatorId: string | null }>,
): { itemTypeMap: Map<string, string>; creatorIdMap: Map<string, string | null> } {
  const itemTypeMap  = new Map<string, string>();
  const creatorIdMap = new Map<string, string | null>();
  for (const item of items) {
    itemTypeMap.set(item.itemId, item.itemType);
    creatorIdMap.set(item.itemId, item.creatorId);
  }
  return { itemTypeMap, creatorIdMap };
}

// ── A. Items within cap accepted in score order ────────────────────────────────

describe("A. Items within the creator cap are accepted in score order", () => {
  it(`up to DEFAULT_MAX_PER_CREATOR (${DEFAULT_MAX_PER_CREATOR}) items per creator pass through`, () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a2", itemType: "post", creatorId: "creator-A" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(result.length, 2);
    assert.equal(result[0].itemId, "item-a1");
    assert.equal(result[1].itemId, "item-a2");
    // No diversity events emitted
    assert.equal(db._inserts.length, 0);
  });
});

// ── B. Items exceeding cap deferred to tail ───────────────────────────────────

describe("B. Items that exceed the cap are deferred to the tail", () => {
  it("third item from same creator moves to tail", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
      makeOutput("item-a3", 70), // third → over cap
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a2", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a3", itemType: "post", creatorId: "creator-A" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(result.length, 3);
    assert.equal(result[0].itemId, "item-a1"); // accepted
    assert.equal(result[1].itemId, "item-a2"); // accepted
    assert.equal(result[2].itemId, "item-a3"); // deferred to tail
  });
});

// ── C. ranking_diversity_reordered emitted for deferred items ─────────────────

describe("C. ranking_diversity_reordered emitted for each deferred item", () => {
  it("one deferred item → one diversity event with correct fields", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
      makeOutput("item-a3", 70), // deferred
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post",  creatorId: "creator-A" },
      { itemId: "item-a2", itemType: "post",  creatorId: "creator-A" },
      { itemId: "item-a3", itemType: "event", creatorId: "creator-A" },
    ]);

    enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(db._inserts.length, 1);
    const evt = db._inserts[0];
    assert.equal(evt.event_type,   RankingEvent.DIVERSITY_REORDERED);
    assert.equal(evt.item_id,      "item-a3");
    assert.equal(evt.content_type, "event");
    assert.equal(evt.surface,      SURFACE);
    assert.equal(evt.user_id,      VIEWER_ID);
    assert.equal(evt.session_id,   SESSION_ID);
    assert.equal(evt.outcome,      "analytics");
  });

  it("two deferred items → two diversity events", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
      makeOutput("item-a3", 70), // deferred
      makeOutput("item-a4", 60), // deferred
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps(
      outputs.map((o) => ({ itemId: o.itemId, itemType: "post", creatorId: "creator-A" })),
    );

    enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(db._inserts.length, 2);
    assert.equal(db._inserts[0].item_id, "item-a3");
    assert.equal(db._inserts[1].item_id, "item-a4");
  });
});

// ── D. System content is never capped ────────────────────────────────────────

describe("D. System content (creatorId = null) is never capped and never counted", () => {
  it("items with null creatorId always pass, unlimited", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("sys-1", 90),
      makeOutput("sys-2", 80),
      makeOutput("sys-3", 70),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps(
      outputs.map((o) => ({ itemId: o.itemId, itemType: "post", creatorId: null })),
    );

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(result.length, 3);
    assert.equal(db._inserts.length, 0); // no diversity events
  });

  it("system content between creator items does not count toward the creator's cap", () => {
    const db = makeFakeDb();
    // creator-A has 2 items; system item in between should not affect A's count
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("sys-1",   85),
      makeOutput("item-a2", 80),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post", creatorId: "creator-A" },
      { itemId: "sys-1",   itemType: "post", creatorId: null },
      { itemId: "item-a2", itemType: "post", creatorId: "creator-A" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.equal(result.length, 3);
    assert.equal(db._inserts.length, 0); // neither creator-A item deferred
  });
});

// ── E. Custom maxPerCreator override ─────────────────────────────────────────

describe("E. Custom maxPerCreator override is respected", () => {
  it("maxPerCreator=1 defers the second item from the same creator", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a2", itemType: "post", creatorId: "creator-A" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
      { maxPerCreator: 1 },
    );

    assert.equal(result[0].itemId, "item-a1"); // accepted
    assert.equal(result[1].itemId, "item-a2"); // deferred to tail
    assert.equal(db._inserts.length, 1);
    assert.equal(db._inserts[0].item_id, "item-a2");
  });

  it("maxPerCreator=3 accepts three items from the same creator", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
      makeOutput("item-a3", 70),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps(
      outputs.map((o) => ({ itemId: o.itemId, itemType: "post", creatorId: "creator-A" })),
    );

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
      { maxPerCreator: 3 },
    );

    assert.equal(result.length, 3);
    assert.equal(db._inserts.length, 0);
  });
});

// ── F. No analytics write when db is null ─────────────────────────────────────

describe("F. No analytics write when db is null", () => {
  it("deferred items with null db do not throw and still move to the tail", () => {
    const outputs = [
      makeOutput("item-a1", 90),
      makeOutput("item-a2", 80),
      makeOutput("item-a3", 70), // deferred
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps(
      outputs.map((o) => ({ itemId: o.itemId, itemType: "post", creatorId: "creator-A" })),
    );

    let result: RankingOutput[] = [];
    assert.doesNotThrow(() => {
      result = enforceCreatorCaps(
        outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, null,
      );
    });

    assert.equal(result.length, 3);
    assert.equal(result[2].itemId, "item-a3"); // still moved to tail
  });
});

// ── G. Deferred items preserve relative score order ───────────────────────────

describe("G. Deferred items preserve their relative score order at the tail", () => {
  it("two deferred items appear in score-descending order at the tail", () => {
    const db = makeFakeDb();
    // creator-A: first two accepted, then two deferred (score 70, 60)
    // creator-B: one item (score 65) accepted between the deferred ones (input order)
    const outputs = [
      makeOutput("item-a1", 90), // accepted (A count = 1)
      makeOutput("item-a2", 80), // accepted (A count = 2)
      makeOutput("item-a3", 70), // deferred (A count would be 3)
      makeOutput("item-b1", 65), // accepted (B count = 1)
      makeOutput("item-a4", 60), // deferred (A count would be 3)
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a1", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a2", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-a3", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-b1", itemType: "post", creatorId: "creator-B" },
      { itemId: "item-a4", itemType: "post", creatorId: "creator-A" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    // Accepted: a1, a2, b1
    assert.equal(result[0].itemId, "item-a1");
    assert.equal(result[1].itemId, "item-a2");
    assert.equal(result[2].itemId, "item-b1");
    // Deferred tail in original score order: a3, a4
    assert.equal(result[3].itemId, "item-a3");
    assert.equal(result[4].itemId, "item-a4");
  });
});

// ── H. No creator exceeds cap → output equals input ───────────────────────────

describe("H. When no creator exceeds the cap, output order equals input order", () => {
  it("all-distinct creators: output is identical to input", () => {
    const db = makeFakeDb();
    const outputs = [
      makeOutput("item-a", 90),
      makeOutput("item-b", 80),
      makeOutput("item-c", 70),
    ];
    const { itemTypeMap, creatorIdMap } = buildMaps([
      { itemId: "item-a", itemType: "post", creatorId: "creator-A" },
      { itemId: "item-b", itemType: "post", creatorId: "creator-B" },
      { itemId: "item-c", itemType: "post", creatorId: "creator-C" },
    ]);

    const result = enforceCreatorCaps(
      outputs, itemTypeMap, creatorIdMap, SURFACE, VIEWER_ID, SESSION_ID, db,
    );

    assert.deepEqual(result.map((r) => r.itemId), ["item-a", "item-b", "item-c"]);
    assert.equal(db._inserts.length, 0);
  });
});
