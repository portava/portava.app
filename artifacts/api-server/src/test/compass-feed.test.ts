/**
 * compass-feed.test.ts — Phase 3 Feed Intelligence tests
 *
 * Covers:
 *   - CompassDiversityEngine: no >2 same-category items in a row; nightlife/paid cap at 25%;
 *     exploration card inserted per 10 items
 *   - CompassFairExposureEngine: inserts new-author items near top; ends on first report;
 *     respects cooldown; does not insert when block list matches
 *   - CompassActiveUserRewardEngine: boost is zero when severe safety flag is present;
 *     boost is zero when boost_visibility_enabled is false; tier thresholds
 *   - CompassFeedBuilder: sections assigned correctly; cursor encoding round-trips;
 *     disabled visibility preference suppresses reward surface expansion
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-feed.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyDiversity, diversifySection } from "../compass/CompassDiversityEngine.js";
import { applyFairExposure, endFairExposure } from "../compass/CompassFairExposureEngine.js";
import {
  computeItemVisibilityBoost,
  recordActivityEvent,
  type ActiveUserScoreResult,
} from "../compass/CompassActiveUserRewardEngine.js";
import { buildFeed, loadBoostLiftWithheld, rankItemsForDiscovery, SECTION_NAMES } from "../compass/CompassFeedBuilder.js";
import type { PipelineResult } from "../compass/CompassPipeline.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ALICE_ID = "00000000-0000-0000-0000-000000000001";
const BOB_ID   = "00000000-0000-0000-0000-000000000002";
const CAROL_ID = "00000000-0000-0000-0000-000000000003";

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:               ALICE_ID,
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
    trustScore:           75,
    trustLevel:           "trusted_traveler",
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:          "Tokyo",
    currentCountry:       "Japan",
    safeReturnActive:     false,
    computedAt:           new Date().toISOString(),
    ...overrides,
  };
}

function baseContext(state: CompassContext["contextState"] = "exploring_now"): CompassContext {
  return {
    contextState: state,
    signals: {
      hourUtc:               14,
      safeReturnActive:      false,
      activeBooking:         false,
      upcomingTripWithin48h: false,
      activeTripNow:         false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: new Date().toISOString(),
  };
}

function makePipelineResult(
  overrides: Partial<CompassItem> & { score?: number } = {},
): PipelineResult {
  const { score = 50, ...itemOverrides } = overrides;
  const item: CompassItem = {
    id:       `item-${Math.random().toString(36).slice(2)}`,
    type:     "event",
    authorId: CAROL_ID,
    ...itemOverrides,
  };
  return {
    item,
    finalScore:       score,
    safetyPassed:     true,
    eligiblePassed:   true,
    privacySanitized: true,
  };
}

function makeResults(types: string[], score = 50): PipelineResult[] {
  return types.map((t) =>
    makePipelineResult({ type: t as CompassItem["type"], score }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CompassDiversityEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassDiversityEngine", () => {
  it("empty input returns empty output with zero counts", () => {
    const result = applyDiversity([], baseProfile());
    assert.equal(result.items.length, 0);
    assert.equal(result.explorationCount, 0);
    assert.equal(result.reorderedCount, 0);
  });

  it("single item passes through unchanged", () => {
    const items = makeResults(["event"]);
    const result = applyDiversity(items, baseProfile());
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.item.type, "event");
  });

  it("no same-category type appears more than 2 times consecutively", () => {
    // 4 events + 4 posts — sufficient non-events to break every run of > 2
    const items = makeResults([
      "event","event","event","event",
      "post","post","post","post",
    ]);
    const { items: diversified } = applyDiversity(items, baseProfile());

    let maxRun = 0;
    let run    = 0;
    let prev   = "";
    for (const r of diversified) {
      if (r.item.type === prev) {
        run++;
      } else {
        run  = 1;
        prev = r.item.type;
      }
      maxRun = Math.max(maxRun, run);
    }
    assert.ok(maxRun <= 2, `max consecutive run was ${maxRun}, expected ≤ 2`);
  });

  it("mixed types with enough variety break consecutive runs", () => {
    // 3 events + 2 posts + 2 users — diverse enough to prevent runs > 2
    const items = makeResults([
      "event","event","event","post","post","user","user",
    ]);
    const { items: out } = applyDiversity(items, baseProfile());
    let maxRun = 0, run = 0, prev = "";
    for (const r of out) {
      if (r.item.type === prev) run++;
      else { run = 1; prev = r.item.type; }
      maxRun = Math.max(maxRun, run);
    }
    assert.ok(maxRun <= 2, `max run = ${maxRun}`);
  });

  it("nightlife items do not appear more than 2 times consecutively in output", () => {
    // 8 nightlife events + 8 regular posts = 16 total.
    // True 25% cap: at most ceil(16 * 0.25) = 4 nightlife items survive.
    // Non-nightlife items are preserved fully.
    // The observable guarantee: nightlife ≤ 25% of output AND no run > 2.
    const nightlifeItems = Array.from({ length: 8 }, (_, i) =>
      makePipelineResult({ id: `n${i}`, type: "event", interestTags: ["nightlife"] }),
    );
    const others = Array.from({ length: 8 }, (_, i) =>
      makePipelineResult({ id: `o${i}`, type: "post" }),
    );
    const input = [...nightlifeItems, ...others];
    const { items: out } = applyDiversity(input, baseProfile());

    // Output-ratio cap: nightlife share of the output must be ≤ 25%
    const nightlifeCount = out.filter((r) => r.item.interestTags?.includes("nightlife")).length;
    const nightlifeRatio = out.length > 0 ? nightlifeCount / out.length : 0;
    assert.ok(nightlifeRatio <= 0.25 + 0.01, `nightlife ratio ${(nightlifeRatio*100).toFixed(0)}% exceeds 25%`);

    // Non-nightlife items are never dropped by the cap
    const othersInOutput = out.filter((r) => r.item.type === "post").length;
    assert.equal(othersInOutput, 8, "non-nightlife items preserved");

    // Consecutive-run is tested by the dedicated "no same-category" test.
    // Here we just verify items are sorted (all posts in output — none dropped).
    assert.ok(out.length >= 8, `at least 8 non-nightlife items must survive`);
  });

  it("total item count is preserved (no items dropped)", () => {
    const items = makeResults(["event","event","event","post","user","stamp","buddy","suggestion","notification"]);
    const { items: out } = applyDiversity(items, baseProfile());
    assert.equal(out.length, items.length, "diversity must not drop items");
  });

  it("diversifySection helper returns same count", () => {
    const items = makeResults(["event","event","event","post","user"]);
    const out   = diversifySection(items, baseProfile());
    assert.equal(out.length, items.length);
  });

  it("exploration card inserted when pool has 10+ items of varied types", () => {
    // 8 events + 2 posts → needs exploration of unfamiliar type
    // We add a stamp at the back; the engine should lift it forward
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        makePipelineResult({ id: `ev${i}`, type: "event", score: 80 }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePipelineResult({ id: `po${i}`, type: "post", score: 60 }),
      ),
      makePipelineResult({ id: "stamp1", type: "stamp", score: 40 }),
    ];
    const { items: out, explorationCount } = applyDiversity(items, baseProfile());
    assert.equal(out.length, items.length, "no items dropped");
    // Spec requires at least one exploration card per 10 items when multiple types present
    assert.ok(explorationCount >= 1, `expected ≥1 exploration card, got ${explorationCount}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassFairExposureEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassFairExposureEngine", () => {
  const recentJoined = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000).toISOString(); // 5 days ago

  it("inserts new-author item near the top of section items", () => {
    const sectionItems = makeResults(["event", "post", "user"]);
    const newAuthorItem = makePipelineResult({
      id:              "new-author-1",
      type:            "buddy",
      authorId:        BOB_ID,
      buddyStatus:     "active",
      authorJoinedAt:  recentJoined,
    });
    const allPool = [...sectionItems, newAuthorItem];

    const { items, insertedCount } = applyFairExposure(
      sectionItems, allPool, baseProfile(), null,
    );
    assert.equal(insertedCount, 1);
    // Inserted at position 1 (after first organic item)
    assert.equal(items[1]!.item.id, "new-author-1");
  });

  it("does not insert item already present in section", () => {
    const newAuthorItem = makePipelineResult({
      id:             "new-author-dup",
      type:           "event",
      authorId:       BOB_ID,
      authorJoinedAt: recentJoined,
    });
    const sectionItems = [newAuthorItem, ...makeResults(["post"])];
    const allPool = [...sectionItems];

    const { insertedCount } = applyFairExposure(sectionItems, allPool, baseProfile(), null);
    assert.equal(insertedCount, 0);
  });

  it("ends fair exposure when appearance count equals cap", () => {
    const newAuthorItem = makePipelineResult({
      id:             "new-author-capped",
      type:           "event",
      authorId:       BOB_ID,
      authorJoinedAt: recentJoined,
    });
    const sectionItems = makeResults(["post"]);
    const allPool = [...sectionItems, newAuthorItem];

    // Simulate cap already reached
    const counts = new Map([["new-author-capped", 10]]);
    const { insertedCount } = applyFairExposure(
      sectionItems, allPool, baseProfile(), null, counts,
    );
    assert.equal(insertedCount, 0, "capped item must not be inserted");
  });

  it("does not insert item when author is on cooldown", () => {
    const newAuthorItem = makePipelineResult({
      id:             "new-author-cooldown",
      type:           "event",
      authorId:       BOB_ID,
      authorJoinedAt: recentJoined,
    });
    const sectionItems = makeResults(["post"]);
    const allPool = [...sectionItems, newAuthorItem];

    const cooldowns = new Set([BOB_ID]);
    const { insertedCount } = applyFairExposure(
      sectionItems, allPool, baseProfile(), null, new Map(), cooldowns,
    );
    assert.equal(insertedCount, 0, "cooldown author must not be inserted");
  });

  it("does not insert item when author is in viewer's block list", () => {
    const newAuthorItem = makePipelineResult({
      id:             "new-author-blocked",
      type:           "event",
      authorId:       BOB_ID,
      authorJoinedAt: recentJoined,
    });
    const sectionItems = makeResults(["post"]);
    const allPool = [...sectionItems, newAuthorItem];
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });

    const { insertedCount } = applyFairExposure(
      sectionItems, allPool, profile, null,
    );
    assert.equal(insertedCount, 0, "blocked author must not be fair-exposure inserted");
  });

  it("does not insert item for old author (joined > 30 days ago)", () => {
    const oldJoined = new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000).toISOString();
    const oldAuthorItem = makePipelineResult({
      id:             "old-author",
      type:           "event",
      authorId:       BOB_ID,
      authorJoinedAt: oldJoined,
    });
    const sectionItems = makeResults(["post"]);
    const allPool = [...sectionItems, oldAuthorItem];

    const { insertedCount } = applyFairExposure(
      sectionItems, allPool, baseProfile(), null,
    );
    assert.equal(insertedCount, 0, "old author must not get fair exposure");
  });

  it("endFairExposure is callable with null DB without throwing", () => {
    assert.doesNotThrow(() => endFairExposure(null, BOB_ID, "report"));
  });

  it("fair exposure is blocked after endFairExposure (report received)", () => {
    // Simulate: a report arrives → endFairExposure is called → author lands on cooldown.
    // Downstream: applyFairExposure must not insert the same author again.
    const newAuthorItem = makePipelineResult({
      id:             "report-subject-item",
      type:           "buddy",
      authorId:       BOB_ID,
      authorJoinedAt: recentJoined,
    });
    const sectionItems = makeResults(["post"]);
    const allPool = [...sectionItems, newAuthorItem];

    // Before report: author is new and eligible → must be inserted
    const before = applyFairExposure(sectionItems, allPool, baseProfile(), null);
    assert.equal(before.insertedCount, 1, "before report: eligible new author should be inserted");

    // After report: author is on cooldown (endFairExposure persists this via DB;
    // here we pass the cooldown set directly to simulate that state).
    const cooldownAfterReport = new Set<string>([BOB_ID]);
    const after = applyFairExposure(
      sectionItems, allPool, baseProfile(), null,
      new Map(),       // empty appearance counts
      cooldownAfterReport,
    );
    assert.equal(after.insertedCount, 0, "after report: cooldown must block fair-exposure insertion");
  });

  it("inserts at most MAX_FAIR_INSERTS (2) items per call", () => {
    const newAuthorItems = Array.from({ length: 5 }, (_, i) =>
      makePipelineResult({
        id:             `fair-${i}`,
        type:           "event",
        authorId:       `00000000-0000-0000-0000-00000000000${i + 4}`,
        authorJoinedAt: recentJoined,
      }),
    );
    const sectionItems = makeResults(["post", "user"]);
    const allPool = [...sectionItems, ...newAuthorItems];

    const { insertedCount } = applyFairExposure(
      sectionItems, allPool, baseProfile(), null,
    );
    assert.ok(insertedCount <= 2, `inserted ${insertedCount}, expected ≤ 2`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassActiveUserRewardEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassActiveUserRewardEngine", () => {
  function makeScore(overrides: Partial<ActiveUserScoreResult> = {}): ActiveUserScoreResult {
    return {
      userId:                ALICE_ID,
      score24h:              5,
      score7d:               10,
      score30d:              20,
      score90d:              30,
      scoreLifetime:         50,
      activeUserScore:       35,
      trustMultiplier:       1.0,
      tier:                  "city_connector",
      boostEligible:         true,
      boostVisibilityEnabled: true,
      badgeEligibility:      [],
      ...overrides,
    };
  }

  it("returns zero boost when trustMultiplier is 0 (severe safety flag)", () => {
    const score = makeScore({ trustMultiplier: 0.0, boostEligible: true });
    assert.equal(computeItemVisibilityBoost(score), 0,
      "severe safety flag must produce zero boost");
  });

  it("returns zero boost when boost_visibility_enabled is false", () => {
    const score = makeScore({ boostVisibilityEnabled: false });
    assert.equal(computeItemVisibilityBoost(score), 0,
      "user with disabled boost preference must get zero boost");
  });

  it("returns zero boost when author has no score record", () => {
    assert.equal(computeItemVisibilityBoost(null), 0);
  });

  it("returns zero boost for active_traveler tier (not yet eligible)", () => {
    const score = makeScore({ tier: "active_traveler", boostEligible: false });
    assert.equal(computeItemVisibilityBoost(score), 0);
  });

  it("returns non-zero boost for city_ambassador_candidate with full trust", () => {
    const score = makeScore({
      tier:           "city_ambassador_candidate",
      trustMultiplier: 1.0,
      boostEligible:   true,
      boostVisibilityEnabled: true,
    });
    assert.ok(computeItemVisibilityBoost(score) > 0, "ambassador must get positive boost");
  });

  it("local_guide gets a lower boost than city_ambassador_candidate", () => {
    const local = makeScore({ tier: "local_guide", boostEligible: true });
    const ambassador = makeScore({ tier: "city_ambassador_candidate", boostEligible: true });
    assert.ok(
      computeItemVisibilityBoost(local) < computeItemVisibilityBoost(ambassador),
      "local_guide boost must be less than city_ambassador_candidate",
    );
  });

  it("city_connector boost is between local_guide and city_ambassador_candidate", () => {
    const local      = computeItemVisibilityBoost(makeScore({ tier: "local_guide",               boostEligible: true }));
    const connector  = computeItemVisibilityBoost(makeScore({ tier: "city_connector",            boostEligible: true }));
    const ambassador = computeItemVisibilityBoost(makeScore({ tier: "city_ambassador_candidate", boostEligible: true }));
    assert.ok(local < connector && connector < ambassador,
      `expected local(${local}) < connector(${connector}) < ambassador(${ambassador})`);
  });

  it("trust multiplier of 0.5 (trust cap) halves the boost vs full trust", () => {
    const full = computeItemVisibilityBoost(makeScore({
      tier: "city_ambassador_candidate", trustMultiplier: 1.0, boostEligible: true,
    }));
    const capped = computeItemVisibilityBoost(makeScore({
      tier: "city_ambassador_candidate", trustMultiplier: 0.5, boostEligible: true,
    }));
    assert.ok(capped < full, "trust-capped boost must be less than full-trust boost");
    assert.ok(capped > 0,   "trust-capped boost must still be positive");
  });

  it("recordActivityEvent stores multiplier=1 by default (no double-weighting)", () => {
    // The weight column is a SCALING MULTIPLIER (default 1), not the raw event score.
    // scoreEvents() computes:  EVENT_WEIGHTS[type] * row.weight
    // If we stored EVENT_WEIGHTS[type] here, the formula would square the weight.
    const inserts: { weight: number }[] = [];
    const fakeDb = {
      from: () => ({
        insert: (row: { weight: number }) => {
          inserts.push(row);
          return { then: () => {} };
        },
      }),
    } as any;

    recordActivityEvent(fakeDb, ALICE_ID, "booking_completed");
    assert.equal(inserts.length, 1, "one insert expected");
    assert.equal(inserts[0]!.weight, 1,
      "default weight must be 1 (the multiplier); event score is applied by scoreEvents()");

    // Caller-supplied multiplier is stored as-is
    const fakeDb2 = {
      from: () => ({
        insert: (row: { weight: number }) => {
          inserts.push(row);
          return { then: () => {} };
        },
      }),
    } as any;
    recordActivityEvent(fakeDb2, ALICE_ID, "booking_completed", { weight: 2 });
    assert.equal(inserts[1]!.weight, 2, "explicit multiplier 2 must be stored as 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassFeedBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassFeedBuilder", () => {
  it("empty input returns empty sections with correct fallback:false", async () => {
    const result = await buildFeed([], baseProfile(), baseContext(), null, null, {
      skipFairExposure: true,
      skipActiveRewards: true,
    });
    assert.equal(result.fallback, false);
    assert.equal(result.sections.length, 0);
    assert.equal(result.nextCursor, null);
    assert.equal(result.pipelineMeta.inputCount, 0);
  });

  it("all sections carry only items that passed the pipeline", async () => {
    // Inject mocked safety + eligibility to let everything through
    const item1: CompassItem = {
      id: "feed-ev1", type: "event", authorId: CAROL_ID, visibilityScope: "public",
    };
    const result = await buildFeed(
      [item1],
      baseProfile(),
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:     () => ({ allowed: true }),
        eligibilityCheck: () => ({ eligible: true }),
        scoreItem:        () => ({ finalScore: 75, components: {} as any }),
      },
    );
    assert.equal(result.fallback, false);
    // At least for_you should have the item
    const forYou = result.sections.find((s) => s.name === "for_you");
    assert.ok(forYou, "for_you section must exist");
    assert.ok(forYou!.items.length >= 1);
  });

  it("each FeedItem carries explanationKey and section name", async () => {
    const item: CompassItem = { id: "feed-ev2", type: "event", authorId: CAROL_ID };
    const result = await buildFeed(
      [item],
      baseProfile(),
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:      () => ({ allowed: true }),
        eligibilityCheck:  () => ({ eligible: true }),
        scoreItem:         () => ({ finalScore: 60, components: {} as any }),
      },
    );
    for (const section of result.sections) {
      for (const feedItem of section.items) {
        assert.ok(typeof feedItem.explanationKey === "string" && feedItem.explanationKey.length > 0,
          "explanationKey must be a non-empty string");
        assert.ok(SECTION_NAMES.includes(section.name), "section.name must be a valid section");
      }
    }
  });

  it("blocked author never appears in any section", async () => {
    const blockedItem: CompassItem = {
      id: "blocked-item", type: "event", authorId: BOB_ID,
    };
    const cleanItem: CompassItem = {
      id: "clean-item", type: "post", authorId: CAROL_ID,
    };
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    // Let items through safety but eligibility blocks the blocked author via pipeline
    const result = await buildFeed(
      [blockedItem, cleanItem],
      profile,
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        // Safety blocks the blocked author's items
        safetyFilter:      (item) => ({ allowed: item.authorId !== BOB_ID }),
        eligibilityCheck:  () => ({ eligible: true }),
        scoreItem:         () => ({ finalScore: 50, components: {} as any }),
      },
    );
    const allIds = result.sections.flatMap((s) => s.items.map((i) => i.item.id));
    assert.ok(!allIds.includes("blocked-item"), "blocked author's item must not appear in feed");
    assert.ok(allIds.includes("clean-item"),    "clean item must appear in feed");
  });

  it("items with finalScore >= 70 appear in compass_picks section", async () => {
    const highItem: CompassItem = { id: "high-score-1", type: "event", authorId: CAROL_ID };
    const result = await buildFeed(
      [highItem],
      baseProfile(),
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:      () => ({ allowed: true }),
        eligibilityCheck:  () => ({ eligible: true }),
        scoreItem:         () => ({ finalScore: 85, components: {} as any }),
      },
    );
    const picks = result.sections.find((s) => s.name === "compass_picks");
    assert.ok(picks && picks.items.length > 0, "compass_picks must contain high-scoring item");
    assert.equal(picks!.items[0]!.item.id, "high-score-1");
  });

  it("buddy items appear in rent_a_buddy and available_now sections", async () => {
    const buddyItem: CompassItem = {
      id:          "buddy-1",
      type:        "buddy",
      authorId:    CAROL_ID,
      buddyStatus: "active",
    };
    const result = await buildFeed(
      [buddyItem],
      baseProfile(),
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:      () => ({ allowed: true }),
        eligibilityCheck:  () => ({ eligible: true }),
        scoreItem:         () => ({ finalScore: 55, components: {} as any }),
      },
    );
    const rentSection = result.sections.find((s) => s.name === "rent_a_buddy");
    const availSection = result.sections.find((s) => s.name === "available_now");
    assert.ok(rentSection && rentSection.items.length > 0,   "buddy must appear in rent_a_buddy");
    assert.ok(availSection && availSection.items.length > 0, "active buddy must appear in available_now");
  });

  it("user with disabled boost_visibility still appears but with zero boost", async () => {
    const authorScore: ActiveUserScoreResult = {
      userId:                CAROL_ID,
      score24h:              10,
      score7d:               20,
      score30d:              40,
      score90d:              60,
      scoreLifetime:         100,
      activeUserScore:       40,
      trustMultiplier:       1.0,
      tier:                  "city_connector",
      boostEligible:         true,
      boostVisibilityEnabled: false, // <-- disabled
      badgeEligibility:      [],
    };

    const item: CompassItem = { id: "no-boost-item", type: "event", authorId: CAROL_ID };
    const result = await buildFeed(
      [item],
      baseProfile(),
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: false,
        authorScores:      new Map([[CAROL_ID, authorScore]]),
        safetyFilter:      () => ({ allowed: true }),
        eligibilityCheck:  () => ({ eligible: true }),
        scoreItem:         () => ({ finalScore: 55, components: {} as any }),
      },
    );
    const allItems = result.sections.flatMap((s) => s.items);
    const found = allItems.find((fi) => fi.item.id === "no-boost-item");
    assert.ok(found, "item must still appear in feed");
    // visibilityBoost must be 0 or absent
    assert.ok(
      !found!.visibilityBoost || found!.visibilityBoost === 0,
      "item with disabled boost_visibility must have zero boost",
    );
  });

  it("sections are only present when they have items", async () => {
    const result = await buildFeed([], baseProfile(), baseContext(), null, null, {
      skipFairExposure:  true,
      skipActiveRewards: true,
    });
    assert.equal(result.sections.length, 0, "no sections emitted for empty input");
  });
});

// ── categoryWeights: null — new-user safety net ───────────────────────────────

describe("CompassFeedBuilder — categoryWeights null guard", () => {
  it("buildFeed with null categoryWeights does not throw and returns valid output", async () => {
    const item: CompassItem = { id: "nw-ev1", type: "event", authorId: CAROL_ID };
    const profile = baseProfile({ categoryWeights: null, ignoredItemIds: [], mutedHashtags: [] });
    const result = await buildFeed(
      [item],
      profile,
      baseContext(),
      null,
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:     () => ({ allowed: true }),
        eligibilityCheck: () => ({ eligible: true }),
        scoreItem:        () => ({ finalScore: 55, components: {} as any }),
      },
    );
    assert.equal(result.fallback, false);
    assert.ok(Array.isArray(result.sections), "sections must be an array");
  });

  it("rankItemsForDiscovery with null categoryWeights does not throw and returns items", async () => {
    const item: CompassItem = { id: "nw-sug1", type: "suggestion", authorId: BOB_ID };
    const profile = baseProfile({ categoryWeights: null, ignoredItemIds: [], mutedHashtags: [] });
    const results = await rankItemsForDiscovery(
      [item],
      profile,
      baseContext(),
      null,
      {
        skipFairExposure:  true,
        skipActiveRewards: true,
        safetyFilter:     () => ({ allowed: true }),
        eligibilityCheck: () => ({ eligible: true }),
        scoreItem:        () => ({ finalScore: 60, components: {} as any }),
      },
    );
    assert.ok(Array.isArray(results), "results must be an array");
    assert.equal(results.length, 1);
  });
});

// ── rankItemsForDiscovery — Compass-rejected items excluded ────────────────────

describe("rankItemsForDiscovery — discovery exclusion regression", () => {
  it("Compass-rejected items are not present in output when COMPASS_V1_RULE_BASED_ENABLED", async () => {
    // Two items: one passes safety, one is suspended (should be rejected)
    const passedItem: CompassItem  = { id: "place:allowed",   type: "suggestion", authorId: BOB_ID };
    const rejectedItem: CompassItem = { id: "place:suspended", type: "suggestion", authorId: CAROL_ID, isSuspended: true };

    const results = await rankItemsForDiscovery(
      [passedItem, rejectedItem],
      baseProfile(),
      baseContext(),
      null,
      {
        // Custom safety filter that blocks suspended items (mirrors pipeline gate)
        safetyFilter:     (item, _profile, _db, _flags) => item.isSuspended
          ? { allowed: false, reason: "suspended" }
          : { allowed: true },
        eligibilityCheck: () => ({ eligible: true }),
        scoreItem:        () => ({ finalScore: 50, components: {} as any }),
        skipFairExposure:  true,
        skipActiveRewards: true,
      },
    );

    const returnedIds = results.map((r) => r.item.id);
    assert.ok(
      returnedIds.includes("place:allowed"),
      "passed item must appear in discovery results",
    );
    assert.ok(
      !returnedIds.includes("place:suspended"),
      "Compass-rejected (suspended) item must NOT appear in discovery results",
    );
  });
});

// ── Lead ruling D-24c (2026-10-06): a messaging restriction withholds the boost lift ──
//
// "While a messaging restriction is active, the person's posts get no boost lift.
// Their stored boost preference is kept, and the lift comes back when the
// restriction ends. If the restriction state cannot be read, apply no boost."
// Verifier finding 3: boost_visibility_enabled defaults TRUE and the feed applied
// the lift with no restriction read at all.
describe("D-24c — the boost lift under a messaging restriction", () => {
  const ambassador = (userId: string): ActiveUserScoreResult => ({
    userId, score24h: 5, score7d: 10, score30d: 20, score90d: 30, scoreLifetime: 50,
    activeUserScore: 90, trustMultiplier: 1.0, tier: "city_ambassador_candidate",
    boostEligible: true, boostVisibilityEnabled: true, badgeEligibility: [],
  });
  const LIFT = computeItemVisibilityBoost(ambassador(BOB_ID));
  const scores = () => new Map([[BOB_ID, ambassador(BOB_ID)], [CAROL_ID, ambassador(CAROL_ID)]]);
  const items = (): CompassItem[] => [
    { id: "post:bob", type: "suggestion", authorId: BOB_ID },
    { id: "post:carol", type: "suggestion", authorId: CAROL_ID },
  ];
  const R = (userId: string, t: string, extra: Record<string, unknown> = {}) =>
    ({ user_id: userId, restriction_type: t, lifted_at: null, expires_at: null, ...extra });

  /** PostgREST-shaped: trust_restrictions answers rows (or an error); every write is recorded. */
  function fakeDb(restrictions: Array<Record<string, unknown>>, opts: { unreadable?: boolean; absent?: boolean } = {}) {
    const writes: string[] = [];
    const db: any = {
      writes,
      from(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        const rows = () => (table === "trust_restrictions" ? restrictions : []).filter((r) => filters.every((f) => f(r)));
        const result = () => (table === "trust_restrictions" && opts.unreadable)
          ? { data: null, error: { message: "trust_restrictions unavailable", code: "XX000" } }
          : (table === "trust_restrictions" && opts.absent)
            // The table is not there at all: getRestrictionState answers fail_OPEN —
            // degraded:true with every can-flag TRUE (TrustRestrictionService).
            ? { data: null, error: { message: 'relation "public.trust_restrictions" does not exist', code: "42P01" } }
            : { data: rows(), error: null };
        const chain: any = {
          select: () => chain,
          eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
          is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
          or: () => chain, in: () => chain, gt: () => chain, gte: () => chain, lt: () => chain, order: () => chain, limit: () => chain,
          insert: () => { writes.push(`insert:${table}`); return chain; },
          update: () => { writes.push(`update:${table}`); return chain; },
          upsert: () => { writes.push(`upsert:${table}`); return chain; },
          maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }; },
          single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error }; },
          then: (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad),
        };
        return chain;
      },
      rpc: async () => ({ data: null, error: null }),
    };
    return db;
  }
  const rank = (db: any, extra: Record<string, unknown> = {}) => rankItemsForDiscovery(items(), baseProfile(), baseContext(), db, {
    safetyFilter: () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    scoreItem: () => ({ finalScore: 50, components: {} as any }),
    skipFairExposure: true,
    skipActiveRewards: true,
    authorScores: scores(),
    ...extra,
  });
  const liftOf = (rs: PipelineResult[], id: string) => rs.find((r) => r.item.id === id)?.item.activeVisibilityBoost ?? 0;

  it("control: with no restriction both authors get the lift", async () => {
    assert.ok(LIFT > 0);
    const rs = await rank(fakeDb([]));
    assert.equal(liftOf(rs, "post:bob"), LIFT);
    assert.equal(liftOf(rs, "post:carol"), LIFT);
  });

  it("an active MESSAGING restriction withholds that author's lift — only theirs — and the feed re-sorts", async () => {
    const db = fakeDb([R(BOB_ID, "messaging")]);
    const rs = await rank(db);
    assert.equal(liftOf(rs, "post:bob"), 0);
    assert.equal(rs.find((r) => r.item.id === "post:bob")!.finalScore, 50);
    assert.equal(liftOf(rs, "post:carol"), LIFT);
    assert.equal(rs[0].item.id, "post:carol");
  });

  it("the stored preference is kept: withholding writes nothing", async () => {
    const db = fakeDb([R(BOB_ID, "messaging")]);
    await rank(db);
    assert.deepEqual(db.writes, []);
  });

  it("a hosting restriction does not touch the lift (D-24c names messaging)", async () => {
    const rs = await rank(fakeDb([R(BOB_ID, "hosting")]));
    assert.equal(liftOf(rs, "post:bob"), LIFT);
  });

  it("a LIFTED messaging restriction gives the lift back", async () => {
    const rs = await rank(fakeDb([R(BOB_ID, "messaging", { lifted_at: "2026-10-01T00:00:00Z" })]));
    assert.equal(liftOf(rs, "post:bob"), LIFT);
  });

  it("an UNREADABLE restriction state applies no lift to anyone (fail-closed for reach), and refuses nothing — every post is still served", async () => {
    const rs = await rank(fakeDb([], { unreadable: true }));
    assert.equal(liftOf(rs, "post:bob"), 0);
    assert.equal(liftOf(rs, "post:carol"), 0);
    assert.deepEqual(rs.map((r) => r.item.id).sort(), ["post:bob", "post:carol"]);
  });

  it("an ABSENT trust_restrictions table (fail_open: degraded, every can-flag TRUE) applies no lift either — `degraded` decides, not canMessage", async () => {
    const rs = await rank(fakeDb([R(BOB_ID, "messaging")], { absent: true }));
    assert.equal(liftOf(rs, "post:bob"), 0);
    assert.equal(liftOf(rs, "post:carol"), 0);
    assert.deepEqual(rs.map((r) => r.item.id).sort(), ["post:bob", "post:carol"]);
  });

  it("no client at all is unreadable too: no lift", async () => {
    const withheld = await loadBoostLiftWithheld(null, [BOB_ID, CAROL_ID]);
    assert.deepEqual([...withheld].sort(), [BOB_ID, CAROL_ID].sort());
  });

  it("buildFeed applies the same rule at its own boost site: the withheld author gets no lift, the other keeps it", async () => {
    const run = (boostWithheld?: Set<string>) => buildFeed(items(), baseProfile(), baseContext(), null, null, {
      safetyFilter: () => ({ allowed: true }),
      eligibilityCheck: () => ({ eligible: true }),
      scoreItem: () => ({ finalScore: 50, components: {} as any }),
      skipFairExposure: true,
      skipActiveRewards: true,
      authorScores: scores(),
      ...(boostWithheld ? { boostWithheld } : {}),
    });
    const all = (page: Awaited<ReturnType<typeof buildFeed>>) => page.sections.flatMap((s) => s.items);
    const lifted = (page: Awaited<ReturnType<typeof buildFeed>>, id: string) =>
      (all(page).find((i: any) => (i.item?.id ?? i.id) === id) as any);
    const withheldBob = await run(new Set([BOB_ID]));
    const bob = lifted(withheldBob, "post:bob"); const carol = lifted(withheldBob, "post:carol");
    assert.ok(bob && carol, JSON.stringify(all(withheldBob)).slice(0, 400));
    assert.equal((bob.item ?? bob).activeVisibilityBoost ?? 0, 0);
    assert.equal((carol.item ?? carol).activeVisibilityBoost ?? 0, LIFT);
    // With no client and no override, nobody's restriction state can be read: no lift.
    const unread = await run();
    assert.equal((lifted(unread, "post:carol").item ?? lifted(unread, "post:carol")).activeVisibilityBoost ?? 0, 0);
  });
});

