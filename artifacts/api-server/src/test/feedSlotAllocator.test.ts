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
