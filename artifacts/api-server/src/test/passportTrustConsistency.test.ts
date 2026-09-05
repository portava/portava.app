/**
 * passportTrustConsistency.test.ts — ONE trust engine (§9/§30).
 *
 * There used to be two trust engines that could disagree for the same traveller:
 * lib/trustScore's local heuristic (owner Home identity card + Rent-a-Buddy card)
 * and services/trust's persisted trust_profiles.overall_score (TrustScreen). This
 * proves they now read ONE source: for a given user the identity-card path
 * (computeTrustScore), the TrustScreen path (buildPassportProjection self →
 * trust.score) and the Rent-a-Buddy path (computeTrustScore, same fn) all return
 * the IDENTICAL number, and that the number is exactly the rounded canonical
 * overall_score. Also proves the no-profile case agrees (all null).
 *
 * Run: node --import tsx/esm --test src/test/passportTrustConsistency.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { computeTrustScore } from "../lib/trustScore.js";
import { getDisplayTrustScore } from "../services/trust/TrustScoreService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-trust";

function permsSelf(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
function selfResolution(): ViewerResolution {
  return { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
}

/** A DB where the canonical trust_profiles carries a fractional overall_score. */
function dbWithProfile(overall: number) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "owner", display_name: "Owner", name: "Owner",
      verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
      is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true, created_at: "2023-01-01",
    }],
    trust_profiles: [{
      user_id: OWNER, overall_score: overall, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50, guide_accuracy: 40, passport_authenticity: 66,
    }],
  });
}

describe("passport trust — one source, one number", () => {
  it("identity card, TrustScreen and Rent-a-Buddy return the SAME number", async () => {
    // A fractional overall_score exercises the shared rounding: every surface
    // must land on the same integer, not one on 78 and another on 77.
    const overall = 77.6;
    const db = dbWithProfile(overall);

    // TrustScreen: the self projection exposes the numeric score.
    const projection = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: async () => selfResolution(),
    }))!;
    const trustScreenScore = projection.trust?.score ?? null;

    // Identity card (GET /me/profile, GET /passport) and Rent-a-Buddy card both
    // call computeTrustScore — the same adapter over the canonical source.
    const identityCard = await computeTrustScore(OWNER, db);
    const rentABuddyCard = await computeTrustScore(OWNER, db);

    // The canonical display helper is the single source of truth.
    const canonical = await getDisplayTrustScore(db, OWNER);

    assert.equal(canonical, 78, "canonical display score is the rounded overall_score");
    assert.equal(trustScreenScore, 78, "TrustScreen shows the canonical number");
    assert.equal(identityCard.score, 78, "identity card shows the canonical number");
    assert.equal(rentABuddyCard.score, 78, "Rent-a-Buddy card shows the canonical number");

    // The whole point: all three agree.
    assert.equal(identityCard.score, trustScreenScore);
    assert.equal(rentABuddyCard.score, trustScreenScore);
    assert.equal(identityCard.score, rentABuddyCard.score);

    // Label is derived from the canonical public_level (not a parallel table).
    assert.equal(identityCard.label, "Trusted Traveler");

    // Breakdown is a view of the nine canonical categories (never a raw event).
    const respect = identityCard.breakdown.factors.find((f) => f.key === "respect_safety");
    assert.ok(respect, "respect_safety factor present");
    assert.equal(respect!.points, 80);
    const guide = identityCard.breakdown.factors.find((f) => f.key === "guide_accuracy");
    assert.ok(guide && guide.hint, "a below-neutral category surfaces an improvement hint");
  });

  it("agree at NULL when the user has no trust profile yet", async () => {
    const db = makePassportDb({
      profiles: [{
        id: OWNER, handle: "owner", display_name: "Owner", name: "Owner",
        verified: false, is_official: false, is_private: false,
        passport_visibility: "public", show_profile_picture_publicly: true, created_at: "2023-01-01",
      }],
      trust_profiles: [], // no row
    });

    const projection = (await buildPassportProjection(db, OWNER, OWNER, {
      resolveViewerContext: async () => selfResolution(),
    }))!;
    const identityCard = await computeTrustScore(OWNER, db);

    assert.equal(await getDisplayTrustScore(db, OWNER), null);
    assert.equal(projection.trust?.score ?? null, null, "TrustScreen shows no number");
    assert.equal(identityCard.score, null, "identity card shows no number");
    // Non-stigmatizing label, never a fabricated number (§10).
    assert.equal(identityCard.label, "New Traveler");
    assert.deepEqual(identityCard.breakdown.factors, []);
  });
});
