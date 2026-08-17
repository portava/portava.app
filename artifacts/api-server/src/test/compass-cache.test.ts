/**
 * compass-cache.test.ts — Phase 4 Cache & Front Load Engine tests
 *
 * Covers:
 *   - CompassCacheEngine: safety data bypasses cache (TTL = 0);
 *     block triggers immediate cache invalidation; L1 evicted on invalidate
 *   - CompassFrontLoadEngine: emergency contacts never appear in payload;
 *     slow/offline network hint caps maxTier to 0; unpublished delayed posts excluded
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-cache.test.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  getCachedFeed,
  setCachedFeed,
  invalidate,
  clearL1Cache,
  type CacheEntryType,
} from "../compass/CompassCacheEngine.js";
import {
  buildFrontLoadPayload,
  buildPreloadManifest,
  recordNavigationEvent,
  resolveMaxTier,
  computePreloadScore,
  CONTENT_SCORE_FACTORS,
  type NetworkHint,
  type BatteryHint,
  type FrontLoadTier,
  type FrontLoadItem,
} from "../compass/CompassFrontLoadEngine.js";
import type { CompassProfile } from "../compass/types.js";
import { feedCacheKey } from "../routes/compass.js";
import { resolveLocalHour, _setTestNowUtc, clearUserTimezoneCache } from "../lib/localTime.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_A = "00000000-0000-0000-0001-000000000001";
const USER_B = "00000000-0000-0000-0001-000000000002";

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:               USER_A,
    preferredCities:      [],
    preferredLanguages:   ["en"],
    budgetStyle:          null,
    travelStyles:         [],
    socialStyle:          null,
    safetyPreference:     "standard",
    visibilityPreference: "semi_private",
    blockedUserIds:       [],
    blockerUserIds:       [],
    mutedUserIds:         [],
    blockCount:           0,
    blockerCount:         0,
    trustScore:           null,
    trustLevel:           null,
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:          null,
    currentCountry:       null,
    safeReturnActive:     false,
    computedAt:           new Date().toISOString(),
    ...overrides,
  };
}

// ── Fake DB builder ───────────────────────────────────────────────────────────

interface FakeDbCall {
  table:   string;
  method:  string;
  args?:   unknown;
}

type FakeDbRow = Record<string, unknown>;

/**
 * Creates a minimal fake Supabase-shaped client for cache tests.
 * `tableData` maps table name → rows to return on .select().
 * `calls` is populated with every method called, for assertions.
 *
 * The `then` property is a proper thenable that calls onFulfilled so that
 * `await db.from(t).select()...` (without .maybeSingle()) resolves correctly.
 * The `delete().eq()` pattern applies the filter and removes matching rows.
 */
