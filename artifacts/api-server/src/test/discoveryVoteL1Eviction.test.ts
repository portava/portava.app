/**
 * Tests confirming that evictOsmPlaceFromL1Cache() removes L1 in-memory cache
 * entries that contain the voted-on OSM place, so vote/review counts are not
 * served stale for up to the 2-hour TTL.
 *
 * These assert the cache STATE after eviction (via _hasTestCacheEntry) — a
 * no-op eviction now fails, where the previous doesNotThrow-around-clear checks
 * passed regardless.
 *
 * Run: node --import tsx/esm --test src/test/discoveryVoteL1Eviction.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  _injectTestCacheEntry,
  _clearTestCacheEntry,
  _hasTestCacheEntry,
  evictOsmPlaceFromL1Cache,
} from "../routes/discovery.js";

// ── Shared identifiers ─────────────────────────────────────────────────────────

const OSM_ID       = "node/111222333";
const OTHER_OSM_ID = "way/444555666";

// ── Helpers ────────────────────────────────────────────────────────────────────

function key(dest: string, cat = "for_you", radius = 10) {
  return `${dest.toLowerCase().trim()}:${cat}:${radius}`;
}

function osmPlace(id: string) {
  return {
    id,
    name:         "OSM Café",
    category:     "for_you" as const,
    type:         "traveler_pick" as const,
    description:  "A café",
    distanceKm:   0.5,
    lat:          48.85,
    lng:           2.35,
    tags:         [],
    address:      "Paris",
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       4.2,
    isOpenNow:    null,
    worthItCount: 3,
    avgRating:    4.2,
    reviewCount:  2,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("evictOsmPlaceFromL1Cache", () => {
  beforeEach(() => {
    for (const d of ["paris", "london", "berlin", "rome"]) {
      _clearTestCacheEntry(key(d));
      _clearTestCacheEntry(key(d, "restaurants", 5));
    }
  });

  it("removes an entry whose places array contains the targeted OSM id", () => {
    const k = key("paris");
    _injectTestCacheEntry(k, [osmPlace(OSM_ID)]);
    assert.equal(_hasTestCacheEntry(k), true, "precondition: entry present");

    evictOsmPlaceFromL1Cache(OSM_ID);

    assert.equal(_hasTestCacheEntry(k), false, "target entry must be evicted");
  });

  it("leaves entries that do not contain the targeted OSM id untouched", () => {
    const kTarget = key("paris");
    const kOther  = key("london");
    _injectTestCacheEntry(kTarget, [osmPlace(OSM_ID)]);
    _injectTestCacheEntry(kOther,  [osmPlace(OTHER_OSM_ID)]);

    evictOsmPlaceFromL1Cache(OSM_ID);

    assert.equal(_hasTestCacheEntry(kTarget), false, "target evicted");
    assert.equal(_hasTestCacheEntry(kOther),  true,  "sibling survives");
  });

  it("evicts all entries that each contain the same OSM id (multiple category buckets)", () => {
    const k1 = key("paris", "restaurants", 5);
    const k2 = key("paris", "for_you",    10);
    const k3 = key("berlin", "for_you",   10);
    _injectTestCacheEntry(k1, [osmPlace(OSM_ID)]);
    _injectTestCacheEntry(k2, [osmPlace(OSM_ID), osmPlace(OTHER_OSM_ID)]);
    _injectTestCacheEntry(k3, [osmPlace(OTHER_OSM_ID)]);

    evictOsmPlaceFromL1Cache(OSM_ID);

    assert.equal(_hasTestCacheEntry(k1), false, "bucket 1 evicted");
    assert.equal(_hasTestCacheEntry(k2), false, "bucket 2 (mixed) evicted");
    assert.equal(_hasTestCacheEntry(k3), true,  "unrelated bucket survives");
  });

  it("is a no-op when no cached entry contains the targeted OSM id", () => {
    const k = key("rome");
    _injectTestCacheEntry(k, [osmPlace(OTHER_OSM_ID)]);

    evictOsmPlaceFromL1Cache(OSM_ID);

    assert.equal(_hasTestCacheEntry(k), true, "unrelated entry untouched");
  });

  it("does not evict entries that contain only DB places (id prefixed 'db/')", () => {
    const k = key("berlin");
    _injectTestCacheEntry(k, [osmPlace(`db/some-uuid`)]);

    evictOsmPlaceFromL1Cache(OSM_ID);

    assert.equal(_hasTestCacheEntry(k), true, "DB-only entry not evicted by an OSM eviction");
  });
});
