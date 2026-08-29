/**
 * Unit tests for DiscoveryRankingService.
 *
 * Tests are structured around the spec's acceptance criteria:
 *   1. Activity boost is capped at ACTIVITY_SCORE_MAX_BOOST
 *   2. Boost cannot rescue an ineligible item
 *   3. Less-active creator with high relevance outranks active creator with low relevance
 *   4. New-contributor boost decays to zero after the 30-day window
 *   5. Search surface: query match outranks activity
 *   6. Pulse (following) surface: does not bury less-active followed accounts
 *   7. Shadow mode zeroes out new boosts and preserves original order
 *   8. Eligibility: blocked/muted/suspended/deleted/expired all excluded
 *   9. Underexposure boost applies only when flag is on
 *  10. Spam penalty propagated from creator_activity_scores
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankItems } from "../services/ranking/DiscoveryRankingService.js";
import type {
  RankingInput,
  RankingViewerContext,
} from "../services/ranking/DiscoveryRankingService.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VIEWER_ID = "00000000-0000-0000-0000-000000000001";

function makeViewer(
  overrides: Partial<RankingViewerContext> = {},
): RankingViewerContext {
  return {
    viewerId:          VIEWER_ID,
    travelStyles:      ["adventure", "food"],
    preferredLanguages: ["en"],
    preferredCities:   ["paris"],
    currentCity:       "paris",
    currentCountry:    "FR",
    lat:               48.85,
    lng:               2.35,
    viewerAge:         null,
    followedCreatorIds: new Set(),
    mutedCreatorIds:    new Set(),
    blockedCreatorIds:  new Set(),
    seenItemIds:        new Set(),
    sessionId:          null,
    lastActiveAt:       null,
    ...overrides,
  };
}

function makeItem(
  id: string,
  overrides: Partial<RankingInput> = {},
): RankingInput {
  return {
    itemId:              id,
    itemType:            "post",
    creatorId:           `creator-${id}`,
    createdAt:           new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3 h ago
    city:                "paris",
    country:             "FR",
    tags:                ["adventure"],
    category:            "adventure",
    languageCode:        "en",
    hasMedia:            true,
    completeness:        0.8,
    positiveReviewRate:  0.9,
    flagCount:           0,
    saveCount:           5,
    shareCount:          2,
    commentCount:        3,
    impressionCount:     100,
    uniqueViewerCount:   80,
    lat:                 48.86,
    lng:                 2.36,
    distanceKm:          1.5,
    isDeleted:           false,
    isExpired:           false,
    isSuspended:         false,
    isModerated:         false,
    isPrivate:           false,
    isAgeRestricted:     false,
    minAgeRequired:      null,
    isGeoRestricted:     false,
    geoRestrictionCountries: null,
    authorIsBlockedByViewer: false,
    authorBlocksViewer:      false,
    authorIsMutedByViewer:   false,
    viewerHasReportedItem:   false,
    viewerHasHiddenItem:     false,
    viewerHasHiddenCreator:  false,
    repeatCount:         null,
    expiresAt:           null,
    accountAgeDays:      90,
    isUnfamiliarCategory: false,
    isFirstImpression:   false,
    ...overrides,
  };
}

/**
 * Items with minimal base signals so small boosts / penalties are clearly visible
 * in the final score without both items capping at 100.
 * No geo (no city, no distanceKm), old content (low freshness), no media, no engagement.
 */
function makeLowBaseItem(id: string, overrides: Partial<RankingInput> = {}): RankingInput {
  return makeItem(id, {
    city:               null,
    country:            null,
    distanceKm:         null,
    lat:                null,
    lng:                null,
    hasMedia:           false,
    completeness:       0.3,
    positiveReviewRate: null,
    saveCount:          0,
    shareCount:         0,
    commentCount:       0,
    impressionCount:    1,
    uniqueViewerCount:  0,
    // 3 weeks old → freshness ≈ 12.5% of max (half-life 7 days, 3 half-lives)
    createdAt:          new Date(Date.now() - 21 * 24 * 60 * 60 * 1_000).toISOString(),
    tags:               [],
    category:           null,
    ...overrides,
  });
}