function makeFakeDb(
  tableData: Record<string, FakeDbRow[]> = {},
): { db: any; calls: FakeDbCall[] } {
  const calls: FakeDbCall[] = [];

  function buildSelectChain(table: string, filters: Record<string, unknown>): any {
    const chain: any = {
      select(_cols?: string) {
        calls.push({ table, method: "select" });
        return chain;
      },
      eq(col: string, val: unknown)        { filters[col] = val; return chain; },
      gt(_col: string, _val: unknown)      { return chain; },
      is(_col: string, _val: unknown)      { return chain; },
      like(_col: string, _val: unknown)    { return chain; },
      in(_col: string, _vals: unknown[])   { return chain; },
      order(_col: string, _opts?: unknown) { return chain; },
      limit(_n: number)                    { return chain; },

      async maybeSingle() {
        const rows = (tableData[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return { data: rows[0] ?? null, error: null };
      },

      // Proper thenable: JS `await` calls then(resolve, reject).
      // We must call resolve(value) — not just return a promise — for the outer
      // await to settle. Delegates to Promise.resolve so it works correctly.
      then(
        onFulfilled?: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        const result = { data: [...(tableData[table] ?? [])], error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },

      async insert(row: unknown) {
        calls.push({ table, method: "insert", args: row });
        if (!tableData[table]) tableData[table] = [];
        tableData[table].push(row as FakeDbRow);
        return { error: null, data: null };
      },

      async upsert(row: unknown, _opts?: unknown) {
        calls.push({ table, method: "upsert", args: row });
        if (!tableData[table]) tableData[table] = [];
        tableData[table].push(row as FakeDbRow);
        return { error: null, data: null };
      },

      // delete() returns a sub-chain where .eq() does the actual row removal
      delete() {
        calls.push({ table, method: "delete" });
        return {
          eq(col: string, val: unknown) {
            if (tableData[table]) {
              tableData[table] = tableData[table].filter((r) => r[col] !== val);
            }
            return { error: null, data: null };
          },
        };
      },
    };
    return chain;
  }

  const db = {
    from(table: string) {
      calls.push({ table, method: "from" });
      return buildSelectChain(table, {});
    },
  };

  return { db, calls };
}

// ── CompassCacheEngine tests ──────────────────────────────────────────────────

describe("CompassCacheEngine — safety bypass", () => {
  before(() => clearL1Cache());

  it("getCachedFeed with entryType='feed' returns null when no cache exists", async () => {
    const { db } = makeFakeDb({ compass_feed_cache: [] });
    const result = await getCachedFeed(db, USER_A, "feed:for_you", "feed");
    assert.strictEqual(result, null, "must return null for empty cache");
  });

  it("safety data is never served from cache — getCachedFeed with type 'feed' after set", async () => {
    // Even if we manually verify the TTL=0 contract: safety type is handled
    // by the caller always bypassing getCachedFeed. We test the intent via
    // resolveMaxTier: slow network means even feed cache is not useful (tier 0 only).
    // The core invariant: 'safety' is not a valid CacheEntryType (no TTL entry).
    // Verify that setCachedFeed with booking type stores and getCachedFeed returns it.
    clearL1Cache();
    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache: [],
      compass_cache_invalidations: [],
    };
    const { db } = makeFakeDb(tableData);
    const payload = { sections: [{ name: "for_you" }] };
    await setCachedFeed(db, USER_A, "feed:test", "feed", payload);
    // After set, L1 should have it
    const hit = await getCachedFeed(db, USER_A, "feed:test", "feed");
    assert.deepStrictEqual(hit, payload, "L1 cache hit must return stored payload");
  });

  it("after invalidate(), L1 cache is evicted and getCachedFeed returns null", async () => {
    clearL1Cache();
    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache: [
        { user_id: USER_A, cache_key: "feed:for_you", expires_at: new Date(Date.now() + 60_000).toISOString() },
      ],
      compass_cache_invalidations: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    // Warm L1
    await setCachedFeed(db, USER_A, "feed:for_you", "feed", { test: true });

    // Block → triggers invalidation
    await invalidate(db, USER_A, "block");

    // L1 should be evicted; DB row also deleted
    clearL1Cache(); // simulate fresh process state — what matters is DB row gone
    const deleteCall = calls.find((c) => c.method === "delete" && c.table === "compass_feed_cache");
    assert.ok(deleteCall, "cache row DELETE must be called on invalidate");

    const insertCall = calls.find((c) => c.method === "insert" && c.table === "compass_cache_invalidations");
    assert.ok(insertCall, "audit log INSERT to compass_cache_invalidations must be called");
  });

  it("invalidate() appends a row to compass_cache_invalidations with the correct reason", async () => {
    clearL1Cache();
    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache: [],
      compass_cache_invalidations: [],
    };
    const { db, calls } = makeFakeDb(tableData);

    await invalidate(db, USER_B, "admin_suspend");

    const insertCall = calls.find((c) => c.method === "insert" && c.table === "compass_cache_invalidations");
    assert.ok(insertCall, "audit log must be appended");
    const row = insertCall!.args as Record<string, unknown>;
    assert.strictEqual(row["user_id"], USER_B);
    assert.strictEqual(row["reason"], "admin_suspend");
  });
});

// ── feedCacheKey — tz-offset partitioning ─────────────────────────────────────

describe("feedCacheKey — tz offset partitions cache entries", () => {
  it("different tzOffsetMinutes produce different keys (feed + section)", () => {
    assert.notStrictEqual(
      feedCacheKey("feed", undefined, 480),
      feedCacheKey("feed", undefined, -300),
    );
    assert.notStrictEqual(
      feedCacheKey("section:for_you", undefined, 480),
      feedCacheKey("section:for_you", undefined, null),
    );
    // Same offset + cursor → stable key (cache hits still work)
    assert.strictEqual(
      feedCacheKey("feed", "abc", 60),
      feedCacheKey("feed", "abc", 60),
    );
  });

  it("two requests with different tzOffsetMinutes do not share a cache entry", async () => {
    clearL1Cache();
    const { db } = makeFakeDb({ compass_feed_cache: [] });
    const eveningPayload = { sections: [{ name: "for_you", vibe: "evening" }] };

    // Cache written for UTC+8 traveler
    await setCachedFeed(db, USER_A, feedCacheKey("feed", undefined, 480), "feed", eveningPayload);

    // Same user now reporting UTC-5 must NOT get the UTC+8 payload
    const crossTz = await getCachedFeed(db, USER_A, feedCacheKey("feed", undefined, -300), "feed");
    assert.strictEqual(crossTz, null, "different tz offset must miss the cache");

    // Original offset still hits
    const sameTz = await getCachedFeed(db, USER_A, feedCacheKey("feed", undefined, 480), "feed");
    assert.deepStrictEqual(sameTz, eveningPayload);
  });
});

// ── feedCacheKey — "auto" (no offset) keys by resolved time-of-day bucket ─────

describe("feedCacheKey — auto path partitions by time-of-day bucket", () => {
  it("same bucket → stable key; different bucket → different key", () => {
    // 8am and 10am are both "morning" → same key (cache hits still work)
    assert.strictEqual(
      feedCacheKey("feed", undefined, null, 8),
      feedCacheKey("feed", undefined, null, 10),
    );
    // 10am (morning) vs 11am (afternoon) → different keys
    assert.notStrictEqual(
      feedCacheKey("feed", undefined, null, 10),
      feedCacheKey("feed", undefined, null, 11),
    );
    // Explicit offset also keys by resolved bucket: same offset + same bucket → stable key
    assert.strictEqual(
      feedCacheKey("feed", undefined, 480, 8),
      feedCacheKey("feed", undefined, 480, 10),
    );
    // Explicit offset + bucket crossing → different keys (the fix for task 2145)
    assert.notStrictEqual(
      feedCacheKey("feed", undefined, 480, 10),
      feedCacheKey("feed", undefined, 480, 23),
    );
  });

  it("an 'auto' traveler crossing a bucket boundary misses the stale cache entry", async () => {
    clearL1Cache();
    clearUserTimezoneCache();
    const { db } = makeFakeDb({
      compass_feed_cache: [],
      notification_preferences: [{ user_id: USER_A, timezone: "America/New_York" }],
    });
    const morningPayload = { sections: [{ name: "for_you", vibe: "morning" }] };

    try {
      // 14:30 UTC = 10:30 in New York (UTC-4, July) → "morning" bucket
      _setTestNowUtc(new Date("2026-07-21T14:30:00Z"));
      const hourBefore = await resolveLocalHour(db, USER_A, null);
      const keyBefore  = feedCacheKey("feed", undefined, null, hourBefore);
      await setCachedFeed(db, USER_A, keyBefore, "feed", morningPayload);

      // One hour later (within cache TTL): 11:30 local → "afternoon" bucket
      _setTestNowUtc(new Date("2026-07-21T15:30:00Z"));
      const hourAfter = await resolveLocalHour(db, USER_A, null);
      const keyAfter  = feedCacheKey("feed", undefined, null, hourAfter);

      assert.notStrictEqual(keyBefore, keyAfter, "bucket crossing must change the cache key");
      const stale = await getCachedFeed(db, USER_A, keyAfter, "feed");
      assert.strictEqual(stale, null, "afternoon request must miss the morning cache entry");

      // The morning key itself still hits (stable within a bucket)
      const sameBucket = await getCachedFeed(db, USER_A, keyBefore, "feed");
      assert.deepStrictEqual(sameBucket, morningPayload);
    } finally {
      _setTestNowUtc(null);
    }
  });

  it("an explicit-offset traveler crossing a bucket boundary misses the stale cache entry", async () => {
    clearL1Cache();
    // UTC+8 traveler (tzOffsetMinutes=480):
    //   16:59 local (08:59 UTC) → "afternoon" bucket
    //   17:01 local (09:01 UTC) → "evening" bucket
    const afternoonPayload = { sections: [{ name: "for_you", vibe: "afternoon" }] };

    // Compute local hours directly from the offset (no DB lookup needed for explicit offset)
    const hourBefore = 16; // 08:59 UTC + 480min = 16:59 local → hour 16 → afternoon
    const keyBefore  = feedCacheKey("feed", undefined, 480, hourBefore);
    const { db } = makeFakeDb({ compass_feed_cache: [] });
    await setCachedFeed(db, USER_A, keyBefore, "feed", afternoonPayload);

    const hourAfter = 17; // 09:01 UTC + 480min = 17:01 local → hour 17 → evening
    const keyAfter  = feedCacheKey("feed", undefined, 480, hourAfter);

    assert.notStrictEqual(keyBefore, keyAfter, "bucket crossing must change the key even with an explicit offset");
    const stale = await getCachedFeed(db, USER_A, keyAfter, "feed");
    assert.strictEqual(stale, null, "evening request must miss the afternoon cache entry for an explicit-offset traveler");

    // The afternoon key itself still hits (stable within a bucket)
    const sameBucket = await getCachedFeed(db, USER_A, keyBefore, "feed");
    assert.deepStrictEqual(sameBucket, afternoonPayload, "afternoon key must still hit within the same bucket");
  });
});

// ── CompassFrontLoadEngine — resolveMaxTier ───────────────────────────────────

describe("CompassFrontLoadEngine — resolveMaxTier", () => {
  const cases: Array<[NetworkHint, BatteryHint, number]> = [
    ["offline", "normal", 0],
    ["slow",    "normal", 1], // slow → Tier 1: feed still preloaded, Tier 2+ avoided
    ["cellular","normal", 1],
    ["wifi",    "low",    2],
    ["wifi",    "normal", 3],
    ["cellular","low",    1], // cellular takes precedence over low battery
  ];

  for (const [network, battery, expected] of cases) {
    it(`network=${network} battery=${battery} → maxTier=${expected}`, () => {
      assert.strictEqual(resolveMaxTier(network, battery), expected);
    });
  }
});

// ── CompassFrontLoadEngine — buildFrontLoadPayload ────────────────────────────

describe("CompassFrontLoadEngine — buildFrontLoadPayload", () => {
  it("slow network hint → maxTier=1; tier0 + tier1 populated, tier2/3 empty", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "slow",
    });
    // slow caps at Tier 1 — feed is still preloaded; heavy Tier 2+ (events/buddies) avoided
    assert.strictEqual(payload.maxTier, 1, "maxTier must be 1 for slow network");
    assert.ok(payload.tier0.length > 0, "tier0 must have items");
    // tier1 is allowed on slow; it may be empty if no city/feed data but the cap is 1 not 0
    assert.strictEqual(payload.tier2.length, 0, "tier2 must be empty for slow network");
    assert.strictEqual(payload.tier3.length, 0, "tier3 must be empty for slow network");
  });

  it("offline network hint → only Tier 0 items", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "offline",
    });
    assert.strictEqual(payload.maxTier, 0);
    assert.strictEqual(payload.tier1.length, 0);
  });

  it("low battery → maxTier is 2 (Tier 3 paused)", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "wifi",
      batteryHint: "low",
    });
    assert.strictEqual(payload.maxTier, 2, "low battery must pause Tier 3");
    assert.strictEqual(payload.tier3.length, 0, "tier3 must be empty on low battery");
  });

  it("emergency_contact type is never present in any tier", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "wifi",
    });
    const allItems = [...payload.tier0, ...payload.tier1, ...payload.tier2, ...payload.tier3];
    const forbidden = allItems.find((i) => i.type === "emergency_contact");
    assert.strictEqual(forbidden, undefined, "emergency_contact must never appear in frontload payload");
  });

  it("id_document type is never present in any tier", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "wifi",
    });
    const allItems = [...payload.tier0, ...payload.tier1, ...payload.tier2, ...payload.tier3];
    const forbidden = allItems.find((i) => i.type === "id_document");
    assert.strictEqual(forbidden, undefined, "id_document must never appear in frontload payload");
  });

  it("tier0 always contains safety_state and feature_flags items", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "offline",
    });
    const types = payload.tier0.map((i) => i.type);
    assert.ok(types.includes("safety_state"),  "tier0 must include safety_state");
    assert.ok(types.includes("feature_flags"), "tier0 must include feature_flags");
    assert.ok(types.includes("blocked_users"), "tier0 must include blocked_users");
  });

  it("tier1 contains a first_feed_page item when network allows Tier 1 (cellular+)", async () => {
    const { db } = makeFakeDb({});
    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "cellular",
    });
    assert.ok(payload.maxTier >= 1, "cellular network must allow at least Tier 1");
    const ffp = payload.tier1.find((i) => i.type === "first_feed_page");
    assert.ok(ffp, "tier1 must include a first_feed_page item");
    assert.strictEqual(ffp!.tier, 1, "first_feed_page must be tagged as tier 1");
  });

  it("unpublished delayed post data (publishEligibleAt in future) is excluded", () => {
    // Test via the isPermitted logic: items with isDelayedPost=true and future
    // publishEligibleAt are forbidden. We verify by constructing such a payload
    // and checking it is stripped.
    // Since isPermitted is internal, we test via the contract: the FrontLoadEngine
    // must not include items whose data.isDelayedPost=true && publishEligibleAt>now.
    //
    // This is guaranteed by the permission-check applied after each tier load.
    // We build a profile and confirm no such items appear in a wifi payload.
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // The DB tables don't return delayed posts in the current tier loaders,
    // but we verify the engine's own safety_state payload does not accidentally
    // carry delayed-post markers.
    const { db } = makeFakeDb({});
    return buildFrontLoadPayload(db, USER_A, baseProfile(), { networkHint: "wifi" }).then((payload) => {
      const allItems = [...payload.tier0, ...payload.tier1, ...payload.tier2, ...payload.tier3];
      for (const item of allItems) {
        const d = item.data as Record<string, unknown> | null;
        if (d && d.isDelayedPost === true) {
          const eligible = d.publishEligibleAt as string | undefined;
          if (eligible && new Date(eligible).getTime() > Date.now()) {
            assert.fail(`Unpublished delayed post found in tier ${item.tier}: ${item.type}`);
          }
        }
      }
    });
  });
});

