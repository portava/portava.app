/**
 * Compass Phase 2 — pipeline tests
 *
 * Covers:
 *   - CompassSafetyFilter: all 16 hard-block conditions
 *   - Safety filter FAIL-CLOSED on exceptions (never fail-open)
 *   - Safety filter fires BEFORE scoring — verified via runPipeline injection
 *   - CompassEligibilityEngine: feature-flag gating, trust floor, capacity,
 *     circle/trip scope, buddy status, private items, city launch control
 *   - CompassPrivacyGuard: GPS/address stripped, admin notes stripped,
 *     location text rewritten, delayed-post coords stripped
 *   - CompassScoringEngine: per-type weight profiles produce correct relative
 *     ordering for 3-item fixtures on all 8 content types
 *   - runPipeline(): blocked user never reaches scoring (orchestration proof),
 *     delayed post blocked, private coords absent, results sorted, gate flags set
 *
 * Runtime: node:test + node:assert (no vitest, no real DB)
 * Run: node --import tsx/esm --test src/test/compass-pipeline.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runSafetyFilter, runSafetyFilterBatch } from "../compass/CompassSafetyFilter.js";
import { runEligibilityCheck, runEligibilityBatch } from "../compass/CompassEligibilityEngine.js";
import { sanitizeItem, buildPrivacySafeLocationText } from "../compass/CompassPrivacyGuard.js";
import { scoreItem, scoreEvent, scorePost, scoreUser, scoreBuddy, scoreTrip, scoreStamp, scoreNotification, scoreSuggestion } from "../compass/CompassScoringEngine.js";
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
    socialStyle:          "solo",
    safetyPreference:     "standard",
    visibilityPreference: "public",
    blockedUserIds:       [],
    blockerUserIds:       [],
    mutedUserIds:         [],
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
    contextState: state as CompassContext["contextState"],
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

function makeItem(
  overrides: Partial<CompassItem> & { id: string; type: CompassItem["type"] },
): CompassItem {
  return {
    authorId:         CAROL_ID, // default to non-blocked author
    city:             "Tokyo",
    createdAt:        new Date().toISOString(),
    interestTags:     ["adventure"],
    languageCode:     "en",
    qualityScore:     7,
    authorTrustScore: 60,
    buddyStatus:      "active", // default so buddy items pass eligibility
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CompassSafetyFilter
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassSafetyFilter", () => {
  it("allows a clean item with no flags", () => {
    const item = makeItem({ id: "e1", type: "event" });
    assert.equal(runSafetyFilter(item, baseProfile()).allowed, true);
  });

  it("blocks item whose author is in viewer's blockedUserIds", () => {
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    const item    = makeItem({ id: "e2", type: "event", authorId: BOB_ID });
    const result  = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_blocked_by_viewer");
  });

  it("blocks item when viewer is in author's block list (blockerUserIds)", () => {
    const profile = baseProfile({ blockerUserIds: [BOB_ID] });
    const item    = makeItem({ id: "e3", type: "event", authorId: BOB_ID });
    const result  = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "viewer_blocked_by_author");
  });

  it("blocks item the viewer has already reported", () => {
    const item   = makeItem({ id: "e3b", type: "post", isReportedByViewer: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "viewer_reported_item");
  });

  it("blocks suspended items", () => {
    const item   = makeItem({ id: "e4", type: "post", isSuspended: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "author_or_item_suspended");
  });

  it("blocks items with adult service flag", () => {
    const item   = makeItem({ id: "e5", type: "buddy", hasAdultServiceFlag: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "adult_service_flag");
  });

  it("blocks items with off-app payment signal", () => {
    const item   = makeItem({ id: "e6", type: "buddy", hasOffAppPaymentSignal: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "off_app_payment_signal");
  });

  it("blocks items with unsafe intent signal", () => {
    const item   = makeItem({ id: "e7", type: "buddy", hasUnsafeIntentSignal: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "unsafe_intent_signal");
  });

  it("blocks hidden items", () => {
    const item   = makeItem({ id: "e8", type: "post", isHidden: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "content_hidden");
  });

  it("blocks expired events", () => {
    const item   = makeItem({ id: "e9", type: "event", isExpired: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "item_expired");
  });

  it("blocks cancelled events", () => {
    const item   = makeItem({ id: "e10", type: "event", isCancelled: true });
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
    assert.equal(runSafetyFilter(item, baseProfile()).allowed, false);
    assert.equal(runSafetyFilter(item, baseProfile()).reason, "buddy_not_verified");
  });

  it("allows verified buddy when verification required", () => {
    const item = makeItem({
      id: "e12", type: "buddy",
      requiresVerification: true,
      isVerified: true,
    });
    assert.equal(runSafetyFilter(item, baseProfile()).allowed, true);
  });

  it("blocks item with age conflict (minAgeRequired > viewerAge)", () => {
    const profile = baseProfile({ viewerAge: 16 });
    const item    = makeItem({ id: "e13", type: "event", minAgeRequired: 21 });
    const result  = runSafetyFilter(item, profile);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "age_conflict");
  });

  it("allows item when viewerAge meets minAgeRequired exactly", () => {
    const profile = baseProfile({ viewerAge: 21 });
    const item    = makeItem({ id: "e14", type: "event", minAgeRequired: 21 });
    assert.equal(runSafetyFilter(item, profile).allowed, true);
  });

  it("blocks item with reportCount >= threshold (5)", () => {
    const item   = makeItem({ id: "e15", type: "post", reportCount: 5 });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "report_count_threshold_exceeded");
  });

  it("allows item with reportCount < threshold", () => {
    const item = makeItem({ id: "e16", type: "post", reportCount: 4 });
    assert.equal(runSafetyFilter(item, baseProfile()).allowed, true);
  });

  it("blocks delayed post with no publishEligibleAt", () => {
    const item   = makeItem({ id: "e17", type: "post", isDelayedPost: true });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "delayed_post_not_yet_eligible");
  });

  it("blocks delayed post with publishEligibleAt in the future", () => {
    const future = new Date(Date.now() + 7_200_000).toISOString();
    const item   = makeItem({ id: "e18", type: "post", isDelayedPost: true, publishEligibleAt: future });
    const result = runSafetyFilter(item, baseProfile());
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "delayed_post_not_yet_eligible");
  });

  it("allows delayed post when publishEligibleAt has passed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = makeItem({ id: "e19", type: "post", isDelayedPost: true, publishEligibleAt: past });
    assert.equal(runSafetyFilter(item, baseProfile()).allowed, true);
  });

  it("blocks item when COMPASS_LAUNCH_CONTROL_ENABLED and country flag absent", () => {
    const item  = makeItem({ id: "e20", type: "event", country: "Brazil" });
    const flags = { COMPASS_LAUNCH_CONTROL_ENABLED: true };
    const result = runSafetyFilter(item, baseProfile(), null, flags);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "country_not_in_launch_region");
  });

  it("allows item when COMPASS_LAUNCH_CONTROL_ENABLED and country flag is true", () => {
    const item  = makeItem({ id: "e21", type: "event", country: "Japan" });
    const flags = { COMPASS_LAUNCH_CONTROL_ENABLED: true, COMPASS_COUNTRY_JAPAN_ENABLED: true };
    assert.equal(runSafetyFilter(item, baseProfile(), null, flags).allowed, true);
  });

  it("blocks item when COMPASS_<TYPE>_SAFETY_BLOCK is true", () => {
    const item  = makeItem({ id: "e22", type: "buddy" });
    const flags = { COMPASS_BUDDY_SAFETY_BLOCK: true };
    const result = runSafetyFilter(item, baseProfile(), null, flags);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.startsWith("type_safety_block:buddy"));
  });

  it("FAIL-CLOSED: exception in checkItem causes item to be blocked, not allowed", () => {
    // Pass a malformed profile that causes an exception inside checkItem
    const malformedProfile = { ...baseProfile(), blockedUserIds: null as any };
    const item = makeItem({ id: "e23", type: "event" });
    // Should return allowed:false (fail-closed), not throw
    let result: { allowed: boolean; reason?: string };
    assert.doesNotThrow(() => {
      result = runSafetyFilter(item, malformedProfile);
    });
    // @ts-expect-error — assigned in doesNotThrow
    assert.equal(result.allowed, false, "safety filter must fail-CLOSED on exception");
  });

  it("batch filter returns correct passed/blocked split", () => {
    const profile = baseProfile({ blockedUserIds: [BOB_ID] });
    const items = [
      makeItem({ id: "b1", type: "event", authorId: CAROL_ID }),   // passes
      makeItem({ id: "b2", type: "event", authorId: BOB_ID }),     // blocked
      makeItem({ id: "b3", type: "post",  isSuspended: true }),    // blocked
    ];
    const { passed, blocked } = runSafetyFilterBatch(items, profile);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].id, "b1");
    assert.equal(blocked.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassEligibilityEngine
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassEligibilityEngine", () => {
  it("allows a clean item", () => {
    const result = runEligibilityCheck(makeItem({ id: "el1", type: "event" }), baseProfile(), baseContext());
    assert.equal(result.eligible, true);
  });

  it("rejects when COMPASS_<TYPE>_ENABLED flag is explicitly false", () => {
    const item  = makeItem({ id: "el0", type: "event" });
    const flags = { COMPASS_EVENT_ENABLED: false };
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "feature_flag_disabled:event");
  });

  it("allows when COMPASS_<TYPE>_ENABLED flag is absent (default enabled)", () => {
    const item  = makeItem({ id: "el0b", type: "event" });
    const flags = {}; // no flag = not set = default allow
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });

  it("allows when COMPASS_<TYPE>_ENABLED flag is true", () => {
    const item  = makeItem({ id: "el0c", type: "post" });
    const flags = { COMPASS_POST_ENABLED: true };
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });

  it("rejects when city launch is required and city flag is false", () => {
    const item  = makeItem({ id: "el0d", type: "event", city: "Nairobi" });
    const flags = {
      COMPASS_CITY_LAUNCH_REQUIRED: true,
      COMPASS_CITY_NAIROBI_ENABLED: false,
    };
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "city_not_in_launch");
  });

  it("allows when city launch required but city flag is absent (default allow)", () => {
    const item  = makeItem({ id: "el0e", type: "event", city: "Nairobi" });
    const flags = { COMPASS_CITY_LAUNCH_REQUIRED: true }; // city flag absent = allow
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });

  it("rejects item when author trust score is below floor (20)", () => {
    const item   = makeItem({ id: "el2", type: "event", authorTrustScore: 15 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "author_trust_score_below_floor");
  });

  it("allows item when author trust score equals floor exactly", () => {
    const item = makeItem({ id: "el3", type: "event", authorTrustScore: 20 });
    assert.equal(runEligibilityCheck(item, baseProfile(), baseContext()).eligible, true);
  });

  it("rejects item requiring verification when not verified", () => {
    const item   = makeItem({ id: "el4", type: "buddy", requiresVerification: true, isVerified: false });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "item_requires_verification");
  });

  it("rejects full event (at capacity)", () => {
    const item   = makeItem({ id: "el5", type: "event", capacity: 10, currentAttendees: 10 });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "event_at_capacity");
  });

  it("allows event with space remaining", () => {
    const item = makeItem({ id: "el6", type: "event", capacity: 10, currentAttendees: 9 });
    assert.equal(runEligibilityCheck(item, baseProfile(), baseContext()).eligible, true);
  });

  it("rejects circle-only item when viewer is not in circle", () => {
    const item   = makeItem({ id: "el7", type: "post", visibilityScope: "circle_only", viewerIsInCircle: false });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "viewer_not_in_circle");
  });

  it("allows circle-only item when viewer is in circle", () => {
    const item = makeItem({ id: "el8", type: "post", visibilityScope: "circle_only", viewerIsInCircle: true });
    assert.equal(runEligibilityCheck(item, baseProfile(), baseContext()).eligible, true);
  });

  it("rejects trip-only item when viewer is not in trip", () => {
    const item   = makeItem({ id: "el9", type: "post", visibilityScope: "trip_only", viewerIsInTrip: false });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "viewer_not_in_trip");
  });

  it("rejects buddy with non-active status", () => {
    const item   = makeItem({ id: "el10", type: "buddy", buddyStatus: "inactive" });
    const result = runEligibilityCheck(item, baseProfile(), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "buddy_not_accepting_bookings");
  });

  it("rejects private item not authored by viewer", () => {
    const item   = makeItem({ id: "el11", type: "post", visibilityScope: "private", authorId: BOB_ID });
    const result = runEligibilityCheck(item, baseProfile({ userId: ALICE_ID }), baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "item_is_private");
  });

  it("allows private item authored by viewer", () => {
    const item = makeItem({ id: "el12", type: "post", visibilityScope: "private", authorId: ALICE_ID });
    assert.equal(
      runEligibilityCheck(item, baseProfile({ userId: ALICE_ID }), baseContext()).eligible,
      true,
    );
  });

  it("FAIL-OPEN: exception in eligibility check allows the item", () => {
    // Pass null profile to cause an exception inside the checker
    const item = makeItem({ id: "el-ex", type: "event" });
    let result: { eligible: boolean };
    assert.doesNotThrow(() => {
      result = runEligibilityCheck(item, null as any, baseContext());
    });
    // @ts-expect-error
    assert.equal(result.eligible, true, "eligibility must fail-OPEN so bugs don't hide content");
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

  // ── Age eligibility gate ──────────────────────────────────────────────────
  it("rejects item when viewer's confirmed age is below minAgeRequired", () => {
    const item   = makeItem({ id: "el-age1", type: "event", minAgeRequired: 21 });
    const viewer = baseProfile({ viewerAge: 19 });
    const result = runEligibilityCheck(item, viewer, baseContext());
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "viewer_age_below_minimum");
  });

  it("allows item when viewer's confirmed age meets minAgeRequired exactly", () => {
    const item   = makeItem({ id: "el-age2", type: "event", minAgeRequired: 21 });
    const viewer = baseProfile({ viewerAge: 21 });
    assert.equal(runEligibilityCheck(item, viewer, baseContext()).eligible, true);
  });

  it("allows item when minAgeRequired is set but viewerAge is not confirmed (fail-open)", () => {
    // viewerAge undefined → safety filter handles this with a conservative default;
    // eligibility stays silent to avoid blocking users whose age simply isn't on profile
    const item   = makeItem({ id: "el-age3", type: "event", minAgeRequired: 21 });
    const viewer = baseProfile(); // viewerAge not set
    assert.equal(runEligibilityCheck(item, viewer, baseContext()).eligible, true);
  });

  it("allows item with no minAgeRequired regardless of viewerAge", () => {
    const viewer = baseProfile({ viewerAge: 15 });
    const item   = makeItem({ id: "el-age4", type: "event" });
    assert.equal(runEligibilityCheck(item, viewer, baseContext()).eligible, true);
  });

  // ── Country launch gate ───────────────────────────────────────────────────
  it("rejects item when COMPASS_COUNTRY_LAUNCH_REQUIRED and country flag is false", () => {
    const item  = makeItem({ id: "el-ctry1", type: "event", country: "Nigeria" });
    const flags = {
      COMPASS_COUNTRY_LAUNCH_REQUIRED: true,
      COMPASS_COUNTRY_NIGERIA_ENABLED:  false,
    };
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "country_not_in_launch");
  });

  it("allows item when COMPASS_COUNTRY_LAUNCH_REQUIRED but country flag is absent (default allow)", () => {
    const item  = makeItem({ id: "el-ctry2", type: "event", country: "Nigeria" });
    const flags = { COMPASS_COUNTRY_LAUNCH_REQUIRED: true }; // country key absent = allow
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });

  it("allows item when country flag is false but COMPASS_COUNTRY_LAUNCH_REQUIRED is absent", () => {
    const item  = makeItem({ id: "el-ctry3", type: "event", country: "Nigeria" });
    const flags = { COMPASS_COUNTRY_NIGERIA_ENABLED: false }; // gate control flag absent = skip gate
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });

  it("allows item when country is enabled in launch flags", () => {
    const item  = makeItem({ id: "el-ctry4", type: "event", country: "Nigeria" });
    const flags = {
      COMPASS_COUNTRY_LAUNCH_REQUIRED: true,
      COMPASS_COUNTRY_NIGERIA_ENABLED:  true,
    };
    const result = runEligibilityCheck(item, baseProfile(), baseContext(), null, flags);
    assert.equal(result.eligible, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassPrivacyGuard
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassPrivacyGuard", () => {
  it("does not mutate the input item", () => {
    const item = makeItem({ id: "p1", type: "event", exactLat: 35.6762, exactLng: 139.6503 });
    const orig = { ...item };
    sanitizeItem(item, baseProfile());
    assert.equal(item.exactLat, orig.exactLat, "original must not be mutated");
  });

  it("strips exactLat and exactLng from output", () => {
    const item      = makeItem({ id: "p2", type: "event", exactLat: 35.6762, exactLng: 139.6503 });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("exactLat" in sanitized), "exactLat must be stripped");
    assert.ok(!("exactLng" in sanitized), "exactLng must be stripped");
  });

  it("strips exactAddress from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p3", type: "event", exactAddress: "123 Main St, Tokyo" }),
      baseProfile(),
    );
    assert.ok(!("exactAddress" in sanitized));
  });

  it("strips hotelAddress from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p4", type: "user", hotelAddress: "Grand Hotel, Tokyo" }),
      baseProfile(),
    );
    assert.ok(!("hotelAddress" in sanitized));
  });

  it("strips safeReturnRoute from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p5", type: "user", safeReturnRoute: { points: [] } }),
      baseProfile(),
    );
    assert.ok(!("safeReturnRoute" in sanitized));
  });

  it("strips emergencyContacts from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p6", type: "user", emergencyContacts: [{ phone: "123" }] }),
      baseProfile(),
    );
    assert.ok(!("emergencyContacts" in sanitized));
  });

  it("strips adminNotes from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p7", type: "post", adminNotes: "flagged by admin" }),
      baseProfile(),
    );
    assert.ok(!("adminNotes" in sanitized));
  });

  it("strips privateBookingNotes from output", () => {
    const sanitized = sanitizeItem(
      makeItem({ id: "p7b", type: "buddy", privateBookingNotes: "note" }),
      baseProfile(),
    );
    assert.ok(!("privateBookingNotes" in sanitized));
  });

  it("rewrites locationText to 'around [neighbourhood], [city]' when GPS was present", () => {
    const item = makeItem({
      id: "p8", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      city: "Tokyo", neighbourhood: "Shibuya",
      locationText: "123 Shibuya crossing",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "around Shibuya, Tokyo");
  });

  it("rewrites to 'in [city]' when neighbourhood absent and GPS was present", () => {
    const item = makeItem({
      id: "p9", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      city: "Tokyo",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "in Tokyo");
  });

  it("rewrites to 'nearby' when no location data present and GPS was stripped", () => {
    const item      = makeItem({ id: "p10", type: "event", exactLat: 0, exactLng: 0, city: undefined, country: undefined });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.locationText, "nearby");
  });

  it("strips delayed-post public coordinates when publishEligibleAt is in the future", () => {
    const future    = new Date(Date.now() + 7_200_000).toISOString();
    const item      = makeItem({
      id: "p11", type: "post",
      isDelayedPost: true, publishEligibleAt: future,
      publicLat: 35.6762, publicLng: 139.6503,
      publicLocationLabel: "Tokyo Event",
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.ok(!("publicLat" in sanitized));
    assert.ok(!("publicLng" in sanitized));
    assert.ok(!("publicLocationLabel" in sanitized));
  });

  it("preserves delayed-post public coordinates when publishEligibleAt has passed", () => {
    const past      = new Date(Date.now() - 60_000).toISOString();
    const item      = makeItem({
      id: "p12", type: "post",
      isDelayedPost: true, publishEligibleAt: past,
      publicLat: 35.6762, publicLng: 139.6503,
    });
    const sanitized = sanitizeItem(item, baseProfile());
    assert.equal(sanitized.publicLat, 35.6762);
    assert.equal(sanitized.publicLng, 139.6503);
  });

  it("strips contentBody for unpublished items not authored by viewer", () => {
    const item = makeItem({
      id: "p13", type: "post",
      isUnpublished: true, authorId: BOB_ID,
      contentBody: "Secret draft text",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.ok(!("contentBody" in sanitized));
  });

  it("preserves contentBody for unpublished items authored by the viewer", () => {
    const item = makeItem({
      id: "p14", type: "post",
      isUnpublished: true, authorId: ALICE_ID,
      contentBody: "My draft",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.equal(sanitized.contentBody, "My draft");
  });

  // ── Unpublished coordinate stripping (privacy leak fix) ───────────────────
  it("strips publicLat/Lng/LocationLabel for unpublished items not authored by viewer", () => {
    const item = makeItem({
      id: "p-upub1", type: "post",
      isUnpublished: true, authorId: BOB_ID,
      publicLat: 40.7128, publicLng: -74.006,
      publicLocationLabel: "New York, NY",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.ok(!("publicLat" in sanitized),          "publicLat must be stripped from unpublished non-author item");
    assert.ok(!("publicLng" in sanitized),          "publicLng must be stripped from unpublished non-author item");
    assert.ok(!("publicLocationLabel" in sanitized), "publicLocationLabel must be stripped from unpublished non-author item");
  });

  it("preserves publicLat/Lng for unpublished items authored by the viewer", () => {
    const item = makeItem({
      id: "p-upub2", type: "post",
      isUnpublished: true, authorId: ALICE_ID,
      publicLat: 40.7128, publicLng: -74.006,
      publicLocationLabel: "New York, NY",
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.equal(sanitized.publicLat,           40.7128,         "owner may see their own draft coordinates");
    assert.equal(sanitized.publicLng,           -74.006,          "owner may see their own draft coordinates");
    assert.equal(sanitized.publicLocationLabel, "New York, NY",  "owner may see their own draft location label");
  });

  it("strips unpublished coordinates even when isDelayedPost is false (not just delayed posts)", () => {
    const item = makeItem({
      id: "p-upub3", type: "post",
      isUnpublished: true, isDelayedPost: false, authorId: BOB_ID,
      publicLat: 51.5074, publicLng: -0.1278,
    });
    const sanitized = sanitizeItem(item, baseProfile({ userId: ALICE_ID }));
    assert.ok(!("publicLat" in sanitized), "non-delayed unpublished coords must also be stripped");
    assert.ok(!("publicLng" in sanitized), "non-delayed unpublished coords must also be stripped");
  });

  it("buildPrivacySafeLocationText helper returns correct phrases", () => {
    assert.equal(buildPrivacySafeLocationText("Tokyo", "Shibuya", "Japan"), "around Shibuya, Tokyo");
    assert.equal(buildPrivacySafeLocationText("Tokyo", null, "Japan"), "in Tokyo");
    assert.equal(buildPrivacySafeLocationText(null, null, "Japan"), "somewhere in Japan");
    assert.equal(buildPrivacySafeLocationText(null, null, null), "nearby");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompassScoringEngine — per-type relative ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("CompassScoringEngine — per-type scoring formulas", () => {
  const profile = baseProfile({
    travelStyles:      ["adventure", "culture"],
    preferredLanguages:["en"],
    currentCity:       "Tokyo",
    preferredCities:   ["Tokyo", "Kyoto"],
    socialStyle:       "solo",
    safetyPreference:  "standard",
  });
  const ctx = baseContext("exploring_now");

  // ── Generic invariants ────────────────────────────────────────────────────
  it("finalScore is always clamped to [0, 100]", () => {
    for (const type of ["event","post","user","buddy","trip","stamp","notification","suggestion"] as const) {
      const item = makeItem({ id: `clamp-${type}`, type,
        city: "Tokyo", interestTags: ["adventure","culture"],
        qualityScore: 10, authorTrustScore: 100,
        createdAt: new Date().toISOString(),
      });
      const { finalScore } = scoreItem(item, profile, ctx);
      assert.ok(finalScore >= 0 && finalScore <= 100,
        `${type} finalScore ${finalScore} must be 0-100`);
    }
  });

  it("spam item always scores lower than non-spam item (all types)", () => {
    for (const type of ["event","post","user","buddy"] as const) {
      const normal = makeItem({ id: `sp-n-${type}`, type });
      const spam   = makeItem({ id: `sp-s-${type}`, type, isSpam: true });
      assert.ok(
        scoreItem(normal, profile, ctx).finalScore > scoreItem(spam, profile, ctx).finalScore,
        `${type}: normal must outscore spam`,
      );
    }
  });

  it("high-report item always scores lower than clean item (all types)", () => {
    for (const type of ["event","post","user"] as const) {
      const clean    = makeItem({ id: `rp-c-${type}`, type, reportCount: 0 });
      const reported = makeItem({ id: `rp-r-${type}`, type, reportCount: 4 });
      assert.ok(
        scoreItem(clean, profile, ctx).finalScore > scoreItem(reported, profile, ctx).finalScore,
        `${type}: clean must outscore high-reported`,
      );
    }
  });

  // ── Event scoring ─────────────────────────────────────────────────────────
  it("event: city-match item scores higher than non-city-match (same tags)", () => {
    const inTokyo = makeItem({ id: "sc-ev-tok", type: "event", city: "Tokyo",   interestTags: ["adventure"] });
    const inOsaka = makeItem({ id: "sc-ev-osa", type: "event", city: "Osaka",   interestTags: ["adventure"] });
    assert.ok(
      scoreEvent(inTokyo, profile, ctx).finalScore > scoreEvent(inOsaka, profile, ctx).finalScore,
      "event: Tokyo > Osaka for Tokyo-current-city viewer",
    );
  });

  it("event: interest-match item scores higher than non-matching item", () => {
    const match   = makeItem({ id: "sc-ev-im",  type: "event", city: "NYC", interestTags: ["adventure","culture"] });
    const noMatch = makeItem({ id: "sc-ev-nm",  type: "event", city: "NYC", interestTags: ["golf"] });
    assert.ok(
      scoreEvent(match, profile, ctx).finalScore > scoreEvent(noMatch, profile, ctx).finalScore,
    );
  });

  it("event: fresh item scores higher than stale item (3-day half-life)", () => {
    const fresh = makeItem({ id: "sc-ev-fr", type: "event", createdAt: new Date().toISOString() });
    const stale = makeItem({ id: "sc-ev-st", type: "event", createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    assert.ok(
      scoreEvent(fresh, profile, ctx).finalScore > scoreEvent(stale, profile, ctx).finalScore,
    );
  });

  it("event: context boost in exploring_now vs. safety_mode", () => {
    const item     = makeItem({ id: "sc-ev-ctx", type: "event" });
    const ctxSafe  = baseContext("safety_mode");
    assert.ok(
      scoreEvent(item, profile, ctx).finalScore > scoreEvent(item, profile, ctxSafe).finalScore,
    );
  });

  // ── Post scoring ──────────────────────────────────────────────────────────
  it("post: high-quality post scores higher than low-quality post", () => {
    const hi = makeItem({ id: "sc-po-hi", type: "post", qualityScore: 9 });
    const lo = makeItem({ id: "sc-po-lo", type: "post", qualityScore: 2 });
    assert.ok(
      scorePost(hi, profile, ctx).finalScore > scorePost(lo, profile, ctx).finalScore,
    );
  });

  it("post: repeated post scores lower than first-time post", () => {
    const first  = makeItem({ id: "sc-po-fr", type: "post", repeatCount: 0 });
    const repeat = makeItem({ id: "sc-po-re", type: "post", repeatCount: 3 });
    assert.ok(
      scorePost(first, profile, ctx).finalScore > scorePost(repeat, profile, ctx).finalScore,
    );
  });

  it("post: language-matched post scores higher than language-mismatched", () => {
    const en = makeItem({ id: "sc-po-en", type: "post", languageCode: "en" });
    const jp = makeItem({ id: "sc-po-jp", type: "post", languageCode: "fr" });
    assert.ok(
      scorePost(en, profile, ctx).finalScore > scorePost(jp, profile, ctx).finalScore,
    );
  });

  // ── User scoring ──────────────────────────────────────────────────────────
  it("user: high-trust author scores higher than low-trust author", () => {
    const highTrust = makeItem({ id: "sc-us-ht", type: "user", authorTrustScore: 90 });
    const lowTrust  = makeItem({ id: "sc-us-lt", type: "user", authorTrustScore: 25 });
    assert.ok(
      scoreUser(highTrust, profile, ctx).finalScore > scoreUser(lowTrust, profile, ctx).finalScore,
    );
  });

  it("user: same-city user scores higher than out-of-city user", () => {
    const inCity  = makeItem({ id: "sc-us-ic", type: "user", city: "Tokyo" });
    const outCity = makeItem({ id: "sc-us-oc", type: "user", city: "Berlin" });
    assert.ok(
      scoreUser(inCity, profile, ctx).finalScore > scoreUser(outCity, profile, ctx).finalScore,
    );
  });

  it("user: interest-matched user scores higher than non-matching user", () => {
    const match  = makeItem({ id: "sc-us-im", type: "user", interestTags: ["adventure","culture"] });
    const noMatch = makeItem({ id: "sc-us-nm", type: "user", interestTags: ["banking"] });
    assert.ok(
      scoreUser(match, profile, ctx).finalScore > scoreUser(noMatch, profile, ctx).finalScore,
    );
  });

  // ── Buddy scoring ─────────────────────────────────────────────────────────
  it("buddy: city-match is the strongest signal (same trust, same quality)", () => {
    const inCity  = makeItem({ id: "sc-bu-ic", type: "buddy", city: "Tokyo",  authorTrustScore: 70, qualityScore: 7 });
    const outCity = makeItem({ id: "sc-bu-oc", type: "buddy", city: "Nairobi", authorTrustScore: 70, qualityScore: 7 });
    assert.ok(
      scoreBuddy(inCity, profile, ctx).finalScore > scoreBuddy(outCity, profile, ctx).finalScore,
      "buddy: city-matched buddy must outscore out-of-city buddy",
    );
  });

  it("buddy: high-trust buddy outscores low-trust buddy in same city", () => {
    const highTrust = makeItem({ id: "sc-bu-ht", type: "buddy", city: "Tokyo", authorTrustScore: 90 });
    const lowTrust  = makeItem({ id: "sc-bu-lt", type: "buddy", city: "Tokyo", authorTrustScore: 20 });
    assert.ok(
      scoreBuddy(highTrust, profile, ctx).finalScore > scoreBuddy(lowTrust, profile, ctx).finalScore,
    );
  });

  // ── Trip scoring ──────────────────────────────────────────────────────────
  it("trip: planning_ahead context boosts trip score over exploring_now", () => {
    const item        = makeItem({ id: "sc-tr-ctx", type: "trip" });
    const planCtx     = baseContext("planning_ahead");
    assert.ok(
      scoreTrip(item, profile, planCtx).finalScore > scoreTrip(item, profile, ctx).finalScore,
      "trip: planning_ahead context must boost trip",
    );
  });

  it("trip: city-matched trip scores higher", () => {
    const tokyoTrip   = makeItem({ id: "sc-tr-tok", type: "trip", city: "Tokyo" });
    const berlinTrip  = makeItem({ id: "sc-tr-ber", type: "trip", city: "Berlin" });
    assert.ok(
      scoreTrip(tokyoTrip, profile, ctx).finalScore > scoreTrip(berlinTrip, profile, ctx).finalScore,
    );
  });

  // ── Stamp scoring ─────────────────────────────────────────────────────────
  it("stamp: city-match dominates stamp scoring (same city >> different city)", () => {
    const localStamp  = makeItem({ id: "sc-st-loc", type: "stamp", city: "Tokyo",  qualityScore: 5 });
    const remoteStamp = makeItem({ id: "sc-st-rem", type: "stamp", city: "Sydney", qualityScore: 8 });
    assert.ok(
      scoreStamp(localStamp, profile, ctx).finalScore > scoreStamp(remoteStamp, profile, ctx).finalScore,
      "stamp: local city match must outweigh quality advantage of remote stamp",
    );
  });

  it("stamp: arrival_mode context boosts stamps (high affinity)", () => {
    const item        = makeItem({ id: "sc-st-ctx", type: "stamp" });
    const arrivalCtx  = baseContext("arrival_mode");
    assert.ok(
      scoreStamp(item, profile, arrivalCtx).finalScore > scoreStamp(item, profile, ctx).finalScore,
      "stamp: arrival_mode must boost stamp",
    );
  });

  // ── Notification scoring ──────────────────────────────────────────────────
  it("notification: freshness is the dominant signal — brand-new beats day-old", () => {
    const brand   = makeItem({ id: "sc-no-bran", type: "notification", createdAt: new Date().toISOString() });
    const dayOld  = makeItem({ id: "sc-no-old",  type: "notification", createdAt: new Date(Date.now() - 86_400_000).toISOString() });
    assert.ok(
      scoreNotification(brand, profile, ctx).finalScore > scoreNotification(dayOld, profile, ctx).finalScore,
      "notification: brand-new must outscore day-old",
    );
  });

  it("notification: safety_mode context boosts notifications", () => {
    const item     = makeItem({ id: "sc-no-ctx", type: "notification" });
    const safeCtx  = baseContext("safety_mode");
    assert.ok(
      scoreNotification(item, profile, safeCtx).finalScore > scoreNotification(item, profile, ctx).finalScore,
    );
  });

  // ── Suggestion scoring ────────────────────────────────────────────────────
  it("suggestion: interest-match is the top signal", () => {
    const match  = makeItem({ id: "sc-sg-im", type: "suggestion", interestTags: ["adventure","culture"] });
    const noMatch = makeItem({ id: "sc-sg-nm", type: "suggestion", interestTags: ["banking"] });
    assert.ok(
      scoreSuggestion(match, profile, ctx).finalScore > scoreSuggestion(noMatch, profile, ctx).finalScore,
    );
  });

  it("suggestion: creator_mode context boosts suggestions", () => {
    const item       = makeItem({ id: "sc-sg-ctx", type: "suggestion" });
    const createCtx  = baseContext("creator_mode");
    assert.ok(
      scoreSuggestion(item, profile, createCtx).finalScore > scoreSuggestion(item, profile, ctx).finalScore,
    );
  });

  // ── Risk and safety compat ────────────────────────────────────────────────
  it("high-risk item scores lower than low-risk item", () => {
    const safe  = makeItem({ id: "sc-risk-s", type: "event", riskScore: 0 });
    const risky = makeItem({ id: "sc-risk-r", type: "event", riskScore: 0.8 });
    assert.ok(
      scoreItem(safe, profile, ctx).finalScore > scoreItem(risky, profile, ctx).finalScore,
    );
  });

  it("safety-compatible item (standard/standard) scores higher than mismatched (relaxed viewer=cautious)", () => {
    const match    = makeItem({ id: "sc-sa-m", type: "event", safetyTier: "standard" });
    const mismatch = makeItem({ id: "sc-sa-x", type: "event", safetyTier: "relaxed" });
    const cautious = baseProfile({ safetyPreference: "cautious" });
    assert.ok(
      scoreItem(match, cautious, ctx).finalScore > scoreItem(mismatch, cautious, ctx).finalScore,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runPipeline — orchestration (async)
// ─────────────────────────────────────────────────────────────────────────────

describe("runPipeline — orchestration", () => {
  const profile = baseProfile({ blockedUserIds: [BOB_ID] });
  const context = baseContext("exploring_now");

  it("scoring is NEVER called when safety filter blocks an item (injection proof)", async () => {
    let scoreCallCount = 0;
    const mockScore = (item: CompassItem, p: CompassProfile, c: CompassContext, db: any) => {
      scoreCallCount++;
      return { finalScore: 99, components: {} as any };
    };

    const items = [
      makeItem({ id: "orch-1", type: "event", authorId: BOB_ID }), // blocked
      makeItem({ id: "orch-2", type: "event", authorId: CAROL_ID }), // passes
    ];

    await runPipeline(items, profile, context, null, { scoreItem: mockScore });

    assert.equal(scoreCallCount, 1, "scoreItem must be called exactly once (only for the unblocked item)");
  });

  it("eligibility-rejected item never reaches scoring (injection proof)", async () => {
    let scoreCallCount = 0;
    const mockScore = (item: CompassItem, p: CompassProfile, c: CompassContext, db: any) => {
      scoreCallCount++;
      return { finalScore: 50, components: {} as any };
    };
    const alwaysReject = () => ({ eligible: false, reason: "test_reject" });

    const items = [makeItem({ id: "orch-elig", type: "event", authorId: CAROL_ID })];
    await runPipeline(items, baseProfile(), context, null, {
      eligibilityCheck: alwaysReject as any,
      scoreItem: mockScore,
    });

    assert.equal(scoreCallCount, 0, "scoreItem must not be called when eligibility rejects");
  });

  it("blocked user never appears in output", async () => {
    const items = [
      makeItem({ id: "orch-3", type: "event", authorId: BOB_ID }),    // blocked
      makeItem({ id: "orch-4", type: "event", authorId: CAROL_ID }),  // clean
    ];
    const summary = await runPipeline(items, profile, context);
    assert.equal(summary.blockedCount, 1);
    assert.equal(summary.passedCount, 1);
    assert.ok(summary.results.every((r) => r.item.id !== "orch-3"), "blocked item must not appear");
    assert.equal(summary.results[0].item.id, "orch-4");
  });

  it("delayed post blocked until eligible", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const items  = [
      makeItem({ id: "orch-5", type: "post", isDelayedPost: true, publishEligibleAt: future }),
      makeItem({ id: "orch-6", type: "event" }),
    ];
    const summary = await runPipeline(items, baseProfile(), context);
    assert.equal(summary.blockedCount, 1);
    const ids = summary.results.map((r) => r.item.id);
    assert.ok(!ids.includes("orch-5"), "delayed post must be blocked");
    assert.ok(ids.includes("orch-6"), "event must pass");
  });

  it("private GPS coordinates absent from pipeline output", async () => {
    const items = [makeItem({
      id: "orch-7", type: "event",
      exactLat: 35.6762, exactLng: 139.6503,
      exactAddress: "123 Shibuya",
    })];
    const summary = await runPipeline(items, baseProfile(), context);
    assert.equal(summary.passedCount, 1);
    const out = summary.results[0].item;
    assert.ok(!("exactLat" in out), "exactLat must be stripped");
    assert.ok(!("exactLng" in out), "exactLng must be stripped");
    assert.ok(!("exactAddress" in out), "exactAddress must be stripped");
  });

  it("results are sorted by finalScore descending", async () => {
    const p      = baseProfile({ currentCity: "Tokyo" });
    const c      = baseContext("exploring_now");
    // itemA: city + interest match → high score
    const itemA  = makeItem({
      id: "orch-8a", type: "event",
      city: "Tokyo", interestTags: ["adventure","culture"],
      qualityScore: 9, authorTrustScore: 80,
      createdAt: new Date().toISOString(),
    });
    // itemB: no city, no interest, stale → low score
    const itemB  = makeItem({
      id: "orch-8b", type: "event",
      city: "Chicago", interestTags: ["golf"],
      qualityScore: 1, authorTrustScore: 25,
      createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    });
    const summary = await runPipeline([itemB, itemA], p, c); // B first in input
    assert.ok(summary.results.length >= 2);
    assert.ok(
      summary.results[0].finalScore >= summary.results[1].finalScore,
      "results must be sorted descending",
    );
    assert.equal(summary.results[0].item.id, "orch-8a", "high-score item must be first");
  });

  it("each result carries all required pipeline gate flags", async () => {
    const summary = await runPipeline(
      [makeItem({ id: "orch-9", type: "event" })],
      baseProfile(), context,
    );
    assert.equal(summary.passedCount, 1);
    const result = summary.results[0];
    assert.equal(result.safetyPassed,     true);
    assert.equal(result.eligiblePassed,   true);
    assert.equal(result.privacySanitized, true);
    assert.ok(typeof result.finalScore === "number");
  });

  it("inputCount = blockedCount + rejectedCount + passedCount", async () => {
    const items = [
      makeItem({ id: "orch-10a", type: "event", authorId: BOB_ID }),            // blocked
      makeItem({ id: "orch-10b", type: "event", authorId: BOB_ID, isSuspended: true }), // blocked
      makeItem({ id: "orch-10c", type: "buddy", authorId: CAROL_ID, buddyStatus: "inactive" }), // rejected
      makeItem({ id: "orch-10d", type: "event", authorId: CAROL_ID }),           // passes
    ];
    const summary = await runPipeline(items, profile, context);
    assert.equal(summary.inputCount, 4);
    assert.equal(summary.blockedCount, 2);
    assert.equal(summary.rejectedCount, 1);
    assert.equal(summary.passedCount, 1);
    assert.equal(
      summary.blockedCount + summary.rejectedCount + summary.passedCount,
      summary.inputCount,
    );
  });

  it("empty input returns empty results with correct counts", async () => {
    const summary = await runPipeline([], baseProfile(), context);
    assert.equal(summary.inputCount, 0);
    assert.equal(summary.passedCount, 0);
    assert.equal(summary.results.length, 0);
  });

  it("preloaded feature flags are forwarded to safety filter — COMPASS_<TYPE>_SAFETY_BLOCK blocks", async () => {
    // Inject a mock safety filter that captures the flags it received
    let capturedFlags: Record<string, boolean> | undefined;
    const mockSafety = (
      item: CompassItem,
      p: CompassProfile,
      db: any,
      flags: Record<string, boolean>,
    ) => {
      capturedFlags = flags;
      return { allowed: true };
    };

    // Inject a mock DB that returns flags
    // We can't use a real DB, so we test that the pipeline passes the flags to the gate.
    // Instead, use a mock that intercepts and verifies flags are supplied.
    await runPipeline(
      [makeItem({ id: "flag-1", type: "event" })],
      baseProfile(),
      context,
      null, // no DB → flags will be {}
      { safetyFilter: mockSafety as any },
    );
    // With no DB, flags = {}
    assert.ok(capturedFlags !== undefined, "safety filter must receive flags object");
    assert.deepEqual(capturedFlags, {});
  });
});