/** Flags that put the service in active mode (all boosts on). */
const ACTIVE_FLAGS: Record<string, boolean> = {
  ACTIVITY_DISCOVERY_BOOST_ENABLED:    true,
  NEW_CONTRIBUTOR_BOOST_ENABLED:       true,
  RETURNING_USER_BOOST_ENABLED:        true,
  UNDEREXPOSED_CONTENT_BOOST_ENABLED:  true,
  RANKING_EXPERIMENT_ENABLED:          false,
};

/** Flags for shadow mode. */
const SHADOW_FLAGS: Record<string, boolean> = {
  ACTIVITY_DISCOVERY_BOOST_ENABLED:    false,
  NEW_CONTRIBUTOR_BOOST_ENABLED:       false,
  RETURNING_USER_BOOST_ENABLED:        false,
  UNDEREXPOSED_CONTENT_BOOST_ENABLED:  false,
  RANKING_EXPERIMENT_ENABLED:          false,
};

// ── 1. Activity boost is capped at ACTIVITY_SCORE_MAX_BOOST ──────────────────

describe("activityBoost cap", () => {
  it("caps raw activity boost at ACTIVITY_SCORE_MAX_BOOST (default 10) on compass surface", async () => {
    const item = makeItem("item-1");
    const viewer = makeViewer();

    // Give creator a perfect activity score of 100
    const activityScores = new Map([
      ["creator-item-1", { score: 100, spam_penalty: 0 }],
    ]);

    // Use "compass" surface — its activityBoost profile multiplier is 1.0
    // so the raw cap (10) is preserved in the component value.
    const results = await rankItems(
      [item],
      "compass",
      viewer,
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results.length, 1);
    assert.ok(results[0]!.eligibilityPassed);
    // activityBoost must not exceed ACTIVITY_SCORE_MAX_BOOST (10)
    assert.ok(
      results[0]!.components.activityBoost <= 10,
      `activityBoost ${results[0]!.components.activityBoost} should be ≤ 10`,
    );
    // With score=100, maxBoost=10, surface multiplier=1.0: boost = 10
    assert.equal(results[0]!.components.activityBoost, 10);
  });

  it("scales activity boost proportionally for scores below 100", async () => {
    const item = makeItem("item-2");
    const activityScores = new Map([
      ["creator-item-2", { score: 50, spam_penalty: 0 }],
    ]);

    // compass surface: multiplier = 1.0, so raw boost = (50/100)*10 = 5
    const results = await rankItems(
      [item],
      "compass",
      makeViewer(),
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results[0]!.components.activityBoost, 5); // 50% of maxBoost=10
  });
});

// ── 2. Boost cannot rescue an ineligible item ─────────────────────────────────