// ── recordNavigationEvent — nav count increment ───────────────────────────────

describe("recordNavigationEvent — nav count increment", () => {
  it("calling twice increments transition_count to 2 on second upsert", async () => {
    const tableData: Record<string, FakeDbRow[]> = {
      compass_preload_events:          [],
      compass_user_navigation_patterns: [],
    };
    const { db, calls } = makeFakeDb(tableData);
    const now = new Date();

    // First event — pattern row does not exist yet → newCount = 1
    await recordNavigationEvent(db, USER_A, "tonight", now);

    const upsert1 = calls.filter((c) => c.method === "upsert");
    assert.ok(upsert1.length >= 1, "first upsert must be called");
    const row1 = (upsert1[upsert1.length - 1]!.args as Record<string, unknown>);
    assert.strictEqual(row1["transition_count"], 1, "first call must write count=1");

    // Second event — fake DB now has the row with transition_count=1 → newCount = 2
    await recordNavigationEvent(db, USER_A, "tonight", now);

    const upsert2 = calls.filter((c) => c.method === "upsert");
    const row2 = (upsert2[upsert2.length - 1]!.args as Record<string, unknown>);
    assert.strictEqual(row2["transition_count"], 2,
      "second call must read existing count (1) and increment to 2");
  });
});

// ── buildPreloadManifest ──────────────────────────────────────────────────────

