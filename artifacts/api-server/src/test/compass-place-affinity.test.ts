/**
 * compass-place-affinity.test.ts
 *
 * Confirms that place-affinity context injected by CompassFeedBuilder flows
 * through to CompassScoringEngine so items whose canonical place the viewer
 * has recently visited rank higher in the Compass feed.
 *
 * Specifically:
 *   A. A place item scores higher when the viewer has ≥ 2 place_view events
 *      for its placeId (≥ PLACE_AFFINITY_THRESHOLD → ×1.15 boost fires).
 *   B. A place item scores the same without affinity (boost is absent).
 *   C. A place item below the threshold does NOT receive the boost.
 *   D. An item without placeId is unaffected even when placeAffinities is
 *      populated for other place IDs.
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-place-affinity.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scoreItem } from "../compass/CompassScoringEngine.js";
import { buildFeed, buildSection } from "../compass/CompassFeedBuilder.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VIEWER_ID = "00000000-0000-0000-0000-000000000001";
const PLACE_ID  = "place-tokyo-shibuya";

/** Threshold that must be met to earn the ×1.15 boost (mirrors the engine constant). */
const THRESHOLD = 2;
/** Expected multiplier when the boost fires. */
const BOOST = 1.15;

function baseProfile(): CompassProfile {
  return {
    userId:                VIEWER_ID,
    preferredCities:       ["Tokyo"],
    preferredLanguages:    ["en"],
    budgetStyle:           null,
    travelStyles:          ["culture"],
    socialStyle:           null,
    safetyPreference:      "standard",
    visibilityPreference:  "semi_private",
    blockedUserIds:        [],
    blockerUserIds:        [],
    mutedUserIds:          [],
    blockCount:            0,
    blockerCount:          0,
    trustScore:            80,
    trustLevel:            "trusted_traveler",
    activeUserScore:       null,
    hasActiveTrip:         false,
    hasActiveBooking:      false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:           "Tokyo",
    currentCountry:        "Japan",
    safeReturnActive:      false,
    computedAt:            new Date().toISOString(),
    categoryWeights:       null,
    ignoredItemIds:        [],
    mutedHashtags:         [],
  };
}