describe("eligibility gate", () => {
  it("excludes suspended items even with a perfect activity score", async () => {
    const item = makeItem("item-susp", { isSuspended: true });
    const activityScores = new Map([
      ["creator-item-susp", { score: 100, spam_penalty: 0 }],
    ]);

    const results = await rankItems(
      [item],
      "discovery",
      makeViewer(),
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.finalScore, 0);
    assert.equal(results[0]!.components.activityBoost, 0);
  });

  it("excludes deleted items", async () => {
    const item = makeItem("item-del", { isDeleted: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
  });

  it("excludes expired items", async () => {
    const item = makeItem("item-exp", { isExpired: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
  });

  it("excludes items from authors blocked by viewer", async () => {
    const item = makeItem("item-blk", { authorIsBlockedByViewer: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.eligibilityReason, "author_blocked_by_viewer");
  });

  it("excludes items where author blocks the viewer", async () => {
    const item = makeItem("item-blk2", { authorBlocksViewer: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.eligibilityReason, "viewer_blocked_by_author");
  });

  it("excludes items from muted authors", async () => {
    const item = makeItem("item-muted", { authorIsMutedByViewer: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
  });

  it("excludes items reported by viewer", async () => {
    const item = makeItem("item-rep", { viewerHasReportedItem: true });
    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
  });

  it("excludes age-restricted items when viewer is below minimum age", async () => {
    const item = makeItem("item-age", {
      isAgeRestricted: true,
      minAgeRequired: 21,
    });
    const viewer = makeViewer({ viewerAge: 18 });
    const results = await rankItems([item], "discovery", viewer, null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.eligibilityReason, "viewer_age_below_minimum");
  });

  it("allows age-restricted items when viewer meets minimum age", async () => {
    const item = makeItem("item-age2", {
      isAgeRestricted: true,
      minAgeRequired: 18,
    });
    const viewer = makeViewer({ viewerAge: 25 });
    const results = await rankItems([item], "discovery", viewer, null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, true);
  });

  it("excludes geo-restricted items outside viewer country", async () => {
    const item = makeItem("item-geo", {
      isGeoRestricted: true,
      geoRestrictionCountries: ["US"],
    });
    const viewer = makeViewer({ currentCountry: "FR" });
    const results = await rankItems([item], "discovery", viewer, null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.equal(results[0]!.eligibilityPassed, false);
    assert.equal(results[0]!.eligibilityReason, "geo_restricted");
  });

  it("ineligible items are sorted AFTER eligible items", async () => {
    const eligible   = makeItem("item-ok");
    const ineligible = makeItem("item-bad", { isSuspended: true });

    const results = await rankItems(
      [ineligible, eligible], // ineligible first in input
      "discovery",
      makeViewer(),
      null,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results[0]!.itemId, "item-ok");
    assert.equal(results[1]!.itemId, "item-bad");
  });
});

// ── 3. High-relevance low-activity outranks low-relevance high-activity ────────

describe("per-candidate analytics switch", () => {
  /**
   * ITEM_ELIGIBLE and ITEM_SCORED are two single-row, un-batched, un-awaited
   * inserts for EVERY candidate — not every served item. A surface whose
   * eligibility inputs are all constants (discovery) pays that for a decision
   * with one possible outcome, so it opts out via RankItemsOptions.
   *
   * Two properties keep that safe, and both are easy to lose silently:
   *   1. the default is ON, so no surface loses analytics by not knowing
   *      the option exists (compass and pulse both rely on this), and
   *   2. the switch governs ANALYTICS ONLY — it must never quietly become a
   *      way to skip the eligibility gate itself.
   */

  /** Records rank_events inserts; reads resolve empty. */
  function recordingDb() {
    const events: string[] = [];
    const client: any = {
      from(table: string) {
        const q: any = {
          select: () => q, eq: () => q, in: () => q, gte: () => q,
          order: () => q, limit: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
          insert: (row: any) => {
            if (table === "rank_events" && row?.event_type) events.push(row.event_type);
            return { then: (ok: any) => Promise.resolve({ data: null, error: null }).then(ok) };
          },
          then: (ok: any) => Promise.resolve({ data: [], error: null }).then(ok),
        };
        return q;
      },
    };
    return { client, events };
  }

  it("emits ITEM_ELIGIBLE and ITEM_SCORED by default — surfaces keep analytics without opting in", async () => {
    const { client, events } = recordingDb();
    await rankItems([makeItem("i-1"), makeItem("i-2")], "compass", makeViewer(), client, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: {},
    });

    assert.equal(events.filter((e) => e === "ranking_item_eligible").length, 2);
    assert.equal(events.filter((e) => e === "ranking_item_scored").length, 2);
  });

  it("emits neither when the caller opts out", async () => {
    const { client, events } = recordingDb();
    await rankItems([makeItem("i-1"), makeItem("i-2")], "discovery", makeViewer(), client, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: {},
    }, { emitPerCandidateAnalytics: false });

    assert.deepEqual(
      events.filter((e) => e === "ranking_item_eligible" || e === "ranking_item_scored"),
      [],
    );
  });

  it("opting out does NOT disable the gate — it still rejects on a real input", async () => {
    // The whole risk of the opt-out is that "we stopped writing about the gate"
    // slides into "we stopped running the gate". A surface that later starts
    // handing real eligibility values must still have them enforced, whether or
    // not it has re-enabled the analytics rows.
    const { client } = recordingDb();
    const results = await rankItems(
      [makeItem("blocked", { authorIsBlockedByViewer: true }), makeItem("fine")],
      "discovery", makeViewer(), client,
      { activityScores: new Map(), fatiguedCreators: new Set(), flags: {} },
      { emitPerCandidateAnalytics: false },
    );

    const blocked = results.find((r) => r.itemId === "blocked")!;
    assert.equal(blocked.eligibilityPassed, false);
    assert.equal(blocked.eligibilityReason, "author_blocked_by_viewer");
    assert.equal(blocked.finalScore, 0);
    assert.equal(results.find((r) => r.itemId === "fine")!.eligibilityPassed, true);
  });
});

describe("relevance vs activity tradeoff", () => {
  it("less-active creator with high relevance outranks active creator with low relevance", async () => {
    // High relevance: tags match viewer interests
    const highRelevance = makeItem("item-relevant", {
      tags:              ["adventure", "food"],
      category:          "adventure",
      languageCode:      "en",
      distanceKm:        0.5,
      creatorId:         "creator-low-activity",
    });

    // Low relevance: mismatched tags
    const lowRelevance = makeItem("item-irrelevant", {
      tags:              ["luxury", "spa"],
      category:          "luxury",
      languageCode:      "zh",
      distanceKm:        50,
      creatorId:         "creator-high-activity",
    });

    const activityScores = new Map([
      ["creator-low-activity",  { score: 20,  spam_penalty: 0 }],
      ["creator-high-activity", { score: 100, spam_penalty: 0 }],
    ]);

    const results = await rankItems(
      [lowRelevance, highRelevance],
      "discovery",
      makeViewer(),
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results[0]!.itemId, "item-relevant",
      "High-relevance item should rank first regardless of lower activity score");
    assert.equal(results[1]!.itemId, "item-irrelevant");
  });
});

// ── 4. New-contributor boost decays to zero after 30-day window ───────────────

describe("newContributorBoost decay", () => {
  it("applies boost for accounts within the 30-day window", async () => {
    const item = makeItem("item-new", {
      accountAgeDays: 5,
      completeness:   0.8,
    });

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });

    assert.ok(results[0]!.components.newContributorBoost > 0,
      "Should have newContributorBoost for a 5-day-old account");
  });

  it("applies zero boost for accounts older than 30 days", async () => {
    const item = makeItem("item-old", {
      accountAgeDays: 31,
      completeness:   0.9,
    });

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });

    assert.equal(results[0]!.components.newContributorBoost, 0,
      "newContributorBoost must be 0 for accounts older than 30 days");
  });

  it("applies zero boost for new accounts with low onboarding completeness", async () => {
    const item = makeItem("item-incomplete", {
      accountAgeDays: 3,
      completeness:   0.1, // below meaningful onboarding threshold
    });

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });

    assert.equal(results[0]!.components.newContributorBoost, 0,
      "newContributorBoost must be 0 without meaningful onboarding");
  });

  it("boost is larger for very new accounts than for accounts near day 29", async () => {
    const newItem  = makeItem("item-day1",  { accountAgeDays: 1,  completeness: 0.9 });
    const nearItem = makeItem("item-day29", { accountAgeDays: 29, completeness: 0.9 });

    const [resNew, resNear] = await Promise.all([
      rankItems([newItem],  "discovery", makeViewer(), null, {
        activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
      }),
      rankItems([nearItem], "discovery", makeViewer(), null, {
        activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
      }),
    ]);

    assert.ok(
      resNew[0]!.components.newContributorBoost >
      resNear[0]!.components.newContributorBoost,
      "Boost should decay over time",
    );
  });
});

// ── 5. Search: query relevance outranks activity ──────────────────────────────

describe("search surface", () => {
  it("query-match item outranks high-activity item with low relevance on search surface", async () => {
    const viewer = makeViewer({ travelStyles: ["beach", "diving"] });

    const highRelevance = makeItem("item-beach", {
      tags:     ["beach", "diving"],
      category: "beach",
      creatorId: "creator-low-act",
    });

    const highActivity = makeItem("item-urban", {
      tags:      ["shopping", "nightlife"],
      category:  "nightlife",
      creatorId: "creator-high-act",
    });

    const activityScores = new Map([
      ["creator-low-act",  { score: 10,  spam_penalty: 0 }],
      ["creator-high-act", { score: 100, spam_penalty: 0 }],
    ]);

    const results = await rankItems(
      [highActivity, highRelevance],
      "search",
      viewer,
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results[0]!.itemId, "item-beach",
      "On search surface, relevance should dominate over activity");
  });
});

// ── 6. Pulse/following: less-active followed accounts not buried ───────────────

describe("pulse surface — following mode", () => {
  it("followed creator outranks unfollowed creator with higher activity", async () => {
    // Use low-base items so geo/freshness/quality don't push both to 100
    // and the relationship boost can dominate.
    const followedId = "creator-followed";
    const viewer = makeViewer({
      followedCreatorIds: new Set([followedId]),
    });

    // Followed item: low activity but has matching tags + relationship weight
    const followedItem = makeLowBaseItem("item-followed", {
      creatorId:          followedId,
      tags:               ["adventure"],   // matches viewer travelStyles
      category:           "adventure",
    });

    // High-activity item: NOT followed, no tag match → only gets activityBoost
    const highActivityItem = makeLowBaseItem("item-high-act", {
      creatorId:          "creator-not-followed",
      tags:               [],              // no relevance match
      category:           null,
    });

    const activityScores = new Map([
      [followedId,             { score: 5,   spam_penalty: 0 }], // low activity
      ["creator-not-followed", { score: 100, spam_penalty: 0 }], // high activity
    ]);

    const results = await rankItems(
      [highActivityItem, followedItem],
      "pulse",
      viewer,
      null,
      { activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS },
    );

    assert.equal(results[0]!.itemId, "item-followed",
      "On pulse surface, following relationship + relevance should prevent less-active followed accounts from being buried");
    // Sanity: followed item has relationship score; high-act item does not
    assert.ok(results.find(r => r.itemId === "item-followed")!.components.relationshipRelevance > 0);
    assert.equal(results.find(r => r.itemId === "item-high-act")!.components.relationshipRelevance, 0);
  });
});

// ── 7. Shadow mode ────────────────────────────────────────────────────────────

describe("shadow mode", () => {
  it("zeroes out activityBoost in shadow mode", async () => {
    const item = makeItem("item-shad");
    const activityScores = new Map([
      ["creator-item-shad", { score: 100, spam_penalty: 0 }],
    ]);

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores,
      fatiguedCreators: new Set(),
      flags: SHADOW_FLAGS,
    });

    assert.equal(results[0]!.components.activityBoost, 0,
      "activityBoost must be 0 in shadow mode");
  });

  it("zeroes out newContributorBoost in shadow mode", async () => {
    const item = makeItem("item-shad2", { accountAgeDays: 5, completeness: 0.9 });

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(),
      fatiguedCreators: new Set(),
      flags: SHADOW_FLAGS,
    });

    assert.equal(results[0]!.components.newContributorBoost, 0);
  });

  it("zeroes out underexposureBoost in shadow mode", async () => {
    const item = makeItem("item-underexp");
    const underexposureStatus = new Map([["item-underexp", "boosting"]]);

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(),
      fatiguedCreators: new Set(),
      underexposureStatus,
      flags: SHADOW_FLAGS,
    });

    assert.equal(results[0]!.components.underexposureBoost, 0);
  });

  it("preserves original input order in shadow mode (does not re-sort eligible items)", async () => {
    const item1 = makeItem("item-z", { tags: [] });                  // low relevance
    const item2 = makeItem("item-a", { tags: ["adventure", "food"] }); // high relevance

    const activityScores = new Map([
      ["creator-item-z", { score: 100, spam_penalty: 0 }],
      ["creator-item-a", { score: 0,   spam_penalty: 0 }],
    ]);

    const results = await rankItems(
      [item1, item2], // item1 first in input
      "discovery",
      makeViewer(),
      null,
      { activityScores, fatiguedCreators: new Set(), flags: SHADOW_FLAGS },
    );

    // Shadow mode must preserve original input order
    assert.equal(results[0]!.itemId, "item-z");
    assert.equal(results[1]!.itemId, "item-a");
  });
});