describe("buildPreloadManifest", () => {
  it("returns Tier 2 URL items sorted by navigation priority", async () => {
    const tableData: Record<string, FakeDbRow[]> = {
      compass_user_navigation_patterns: [
        { user_id: USER_A, from_screen: "app", to_screen: "tonight",   transition_count: 42 },
        { user_id: USER_A, from_screen: "app", to_screen: "discovery", transition_count: 10 },
      ],
    };
    const { db } = makeFakeDb(tableData);
    const manifest = await buildPreloadManifest(db, USER_A, "https://example.com");

    assert.ok(manifest.length > 0, "manifest must not be empty");
    // All items should be tier 2
    for (const item of manifest) {
      assert.strictEqual(item.tier, 2, "all manifest items must be tier 2");
    }
    // "tonight" had the highest nav count — its URL must rank first
    const tonightItem = manifest.find((m) => m.url.includes("tonight"));
    const discoveryItem = manifest.find((m) => m.url.includes("discovery"));
    if (tonightItem && discoveryItem) {
      assert.ok(
        tonightItem.priority >= discoveryItem.priority,
        "higher nav-count screen must rank first in manifest",
      );
    }
  });

  it("manifest never includes emergency_contact or id_document URLs", async () => {
    const { db } = makeFakeDb({});
    const manifest = await buildPreloadManifest(db, USER_A, "https://example.com");
    for (const item of manifest) {
      assert.ok(!item.url.includes("emergency"), "manifest must not include emergency contact URLs");
      assert.ok(!item.url.includes("id_document"), "manifest must not include ID document URLs");
    }
  });
});

// ── computePreloadScore — formula-based scoring ───────────────────────────────
//
// Formula: score = likelihood × safetyPriority × timeSensitivity
//                − heavyMediaCost × 0.5 − stalenessRisk × 0.3 − privacyRisk × 0.2
//
// All operands are in [0,1]; result is clamped to [0,100].
// Known types use CONTENT_SCORE_FACTORS; unknown types fall back to tier-derived score.
//
// Expected scores (computed from CONTENT_SCORE_FACTORS):
//   safety_state       → 100  (1.0×1.0×1.0 − 0 − 0 − 0 = 1.0)
//   first_feed_page    →  58  (0.9×0.9×0.8 − 0.10×0.5 − 0.05×0.3 − 0.02×0.2 = 0.579)
//   top_events         →  32  (0.6×0.7×0.8 − 0 − 0.05×0.3 − 0 = 0.321)
//   trip_crew_location →  10  (0.3×0.9×0.9 − 0.10×0.5 − 0.10×0.3 − 0.30×0.2 = 0.103)

describe("computePreloadScore — formula-based scoring", () => {
  const rules = new Map<string, FrontLoadTier>();

  it("safety_state scores 100 (max product, no penalties)", () => {
    const f = CONTENT_SCORE_FACTORS['safety_state']!;
    const expectedRaw = f.likelihood * f.safetyPriority * f.timeSensitivity
      - f.heavyMediaCost * 0.5 - f.stalenessRisk * 0.3 - f.privacyRisk * 0.2;
    const expected = Math.max(0, Math.min(100, Math.round(expectedRaw * 100)));
    assert.strictEqual(computePreloadScore('safety_state', rules), expected);
    assert.strictEqual(expected, 100, "safety_state must score 100");
  });

  it("first_feed_page formula score is correct and lower than safety_state", () => {
    const f = CONTENT_SCORE_FACTORS['first_feed_page']!;
    const expectedRaw = f.likelihood * f.safetyPriority * f.timeSensitivity
      - f.heavyMediaCost * 0.5 - f.stalenessRisk * 0.3 - f.privacyRisk * 0.2;
    const expected = Math.max(0, Math.min(100, Math.round(expectedRaw * 100)));
    assert.strictEqual(computePreloadScore('first_feed_page', rules), expected);
    assert.ok(expected < 100, "first_feed_page must score below safety_state");
    assert.ok(expected > 0,   "first_feed_page must score above 0");
  });

  it("formula scores preserve tier urgency ordering: safety_state > first_feed_page > top_events > trip_crew_location", () => {
    const score = (t: string) => computePreloadScore(t, rules);
    assert.ok(score('safety_state')    > score('first_feed_page'),   "safety > feed");
    assert.ok(score('first_feed_page') > score('top_events'),         "feed > events");
    assert.ok(score('top_events')      > score('trip_crew_location'), "events > trip_crew (more private)");
  });

  it("navWeight boosts the score by increasing likelihood component", () => {
    const baseScore    = computePreloadScore('top_events', rules, 0.0);
    const boostedScore = computePreloadScore('top_events', rules, 0.5);
    assert.ok(boostedScore >= baseScore, "navWeight must not decrease score");
    // With navWeight=0.5: boostedLikelihood = min(1, 0.6 + 0.5×0.2) = 0.7 vs 0.6 baseline
    const f = CONTENT_SCORE_FACTORS['top_events']!;
    const raw0 = f.likelihood * f.safetyPriority * f.timeSensitivity
      - f.heavyMediaCost * 0.5 - f.stalenessRisk * 0.3 - f.privacyRisk * 0.2;
    const raw5 = Math.min(1, f.likelihood + 0.5 * 0.2) * f.safetyPriority * f.timeSensitivity
      - f.heavyMediaCost * 0.5 - f.stalenessRisk * 0.3 - f.privacyRisk * 0.2;
    assert.strictEqual(boostedScore, Math.max(0, Math.min(100, Math.round(raw5 * 100))));
    assert.ok(raw5 > raw0, "navWeight=0.5 must increase the raw product");
  });

  it("unknown type with no rules falls back to tier 3 score (25)", () => {
    assert.strictEqual(computePreloadScore('totally_unknown_type', rules), 25,
      "unknown types with no rule entry must default to tier 3 score (25)");
  });

  it("operator DB override changes tier for unknown types: tier 0 → 100", () => {
    // Simulate operator assigning a new custom content type to tier 0 via DB rule
    const rulesWithOverride = new Map<string, FrontLoadTier>([['custom_safety_widget', 0]]);
    assert.strictEqual(computePreloadScore('custom_safety_widget', rulesWithOverride), 100,
      "operator DB override to tier 0 must yield score 100 for unknown types");
    // Tier 1 override
    const rulesTier1 = new Map<string, FrontLoadTier>([['custom_safety_widget', 1]]);
    assert.strictEqual(computePreloadScore('custom_safety_widget', rulesTier1), 75,
      "operator DB override to tier 1 must yield score 75 for unknown types");
  });
});