function baseContext(placeAffinities?: Record<string, number>): CompassContext {
  return {
    contextState: "exploring_now",
    signals: {
      hourUtc:                9,
      safeReturnActive:       false,
      activeBooking:          false,
      upcomingTripWithin48h:  false,
      activeTripNow:          false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt:      new Date().toISOString(),
    placeAffinities,
  };
}

/** A minimal stamp item tied to PLACE_ID. */
function placeItem(overrides: Partial<CompassItem> = {}): CompassItem {
  return {
    id:           "stamp-001",
    type:         "stamp",
    placeId:      PLACE_ID,
    city:         "Tokyo",
    languageCode: "en",
    qualityScore: 7,
    interestTags: ["culture"],
    createdAt:    new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Compass place-affinity boost", () => {
  it("A: fires ×1.15 when viewer has ≥ threshold views for the item's placeId", () => {
    const item    = placeItem();
    const profile = baseProfile();
    const ctxNone = baseContext();                                   // no affinities
    const ctxWith = baseContext({ [PLACE_ID]: THRESHOLD });         // exactly at threshold

    const scoreWithout = scoreItem(item, profile, ctxNone, null).finalScore;
    const scoreWith    = scoreItem(item, profile, ctxWith, null).finalScore;

    assert.ok(
      scoreWith > scoreWithout,
      `Expected affinity boost to increase score: ${scoreWith} should be > ${scoreWithout}`,
    );
    // Verify the multiplier is approximately ×1.15 (within floating-point tolerance).
    assert.ok(
      Math.abs(scoreWith / scoreWithout - BOOST) < 0.001,
      `Expected score ratio ≈ ${BOOST}, got ${scoreWith / scoreWithout}`,
    );
  });

  it("B: score without affinity is unchanged (no placeAffinities key)", () => {
    const item    = placeItem();
    const profile = baseProfile();
    const ctxA    = baseContext();
    const ctxB    = baseContext();

    const s1 = scoreItem(item, profile, ctxA, null).finalScore;
    const s2 = scoreItem(item, profile, ctxB, null).finalScore;

    assert.strictEqual(s1, s2, "Two identical contexts with no affinities must yield the same score");
  });

  it("C: boost does NOT fire when view count is below threshold", () => {
    const item     = placeItem();
    const profile  = baseProfile();
    const ctxNone  = baseContext();
    const ctxLow   = baseContext({ [PLACE_ID]: THRESHOLD - 1 });    // one below threshold

    const scoreNone = scoreItem(item, profile, ctxNone, null).finalScore;
    const scoreLow  = scoreItem(item, profile, ctxLow,  null).finalScore;

    assert.strictEqual(
      scoreNone, scoreLow,
      `Below-threshold affinity must not change score: ${scoreLow} should equal ${scoreNone}`,
    );
  });

  it("D: item without placeId is unaffected even when placeAffinities is populated", () => {
    const itemNoPlace = placeItem({ placeId: undefined });
    const profile     = baseProfile();
    const ctxNone     = baseContext();
    const ctxWith     = baseContext({ [PLACE_ID]: THRESHOLD + 10 });

    const scoreNone = scoreItem(itemNoPlace, profile, ctxNone, null).finalScore;
    const scoreWith = scoreItem(itemNoPlace, profile, ctxWith, null).finalScore;

    assert.strictEqual(
      scoreNone, scoreWith,
      `Item without placeId must not be affected by placeAffinities: ${scoreWith} vs ${scoreNone}`,
    );
  });
});

// ── Integration: boost flows end-to-end through buildSection ──────────────────

describe("Compass place-affinity boost — buildSection integration", () => {
  it("F: a place item with affinity ranks above a baseline item of equal quality in the section", async () => {
    const AFFINITY_PLACE_ID = "uuid-affinity-place-002";

    /** Item with a placeId the viewer has affinity for. */
    const affinityItem: CompassItem = {
      id:              "section-item-with-affinity",
      type:            "stamp",
      placeId:         AFFINITY_PLACE_ID,
      city:            "Tokyo",
      languageCode:    "en",
      qualityScore:    5,
      interestTags:    ["culture"],
      createdAt:       new Date().toISOString(),
      visibilityScope: "public",
    };

    /** Identical item but tied to an unvisited place — should rank lower. */
    const baselineItem: CompassItem = {
      id:              "section-item-without-affinity",
      type:            "stamp",
      placeId:         "uuid-unvisited-place-888",
      city:            "Tokyo",
      languageCode:    "en",
      qualityScore:    5,
      interestTags:    ["culture"],
      createdAt:       new Date().toISOString(),
      visibilityScope: "public",
    };

    const profile = baseProfile();
    const ctx     = baseContext();

    // stamp items are routed to "passport_stamp_opportunities"
    const result = await buildSection(
      "passport_stamp_opportunities",
      [baselineItem, affinityItem],
      profile,
      ctx,
      null,   // no real DB
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        // Inject affinity at threshold — bypasses the DB call
        placeAffinities:   { [AFFINITY_PLACE_ID]: THRESHOLD },
      },
    );

    const { items } = result.section;

    // Both items must appear in the section
    const affinityIdx  = items.findIndex((i) => i.item.id === "section-item-with-affinity");
    const baselineIdx  = items.findIndex((i) => i.item.id === "section-item-without-affinity");

    assert.ok(affinityIdx  !== -1, "Affinity item must appear in section output");
    assert.ok(baselineIdx  !== -1, "Baseline item must appear in section output");

    // Affinity item must rank higher (lower index) than the baseline item
    assert.ok(
      affinityIdx < baselineIdx,
      `Affinity item (idx ${affinityIdx}) must rank above baseline item (idx ${baselineIdx}) ` +
      `when placeAffinities has ≥${THRESHOLD} views for its placeId`,
    );
  });
});

// ── Fake DB builder (table-aware) ─────────────────────────────────────────────

