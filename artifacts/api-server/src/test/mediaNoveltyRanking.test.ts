/**
 * mediaNoveltyRanking.test.ts
 *
 * Tests for the novelty multiplier and loadBucketMap path in
 * MediaFeedRankingService.
 *
 * Covers:
 *   1. noveltyMultiplier() unit — correct thresholds (< 5 → ×1.4, < 20 → ×1.2, else ×1.0).
 *   2. Multi-bucket: uses the minimum count across matched buckets.
 *   3. Missing / null inputs fall back to ×1.0.
 *   4. rankMediaFeed with seeded bucketCounts: posts in thin buckets score
 *      higher than identical posts in saturated buckets.
 *   5. loadBucketMap with a fake DB client: produces the correct Map keys.
 *
 * Runtime: node:test + tsx/esm
 * Run: node --import tsx/esm --test src/test/mediaNoveltyRanking.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  noveltyMultiplier,
  rankMediaFeed,
  loadBucketMap,
  type MediaFeedItem,
  type MediaRankingInput,
  type MediaRankingFlags,
  type MediaSessionState,
} from "../services/ranking/MediaFeedRankingService.js";
import type { BucketType } from "../lib/places/bucketClassifier.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FLAGS_ALL_ON: MediaRankingFlags = {
  rankingEnabled:               true,
  activeCreatorBoostEnabled:    false,
  newCreatorBoostEnabled:       false,
  returningCreatorBoostEnabled: false,
  underexposedBoostEnabled:     false,
  creatorFatigueEnabled:        false,
};

const EMPTY_SESSION: MediaSessionState = { creatorImpressions: new Map() };

const VIEWER = {
  viewerId:    "viewer-01",
  nowMs:       new Date("2026-07-28T12:00:00Z").getTime(),
  followedIds: new Set<string>(),
};

function makeItem(overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  return {
    id:        "item-default",
    authorId:  "author-01",
    kind:      "photo",
    createdAt: "2026-07-28T10:00:00Z",
    ...overrides,
  };
}

// ── noveltyMultiplier unit tests ──────────────────────────────────────────────

describe("noveltyMultiplier — thresholds", () => {
  const PLACE_ID = "place-001";

  it("returns 1.4 when bucket post_count < 5", () => {
    const map = new Map([["place-001:drone", 3]]);
    const result = noveltyMultiplier(["drone"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.4);
  });

  it("returns 1.4 when bucket post_count is 0 (missing key → 0)", () => {
    const map = new Map<string, number>(); // empty — treat as 0
    const result = noveltyMultiplier(["night"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.4);
  });

  it("returns 1.2 when bucket post_count is 5 (on threshold)", () => {
    const map = new Map([["place-001:sunrise", 5]]);
    const result = noveltyMultiplier(["sunrise"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.2);
  });

  it("returns 1.2 when bucket post_count is 19 (just under upper threshold)", () => {
    const map = new Map([["place-001:adventure", 19]]);
    const result = noveltyMultiplier(["adventure"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.2);
  });

  it("returns 1.0 when bucket post_count is 20 (saturated)", () => {
    const map = new Map([["place-001:festival", 20]]);
    const result = noveltyMultiplier(["festival"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.0);
  });

  it("returns 1.0 when bucket post_count is 100", () => {
    const map = new Map([["place-001:tips", 100]]);
    const result = noveltyMultiplier(["tips"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.0);
  });
});

describe("noveltyMultiplier — multi-bucket uses minimum count", () => {
  const PLACE_ID = "place-001";

  it("uses the minimum count — one thin bucket drives the multiplier", () => {
    const map = new Map([
      ["place-001:drone",   50],  // saturated
      ["place-001:sunrise",  2],  // very thin
    ]);
    const result = noveltyMultiplier(["drone", "sunrise"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.4); // minimum is 2, so ×1.4
  });

  it("both saturated → ×1.0", () => {
    const map = new Map([
      ["place-001:night",   25],
      ["place-001:festival", 30],
    ]);
    const result = noveltyMultiplier(["night", "festival"] as BucketType[], PLACE_ID, map);
    assert.equal(result, 1.0);
  });
});

describe("noveltyMultiplier — null/missing inputs", () => {
  it("returns 1.0 when postBuckets is empty", () => {
    const map = new Map([["place-001:drone", 1]]);
    assert.equal(noveltyMultiplier([], "place-001", map), 1.0);
  });

  it("returns 1.0 when postBuckets is null", () => {
    const map = new Map([["place-001:drone", 1]]);
    assert.equal(noveltyMultiplier(null, "place-001", map), 1.0);
  });

  it("returns 1.0 when placeId is null", () => {
    const map = new Map([["place-001:drone", 1]]);
    assert.equal(noveltyMultiplier(["drone"] as BucketType[], null, map), 1.0);
  });

  it("returns 1.0 when bucketCounts is null", () => {
    assert.equal(noveltyMultiplier(["drone"] as BucketType[], "place-001", null), 1.0);
  });

  it("returns 1.0 when bucketCounts is undefined", () => {
    assert.equal(noveltyMultiplier(["drone"] as BucketType[], "place-001", undefined), 1.0);
  });
});

// ── rankMediaFeed with bucketCounts ──────────────────────────────────────────

describe("rankMediaFeed — novelty boost from thin buckets", () => {
  const PLACE_ID = "place-001";

  it("thin-bucket post scores higher than identical saturated post", () => {
    const bucketCounts = new Map([
      [`${PLACE_ID}:drone`,   2],  // thin → ×1.4
      [`${PLACE_ID}:sunrise`, 50], // saturated → ×1.0
    ]);

    const thinPost = makeItem({
      id:               "thin-post",
      authorId:         "author-01",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      ["drone"] as BucketType[],
    });

    const saturatedPost = makeItem({
      id:               "saturated-post",
      authorId:         "author-02",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      ["sunrise"] as BucketType[],
      // Identical signals to thinPost
    });

    const input: MediaRankingInput = {
      candidates:   [thinPost, saturatedPost],
      viewer:       VIEWER,
      mode:         "for_you",
      sessionState: EMPTY_SESSION,
      flags:        FLAGS_ALL_ON,
      bucketCounts,
      nowMs:        VIEWER.nowMs,
    };

    const ranked = rankMediaFeed(input);
    const thinIdx      = ranked.findIndex((r) => r.item.id === "thin-post");
    const saturatedIdx = ranked.findIndex((r) => r.item.id === "saturated-post");
    assert.ok(
      thinIdx < saturatedIdx,
      `expected thin-post (idx ${thinIdx}) before saturated-post (idx ${saturatedIdx})`,
    );
  });

  it("thin-bucket post has a higher finalScore than otherwise identical post with no buckets", () => {
    const bucketCounts = new Map([[`${PLACE_ID}:drone`, 1]]);

    const thinPost = makeItem({
      id:               "with-bucket",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      ["drone"] as BucketType[],
    });

    const noBucketPost = makeItem({
      id:               "no-bucket",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      [],
    });

    const input: MediaRankingInput = {
      candidates:   [thinPost, noBucketPost],
      viewer:       VIEWER,
      mode:         "for_you",
      sessionState: EMPTY_SESSION,
      flags:        FLAGS_ALL_ON,
      bucketCounts,
      nowMs:        VIEWER.nowMs,
    };

    const ranked = rankMediaFeed(input);
    const thinResult      = ranked.find((r) => r.item.id === "with-bucket")!;
    const noBucketResult  = ranked.find((r) => r.item.id === "no-bucket")!;
    assert.ok(
      thinResult.finalScore > noBucketResult.finalScore,
      `expected thin (${thinResult.finalScore}) > no-bucket (${noBucketResult.finalScore})`,
    );
  });

  it("no novelty boost when bucketCounts is not supplied", () => {
    const withBuckets = makeItem({
      id:               "with-bucket",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      ["drone"] as BucketType[],
    });

    const noBuckets = makeItem({
      id:               "no-bucket",
      canonicalPlaceId: PLACE_ID,
      postBuckets:      [],
    });

    const input: MediaRankingInput = {
      candidates:   [withBuckets, noBuckets],
      viewer:       VIEWER,
      mode:         "for_you",
      sessionState: EMPTY_SESSION,
      flags:        FLAGS_ALL_ON,
      // No bucketCounts — should not apply any novelty boost
      nowMs:        VIEWER.nowMs,
    };

    const ranked = rankMediaFeed(input);
    const withResult = ranked.find((r) => r.item.id === "with-bucket")!;
    const noResult   = ranked.find((r) => r.item.id === "no-bucket")!;
    // Scores should be equal (same signals, no bucket boost)
    assert.equal(withResult.finalScore, noResult.finalScore);
  });
});

// ── loadBucketMap with fake client ────────────────────────────────────────────

describe("loadBucketMap — fake client", () => {
  function makeFakeDb(rows: Array<{ canonical_place_id: string; bucket: string; post_count: number }>) {
    return {
      from: (_table: string) => ({
        select: (_cols: string) => ({
          in: (_col: string, _ids: string[]) =>
            Promise.resolve({ data: rows, error: null }),
        }),
      }),
    } as any;
  }

  it("returns a correctly keyed Map from DB rows", async () => {
    const db = makeFakeDb([
      { canonical_place_id: "p1", bucket: "drone",   post_count: 3 },
      { canonical_place_id: "p1", bucket: "sunrise",  post_count: 12 },
      { canonical_place_id: "p2", bucket: "festival", post_count: 1 },
    ]);

    const map = await loadBucketMap(db, ["p1", "p2"]);
    assert.equal(map.get("p1:drone"),    3);
    assert.equal(map.get("p1:sunrise"),  12);
    assert.equal(map.get("p2:festival"), 1);
    assert.equal(map.size, 3);
  });

  it("returns empty Map when placeIds is empty", async () => {
    const db = makeFakeDb([]);
    const map = await loadBucketMap(db, []);
    assert.equal(map.size, 0);
  });

  it("returns empty Map when db is null", async () => {
    const map = await loadBucketMap(null, ["p1"]);
    assert.equal(map.size, 0);
  });

  it("returns empty Map on DB error", async () => {
    const errorDb = {
      from: () => ({
        select: () => ({
          in: () => Promise.resolve({ data: null, error: new Error("DB error") }),
        }),
      }),
    } as any;
    const map = await loadBucketMap(errorDb, ["p1"]);
    assert.equal(map.size, 0);
  });
});
