/**
 * passportTrustRecoveryHints.test.ts — recovery hints reach the OWNER, and only
 * the owner (§9/§10).
 *
 * TrustRecoveryService produces ordered, second-person recovery steps;
 * TrustPrivacyGuard.getSafeTrustSummary keeps the top 3 as `recoveryHints`. Until
 * now buildTrust read `publicLevel`/`strengths` off that summary and DISCARDED
 * the hints, so nothing downstream — projection, route, client — could ever show
 * them. This proves both halves of the fix:
 *
 *   1. The owner's own projection (context "self") carries the SAME three hint
 *      strings the safe summary computed, in the same order — not a re-derived
 *      or re-worded list, and not a 4th step that the top-3 slice dropped.
 *   2. NO other viewer gets them. The key is absent for the unauthenticated
 *      `public` context AND for a RELATIONSHIP context (`follower`), which is the
 *      one that would leak: buildTrust's early return only peels off `public`, so
 *      follower / trip_crew / buddy_customer / … all still read the same safe
 *      summary and would have carried the hints if the gate were "reached the
 *      summary" instead of "is the owner". Hints only exist when a category sits
 *      below neutral, so their presence alone would disclose that this traveller
 *      is in recovery.
 *
 * Run: node --import tsx/esm --test src/test/passportTrustRecoveryHints.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassportProjection,
  type PassportViewerContext,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { getSafeTrustSummary } from "../services/trust/TrustPrivacyGuard.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-recovery";
const VIEWER = "viewer-follower";

function perms(full: boolean): ViewerPermissions {
  return {
    relationshipLabel: full ? "self" : "follower",
    isBlocked: false,
    isUnavailable: false,
    canViewProfile: true,
    canViewFullProfile: full,
    canSeeAvailability: full,
    canSeeTrips: full,
    canSeeMutuals: full,
    canSeeLocationContext: full,
    canSeeFriendOnlyPosts: full,
    canMessage: !full,
    canSendMessageRequest: !full,
    canFollow: !full,
    canInviteToTripCrew: false,
  };
}

function resolution(context: PassportViewerContext): ViewerResolution {
  return {
    context,
    permissions: perms(context === "self"),
    sharedTrip: false,
    sharedEvent: false,
    ownerIsTripHost: false,
    buddyRole: null,
  };
}

/**
 * A traveller with four below-neutral categories, ordered by deficit:
 *   plan_attendance 10 (deficit 40 → 5 steps)
 *   communication   25 (deficit 25 → 3 steps)
 *   content_quality 40 (deficit 10 → 2 steps)
 *   guide_accuracy  43 (deficit  7 → 2 steps)  ← 4th, dropped by the top-3 slice
 * Everything else is at/above neutral, so it produces no step at all.
 */
function db() {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "owner", display_name: "Owner", name: "Owner",
      verified: false, is_official: false, is_private: false,
      passport_visibility: "public", show_profile_picture_publicly: true,
      created_at: "2023-01-01",
    }],
    trust_profiles: [{
      user_id: OWNER, overall_score: 44, public_level: "building_trust",
      plan_attendance: 10, host_quality: 60, communication: 25, respect_safety: 70,
      location_honesty: 55, content_quality: 40, community_value: 62,
      guide_accuracy: 43, passport_authenticity: 58,
    }],
  });
}

const EXPECTED_HINTS = [
  "Attend 5 more plans without cancelling",
  "Reply to 3 messages within 24 hours",
  "Post 2 pieces of content with no reports",
];
/** The 4th step the top-3 slice must drop — a canary against a re-derived list. */
const DROPPED_HINT = "Verify 2 hidden gems in person";

describe("passport trust — recovery hints are delivered to the owner", () => {
  it("the safe summary really produces these hints (producer sanity)", async () => {
    const summary = await getSafeTrustSummary(db(), OWNER);
    assert.deepEqual(summary.recoveryHints, EXPECTED_HINTS);
  });

  it("the SELF projection carries the summary's hints verbatim and in order", async () => {
    const sc = db();
    const summary = await getSafeTrustSummary(sc, OWNER);

    const projection = (await buildPassportProjection(sc, OWNER, OWNER, {
      resolveViewerContext: async () => resolution("self"),
    }))!;

    assert.ok(projection.trust, "self projection carries a trust block");
    assert.deepEqual(
      projection.trust!.recoveryHints,
      EXPECTED_HINTS,
      "owner sees the server's recovery steps",
    );
    // Same source, not a parallel re-derivation.
    assert.deepEqual(projection.trust!.recoveryHints, summary.recoveryHints);
    // The top-3 slice is preserved — the 4th step never leaves the server.
    assert.ok(
      !projection.trust!.recoveryHints!.includes(DROPPED_HINT),
      "only the top 3 steps are projected",
    );
  });

  it("an unauthenticated PUBLIC viewer gets no hints at all", async () => {
    const projection = (await buildPassportProjection(db(), OWNER, null, {
      resolveViewerContext: async () => resolution("public"),
    }))!;

    assert.ok(projection.trust, "public projection still carries a trust block");
    assert.equal(
      Object.prototype.hasOwnProperty.call(projection.trust!, "recoveryHints"),
      false,
      "the key is absent, not an empty array a client could misread",
    );
    const wire = JSON.stringify(projection);
    for (const hint of [...EXPECTED_HINTS, DROPPED_HINT]) {
      assert.ok(!wire.includes(hint), `public wire must not contain: ${hint}`);
    }
  });

  it("a FOLLOWER — a real viewer on the safe-summary path — gets no hints", async () => {
    // This is the leak the gate exists to stop: `follower` is not `public`, so it
    // falls through buildTrust's early return and reads the very same
    // getSafeTrustSummary the owner does.
    const projection = (await buildPassportProjection(db(), OWNER, VIEWER, {
      resolveViewerContext: async () => resolution("follower"),
    }))!;

    assert.ok(projection.trust, "follower projection still carries a trust block");
    assert.equal(
      Object.prototype.hasOwnProperty.call(projection.trust!, "recoveryHints"),
      false,
      "a follower must not learn that this traveller is in recovery",
    );
    const wire = JSON.stringify(projection);
    for (const hint of [...EXPECTED_HINTS, DROPPED_HINT]) {
      assert.ok(!wire.includes(hint), `follower wire must not contain: ${hint}`);
    }
  });

  it("an owner with nothing to recover gets an EMPTY list, not a fabricated one", async () => {
    // Every category at/above neutral → no steps. The owner's view still carries
    // the key (an authoritative "nothing to do"), and the client must not invent
    // advice to fill it.
    const healthy = makePassportDb({
      profiles: [{
        id: OWNER, handle: "owner", display_name: "Owner", name: "Owner",
        verified: true, is_official: false, is_private: false,
        passport_visibility: "public", show_profile_picture_publicly: true,
        created_at: "2023-01-01",
      }],
      trust_profiles: [{
        user_id: OWNER, overall_score: 82, public_level: "trusted_traveler",
        plan_attendance: 80, host_quality: 78, communication: 75, respect_safety: 88,
        location_honesty: 70, content_quality: 72, community_value: 74,
        guide_accuracy: 68, passport_authenticity: 90,
      }],
    });

    const projection = (await buildPassportProjection(healthy, OWNER, OWNER, {
      resolveViewerContext: async () => resolution("self"),
    }))!;

    assert.deepEqual(projection.trust!.recoveryHints, []);
  });
});
