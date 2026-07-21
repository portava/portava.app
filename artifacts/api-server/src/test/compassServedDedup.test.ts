/**
 * compassServedDedup.test.ts — served-recommendation registration dedupe
 *
 * Regression guard for the silent "Why this?" outage: recommendation tokens
 * are deterministic (HMAC over user/item/section/key), so the same item
 * appearing twice in one feed page produces duplicate recommendation_ids in
 * one upsert batch. Postgres rejects the WHOLE batch ("cannot affect row a
 * second time", code 21000) and supabase-js surfaces it only via the `error`
 * field — silently dropping ALL registrations, so every /compass/why call
 * returned "not found".
 *
 * Locks in dedupeByRecommendationId() and its use inside
 * enrichFeedWithRecommendationIds() (routes/compass.ts, feed + section paths).
 *
 * Runtime: node:test + node:assert/strict (no DB).
 * Run: node --import tsx/esm --test src/test/compassServedDedup.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dedupeByRecommendationId,
  enrichFeedWithRecommendationIds,
  type RecommendationRow,
} from "../routes/compass.js";
import type { FeedPage, FeedItem, SectionName } from "../compass/CompassFeedBuilder.js";
import { decodeRecommendationToken } from "../compass/CompassExplanationEngine.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

function makeRow(recommendationId: string, overrides: Partial<RecommendationRow> = {}): RecommendationRow {
  return {
    user_id:           USER_ID,
    recommendation_id: recommendationId,
    explanation_key:   "matches_travel_style",
    item_id:           "item-1",
    item_type:         "event",
    section_name:      "for_you_today",
    ranking_factors:   null,
    ...overrides,
  };
}

function makeFeedItem(
  id: string,
  section: SectionName,
  explanationKey = "matches_travel_style",
): FeedItem {
  return {
    item: { id, type: "event" } as FeedItem["item"],
    finalScore:       50,
    safetyPassed:     true,
    eligiblePassed:   true,
    privacySanitized: true,
    explanationKey,
    section,
  };
}

function makeFeed(sections: { name: SectionName; items: FeedItem[] }[]): FeedPage {
  return {
    sections: sections.map((s) => ({ name: s.name, items: s.items, total: s.items.length })),
    nextCursor: null,
    fallback:   false,
    pipelineMeta: { inputCount: 0, blockedCount: 0, rejectedCount: 0, passedCount: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// dedupeByRecommendationId
// ─────────────────────────────────────────────────────────────────────────────

describe("dedupeByRecommendationId", () => {
  it("passes through rows with unique recommendation_ids unchanged", () => {
    const rows = [makeRow("tok-a"), makeRow("tok-b"), makeRow("tok-c")];
    const out = dedupeByRecommendationId(rows);
    assert.deepEqual(out.map((r) => r.recommendation_id), ["tok-a", "tok-b", "tok-c"]);
  });

  it("drops duplicate recommendation_ids, keeping the first occurrence", () => {
    const rows = [
      makeRow("tok-a", { section_name: "for_you_today" }),
      makeRow("tok-b"),
      makeRow("tok-a", { section_name: "happening_nearby" }),
    ];
    const out = dedupeByRecommendationId(rows);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((r) => r.recommendation_id), ["tok-a", "tok-b"]);
    // First occurrence is the survivor
    assert.equal(out[0]!.section_name, "for_you_today");
  });

  it("handles an empty batch", () => {
    assert.deepEqual(dedupeByRecommendationId([]), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// enrichFeedWithRecommendationIds — the actual regression scenario
// ─────────────────────────────────────────────────────────────────────────────

describe("enrichFeedWithRecommendationIds — repeated feed item", () => {
  it("same item twice in one page yields NO duplicate recommendation_ids in the registration batch", () => {
    // Same item + same section + same explanation key ⇒ deterministic token collides
    const dup1 = makeFeedItem("event-123", "for_you_today");
    const dup2 = makeFeedItem("event-123", "for_you_today");
    const other = makeFeedItem("event-456", "for_you_today");
    const feed = makeFeed([{ name: "for_you_today", items: [dup1, dup2, other] }]);

    const { registrationRows } = enrichFeedWithRecommendationIds(USER_ID, feed);

    const ids = registrationRows.map((r) => r.recommendation_id);
    assert.equal(new Set(ids).size, ids.length, "registration batch must contain no duplicate recommendation_ids");
    // The duplicate pair collapsed to one row; the other item survived.
    assert.equal(registrationRows.length, 2);
  });

  it("same item repeated across sections in one page also produces a unique batch", () => {
    const a = makeFeedItem("event-123", "for_you_today");
    const b = makeFeedItem("event-123", "happening_nearby");
    const feed = makeFeed([
      { name: "for_you_today",    items: [a, a] },
      { name: "happening_nearby", items: [b, b] },
    ]);

    const { registrationRows } = enrichFeedWithRecommendationIds(USER_ID, feed);

    const ids = registrationRows.map((r) => r.recommendation_id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("every enriched item still carries a recommendationId decodable to a registered row", () => {
    const dup = makeFeedItem("event-123", "for_you_today");
    const feed = makeFeed([{ name: "for_you_today", items: [dup, dup] }]);

    const { enrichedFeed, registrationRows } = enrichFeedWithRecommendationIds(USER_ID, feed);

    const registered = new Set(registrationRows.map((r) => r.recommendation_id));
    const sections = (enrichedFeed as { sections: { items: { recommendationId: string }[] }[] }).sections;
    for (const section of sections) {
      for (const item of section.items) {
        assert.ok(item.recommendationId, "each item must expose a recommendationId");
        // Both duplicates share the same (deduped) registered token — /why still works.
        assert.ok(registered.has(item.recommendationId), "item token must be present in the registration batch");
        const decoded = decodeRecommendationToken(item.recommendationId);
        assert.ok(decoded, "token must decode");
        assert.equal(decoded!.userId, USER_ID);
        assert.equal(decoded!.itemId, "event-123");
      }
    }
  });
});