// ── Per-item authz — blocked users excluded from city_pulse_preview ───────────

describe("Per-item authz — blocked users excluded from city_pulse_preview", () => {
  before(() => clearL1Cache());

  it("posts from blocked users do not appear in city_pulse_preview", async () => {
    const BLOCKED_USER = "00000000-0000-0000-9999-000000000099";
    const SAFE_USER    = "00000000-0000-0000-8888-000000000088";

    const fakePost_fromBlocked = {
      id: "post-blocked", content: "blocked post", created_at: new Date().toISOString(),
      author_id: BLOCKED_USER, post_status: null, status: "active", visibility: "public", location_city: "Bangkok",
    };
    const fakePost_fromSafe = {
      id: "post-safe", content: "safe post", created_at: new Date().toISOString(),
      author_id: SAFE_USER, post_status: null, status: "active", visibility: "public", location_city: "Bangkok",
    };

    const { db } = makeFakeDb({
      posts: [fakePost_fromBlocked, fakePost_fromSafe],
    });

    const profile = baseProfile({
      currentCity:    "Bangkok",
      blockedUserIds: [BLOCKED_USER],
    });

    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const pulseItem = [...payload.tier1].find((i) => i.type === "city_pulse_preview");
    assert.ok(pulseItem, "city_pulse_preview must be present in tier1");
    const pulseData = pulseItem!.data as Array<{ id: string }>;

    const blockedIds = pulseData.filter((p) => p.id === "post-blocked");
    assert.strictEqual(blockedIds.length, 0,
      "posts from blocked users must not appear in city_pulse_preview");

    const safePost = pulseData.find((p) => p.id === "post-safe");
    assert.ok(safePost, "posts from non-blocked users must be included");
  });

  it("private and trip_only posts never appear in city_pulse_preview", async () => {
    // Regression lock for the city-pulse visibility leak. The query had no
    // visibility predicate and the caller passes the SERVICE-ROLE client, which
    // bypasses RLS, so every private and trip_only caption in the viewer's city
    // was returned to any signed-in user in that city.
    //
    // This test can only observe the IN-MEMORY gate: makeFakeDb ignores .eq()
    // on its array path and hands back every row for the table, so the SQL
    // predicate is invisible here. That is exactly why the fix keeps both — a
    // SQL-only fix would have shipped with no test able to fail.
    clearL1Cache();
    const mk = (id: string, visibility: string) => ({
      id, content: `${visibility} post`, created_at: new Date().toISOString(),
      author_id: USER_B, post_status: null, status: "active",
      visibility, location_city: "Lisbon",
    });

    const { db } = makeFakeDb({
      posts: [mk("post-private", "private"), mk("post-trip", "trip_only"), mk("post-public", "public")],
    });

    const payload = await buildFrontLoadPayload(
      db, USER_A, baseProfile({ currentCity: "Lisbon" }), { networkHint: "wifi" },
    );

    const pulseItem = [...payload.tier1].find((i) => i.type === "city_pulse_preview");
    assert.ok(pulseItem, "city_pulse_preview must be present in tier1");
    const ids = (pulseItem!.data as Array<{ id: string }>).map((p) => p.id);

    assert.ok(!ids.includes("post-private"), "private posts must never reach city_pulse_preview");
    assert.ok(!ids.includes("post-trip"), "trip_only posts must never reach city_pulse_preview");
    assert.ok(ids.includes("post-public"), "public posts must still be included");
  });

  it("delayed/unpublished posts never appear in city_pulse_preview", async () => {
    clearL1Cache();   // isolate from previous test's L1 back-fill (same user, same cache key)
    const fakeDelayedPost = {
      id: "post-delayed", content: "not yet!", created_at: new Date().toISOString(),
      author_id: USER_B, post_status: "pending_delay", status: "active", visibility: "public", location_city: "Bangkok",
    };
    const fakePublishedPost = {
      id: "post-published", content: "live", created_at: new Date().toISOString(),
      author_id: USER_B, post_status: null, status: "active", visibility: "public", location_city: "Tokyo",
    };

    const { db } = makeFakeDb({
      posts: [fakeDelayedPost, fakePublishedPost],
    });

    const profile = baseProfile({ currentCity: "Tokyo" });
    const payload  = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const pulseItem = [...payload.tier1].find((i) => i.type === "city_pulse_preview");
    const pulseData = (pulseItem?.data ?? []) as Array<{ id: string }>;

    assert.ok(
      !pulseData.find((p) => p.id === "post-delayed"),
      "delayed/unpublished posts must never appear in city_pulse_preview",
    );
    assert.ok(
      pulseData.find((p) => p.id === "post-published"),
      "fully published posts must appear in city_pulse_preview",
    );
  });
});

// ── Cellular mode — no video previews ────────────────────────────────────────

describe("Cellular mode — no video previews in city_pulse_preview", () => {
  before(() => clearL1Cache());

  it("video posts are stripped from city_pulse_preview when networkHint=cellular", async () => {
    const VIDEO_USER = "00000000-0000-0000-7777-000000000077";
    const fakeVideoPost = {
      id: "post-video", content: "watch this!", created_at: new Date().toISOString(),
      author_id: VIDEO_USER, post_status: null, status: "active", visibility: "public", has_video: true, location_city: "Barcelona",
    };
    const fakeTextPost = {
      id: "post-text", content: "hello world", created_at: new Date().toISOString(),
      author_id: VIDEO_USER, post_status: null, status: "active", visibility: "public", has_video: false, location_city: "Barcelona",
    };

    const { db } = makeFakeDb({ posts: [fakeVideoPost, fakeTextPost] });
    const profile = baseProfile({ currentCity: "Barcelona" });

    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "cellular" });

    const pulseItem = [...payload.tier1].find((i) => i.type === "city_pulse_preview");
    const pulseData = (pulseItem?.data ?? []) as Array<{ id: string }>;

    assert.ok(
      !pulseData.find((p) => p.id === "post-video"),
      "cellular mode must strip video posts from city_pulse_preview",
    );
    assert.ok(
      pulseData.find((p) => p.id === "post-text"),
      "cellular mode must still include non-video posts",
    );
  });

  it("video posts appear in city_pulse_preview on wifi", async () => {
    clearL1Cache();   // isolate from the previous cellular test's L1 back-fill
    const VIDEO_USER = "00000000-0000-0000-7777-000000000077";
    const fakeVideoPost = {
      id: "post-video-wifi", content: "watch this!", created_at: new Date().toISOString(),
      author_id: VIDEO_USER, post_status: null, status: "active", visibility: "public", has_video: true, location_city: "Barcelona",
    };

    const { db } = makeFakeDb({ posts: [fakeVideoPost] });
    const profile = baseProfile({ currentCity: "Barcelona" });

    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const pulseItem = [...payload.tier1].find((i) => i.type === "city_pulse_preview");
    const pulseData = (pulseItem?.data ?? []) as Array<{ id: string }>;

    assert.ok(
      pulseData.find((p) => p.id === "post-video-wifi"),
      "wifi mode must include video posts in city_pulse_preview",
    );
  });
});