/**
 * Returns a minimal Supabase-compatible fake for test F.
 *
 * The fake is stateful: only the very first `from("rank_events")` call
 * (which is `buildPlaceAffinities`, called at the top of `runFeedPipeline`)
 * resolves with `placeViewRows`.  Every subsequent call — to `rank_events`
 * OR any other table — rejects.  This ensures:
 *
 *   • `buildPlaceAffinities` builds `{ [AFFINITY_PLACE_ID]: count }` from the
 *     mocked DB without relying on `_overrides.placeAffinities`.
 *   • The DiscoveryRankingService (DRS) pass, which also queries `rank_events`
 *     and would otherwise reorder the pool independently of Compass scores,
 *     fails fast into its own try/catch and leaves the Compass-scored order
 *     intact.
 *   • All other ancillary callers (feature-flag loader, creator-caps, fair-
 *     exposure preloads) also fail into their own guards and use safe defaults.
 */
function fakePlaceViewDb(placeViewRows: { item_id: string }[]): any {
  let rankEventsConsumed = false;

  /** Chain that resolves to the supplied rows. */
  function successChain(rows: { item_id: string }[]): any {
    const terminal = { data: rows, error: null };
    const c: any = {
      select:      () => c,
      insert:      () => c,
      upsert:      () => c,
      update:      () => c,
      delete:      () => c,
      eq:          () => c,
      neq:         () => c,
      gte:         () => c,
      gt:          () => c,
      lte:         () => c,
      lt:          () => c,
      in:          () => c,
      like:        () => c,
      ilike:       () => c,
      is:          () => c,
      order:       () => c,
      limit:       () => c,
      range:       () => c,
      single:      () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then(resolve?: (v: typeof terminal) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(terminal).then(resolve, reject);
      },
    };
    return c;
  }

  /** Chain that always rejects — ancillary callers (DRS, flags, caps) each have
   *  their own try/catch, so they fall back to safe defaults without crashing.
   *
   *  NOTE: all Supabase chain builder methods (including write paths like
   *  `insert`, `upsert`, `update`, `delete`) must be present.  A missing method
   *  throws a synchronous TypeError that can be swallowed by a caller's own
   *  try/catch (e.g. `scoreItem`'s catch-all returns finalScore=0), producing
   *  silent wrong results instead of a clean fail-soft.
   */
  function throwingChain(): any {
    const err = new Error("fake-db: table not available in test");
    const c: any = {
      select:      () => c,
      insert:      () => c,
      upsert:      () => c,
      update:      () => c,
      delete:      () => c,
      eq:          () => c,
      neq:         () => c,
      gte:         () => c,
      gt:          () => c,
      lte:         () => c,
      lt:          () => c,
      in:          () => c,
      like:        () => c,
      ilike:       () => c,
      is:          () => c,
      order:       () => c,
      limit:       () => c,
      range:       () => c,
      single:      () => Promise.reject(err),
      maybeSingle: () => Promise.reject(err),
      then(_resolve?: unknown, reject?: (e: unknown) => unknown) {
        return Promise.reject(err).then(undefined, reject);
      },
    };
    return c;
  }

  return {
    from(table: string) {
      if (table === "rank_events" && !rankEventsConsumed) {
        rankEventsConsumed = true;
        return successChain(placeViewRows);
      }
      return throwingChain();
    },
  };
}

// ── Integration: boost flows end-to-end through buildFeed ─────────────────────

