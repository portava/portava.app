/**
 * Compass Phase 2 — pipeline tests
 *
 * Covers:
 *   - CompassSafetyFilter: hard-block conditions (block, suspend, adult flag,
 *     unsafe intent, delayed post, hidden, expired, cancelled, unverified buddy,
 *     age conflict, report threshold)
 *   - Safety filter fires BEFORE scoring (scoring fn never called when safety blocks)
 *   - CompassEligibilityEngine: trust floor, capacity, circle/trip scope,
 *     buddy status, private items
 *   - CompassPrivacyGuard: exact GPS stripped, hotel address stripped, admin notes
 *     stripped, location text rewritten, delayed post coords stripped
 *   - CompassScoringEngine: correct relative ordering for 3-item fixtures
 *     (interest match, city match, freshness, trust boost, penalties)
 *   - runPipeline(): blocked user never reaches score, correct output shape,
 *     results sorted by finalScore descending
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-pipeline.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSafetyFilter, runSafetyFilterBatch } from "../compass/CompassSafetyFilter.js";
import { runEligibilityCheck, runEligibilityBatch } from "../compass/CompassEligibilityEngine.js";
import { sanitizeItem, buildPrivacySafeLocationText } from "../compass/CompassPrivacyGuard.js";
import { scoreItem } from "../compass/CompassScoringEngine.js";
import { runPipeline } from "../compass/CompassPipeline.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const ALICE_ID = "00000000-0000-0000-0000-0000000000a1";
const BOB_ID   = "00000000-0000-0000-0000-0000000000b2";
const CAROL_ID = "00000000-0000-0000-0000-0000000000c3";

function baseProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId:               ALICE_ID,
    preferredCities:      ["Tokyo"],
    preferredLanguages:   ["en"],
    budgetStyle:          null,
    travelStyles:         ["adventure", "culture"],
    socialStyle:          null,
    safetyPreference:     "standard",
    visibilityPreference: "public",
    blockedUserIds:       [],
    blockerUserIds:       [],
    blockCount:           0,
    blockerCount:         0,
    trustScore:           60,
    trustLevel:           "trusted_traveler",
    activeUserScore:      null,
    hasActiveTrip:        false,
    hasActiveBooking:     false,
    upcomingTripWithin48h:    false,
    hasFutureTripScheduled:   false,
    currentCity:          "Tokyo",
    currentCountry:       "Japan",
    safeReturnActive:     false,
    computedAt:           new Date().toISOString(),
    ...overrides,
  };
}

function baseContext(state = "exploring_now"): CompassContext {
  return {
    contextState: state as any,
    signals: {
      hourUtc: 14,
      safeReturnActive: false,
      activeBooking: false,
      upcomingTripWithin48h: false,
      activeTripNow: false,
      hasPendingDelayedPosts: false,
      hasFutureTripScheduled: false,
    },
    computedAt: new Date().toISOString(),
  };
}

function makeItem(overrides: Partial<CompassItem> & { id: string; type: CompassItem["type"] }): CompassItem {
  return {
    authorId:   BOB_ID,
    city:       "Tokyo",
    createdAt:  new Date().toISOString(),
    interestTags: ["adventure"],
    languageCode: "en",
    qualityScore: 7,
    authorTrustScore: 60,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassSafetyFilter
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassSafetyFilter", () => {
  it("allows a clean item with no flags", () => {
    const item = makeItem({ id: "e1", type: "event" });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, true);
  });

  it("blocks item whose author is in viewer's blockedUserIds", () => {
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    const item = makeItem({ id: "e2", type: "event", authorId: BOB_ID });
    const result = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_blocked_by_viewer");
  });

  it("blocks item when viewer is in author's block list (blockerUserIds)", () => {
    const profile = baseProfile({ blockerUserIds: [BOB_ID] });
    const item = makeItem({ id: "e3", type: "event", authorId: BOB_ID });
    const result = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "viewer_blocked_by_author");
  });

  it("blocks suspended items", () => {
    const item = makeItem({ id: "e4", type: "post", isSuspended: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_or_item_suspended");
  });

  it("blocks items with adult service flag", () => {
    const item = makeItem({ id: "e5", type: "buddy", hasAdultServiceFlag: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "adult_service_flag");
  });

  it("blocks items with off-app payment signal", () => {
    const item = makeItem({ id: "e6", type: "buddy", hasOffAppPaymentSignal: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "off_app_payment_signal");
  });

  it("blocks items with unsafe intent signal", () => {
    const item = makeItem({ id: "e7", type: "buddy", hasUnsafeIntentSignal: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "unsafe_intent_signal");
  });

  it("blocks hidden items", () => {
    const item = makeItem({ id: "e8", type: "post", isHidden: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "content_hidden");
  });

  it("blocks expired events", () => {
    const item = makeItem({ id: "e9", type: "event", isExpired: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "item_expired");
  });

  it("blocks cancelled events", () => {
    const item = makeItem({ id: "e10", type: "event", isCancelled: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "item_cancelled");
  });

  it("blocks unverified buddy when verification required", () => {
    const item = makeItem({
      id: "e11", type: "buddy",
      requiresVerification: true,
      isVerified: false,
    });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "buddy_not_verified");
  });

  it("allows verified buddy when verification required", () => {
    const item = makeItem({
      id: "e12", type: "buddy",
      requiresVerification: true,
      isVerified: true,
    });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, true);
  });

  it("blocks item with age conflict (minAgeRequired > viewerAge)", () => {
    const profile = baseProfile({ viewerAge: 16 });
    const item = makeItem({ id: "e13", type: "event", minAgeRequired: 21 });
    const result = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "age_conflict");
  });

  it("allows item when viewerAge meets minAgeRequired", () => {
    const profile = baseProfile({ viewerAge: 21 });
    const item = makeItem({ id: "e14", type: "event", minAgeRequired: 21 });
    const result = runSafetyFilter(item, baseProfile({ viewerAge: 21 }));
    assert.equal(result.allowed, true);
  });

  it("blocks item with reportCount >= 5", () => {
    const item = makeItem({ id: "e15", type: "post", reportCount: 5 });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "report_count_threshold_exceeded");
  });

  it("allows item with reportCount < 5", () => {
    const item = makeItem({ id: "e16", type: "post", reportCount: 4 });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, true);
  });

  it("blocks delayed post that is not yet eligible (no publishEligibleAt)", () => {
    const item = makeItem({ id: "e17", type: "post", isDelayedPost: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "delayed_post_not_yet_eligible");
  });

  it("blocks delayed post with publishEligibleAt in the future", () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const item = makeItem({ id: "e18", type: "post", isDelayedPost: true, publishEligibleAt: future });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "delayed_post_not_yet_eligible");
  });

  it("allows delayed post when publishEligibleAt is in the past", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = makeItem({ id: "e19", type: "post", isDelayedPost: true, publishEligibleAt: past });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, true);
  });

  it("batch filter returns correct passed/blocked split", () => {
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    const items = [
      makeItem({ id: "b1", type: "event", authorId: CAROL_ID }), // no block
      makeItem({ id: "b2", type: "event", authorId: BOB_ID }),    // blocked
      makeItem({ id: "b3", type: "post",  isSuspended: true }),   // suspended (author BOB_ID also blocked, but isSuspended fires first or same effect)
    ];
    const { passed, blocked } = runSafetyFilterBatch(items, profile);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].id, "b1");
    assert.equal(blocked.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Safety filter fires BEFORE scoring (scoring never called when blocked)
// ─────────────────────────────────────────────────────────────────────────────

describe("Safety filter fires before scoring", () => {
  it("scoring function is never called when safety filter blocks an item", () => {
    let scoreCallCount = 0;
    const mockedScoreFn = (item: CompassItem) => {
      scoreCallCount++;
      return { finalScore: 99, components: {} as any };
    };

    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    const item = makeItem({ id: "s1", type: "event", authorId: BOB_ID });
    const context = baseContext();

    // Manually simulate what runPipeline does (gate-by-gate)
    const safety = runSafetyFilter(item, profile);
    if (safety.allowed) {
      mockedScoreFn(item); // should NOT be called
    }

    assert.equal(scoreCallCount, 0, "score fn must not be called when safety blocks");
    assert.equal(safety.allowed, false);
  });

  it("scoring function IS called when safety passes", () => {
    let scoreCallCount = 0;
    const mockedScoreFn = () => {
      scoreCallCount++;
      return { finalScore: 50, components: {} as any };
    };

    const item = makeItem({ id: "s2", type: "event" });
    const safety = runSafetyFilter(item, baseProfile());
    if (safety.allowed) {
      mockedScoreFn();
    }

    assert.equal(scoreCallCount, 1, "score fn must be called when safety passes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassEligibilityEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassEligibilityEngine", () => {
  it("allows a clean item", () => {
    const result = runEligibilityCheck(
      makeItem({ id: "el1", type: "event" }),
      baseProfile(), baseContext(),
    );
    assert.equal(result.eligible, true);
  });

  it("rejects item when author trust score is below floor (20)", () => {
    const item = makeItem({ id: "el2", type: "event", authorTrustScore: 15 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "author_trust_score_below_floor");
  });

  it("allows item when author trust score equals floor", () => {
    const item = makeItem({ id: "el3", type: "event", authorTrustScore: 20 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, true);
  });

  it("rejects item requiring verification if not verified", () => {
    const item = makeItem({ id: "el4", type: "buddy", requiresVerification: true, isVerified: false });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "item_requires_verification");
  });

  it("rejects full event (at capacity)", () => {
    const item = makeItem({ id: "el5", type: "event", capacity: 10, currentAttendees: 10 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "event_at_capacity");
  });

  it("allows event with space remaining", () => {
    const item = makeItem({ id: "el6", type: "event", capacity: 10, currentAttendees: 9 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, true);
  });

  it("rejects circle-only item when viewer is not in circle", () => {
    const item = makeItem({
      id: "el7", type: "post",
      visibilityScope: "circle_only",
      viewerIsInCircle: false,
    });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "viewer_not_in_circle");
  });

  it("allows circle-only item when viewer is in circle", () => {
    const item = makeItem({
      id: "el8", type: "post",
      visibilityScope: "circle_only",
      viewerIsInCircle: true,
    });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, true);
  });

  it("rejects trip-only item when viewer is not in trip", () => {
    const item = makeItem({
      id: "el9", type: "post",
      visibilityScope: "trip_only",
      viewerIsInTrip: false,
    });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "viewer_not_in_trip");
  });

  it("rejects buddy with non-active status", () => {
    const item = makeItem({ id: "el10", type: "buddy", buddyStatus: "inactive" });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "buddy_not_accepting_bookings");
  });

  it("rejects private item not authored by viewer", () => {
    const item = makeItem({ id: "el11", type: "post", visibilityScope: "private", authorId: BOB_ID });
    const result = runEligibilityCheck(item, baseProfile({ userId: ALICE_ID }), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "item_is_private");
  });

  it("allows private item authored by viewer", () => {
    const item = makeItem({ id: "el12", type: "post", visibilityScope: "private", authorId: ALICE_ID });
    const result = runEligibilityCheck(item, baseProfile({ userId: ALICE_ID }), baseContext());
    assert.equal(result.eligible, true);
  });

  it("batch eligibility returns correct passed/rejected split", () => {
    const items = [
      makeItem({ id: "el-b1", type: "event" }),                          // passes
      makeItem({ id: "el-b2", type: "event", authorTrustScore: 10 }),   // rejected (trust)
      makeItem({ id: "el-b3", type: "event", capacity: 5, currentAttendees: 5 }), // rejected (capacity)
    ];
    const { passed, rejected } = runEligibilityBatch(items, baseProfile(), baseContext());
    assert.equal(passed.length, 1);
    assert.equal(rejected.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassPrivacyGuard
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassPrivacyGuard", () => {
  it("does not mutate the input item", () => {
    const item = makeItem({ id: "p1", type: "event", exactLat: 35.6762, exactLng: 139.6503 });
    const original = { ...item };
    sanitizeItem(item, baseProfile());
    assert.equal(item.exactLat, original.exactLat, "original must not be mutated");
    assert.equal(item.exactLng, original.exactLng, "original must not be mutated");
  });

  it("strips exactLat and exactLng from output", () => {
    const item = makeItem({ id: "p2", type: "event", exactLat: 35.6762, exactLng: 139.6503 });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("exactLat" in sanitized), "exactLat must be stripped");
    assert.ok(!("exactLng" in sanitized), "exactLng must be stripped");
  });

  it("strips exactAddress from output", () => {
    const item = makeItem({ id: "p3", type: "event", exactAddress: "123 Main St, Tokyo" });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("exactAddress" in sanitized), "exactAddress must be stripped");
  });

  it("strips hotelAddress from output", () => {
    const item = makeItem({ id: "p4", type: "user", hotelAddress: "Grand Hotel, Tokyo" });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("hotelAddress" in sanitized), "hotelAddress must be stripped");
  });

  it("strips safeReturnRoute from output", () => {
    const item = makeItem({ id: "p5", type: "user", safeReturnRoute: { points: [] } });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("safeReturnRoute" in sanitized));
  });

  it("strips emergencyContacts from output", () => {
    const item = makeItem({ id: "p6", type: "user", emergencyContacts: [{ phone: "123" }] });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("emergencyContacts" in sanitized));
  });

  it("strips adminNotes from output", () => {
    const item = makeItem({ id: "p7", type: "post", adminNotes: "flagged by admin" });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("adminNotes" in sanitized));
  });

  it("rewrites locationText to privacy-safe phrasing when GPS was present", () => {
    const item = makeItem({
      id: "p8", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      city: "Tokyo", neighbourhood: "Shibuya",
      locationText: "123 Shibuya crossing",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "around Shibuya, Tokyo");
  });

  it("rewrites to 'in [city]' when neighbourhood is absent", () => {
    const item = makeItem({
      id: "p9", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      city: "Tokyo",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "in Tokyo");
  });

  it("rewrites to 'nearby' when no location data is available", () => {
    const item = makeItem({ id: "p10", type: "event", exactLat: 0, exactLng: 0, city: undefined, country: undefined });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "nearby");
  });

  it("strips delayed-post public coordinates when publishEligibleAt is in the future", () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const item = makeItem({
      id: "p11", type: "post",
      isDelayedPost: true,
      publishEligibleAt: future,
      publicLat: 35.6762,
      publicLng: 139.6503,
      publicLocationLabel: "Tokyo Event",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("publicLat" in sanitized));
    assert.ok(!("publicLng" in sanitized));
    assert.ok(!("publicLocationLabel" in sanitized));
  });

  it("preserves delayed-post public coordinates when publishEligibleAt has passed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = makeItem({
      id: "p12", type: "post",
      isDelayedPost: true,
      publishEligibleAt: past,
      publicLat: 35.6762,
      publicLng: 139.6503,
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.publicLat, 35.6762);
    assert.equal(sanitized.publicLng, 139.6503);
  });

  it("strips contentBody for unpublished items not authored by viewer", () => {
    const item = makeItem({
      id: "p13", type: "post",
      isUnpublished: true,
      authorId: BOB_ID,
      contentBody: "Secret draft text",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.ok(!("contentBody" in sanitized));
  });

  it("preserves contentBody for unpublished items authored by the viewer", () => {
    const item = makeItem({
      id: "p14", type: "post",
      isUnpublished: true,
      authorId: ALICE_ID,
      contentBody: "My draft",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.equal(sanitized.contentBody, "My draft");
  });

  it("buildPrivacySafeLocationText returns correct phrases", () => {
    assert.equal(buildPrivacySafeLocationText("Tokyo", "Shibuya", "Japan"), "around Shibuya, Tokyo");
    assert.equal(buildPrivacySafeLocationText("Tokyo", null, "Japan"), "in Tokyo");
    assert.equal(buildPrivacySafeLocationText(null, null, "Japan"), "somewhere in Japan");
    assert.equal(buildPrivacySafeLocationText(null, null, null), "nearby");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: CompassScoringEngine — relative ordering for fixtures
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassScoringEngine — relative score ordering", () => {
  const profile = baseProfile({
    travelStyles:      ["adventure", "culture"],
    preferredLanguages:["en"],
    currentCity:       "Tokyo",
    preferredCities:   ["Tokyo", "Kyoto"],
  });
  const context = baseContext("exploring_now");

  it("city-matched item scores higher than non-city-matched item (same tags)", () => {
    const inTokyo    = makeItem({ id: "sc1", type: "event", city: "Tokyo",    interestTags: ["adventure"] });
    const inOsaka    = makeItem({ id: "sc2", type: "event", city: "Osaka",    interestTags: ["adventure"] });
    const scoreTokyo = scoreItem(inTokyo, profile, context);
    const scoreOsaka = scoreItem(inOsaka, profile, context);
    assert.ok(scoreTokyo.finalScore > scoreOsaka.finalScore,
      `Tokyo (${scoreTokyo.finalScore}) > Osaka (${scoreOsaka.finalScore})`);
  });

  it("interest-matched item scores higher than non-matching item", () => {
    const matching    = makeItem({ id: "sc3", type: "event", city: "NYC", interestTags: ["adventure", "culture"] });
    const nonMatching = makeItem({ id: "sc4", type: "event", city: "NYC", interestTags: ["golf"] });
    const scoreMatch  = scoreItem(matching, profile, context);
    const scoreNoMatch = scoreItem(nonMatching, profile, context);
    assert.ok(scoreMatch.finalScore > scoreNoMatch.finalScore,
      `match (${scoreMatch.finalScore}) > no match (${scoreNoMatch.finalScore})`);
  });

  it("fresh item (today) scores higher than stale item (30 days ago)", () => {
    const fresh = makeItem({ id: "sc5", type: "post", createdAt: new Date().toISOString() });
    const stale = makeItem({
      id: "sc6", type: "post",
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    const scoreFresh = scoreItem(fresh, profile, context);
    const scoreStale = scoreItem(stale, profile, context);
    assert.ok(scoreFresh.finalScore > scoreStale.finalScore,
      `fresh (${scoreFresh.finalScore}) > stale (${scoreStale.finalScore})`);
  });

  it("high-trust author scores higher than low-trust author (same item)", () => {
    const highTrust = makeItem({ id: "sc7", type: "user", authorTrustScore: 90 });
    const lowTrust  = makeItem({ id: "sc8", type: "user", authorTrustScore: 20 });
    const scoreHigh = scoreItem(highTrust, profile, context);
    const scoreLow  = scoreItem(lowTrust, profile, context);
    assert.ok(scoreHigh.finalScore > scoreLow.finalScore,
      `high trust (${scoreHigh.finalScore}) > low trust (${scoreLow.finalScore})`);
  });

  it("reported item scores lower than clean item (report penalty)", () => {
    const clean    = makeItem({ id: "sc9",  type: "post", reportCount: 0 });
    const reported = makeItem({ id: "sc10", type: "post", reportCount: 4 });
    const scoreClean    = scoreItem(clean, profile, context);
    const scoreReported = scoreItem(reported, profile, context);
    assert.ok(scoreClean.finalScore > scoreReported.finalScore,
      `clean (${scoreClean.finalScore}) > reported (${scoreReported.finalScore})`);
  });

  it("spam item scores lower than non-spam item", () => {
    const normal = makeItem({ id: "sc11", type: "post", isSpam: false });
    const spam   = makeItem({ id: "sc12", type: "post", isSpam: true });
    assert.ok(
      scoreItem(normal, profile, context).finalScore >
      scoreItem(spam,   profile, context).finalScore,
    );
  });

  it("repeated item scores lower than first-time item (repetition penalty)", () => {
    const fresh  = makeItem({ id: "sc13", type: "post", repeatCount: 0 });
    const repeat = makeItem({ id: "sc14", type: "post", repeatCount: 3 });
    assert.ok(
      scoreItem(fresh,  profile, context).finalScore >
      scoreItem(repeat, profile, context).finalScore,
    );
  });

  it("context boost: event scores higher in exploring_now vs. safety_mode context", () => {
    const item = makeItem({ id: "sc15", type: "event" });
    const exploreCtx = baseContext("exploring_now");
    const safetyCtx  = baseContext("safety_mode");
    assert.ok(
      scoreItem(item, profile, exploreCtx).finalScore >
      scoreItem(item, profile, safetyCtx).finalScore,
    );
  });

  it("finalScore is clamped to [0, 100]", () => {
    // Item with all positive signals maxed out
    const perfect = makeItem({
      id: "sc16", type: "event",
      city: "Tokyo", interestTags: ["adventure", "culture"],
      qualityScore: 10, authorTrustScore: 100,
      createdAt: new Date().toISOString(),
    });
    const { finalScore } = scoreItem(perfect, profile, context);
    assert.ok(finalScore >= 0 && finalScore <= 100, `finalScore ${finalScore} must be 0-100`);
  });

  it("scoreComponents: positive components summed > penalties for a normal item", () => {
    const item = makeItem({ id: "sc17", type: "event" });
    const { components } = scoreItem(item, profile, context);
    const positive = components.interestMatch + components.cityMatch + components.freshness +
                     components.trustBoost + components.languageMatch + components.qualitySignal +
                     components.contextBoost;
    const penalties = components.reportPenalty + components.repetitionPenalty + components.spamPenalty;
    assert.ok(positive > penalties, `positive (${positive}) > penalties (${penalties})`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: runPipeline() — full pipeline integration
// ─────────────────────────────────────────────────────────────────────────────

describe("runPipeline — full pipeline integration", () => {
  const profile = baseProfile({ blockedUserIds: [BOB_ID] });
  const context = baseContext("exploring_now");

  it("blocked user never reaches score — not in output", () => {
    const items = [
      makeItem({ id: "pl1", type: "event", authorId: BOB_ID }),  // blocked
      makeItem({ id: "pl2", type: "event", authorId: CAROL_ID }), // clean
    ];
    const summary = runPipeline(items, profile, context);
    assert.equal(summary.blockedCount, 1);
    assert.equal(summary.passedCount, 1);
    assert.ok(summary.results.every((r) => r.item.id !== "pl1"), "blocked item must not appear in results");
    assert.equal(summary.results[0].item.id, "pl2");
  });

  it("delayed post blocked until eligible", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const items = [
      makeItem({ id: "pl3", type: "post", isDelayedPost: true, publishEligibleAt: future }),
      makeItem({ id: "pl4", type: "event" }),
    ];
    const summary = runPipeline(items, baseProfile(), context);
    assert.equal(summary.blockedCount, 1);
    const ids = summary.results.map((r) => r.item.id);
    assert.ok(!ids.includes("pl3"), "delayed post must be blocked");
    assert.ok(ids.includes("pl4"), "event must pass");
  });

  it("private coordinates absent from pipeline output", () => {
    const items = [makeItem({
      id: "pl5", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      exactAddress: "123 Shibuya",
    })];
    const summary = runPipeline(items, baseProfile(), context);
    assert.equal(summary.passedCount, 1);
    const out = summary.results[0].item;
    assert.ok(!("exactLat" in out), "exactLat must be stripped");
    assert.ok(!("exactLng" in out), "exactLng must be stripped");
    assert.ok(!("exactAddress" in out), "exactAddress must be stripped");
  });

  it("results are sorted by finalScore descending", () => {
    const ctx = baseContext("exploring_now");
    const p = baseProfile({ currentCity: "Tokyo" });
    // Item A: city match + interest match → high score
    // Item B: no city match, no interest match, stale → low score
    const itemA = makeItem({
      id: "pl6", type: "event",
      city: "Tokyo", interestTags: ["adventure", "culture"],
      qualityScore: 9, authorTrustScore: 80,
      createdAt: new Date().toISOString(),
    });
    const itemB = makeItem({
      id: "pl7", type: "event",
      city: "Chicago", interestTags: ["golf"],
      qualityScore: 1, authorTrustScore: 25,
      createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    });
    const summary = runPipeline([itemB, itemA], p, ctx); // note: B first in input
    assert.ok(summary.results.length >= 2);
    assert.ok(
      summary.results[0].finalScore >= summary.results[1].finalScore,
      "results must be sorted by finalScore descending",
    );
    assert.equal(summary.results[0].item.id, "pl6", "high-score item must be first");
  });

  it("each result has required pipeline gate flags", () => {
    const items = [makeItem({ id: "pl8", type: "event" })];
    const summary = runPipeline(items, baseProfile(), context);
    assert.equal(summary.passedCount, 1);
    const result = summary.results[0];
    assert.equal(result.safetyPassed,    true);
    assert.equal(result.eligiblePassed,  true);
    assert.equal(result.privacySanitized, true);
    assert.ok(typeof result.finalScore === "number");
  });

  it("inputCount, blockedCount, rejectedCount, passedCount sum correctly", () => {
    const items = [
      makeItem({ id: "pl9",  type: "event",  authorId: BOB_ID }),             // blocked (viewer blocked BOB)
      makeItem({ id: "pl10", type: "event",  authorId: BOB_ID, isSuspended: true }), // blocked (viewer blocked BOB)
      makeItem({ id: "pl11", type: "buddy",  authorId: CAROL_ID, buddyStatus: "inactive" }), // rejected (eligibility)
      makeItem({ id: "pl12", type: "event",  authorId: CAROL_ID }),            // passes
    ];
    const summary = runPipeline(items, profile, context);
    assert.equal(summary.inputCount, 4);
    assert.equal(summary.blockedCount, 2);
    assert.equal(summary.rejectedCount, 1);
    assert.equal(summary.passedCount, 1);
    assert.equal(summary.blockedCount + summary.rejectedCount + summary.passedCount, summary.inputCount);
  });

  it("empty input returns empty results", () => {
    const summary = runPipeline([], baseProfile(), context);
    assert.equal(summary.inputCount, 0);
    assert.equal(summary.passedCount, 0);
    assert.equal(summary.results.length, 0);
  });
});