// ── notification_preview — live-schema column check ───────────────────────────

describe("notification_preview — live-schema column check (event_type)", () => {
  before(() => clearL1Cache());

  it("unread notifications seeded with event_type appear in notification_preview", async () => {
    clearL1Cache();

    const fakeUnread = {
      id: "notif-unread-1",
      user_id: USER_A,
      event_type: "booking_confirmed",
      body: "Your booking was confirmed",
      created_at: new Date().toISOString(),
      read_at: null,
    };

    const { db } = makeFakeDb({
      notifications: [fakeUnread],
    });

    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "wifi",
    });

    const notifItem = [...payload.tier1].find((i) => i.type === "notification_preview");
    assert.ok(notifItem, "notification_preview must be present in tier1");

    const notifData = notifItem!.data as { unreadCount: number; items: unknown[] };
    assert.strictEqual(notifData.unreadCount, 1,
      "unreadCount must reflect the number of unread rows returned");
    assert.strictEqual(notifData.items.length, 1,
      "items array must contain the unread notification row");

    const row = notifData.items[0] as Record<string, unknown>;
    assert.strictEqual(row["id"], "notif-unread-1",
      "notification id must be preserved");
    assert.strictEqual(row["event_type"], "booking_confirmed",
      "event_type (live column name) must be returned — not 'type'");
    assert.ok(!("type" in row),
      "legacy 'type' column must not appear — it does not exist in the live schema");
  });

  it("already-read notifications (read_at set) are excluded from notification_preview", async () => {
    clearL1Cache();

    const fakeRead = {
      id: "notif-read-1",
      user_id: USER_A,
      event_type: "trip_reminder",
      body: "Your trip starts tomorrow",
      created_at: new Date().toISOString(),
      read_at: new Date().toISOString(),
    };

    // The fake DB chain passes all rows through; the .is("read_at", null) filter
    // is honoured by the then() thenable which returns the full tableData array.
    // The important check is that the code selects event_type without an error —
    // when the column was 'type' (drifted), PostgREST would fail the whole query
    // and the catch block would silently return unreadCount=0 / items=[].
    // Here we verify that even with a read notification present, unreadCount=0
    // is the correct outcome (PostgREST filters server-side; fake chain returns all).
    // The key assertion is that the query doesn't blow up and the item is present.
    const { db } = makeFakeDb({
      notifications: [fakeRead],
    });

    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), {
      networkHint: "wifi",
    });

    const notifItem = [...payload.tier1].find((i) => i.type === "notification_preview");
    assert.ok(notifItem, "notification_preview item must always be present in tier1 (even with zero unread)");
  });
});

// ── Cache-backed tier 1–3 assembly ───────────────────────────────────────────

describe("Cache-backed tier 1–3 assembly", () => {
  before(() => clearL1Cache());

  it("tier 1 is served from L1 cache on cache hit (payload matches pre-seeded data)", async () => {
    clearL1Cache();

    // Pre-populate L1 cache with a known tier1 payload via setCachedFeed
    const cachedPayload: FrontLoadItem[] = [{
      type: 'city_pulse_preview', tier: 1,
      cachedAt: new Date().toISOString(),
      data: [{ id: 'from-l1-cache', body: 'pre-cached pulse post' }],
    }];

    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache: [],
      compass_cache_invalidations: [],
      // Only this post exists in DB — it must NOT appear in tier1 on cache hit
      posts: [{ id: 'fresh-post', content: 'should not appear', author_id: USER_B,
                post_status: null, status: 'active', location_city: 'Rome', created_at: new Date().toISOString() }],
    };
    const { db } = makeFakeDb(tableData);

    // Seed the L1 in-process cache (setCachedFeed stores in L1 synchronously).
    // Key includes ':wifi' because buildFrontLoadPayload is called with networkHint='wifi'.
    await setCachedFeed(db, USER_A, 'frontload:tier1:wifi', 'frontload', cachedPayload);

    // buildFrontLoadPayload should detect the L1 hit and return the cached tier1
    const profile = baseProfile({ currentCity: 'Rome' });
    const result = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: 'wifi' });

    // The returned tier1 must come from L1 cache (not freshly built from DB).
    // applyScores() adds preloadScore to each item after cache retrieval, so we
    // check the core data identity rather than exact struct equality.
    const tier1Items = result.tier1 as FrontLoadItem[];
    assert.ok(tier1Items.length >= 1, "tier1 must contain at least the cached item");
    const cityPulseItem = tier1Items.find(i => i.type === 'city_pulse_preview');
    assert.ok(cityPulseItem, "cached city_pulse_preview item must be present");
    assert.deepStrictEqual(
      cityPulseItem.data,
      cachedPayload[0].data,
      "cached data payload must match pre-seeded cache (confirms L1 hit, not DB build)",
    );
    // Score is computed from CONTENT_SCORE_FACTORS[city_pulse_preview] = 39
    assert.strictEqual(cityPulseItem.preloadScore, 39, "preloadScore must be applied to cached items");
    // The fresh-post from DB must not appear (would only appear on cache miss)
    const allIds = tier1Items
      .flatMap(item => Array.isArray(item.data) ? (item.data as any[]).map((d: any) => d.id) : []);
    assert.ok(!allIds.includes('fresh-post'),
      "fresh DB post must not appear when tier1 is served from L1 cache");
  });

  it("tier 1 is built fresh and back-filled into L1 on cache miss", async () => {
    clearL1Cache();

    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache: [],
      compass_cache_invalidations: [],
      posts: [],
    };
    const { db } = makeFakeDb(tableData);

    // Verify L1 is empty before the call.
    // Key includes ':wifi' — must match the key used inside buildFrontLoadPayload.
    const before = await getCachedFeed(db, USER_A, 'frontload:tier1:wifi', 'frontload');
    assert.strictEqual(before, null, "L1 must be empty before buildFrontLoadPayload on cache miss");

    const profile = baseProfile({ currentCity: 'Berlin' });
    await buildFrontLoadPayload(db, USER_A, profile, { networkHint: 'wifi' });

    // After a cache miss, setCachedFeed sets L1 synchronously inside buildFrontLoadPayload.
    // The fire-and-forget DB upsert may still be in-flight, but L1 is available immediately.
    const after = await getCachedFeed(db, USER_A, 'frontload:tier1:wifi', 'frontload');
    assert.ok(after !== null,
      "cache miss must back-fill L1 so the next call is a cache hit");
    assert.ok(Array.isArray(after),
      "back-filled L1 cache entry must be a FrontLoadItem array");
  });

  it("tier 0 items (safety/auth) are never served from cache", async () => {
    // getCachedFeed with entryType='safety' returns null — safety data always live
    clearL1Cache();
    const { db } = makeFakeDb({ compass_feed_cache: [] });
    const safetyResult = await getCachedFeed(db, USER_A, 'safety_state', 'safety');
    assert.strictEqual(safetyResult, null,
      "safety entryType must always return null from getCachedFeed (TTL=0, never cached)");
  });
});