// ── 8. Underexposure boost ────────────────────────────────────────────────────

describe("underexposure boost", () => {
  it("applies boost for items with underexposure_status = boosting when flag is on", async () => {
    const item = makeItem("item-exp-1");
    const underexposureStatus = new Map([["item-exp-1", "boosting"]]);

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(),
      fatiguedCreators: new Set(),
      underexposureStatus,
      flags: ACTIVE_FLAGS,
    });

    assert.ok(results[0]!.components.underexposureBoost > 0,
      "Underexposure boost should apply when status = boosting");
  });

  it("does not apply boost for items with underexposure_status = evaluated", async () => {
    const item = makeItem("item-eval");
    const underexposureStatus = new Map([["item-eval", "evaluated"]]);

    const results = await rankItems([item], "discovery", makeViewer(), null, {
      activityScores: new Map(),
      fatiguedCreators: new Set(),
      underexposureStatus,
      flags: ACTIVE_FLAGS,
    });

    assert.equal(results[0]!.components.underexposureBoost, 0);
  });
});

// ── 9. Spam penalty from creator_activity_scores ──────────────────────────────

describe("spam penalty", () => {
  it("propagates spam_penalty from creator_activity_scores", async () => {
    // Use low-base items so the penalty isn't lost in signals that push both to 100.
    const noSpam = makeLowBaseItem("item-clean");
    const spammy  = makeLowBaseItem("item-spam");

    const activityScores = new Map([
      ["creator-item-clean", { score: 50, spam_penalty: 0  }],
      ["creator-item-spam",  { score: 50, spam_penalty: 25 }], // max penalty
    ]);

    const [cleanResult, spamResult] = await Promise.all([
      rankItems([noSpam], "discovery", makeViewer(), null, {
        activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
      }),
      rankItems([spammy], "discovery", makeViewer(), null, {
        activityScores, fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
      }),
    ]);

    assert.ok(
      spamResult[0]!.components.spamPenalty > cleanResult[0]!.components.spamPenalty,
      "Spammy creator should have higher spamPenalty than clean creator",
    );
    assert.ok(
      spamResult[0]!.finalScore < cleanResult[0]!.finalScore,
      "Spammy item should have lower final score",
    );
  });
});

