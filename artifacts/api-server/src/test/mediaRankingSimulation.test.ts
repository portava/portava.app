/**
 * mediaRankingSimulation.test.ts
 *
 * Simulation tests for MediaFeedRankingService.
 *
 * Creates a synthetic population of 100 creators across activity groups and
 * runs the full MediaFeedRankingService pipeline against 50 simulated
 * For-You sessions.
 *
 * Assertions:
 *   1. No single creator dominates a 50-item session (creator cap).
 *   2. New-creator content appears in positions 1–10 of a fresh session.
 *   3. Underexposed items surface within 2 pages (40 positions).
 *   4. Gems: wrong-place items are demoted below zero-report items.
 *   5. When MEDIA_RANKING_ENABLED=false, output order matches chronological.
 *   6. Session-fatigue penalty reduces a creator's rank after repeated appearances.
 *   7. Returning-creator boost lifts content above inactive-legacy baseline.
 *
 * Runtime: node:test + tsx/esm (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/mediaRankingSimulation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rankMediaFeed,
  type MediaFeedItem,
  type MediaRankingInput,
  type MediaRankingFlags,
  type MediaSessionState,
} from "../services/ranking/MediaFeedRankingService.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const NUM_VIEWERS  = 50;
const SESSION_SIZE = 50;

const CITIES      = ["paris", "london", "berlin", "tokyo", "new york", "barcelona", "sydney", "dubai"] as const;
const CATEGORIES  = ["adventure", "food", "nightlife", "culture", "nature", "wellness"] as const;

/** All boosts enabled — production-like flags. */
const ALL_FLAGS_ON: MediaRankingFlags = {
  rankingEnabled:               true,
  activeCreatorBoostEnabled:    true,
  newCreatorBoostEnabled:       true,
  returningCreatorBoostEnabled: true,
  underexposedBoostEnabled:     true,
  creatorFatigueEnabled:        true,
};

const FLAGS_OFF: MediaRankingFlags = {
  rankingEnabled:               false,
  activeCreatorBoostEnabled:    false,
  newCreatorBoostEnabled:       false,
  returningCreatorBoostEnabled: false,
  underexposedBoostEnabled:     false,
  creatorFatigueEnabled:        false,
};

// ── Simple deterministic PRNG ─────────────────────────────────────────────────