describe("Compass place-affinity boost — buildFeed integration", () => {
  it("E: a place item with affinity ranks above a baseline item of equal quality in the feed", async () => {
    const AFFINITY_PLACE_ID = "uuid-affinity-place-001";

    /** Item with a placeId the viewer has affinity for. */
    const affinityItem: CompassItem = {
      id:           "item-with-affinity",
      type:         "stamp",
      placeId:      AFFINITY_PLACE_ID,
      city:         "Tokyo",
      languageCode: "en",
      qualityScore: 5,
      interestTags: ["culture"],
      createdAt:    new Date().toISOString(),
      visibilityScope: "public",
    };

    /** Identical item but with a different placeId the viewer has NOT visited. */
    const baselineItem: CompassItem = {
      id:           "item-without-affinity",
      type:         "stamp",
      placeId:      "uuid-unvisited-place-999",
      city:         "Tokyo",
      languageCode: "en",
      qualityScore: 5,
      interestTags: ["culture"],
      createdAt:    new Date().toISOString(),
      visibilityScope: "public",
    };

    const profile = baseProfile();
    const ctx     = baseContext();

    const result = await buildFeed(
      [baselineItem, affinityItem],
      profile,
      ctx,
      null,   // no real DB — placeAffinities injected via override below
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        // Inject affinity for AFFINITY_PLACE_ID at threshold — no DB call needed
        placeAffinities:   { [AFFINITY_PLACE_ID]: THRESHOLD },
      },
    );

    // Collect all items across all sections, sorted by their feed position
    const allItems = result.sections.flatMap((s) => s.items);

    const affinityIdx  = allItems.findIndex((i) => i.item.id === "item-with-affinity");
    const baselineIdx  = allItems.findIndex((i) => i.item.id === "item-without-affinity");

    // Both items must appear
    assert.ok(affinityIdx  !== -1, "Affinity item must appear in feed output");
    assert.ok(baselineIdx  !== -1, "Baseline item must appear in feed output");

    // Affinity item must appear before (lower index = higher rank) baseline item
    assert.ok(
      affinityIdx < baselineIdx,
      `Affinity item (idx ${affinityIdx}) must rank above baseline item (idx ${baselineIdx}) ` +
      `when placeAffinities has ≥${THRESHOLD} views for its placeId`,
    );
  });

  it("F: place-affinity boost fires end-to-end when buildPlaceAffinities reads from a mocked DB — no override bypass", async () => {
    const AFFINITY_PLACE_ID = "uuid-affinity-place-db-001";

    /** Item whose placeId the viewer has THRESHOLD place_view events for. */
    const affinityItem: CompassItem = {
      id:              "item-with-affinity-db",
      type:            "stamp",
      placeId:         AFFINITY_PLACE_ID,
      city:            "Tokyo",
      languageCode:    "en",
      qualityScore:    5,
      interestTags:    ["culture"],
      createdAt:       new Date().toISOString(),
      visibilityScope: "public",
    };

    /** Identical item but for a place the viewer has never visited. */
    const baselineItem: CompassItem = {
      id:              "item-without-affinity-db",
      type:            "stamp",
      placeId:         "uuid-unvisited-place-db-999",
      city:            "Tokyo",
      languageCode:    "en",
      qualityScore:    5,
      interestTags:    ["culture"],
      createdAt:       new Date().toISOString(),
      visibilityScope: "public",
    };

    // Fake DB: rank_events returns THRESHOLD rows for AFFINITY_PLACE_ID so
    // buildPlaceAffinities builds { [AFFINITY_PLACE_ID]: THRESHOLD }.
    // All other tables return empty rows — ancillary calls fail gracefully.
    const db = fakePlaceViewDb(
      Array.from({ length: THRESHOLD }, () => ({ item_id: AFFINITY_PLACE_ID })),
    );

    const profile = baseProfile();
    const ctx     = baseContext(); // no placeAffinities — must come from DB

    const result = await buildFeed(
      [baselineItem, affinityItem],
      profile,
      ctx,
      db as any,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        // No placeAffinities override — buildPlaceAffinities must query the fake DB
      },
    );

    const allItems    = result.sections.flatMap((s) => s.items);
    const affinityIdx = allItems.findIndex((i) => i.item.id === "item-with-affinity-db");
    const baselineIdx = allItems.findIndex((i) => i.item.id === "item-without-affinity-db");

    assert.ok(affinityIdx  !== -1, "Affinity item must appear in feed output");
    assert.ok(baselineIdx  !== -1, "Baseline item must appear in feed output");

    assert.ok(
      affinityIdx < baselineIdx,
      `Affinity item (idx ${affinityIdx}) must rank above baseline (idx ${baselineIdx}) ` +
      `when buildPlaceAffinities returns ≥${THRESHOLD} views for its placeId from the DB`,
    );
  });
});