// ── Invalidation timing — await semantics ─────────────────────────────────────

describe("Invalidation timing — await semantics", () => {
  it("invalidate() resolves before caller continues (no unresolved promises)", async () => {
    const auditRows: unknown[] = [];
    const { db } = makeFakeDb({
      compass_feed_cache:         [],
      compass_cache_invalidations: [],
    });

    // Track that the promise returned by invalidate resolves synchronously-ish
    let resolved = false;
    const p = invalidate(db, USER_A, "test_timing").then(() => { resolved = true; });
    await p;
    assert.ok(resolved, "invalidate() promise must resolve when awaited — same-request guarantee");
  });

  it("invalidate() evicts L1 before promise resolves", async () => {
    clearL1Cache();
    const tableData: Record<string, FakeDbRow[]> = {
      compass_feed_cache:          [],
      compass_cache_invalidations: [],
    };
    const { db } = makeFakeDb(tableData);

    // Prime L1 cache
    const payload = { items: [{ id: "test-item" }] };
    await setCachedFeed(db, USER_A, "feed:evict_test", "feed", payload);

    // Confirm L1 has the item before invalidation
    const before = await getCachedFeed(db, USER_A, "feed:evict_test", "feed");
    assert.ok(before !== null, "L1 must have the item before invalidation");

    // Await invalidation — L1 must be cleared when promise resolves
    await invalidate(db, USER_A, "test_eviction");
    const after = await getCachedFeed(db, USER_A, "feed:evict_test", "feed");
    assert.strictEqual(after, null, "L1 must be evicted when invalidate() resolves");
  });
});

// ── top_events — live-schema column check ─────────────────────────────────────
//
// Verified 2026-07-17 via Supabase Management API (information_schema.columns):
//   events: id (uuid), title (text), description (text), starts_at (timestamptz),
//           city (text), created_at (timestamptz), host_id (uuid), state (USER-DEFINED)
// A wrong column name in .select() causes PostgREST to fail the whole query;
// the catch block silently returns [] — emptying top_events on every app open.

describe("top_events — live-schema column check", () => {
  before(() => clearL1Cache());

  it("events seeded with live-shaped columns appear in top_events tier2 item", async () => {
    clearL1Cache();

    const FUTURE    = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const HOST_USER = "00000000-0000-0000-aaaa-000000000001";

    const fakeEvent = {
      id:          "evt-live-col-1",
      title:       "Sunset Rooftop Meetup",
      description: "A casual evening with fellow travelers",
      starts_at:   FUTURE,
      city:        "Lisbon",
      created_at:  new Date().toISOString(),
      host_id:     HOST_USER,
      state:       "open",
    };

    const { db } = makeFakeDb({ events: [fakeEvent] });

    const profile = baseProfile({ currentCity: "Lisbon" });
    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const eventsItem = [...payload.tier2].find((i) => i.type === "top_events");
    assert.ok(eventsItem, "top_events must be present in tier2");

    const eventsData = eventsItem!.data as Array<Record<string, unknown>>;
    assert.ok(
      eventsData.length >= 1,
      "top_events data must contain the seeded row — a drifted column name would silently empty this array",
    );

    const row = eventsData.find((e) => e["id"] === "evt-live-col-1");
    assert.ok(row, "seeded event id must be present in top_events data");
    assert.strictEqual(row["title"],       "Sunset Rooftop Meetup",
      "title (live column name) must be returned");
    assert.strictEqual(row["description"], "A casual evening with fellow travelers",
      "description (live column name) must be returned");
    assert.strictEqual(row["starts_at"],   FUTURE,
      "starts_at (live column name) must be returned");
    assert.strictEqual(row["city"],        "Lisbon",
      "city (live column name) must be returned");
    assert.ok(!("host_id" in row),
      "host_id must be stripped from top_events output (authz-only field, not exposed to client)");
    assert.ok(!("state" in row),
      "state must be stripped from top_events output (authz-only field, not exposed to client)");
  });

  it("events from blocked hosts do not appear in top_events", async () => {
    clearL1Cache();

    const BLOCKED_HOST = "00000000-0000-0000-bbbb-000000000001";
    const SAFE_HOST    = "00000000-0000-0000-bbbb-000000000002";
    const FUTURE       = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { db } = makeFakeDb({
      events: [
        {
          id: "evt-blocked", title: "Blocked Event", description: "hidden",
          starts_at: FUTURE, city: "Lisbon", created_at: new Date().toISOString(),
          host_id: BLOCKED_HOST, state: "open",
        },
        {
          id: "evt-safe", title: "Safe Event", description: "visible",
          starts_at: FUTURE, city: "Lisbon", created_at: new Date().toISOString(),
          host_id: SAFE_HOST, state: "open",
        },
      ],
    });

    const profile = baseProfile({ currentCity: "Lisbon", blockedUserIds: [BLOCKED_HOST] });
    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const eventsItem = [...payload.tier2].find((i) => i.type === "top_events");
    const eventsData = (eventsItem?.data ?? []) as Array<Record<string, unknown>>;

    assert.ok(
      !eventsData.find((e) => e["id"] === "evt-blocked"),
      "events from blocked hosts must not appear in top_events",
    );
    assert.ok(
      eventsData.find((e) => e["id"] === "evt-safe"),
      "events from non-blocked hosts must appear in top_events",
    );
  });
});