// ── 10. Fatigue penalty ───────────────────────────────────────────────────────

describe("fatigue penalty", () => {
  it("applies fatigue penalty when creator is in the fatigued set", async () => {
    // Use low-base items so the fatigue penalty isn't lost in signals that
    // push both items to 100 before the penalty can differentiate them.
    const item  = makeLowBaseItem("item-fatigued");
    const fresh = makeLowBaseItem("item-fresh");

    const [fatiguedResult, freshResult] = await Promise.all([
      rankItems([item], "discovery", makeViewer(), null, {
        activityScores: new Map(),
        fatiguedCreators: new Set(["creator-item-fatigued"]),
        flags: ACTIVE_FLAGS,
      }),
      rankItems([fresh], "discovery", makeViewer(), null, {
        activityScores: new Map(),
        fatiguedCreators: new Set(),
        flags: ACTIVE_FLAGS,
      }),
    ]);

    assert.ok(fatiguedResult[0]!.components.fatiguePenalty > 0,
      "Fatigued creator should have fatiguePenalty > 0");
    assert.equal(freshResult[0]!.components.fatiguePenalty, 0);
    assert.ok(
      fatiguedResult[0]!.finalScore < freshResult[0]!.finalScore,
      "Fatigued item should score lower",
    );
  });
});