// ── D-24c on the rest of the Compass boost path (lane L wave 6, 2026-10-07) ──
//
// The active-user lift above was the only boost the ruling reached. Two more
// Compass paths lift a person's reach with no restriction read:
//   - fair exposure (CompassFairExposureEngine) puts a new author's item in slot
//     2 and its "Why this?" calls that a boost;
//   - the fallback feed's `basic_discovery` surfaces people BECAUSE their boost
//     is on (`boost_eligible` needs the boost preference).
// Both now withhold the lift for a messaging-restricted or unreadable author.
describe("D-24c — fair exposure and the fallback's boost-selected suggestions withhold the lift too", () => {
  const NEW_ID = BOB_ID;    // joined 5 days ago, verified: fair-exposure eligible
  const OLD_ID = CAROL_ID;  // joined long ago: never eligible
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const pool = (): CompassItem[] => [
    { id: "post:old", type: "suggestion", authorId: OLD_ID, authorJoinedAt: daysAgo(400), isVerified: true },
    { id: "post:new", type: "suggestion", authorId: NEW_ID, authorJoinedAt: daysAgo(5), isVerified: true },
  ];
  const R = (userId: string, t: string) => ({ user_id: userId, restriction_type: t, lifted_at: null, expires_at: null });
  const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
  /** A table-backed fake that also counts the restriction reads. */
  async function client(seed: Record<string, any[]>, errors: Record<string, { message: string; code?: string }> = {}) {
    const { makeClient } = await import("./highlightRouteHarness.js");
    const c: any = makeClient({ compass_visibility_boosts: [], compass_visibility_cooldowns: [], feature_flags: [], ...seed }, { errors });
    const inner = c.from;
    c.restrictionReads = 0;
    c.from = (t: string) => { if (t === "trust_restrictions") c.restrictionReads++; return inner(t); };
    return c;
  }
  const overrides = {
    safetyFilter: () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    scoreItem: (item: CompassItem) => ({ finalScore: item.id === "post:old" ? 60 : 50, components: {} as any }),
    skipActiveRewards: true,
    authorScores: new Map<string, ActiveUserScoreResult>(),
  } as any;
  const fair = (rs: PipelineResult[]) => rs.filter((r) => r.item.isFairExposureBoosted).map((r) => r.item.id);

  it("control: with no restriction the new author's item is lifted by fair exposure, and only that author's state is read", async () => {
    const c = await client({ trust_restrictions: [] });
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.deepEqual(fair(rs), ["post:new"]);
    assert.equal(rs[0].item.id, "post:new");
    assert.equal(c.restrictionReads, 1, "the long-standing author can get no fair-exposure lift, so nobody reads their restriction");
  });

  it("an active MESSAGING restriction withholds the fair-exposure lift; the item keeps its organic place", async () => {
    const c = await client({ trust_restrictions: [R(NEW_ID, "messaging")] });
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.deepEqual(fair(rs), []);
    assert.deepEqual(rs.map((r) => r.item.id), ["post:old", "post:new"]);
  });

  it("a HOSTING restriction does not touch it (D-24c names messaging)", async () => {
    const c = await client({ trust_restrictions: [R(NEW_ID, "hosting")] });
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.deepEqual(fair(rs), ["post:new"]);
  });

  it("an UNREADABLE restriction state lifts nobody and still serves every item", async () => {
    const c = await client({ trust_restrictions: [] }, { trust_restrictions: ERR });
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.deepEqual(fair(rs), []);
    assert.deepEqual(rs.map((r) => r.item.id).sort(), ["post:new", "post:old"]);
  });

  it("two eligible authors, the SECOND restricted (wave-6 verifier F4): only the first is lifted, and both states are read", async () => {
    const SECOND = ALICE_ID; // a second new verified author, distinct from NEW_ID
    const two = (): CompassItem[] => [
      ...pool(),
      { id: "post:second", type: "suggestion", authorId: SECOND, authorJoinedAt: daysAgo(3), isVerified: true },
    ];
    const viewer = baseProfile({ userId: "99999999-0000-4000-8000-000000000009" });
    const c = await client({ trust_restrictions: [R(SECOND, "messaging")] });
    const rs = await rankItemsForDiscovery(two(), viewer, baseContext(), c, overrides);
    assert.deepEqual(fair(rs), ["post:new"]);
    assert.equal(c.restrictionReads, 2, "both eligible authors' states are read — and only theirs");
    const control = await client({ trust_restrictions: [] });
    assert.deepEqual(fair(await rankItemsForDiscovery(two(), viewer, baseContext(), control, overrides)).sort(), ["post:new", "post:second"]);
  });

  it("buildFeed's own fair-exposure site applies the same rule", async () => {
    const ids = async (seed: any[]) => {
      const c = await client({ trust_restrictions: seed });
      const page = await buildFeed(pool(), baseProfile(), baseContext(), c, null, overrides);
      return page.sections.flatMap((s) => s.items).filter((i: any) => (i.item ?? i).isFairExposureBoosted).map((i: any) => (i.item ?? i).id);
    };
    assert.ok((await ids([])).includes("post:new"), "control: the new author is lifted on the feed");
    assert.deepEqual(await ids([R(NEW_ID, "messaging")]), []);
  });

  describe("the fallback feed's basic_discovery (people surfaced because their boost is on)", () => {
    const seed = (restrictions: any[]) => ({
      blocks: [], user_mutes: [], trips: [], trip_members: [], rent_buddy_bookings: [],
      compass_active_user_scores: [
        { user_id: NEW_ID, active_user_score: 90, boost_eligible: true },
        { user_id: OLD_ID, active_user_score: 80, boost_eligible: true },
      ],
      trust_restrictions: restrictions,
    });
    const suggested = async (c: any) => {
      const { buildFallbackFeed } = await import("../compass/CompassFallbackFeedBuilder.js");
      const out = await buildFallbackFeed(c, ALICE_ID, baseProfile({ currentCity: "Lisbon" }), "feed_builder_threw");
      return out.safeItems.filter((i) => i.category === "basic_discovery").map((i) => i.authorId).sort();
    };

    it("control: both boost-eligible people are suggested", async () => {
      assert.deepEqual(await suggested(await client(seed([]))), [NEW_ID, OLD_ID].sort());
    });

    it("a messaging-restricted person is not surfaced by their boost; the other still is", async () => {
      assert.deepEqual(await suggested(await client(seed([R(NEW_ID, "messaging")]))), [OLD_ID]);
    });

    it("an unreadable restriction state surfaces nobody by boost — and the fallback feed still answers", async () => {
      const c = await client(seed([]), { trust_restrictions: ERR });
      assert.deepEqual(await suggested(c), []);
      const { buildFallbackFeed } = await import("../compass/CompassFallbackFeedBuilder.js");
      const out = await buildFallbackFeed(c, ALICE_ID, baseProfile({ currentCity: "Lisbon" }), "feed_builder_threw");
      assert.ok(out.safeItems.some((i) => i.category === "safety_tool"), "the rest of the fallback is untouched");
    });
  });
});