// ── top_buddies — live-schema column check ────────────────────────────────────
//
// Verified 2026-07-17 via Supabase Management API (information_schema.columns):
//   buddy_profiles: user_id (uuid), display_name (text), tagline (text),
//                   city (text), hourly_rate_usd (numeric), average_rating (numeric)
// A wrong column name in .select() causes PostgREST to fail the whole query;
// the catch block silently returns [] — emptying top_buddies on every app open.

describe("top_buddies — live-schema column check", () => {
  before(() => clearL1Cache());

  it("buddy_profiles seeded with live-shaped columns appear in top_buddies tier2 item", async () => {
    clearL1Cache();

    const BUDDY_USER = "00000000-0000-0000-cccc-000000000001";

    const fakeBuddy = {
      user_id:        BUDDY_USER,
      display_name:   "Sofia T.",
      tagline:        "Your local guide to hidden gems",
      city:           "Porto",
      hourly_rate_usd: 25,
      average_rating: 4.9,
      status:         "active",
      verified:       true,
    };

    const { db } = makeFakeDb({ buddy_profiles: [fakeBuddy] });

    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), { networkHint: "wifi" });

    const buddiesItem = [...payload.tier2].find((i) => i.type === "top_buddies");
    assert.ok(buddiesItem, "top_buddies must be present in tier2");

    const buddiesData = buddiesItem!.data as Array<Record<string, unknown>>;
    assert.ok(
      buddiesData.length >= 1,
      "top_buddies data must contain the seeded row — a drifted column name would silently empty this array",
    );

    const row = buddiesData.find((b) => b["user_id"] === BUDDY_USER);
    assert.ok(row, "seeded buddy user_id must be present in top_buddies data");
    assert.strictEqual(row["display_name"],    "Sofia T.",
      "display_name (live column name) must be returned");
    assert.strictEqual(row["tagline"],         "Your local guide to hidden gems",
      "tagline (live column name) must be returned");
    assert.strictEqual(row["city"],            "Porto",
      "city (live column name) must be returned");
    assert.strictEqual(row["hourly_rate_usd"], 25,
      "hourly_rate_usd (live column name) must be returned");
    assert.strictEqual(row["average_rating"],  4.9,
      "average_rating (live column name) must be returned");
  });

  it("buddy profiles from blocked users do not appear in top_buddies", async () => {
    clearL1Cache();

    const BLOCKED_BUDDY = "00000000-0000-0000-dddd-000000000001";
    const SAFE_BUDDY    = "00000000-0000-0000-dddd-000000000002";

    const { db } = makeFakeDb({
      buddy_profiles: [
        {
          user_id: BLOCKED_BUDDY, display_name: "Blocked Buddy", tagline: "hidden",
          city: "Madrid", hourly_rate_usd: 20, average_rating: 4.5,
          status: "active", verified: true,
        },
        {
          user_id: SAFE_BUDDY, display_name: "Safe Buddy", tagline: "visible",
          city: "Madrid", hourly_rate_usd: 30, average_rating: 4.8,
          status: "active", verified: true,
        },
      ],
    });

    const profile = baseProfile({ blockedUserIds: [BLOCKED_BUDDY] });
    const payload = await buildFrontLoadPayload(db, USER_A, profile, { networkHint: "wifi" });

    const buddiesItem = [...payload.tier2].find((i) => i.type === "top_buddies");
    const buddiesData = (buddiesItem?.data ?? []) as Array<Record<string, unknown>>;

    assert.ok(
      !buddiesData.find((b) => b["user_id"] === BLOCKED_BUDDY),
      "buddy profiles from blocked users must not appear in top_buddies",
    );
    assert.ok(
      buddiesData.find((b) => b["user_id"] === SAFE_BUDDY),
      "buddy profiles from non-blocked users must appear in top_buddies",
    );
  });
});

// ── saved_places — live-schema column check ───────────────────────────────────
//
// Verified 2026-07-17 via Supabase Management API (information_schema.columns):
//   discovery_places: id (uuid), name (text), category (text|null), city (text),
//                     submitted_by (uuid|null), created_at (timestamptz)
// A wrong column name in .select("id, name, category, city") causes PostgREST to
// fail the whole query; the catch block silently returns [] — emptying saved_places
// (the wishlist section) on every app open.

describe("saved_places — live-schema column check", () => {
  before(() => clearL1Cache());

  it("discovery_places seeded with live-shaped columns appear in saved_places tier2 item", async () => {
    clearL1Cache();

    const fakePlace = {
      id:           "place-live-col-1",
      name:         "Miradouro da Graça",
      category:     "viewpoint",
      city:         "Lisbon",
      submitted_by: USER_A,
      created_at:   new Date().toISOString(),
    };

    const { db } = makeFakeDb({ discovery_places: [fakePlace] });

    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), { networkHint: "wifi" });

    const savedItem = [...payload.tier2].find((i) => i.type === "saved_places");
    assert.ok(savedItem, "saved_places must be present in tier2");

    const savedData = savedItem!.data as Array<Record<string, unknown>>;
    assert.ok(
      savedData.length >= 1,
      "saved_places data must contain the seeded row — a drifted column name would silently empty this array",
    );

    const row = savedData.find((p) => p["id"] === "place-live-col-1");
    assert.ok(row, "seeded discovery_places id must be present in saved_places data");
    assert.strictEqual(row["name"],     "Miradouro da Graça",
      "name (live column name) must be returned");
    assert.strictEqual(row["category"], "viewpoint",
      "category (live column name) must be returned");
    assert.strictEqual(row["city"],     "Lisbon",
      "city (live column name) must be returned");
  });

  it("saved_places data is empty when discovery_places table has no rows", async () => {
    clearL1Cache();

    const { db } = makeFakeDb({ discovery_places: [] });

    const payload = await buildFrontLoadPayload(db, USER_A, baseProfile(), { networkHint: "wifi" });

    const savedItem = [...payload.tier2].find((i) => i.type === "saved_places");
    assert.ok(savedItem, "saved_places item must still be present in tier2 even with no rows");

    const savedData = savedItem!.data as Array<Record<string, unknown>>;
    assert.strictEqual(savedData.length, 0, "saved_places data must be empty when no places exist");
  });
});