// ── 11. Empty input ───────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("returns empty array for empty input", async () => {
    const results = await rankItems([], "discovery", makeViewer(), null, {
      activityScores: new Map(), fatiguedCreators: new Set(), flags: ACTIVE_FLAGS,
    });
    assert.deepEqual(results, []);
  });

  it("final score is always in [0, 100]", async () => {
    const items = [
      makeItem("item-worst", {
        flagCount: 999, repeatCount: 100, isSuspended: false,
        saveCount: 0, shareCount: 0, commentCount: 0, impressionCount: 1,
        tags: [], category: null, languageCode: "zh",
      }),
      makeItem("item-best", {
        flagCount: 0, hasMedia: true, completeness: 1,
        saveCount: 100, shareCount: 50, commentCount: 30, impressionCount: 200,
        tags: ["adventure", "food"], category: "adventure",
      }),
    ];

    const results = await rankItems(items, "discovery", makeViewer(), null, {
      activityScores: new Map([
        ["creator-item-best", { score: 100, spam_penalty: 0 }],
      ]),
      fatiguedCreators: new Set(),
      flags: ACTIVE_FLAGS,
    });

    for (const r of results.filter((r) => r.eligibilityPassed)) {
      assert.ok(r.finalScore >= 0,   `Score ${r.finalScore} should be ≥ 0`);
      assert.ok(r.finalScore <= 100, `Score ${r.finalScore} should be ≤ 100`);
    }
  });
});