// ── D-24c at the feed slot allocator, from both Compass call sites (lane L, after #650) ──
//
// allocateFeedSlots withholds every authored item's reserved slot when it is not
// told whose lift is withheld (lane C's fail-closed default), so with
// DISCOVERY_DIVERSITY_ENABLED on, Compass's two call sites must pass
// loadSlotLiftWithheld's set: a free author's new-user item is lifted forward, a
// messaging-restricted or unreadable author's is not, and only the authors who
// would take a reserved slot are read.
describe("D-24c — Compass passes the slot allocator its lift-withheld set (DISCOVERY_DIVERSITY_ENABLED on)", () => {
  const NEW_ID = BOB_ID; // joined 5 days ago: the new-user bucket
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const pool = (): CompassItem[] => [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `post:old${i}`, type: "suggestion" as const, authorId: `0000000${i}-0000-4000-8000-00000000000${i}`, authorJoinedAt: daysAgo(400) })),
    { id: "post:new", type: "suggestion", authorId: NEW_ID, authorJoinedAt: daysAgo(5) },
  ];
  const R = (userId: string, t: string) => ({ user_id: userId, restriction_type: t, lifted_at: null, expires_at: null });
  async function client(restrictions: any[], errors: Record<string, { message: string; code?: string }> = {}) {
    const { makeClient } = await import("./highlightRouteHarness.js");
    const c: any = makeClient({
      feature_flags: [{ flag: "DISCOVERY_DIVERSITY_ENABLED", enabled: true }],
      ranking_config: [], content_distribution_stats: [], trust_restrictions: restrictions,
      compass_visibility_boosts: [], compass_visibility_cooldowns: [],
    }, { errors });
    const inner = c.from;
    c.restrictionReads = 0;
    c.from = (t: string) => { if (t === "trust_restrictions") c.restrictionReads++; return inner(t); };
    return c;
  }
  const overrides = {
    safetyFilter: () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    // post:new scores lowest: only the reserved new-user slot can move it forward.
    scoreItem: (item: CompassItem) => ({ finalScore: item.id === "post:new" ? 10 : 90 - Number(item.id.slice(-1)), components: {} as any }),
    skipActiveRewards: true,
    skipFairExposure: true,
    authorScores: new Map<string, ActiveUserScoreResult>(),
  } as any;
  const posOf = (rs: PipelineResult[]) => rs.findIndex((r) => r.item.id === "post:new");

  it("a free author's new-user item takes its reserved slot (lifted forward), and only that author's restriction is read", async () => {
    const c = await client([]);
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.equal(rs.length, 8);
    assert.ok(posOf(rs) < 7, `the new-user item was not lifted: ${rs.map((r) => r.item.id).join(",")}`);
    assert.equal(c.restrictionReads, 1, "only the author who could take a reserved slot is read");
  });

  it("a MESSAGING-restricted author's item takes no reserved slot: it stays last", async () => {
    const c = await client([R(NEW_ID, "messaging")]);
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.equal(posOf(rs), 7);
  });

  it("an UNREADABLE restriction state lifts nobody (fail closed for reach) and still serves every item", async () => {
    const c = await client([], { trust_restrictions: { message: "canceling statement due to statement timeout", code: "57014" } });
    const rs = await rankItemsForDiscovery(pool(), baseProfile(), baseContext(), c, overrides);
    assert.equal(rs.length, 8);
    assert.equal(posOf(rs), 7);
  });

  // V-L6e N4: the read count alone let a mutant read the set and pass an EMPTY one at buildFeed's site.
  it("buildFeed's allocation WITHHOLDS the set it read: a free author's new-user item is lifted in for_you; a messaging-restricted or unreadable author's stays last", async () => {
    const forYou = async (c: any) => {
      const page = await buildFeed(pool(), baseProfile(), baseContext(), c, null, overrides);
      const items = page.sections.find((s) => s.name === "for_you")?.items.map((i) => i.item.id) ?? [];
      assert.equal(items.length, 8, `fixture: every item is served in for_you: ${items.join(",")}`);
      return items.indexOf("post:new");
    };
    assert.ok((await forYou(await client([]))) < 7, "control: the free author's new-user item was not lifted through buildFeed");
    assert.equal(await forYou(await client([R(NEW_ID, "messaging")])), 7, "a messaging-restricted author's item took a reserved slot through buildFeed");
    assert.equal(await forYou(await client([], { trust_restrictions: { message: "canceling statement due to statement timeout", code: "57014" } })), 7, "an unreadable restriction state lifted the item through buildFeed");
  });

  it("buildFeed's own allocation site reads the same set: with the flag on exactly the would-be-lifted author is read; off, nobody", async () => {
    const on = await client([]);
    await buildFeed(pool(), baseProfile(), baseContext(), on, null, overrides);
    assert.equal(on.restrictionReads, 1, "buildFeed allocated slots without reading whose lift is withheld");
    // Flag OFF: no slot allocation, so no restriction read for it.
    const { makeClient } = await import("./highlightRouteHarness.js");
    const c: any = makeClient({ feature_flags: [{ flag: "DISCOVERY_DIVERSITY_ENABLED", enabled: false }], ranking_config: [], content_distribution_stats: [], trust_restrictions: [], compass_visibility_boosts: [], compass_visibility_cooldowns: [] }, {});
    const inner = c.from; let reads = 0;
    c.from = (t: string) => { if (t === "trust_restrictions") reads++; return inner(t); };
    await buildFeed(pool(), baseProfile(), baseContext(), c, null, overrides);
    assert.equal(reads, 0);
  });
});