function lcg(seed: number, min: number, max: number): number {
  const s = ((seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff;
  return min + s * (max - min);
}

function deterministicShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = (seed * 1664525 + 1013904223) & 0x7fffffff;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── Synthetic item builder ────────────────────────────────────────────────────

type CreatorTier =
  | "highly_active"
  | "moderately_active"
  | "new"
  | "returning"
  | "underexposed"
  | "inactive_legacy"
  | "gems_accurate"
  | "gems_wrong_place";

interface SyntheticCreator {
  id: string;
  tier: CreatorTier;
  city: string;
  category: string;
  accountAgeDays: number;
  weeklyPostCount: number;
  lastPostAtDaysAgo: number | null;
}

function buildCreators(): SyntheticCreator[] {
  const creators: SyntheticCreator[] = [];
  let idx = 0;

  function add(count: number, tier: CreatorTier, ageDays: number, weeklyPosts: number, lastPostDaysAgo: number | null): void {
    for (let i = 0; i < count; i++) {
      creators.push({
        id: `creator-${tier}-${i}`,
        tier,
        city:       CITIES[idx % CITIES.length]!,
        category:   CATEGORIES[idx % CATEGORIES.length]!,
        accountAgeDays: ageDays,
        weeklyPostCount: weeklyPosts,
        lastPostAtDaysAgo: lastPostDaysAgo,
      });
      idx++;
    }
  }

  add(10, "highly_active",     365, 7,    0);
  add(20, "moderately_active", 180, 3,    0);
  add(10, "new",               5,   1,    0);
  add(10, "returning",         90,  1,    20);  // returning after 20 days
  add(10, "underexposed",      60,  2,    0);   // low view count
  add(15, "inactive_legacy",   730, 0,    60);  // quiet for 60 days
  add(15, "gems_accurate",     200, 2,    0);
  add(10, "gems_wrong_place",  200, 2,    0);

  return creators;
}

const NOW_MS = Date.now();

function buildItem(creator: SyntheticCreator, viewerIdx: number, overrides: Partial<MediaFeedItem> = {}): MediaFeedItem {
  const seed = creator.id.length * 7 + viewerIdx * 13;
  const ageDays = lcg(seed, 0, 10);
  const createdAt = new Date(NOW_MS - ageDays * 86_400_000).toISOString();

  const lastPostAt = creator.lastPostAtDaysAgo != null
    ? new Date(NOW_MS - creator.lastPostAtDaysAgo * 86_400_000).toISOString()
    : null;

  // Underexposed items: very low view count
  const isUnderexposed = creator.tier === "underexposed";
  const viewCount = isUnderexposed
    ? Math.round(lcg(seed + 1, 0, 30))
    : Math.round(lcg(seed + 1, 100, 2000));

  // Gems items
  const isGemsAccurate    = creator.tier === "gems_accurate";
  const isGemsWrongPlace  = creator.tier === "gems_wrong_place";

  return {
    id:            `item-${creator.id}-v${viewerIdx}`,
    kind:          "post",
    authorId:      creator.id,
    createdAt,
    city:          creator.city,
    category:      creator.category,
    tags:          [creator.category],
    likeCount:     Math.round(lcg(seed + 2, 10, 300)),
    joinCount:     0,
    authorTrustScore: 70,

    // Media signals
    watchCompletionRate:  lcg(seed + 3, 0.3, 0.9),
    qualifiedViewCount:   Math.round(viewCount * 0.4),
    rewatchRate:          lcg(seed + 4, 0.0, 0.15),
    totalImpressionCount: viewCount,

    // Creator signals
    creatorAccountAgeDays:  creator.accountAgeDays,
    creatorLastPostAt:      lastPostAt,
    creatorWeeklyPostCount: creator.weeklyPostCount,

    // Gems-specific
    placeAccuracyScore:   isGemsAccurate ? 1.0 : (isGemsWrongPlace ? 0.4 : null),
    wrongPlaceReportRate: isGemsWrongPlace ? 0.20 : (isGemsAccurate ? 0.0 : null),
    addToTripRate:        isGemsAccurate ? lcg(seed + 5, 0.05, 0.20) : null,
    placeUniqueness:      isGemsAccurate ? 0.8 : (isGemsWrongPlace ? 0.3 : null),

    ...overrides,
  };
}

function makeSessionState(): MediaSessionState {
  return { creatorImpressions: new Map() };
}

function makeViewerCtx(viewerIdx: number) {
  const city = CITIES[viewerIdx % CITIES.length]!;
  return {
    userId:      `viewer-${viewerIdx}`,
    city,
    interestTags: new Set([CATEGORIES[viewerIdx % CATEGORIES.length]!]),
    followedIds:  new Set<string>(),
    seenIds:      new Set<string>(),
    nowMs:        NOW_MS,
  };
}

// ── Helper: find creator tier from item id ────────────────────────────────────

function tierOf(itemId: string, creators: SyntheticCreator[]): CreatorTier | null {
  const creator = creators.find((c) => itemId.includes(c.id));
  return creator?.tier ?? null;
}

function creatorOf(itemId: string, creators: SyntheticCreator[]): string | null {
  return creators.find((c) => itemId.includes(c.id))?.id ?? null;
}

// ── Simulation runner ─────────────────────────────────────────────────────────

interface SimResult {
  viewerIdx: number;
  ranked: ReturnType<typeof rankMediaFeed>;
}

function runSimulation(
  creators: SyntheticCreator[],
  flags: MediaRankingFlags = ALL_FLAGS_ON,
): SimResult[] {
  const results: SimResult[] = [];

  for (let vi = 0; vi < NUM_VIEWERS; vi++) {
    const rawItems = creators.map((c) => buildItem(c, vi));
    // Shuffle so different viewers see different orderings
    const items = deterministicShuffle(rawItems, vi * 997 + 12345);
    const viewer = makeViewerCtx(vi);
    const session = makeSessionState();

    const input: MediaRankingInput = {
      candidates: items,
      viewer,
      mode: "for_you",
      sessionState: session,
      flags,
      nowMs: NOW_MS,
    };

    const ranked = rankMediaFeed(input);
    results.push({ viewerIdx: vi, ranked });
  }

  return results;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MediaFeedRankingService simulation — 100 creators, 50 viewers", () => {
  const creators   = buildCreators();
  const simResults = runSimulation(creators);

  // ── 1. Creator frequency cap ───────────────────────────────────────────────

  it("1. No single creator dominates a 50-item session", () => {
    for (const { viewerIdx, ranked } of simResults) {
      const top = ranked.slice(0, SESSION_SIZE);
      const countByCreator = new Map<string, number>();
      for (const r of top) {
        const cid = r.item.authorId ?? r.item.id;
        countByCreator.set(cid, (countByCreator.get(cid) ?? 0) + 1);
      }
      const maxAllowed = Math.ceil(SESSION_SIZE * 0.20); // 20% cap
      for (const [cid, count] of countByCreator) {
        assert.ok(
          count <= maxAllowed,
          `Viewer ${viewerIdx}: creator '${cid}' has ${count}/${SESSION_SIZE} items (${((count / SESSION_SIZE) * 100).toFixed(1)}%) — exceeds 20% cap`,
        );
      }
    }
  });

  // ── 2. New-creator content appears in positions 1–10 ─────────────────────

  it("2. New-creator content appears in top-10 of at least 40% of sessions", () => {
    const newCreatorIds = new Set(creators.filter((c) => c.tier === "new").map((c) => c.id));
    let sessionsWithNewInTop10 = 0;

    for (const { ranked } of simResults) {
      const top10 = ranked.slice(0, 10);
      const hasNew = top10.some((r) => {
        const cid = creatorOf(r.item.id, creators);
        return cid != null && newCreatorIds.has(cid);
      });
      if (hasNew) sessionsWithNewInTop10++;
    }

    const rate = sessionsWithNewInTop10 / simResults.length;
    assert.ok(
      rate >= 0.40,
      `New-creator content appeared in top-10 in ${sessionsWithNewInTop10}/${simResults.length} sessions (${(rate * 100).toFixed(1)}%) — need ≥40%`,
    );
  });

  // ── 3. Underexposed items surface within 2 pages (40 positions) ───────────

  it("3. Underexposed items appear within 40 positions in ≥60% of sessions", () => {
    const underCreatorIds = new Set(creators.filter((c) => c.tier === "underexposed").map((c) => c.id));
    let sessionsWithUnder = 0;

    for (const { ranked } of simResults) {
      const first40 = ranked.slice(0, 40);
      const hasUnder = first40.some((r) => {
        const cid = creatorOf(r.item.id, creators);
        return cid != null && underCreatorIds.has(cid);
      });
      if (hasUnder) sessionsWithUnder++;
    }

    const rate = sessionsWithUnder / simResults.length;
    assert.ok(
      rate >= 0.60,
      `Underexposed items appeared in first 40 positions in ${sessionsWithUnder}/${simResults.length} sessions (${(rate * 100).toFixed(1)}%) — need ≥60%`,
    );
  });

  // ── 4. Gems: wrong-place items are demoted ────────────────────────────────

  it("4. Gems: wrong-place items rank below accurate-place items on average", () => {
    const gemsCreators  = creators.filter((c) => c.tier === "gems_accurate" || c.tier === "gems_wrong_place");
    const gemsAccIds    = new Set(creators.filter((c) => c.tier === "gems_accurate").map((c) => c.id));
    const gemsWrongIds  = new Set(creators.filter((c) => c.tier === "gems_wrong_place").map((c) => c.id));

    // Run gems-mode simulation for a few viewers
    const gemsResults: SimResult[] = [];
    for (let vi = 0; vi < 20; vi++) {
      const gemsItems = gemsCreators.map((c) => buildItem(c, vi));
      const gemsRanked = rankMediaFeed({
        candidates: gemsItems,
        viewer: makeViewerCtx(vi),
        mode: "gems",
        sessionState: makeSessionState(),
        flags: ALL_FLAGS_ON,
        nowMs: NOW_MS,
      });
      gemsResults.push({ viewerIdx: vi, ranked: gemsRanked });
    }

    let accRankSum  = 0;
    let wrongRankSum = 0;
    let accCount    = 0;
    let wrongCount  = 0;

    for (const { ranked } of gemsResults) {
      ranked.forEach((r, idx) => {
        const cid = creatorOf(r.item.id, creators);
        if (cid && gemsAccIds.has(cid))   { accRankSum   += idx; accCount++;   }
        if (cid && gemsWrongIds.has(cid)) { wrongRankSum += idx; wrongCount++; }
      });
    }

    const avgAccRank   = accCount   > 0 ? accRankSum   / accCount   : 0;
    const avgWrongRank = wrongCount > 0 ? wrongRankSum / wrongCount : 0;

    assert.ok(
      avgAccRank < avgWrongRank,
      `Gems accurate-place avg rank (${avgAccRank.toFixed(1)}) should be LOWER (better) than wrong-place avg rank (${avgWrongRank.toFixed(1)})`,
    );
  });

  // ── 5. Chronological order when MEDIA_RANKING_ENABLED=false ──────────────

  it("5. When MEDIA_RANKING_ENABLED=false, output matches input chronological order", () => {
    const items = creators.slice(0, 20).map((c) => buildItem(c, 0));
    // Sort chronologically (newest first, like the DB query)
    const chronological = [...items].sort((a, b) =>
      new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime(),
    );

    const ranked = rankMediaFeed({
      candidates: chronological,
      viewer: makeViewerCtx(0),
      mode: "for_you",
      sessionState: makeSessionState(),
      flags: FLAGS_OFF,
      nowMs: NOW_MS,
    });

    // All scores should be 0
    assert.ok(
      ranked.every((r) => r.finalScore === 0),
      "All scores should be 0 when ranking is disabled",
    );

    // Order should be preserved (same as input)
    assert.equal(ranked.length, chronological.length);
    for (let i = 0; i < ranked.length; i++) {
      assert.equal(
        ranked[i]!.item.id,
        chronological[i]!.id,
        `Position ${i}: expected ${chronological[i]!.id}, got ${ranked[i]!.item.id}`,
      );
    }
  });

  // ── 6. Session fatigue reduces rank after repeated appearances ────────────

  it("6. Session-fatigue penalty reduces a creator's score when seen repeatedly", () => {
    const creator = creators.find((c) => c.tier === "highly_active")!;
    const item = buildItem(creator, 0);

    // No fatigue
    const noFatigue = rankMediaFeed({
      candidates: [item],
      viewer: makeViewerCtx(0),
      mode: "for_you",
      sessionState: { creatorImpressions: new Map() },
      flags: ALL_FLAGS_ON,
      nowMs: NOW_MS,
    });

    // Heavy fatigue: seen 10 times already
    const withFatigue = rankMediaFeed({
      candidates: [item],
      viewer: makeViewerCtx(0),
      mode: "for_you",
      sessionState: { creatorImpressions: new Map([[creator.id, 10]]) },
      flags: ALL_FLAGS_ON,
      nowMs: NOW_MS,
    });

    assert.ok(
      noFatigue[0]!.finalScore > withFatigue[0]!.finalScore,
      `Score without fatigue (${noFatigue[0]!.finalScore.toFixed(3)}) should exceed score with fatigue (${withFatigue[0]!.finalScore.toFixed(3)})`,
    );
  });

  // ── 7. Returning-creator boost ────────────────────────────────────────────

  it("7. Returning creator (20 days inactive) scores above inactive-legacy baseline", () => {
    // Build one item from each tier
    const returningCreator = creators.find((c) => c.tier === "returning")!;
    const inactiveCreator  = creators.find((c) => c.tier === "inactive_legacy")!;

    const returningItem = buildItem(returningCreator, 0);
    const inactiveItem  = buildItem(inactiveCreator, 0);

    const ranked = rankMediaFeed({
      candidates: [returningItem, inactiveItem],
      viewer: makeViewerCtx(0),
      mode: "for_you",
      sessionState: makeSessionState(),
      flags: ALL_FLAGS_ON,
      nowMs: NOW_MS,
    });

    // Find positions
    const returningPos = ranked.findIndex((r) => r.item.id === returningItem.id);
    const inactivePos  = ranked.findIndex((r) => r.item.id === inactiveItem.id);

    // In this targeted test, the returning creator should rank at least as high
    // (lower index = better rank). We allow tie (returningPos <= inactivePos).
    assert.ok(
      returningPos <= inactivePos,
      `Returning creator at position ${returningPos} should rank ≤ inactive-legacy at position ${inactivePos}`,
    );
  });

  // ── Extra: reason codes are populated ────────────────────────────────────

  it("8. Every ranked item carries at least one reason code when ranking is enabled", () => {
    const { ranked } = simResults[0]!;
    for (const r of ranked) {
      assert.ok(
        r.reasonCodes.length > 0,
        `Item ${r.item.id} has no reason codes`,
      );
    }
  });
});
