/**
 * CompassSafetyFilter — block exclusion tests
 *
 * Tests the hard-block gate that strips blocked/blocker users from Compass
 * feed results. Uses the exported pure functions (no HTTP server, no DB).
 *
 * Run: node --import tsx/esm --test src/test/compassSafetyFilter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSafetyFilter, runSafetyFilterBatch } from "../compass/CompassSafetyFilter.js";
import type { CompassItem, CompassProfile } from "../compass/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VIEWER_ID  = "aaaabbbb-0001-0002-0003-aaaabbbb0001";
const BLOCKED_ID = "ccccdddd-0001-0002-0003-ccccdddd0001";
const BLOCKER_ID = "eeeeffff-0001-0002-0003-eeeeffff0001";
const NEUTRAL_ID = "11112222-0001-0002-0003-111122220001";

function makeProfile(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: VIEWER_ID,
    preferredCities: [],
    preferredLanguages: [],
    budgetStyle: null,
    travelStyles: [],
    socialStyle: null,
    safetyPreference: "standard",
    visibilityPreference: "public",
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    blockCount: 0,
    blockerCount: 0,
    trustScore: null,
    trustLevel: null,
    activeUserScore: null,
    hasActiveTrip: false,
    hasActiveBooking: false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity: null,
    currentCountry: null,
    safeReturnActive: false,
    categoryWeights: null,
    ignoredItemIds: [],
    mutedHashtags: [],
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<CompassItem> = {}): CompassItem {
  return {
    id: `item-${Math.random().toString(36).slice(2)}`,
    type: "post",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
// All suites in one outer describe — see nodetest-describe-concurrency.md.

describe("CompassSafetyFilter — block exclusion", () => {

  describe("runSafetyFilter — individual item checks", () => {
    it("1a. allows item whose author is not blocked", () => {
      const profile = makeProfile({ blockedUserIds: [], blockerUserIds: [] });
      const item = makeItem({ authorId: NEUTRAL_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, true);
    });

    it("1b. blocks item from author the viewer has blocked (blockedUserIds)", () => {
      const profile = makeProfile({ blockedUserIds: [BLOCKED_ID], blockerUserIds: [] });
      const item = makeItem({ authorId: BLOCKED_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "author_blocked_by_viewer");
    });

    it("1c. blocks item from author who has blocked the viewer (blockerUserIds)", () => {
      const profile = makeProfile({ blockedUserIds: [], blockerUserIds: [BLOCKER_ID] });
      const item = makeItem({ authorId: BLOCKER_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "viewer_blocked_by_author");
    });

    it("1d. allows item from neutral author when other blocks exist", () => {
      const profile = makeProfile({ blockedUserIds: [BLOCKED_ID], blockerUserIds: [BLOCKER_ID] });
      const item = makeItem({ authorId: NEUTRAL_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, true);
    });

    it("1e. item without authorId passes the block checks (non-user content)", () => {
      const profile = makeProfile({ blockedUserIds: [BLOCKED_ID] });
      const item = makeItem({ authorId: undefined });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, true);
    });

    it("1f. blocks item already reported by the viewer", () => {
      const profile = makeProfile();
      const item = makeItem({ isReportedByViewer: true, authorId: NEUTRAL_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "viewer_reported_item");
    });

    it("1g. blocks suspended item", () => {
      const profile = makeProfile();
      const item = makeItem({ isSuspended: true, authorId: NEUTRAL_ID });
      const result = runSafetyFilter(item, profile, null, {});
      assert.equal(result.allowed, false);
      assert.equal(result.reason, "author_or_item_suspended");
    });
  });

  describe("runSafetyFilterBatch — feed exclusion", () => {
    it("2a. feed with no blocks passes all items", () => {
      const profile = makeProfile();
      const items = [
        makeItem({ authorId: NEUTRAL_ID, type: "post" }),
        makeItem({ authorId: NEUTRAL_ID, type: "event" }),
        makeItem({ authorId: NEUTRAL_ID, type: "user" }),
      ];
      const { passed, blocked } = runSafetyFilterBatch(items, profile, null, {});
      assert.equal(passed.length, 3);
      assert.equal(blocked.length, 0);
    });

    it("2b. blocked author's items are removed from the batch", () => {
      const profile = makeProfile({ blockedUserIds: [BLOCKED_ID] });
      const items = [
        makeItem({ authorId: NEUTRAL_ID }),
        makeItem({ authorId: BLOCKED_ID }),
        makeItem({ authorId: NEUTRAL_ID }),
      ];
      const { passed, blocked } = runSafetyFilterBatch(items, profile, null, {});
      assert.equal(passed.length, 2, "only neutral items should pass");
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0].reason, "author_blocked_by_viewer");
    });

    it("2c. blocker's items are removed from the batch", () => {
      const profile = makeProfile({ blockerUserIds: [BLOCKER_ID] });
      const items = [
        makeItem({ authorId: BLOCKER_ID }),
        makeItem({ authorId: NEUTRAL_ID }),
      ];
      const { passed, blocked } = runSafetyFilterBatch(items, profile, null, {});
      assert.equal(passed.length, 1);
      assert.equal(blocked[0].reason, "viewer_blocked_by_author");
    });

    it("2d. mutual block removes items from both directions", () => {
      // blockedUserIds and blockerUserIds can overlap (mutual block).
      const profile = makeProfile({
        blockedUserIds: [BLOCKED_ID],
        blockerUserIds: [BLOCKER_ID],
      });
      const items = [
        makeItem({ authorId: NEUTRAL_ID }),
        makeItem({ authorId: BLOCKED_ID }),
        makeItem({ authorId: BLOCKER_ID }),
      ];
      const { passed, blocked } = runSafetyFilterBatch(items, profile, null, {});
      assert.equal(passed.length, 1);
      assert.equal(passed[0].authorId, NEUTRAL_ID);
      assert.equal(blocked.length, 2);
    });

    it("2e. empty feed returns empty passed and blocked arrays", () => {
      const profile = makeProfile({ blockedUserIds: [BLOCKED_ID] });
      const { passed, blocked } = runSafetyFilterBatch([], profile, null, {});
      assert.equal(passed.length, 0);
      assert.equal(blocked.length, 0);
    });
  });
});
