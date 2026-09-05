/**
 * Passport viewer-context resolution + capability projection (§4/§11/§30, TABLE
 * 5 / TABLE 14 / TABLE 29).
 *
 * Covers:
 *   • classifyViewerContext — exhaustive mapping onto TABLE 5, plus precedence.
 *   • toCallerContext — projection→privacy-guard caller mapping.
 *   • buildOwnerCapabilities — positive owner credentials from trust level.
 *   • buildViewerActions — per-viewer action flags, incl. blocked ⇒ all false.
 *   • resolvePassportViewerContext — self / unauthenticated public / a real
 *     "following" relationship driven through the canonical permission engine.
 *
 * Run: node --import tsx/esm --test src/test/passportViewerContext.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyViewerContext,
  toCallerContext,
  buildOwnerCapabilities,
  buildViewerActions,
  resolvePassportViewerContext,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";

function perms(over: Partial<ViewerPermissions> = {}): ViewerPermissions {
  return {
    relationshipLabel: "stranger",
    isBlocked: false,
    isUnavailable: false,
    canViewProfile: true,
    canViewFullProfile: false,
    canSeeAvailability: false,
    canSeeTrips: false,
    canSeeMutuals: false,
    canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false,
    canMessage: false,
    canSendMessageRequest: false,
    canFollow: true,
    canInviteToTripCrew: false,
    ...over,
  };
}

describe("classifyViewerContext (TABLE 5)", () => {
  const base = {
    isSelf: false,
    isBlocked: false,
    relationshipLabel: "stranger",
    sharedTrip: false,
    ownerIsTripHost: false,
    sharedEvent: false,
    buddyRole: null as "provider" | "customer" | null,
  };

  it("self wins over everything", () => {
    assert.equal(classifyViewerContext({ ...base, isSelf: true, sharedTrip: true, ownerIsTripHost: true }), "self");
  });

  it("blocked collapses to public and never leaks a relationship", () => {
    assert.equal(classifyViewerContext({ ...base, isBlocked: true, relationshipLabel: "following", sharedTrip: true }), "public");
  });

  it("trip_host when owner hosts a shared trip", () => {
    assert.equal(classifyViewerContext({ ...base, sharedTrip: true, ownerIsTripHost: true }), "trip_host");
  });

  it("trip_crew when sharing a trip the owner does not host", () => {
    assert.equal(classifyViewerContext({ ...base, sharedTrip: true, ownerIsTripHost: false }), "trip_crew");
  });

  it("buddy_provider / buddy_customer from buddy role", () => {
    assert.equal(classifyViewerContext({ ...base, buddyRole: "provider" }), "buddy_provider");
    assert.equal(classifyViewerContext({ ...base, buddyRole: "customer" }), "buddy_customer");
  });

  it("event_group from a shared event", () => {
    assert.equal(classifyViewerContext({ ...base, sharedEvent: true }), "event_group");
  });

  it("following for following / mutual_follow / friend", () => {
    for (const rel of ["following", "mutual_follow", "friend"]) {
      assert.equal(classifyViewerContext({ ...base, relationshipLabel: rel }), "following");
    }
  });

  it("follower for a one-way inbound follow", () => {
    assert.equal(classifyViewerContext({ ...base, relationshipLabel: "follower" }), "follower");
  });

  it("public for a stranger", () => {
    assert.equal(classifyViewerContext({ ...base, relationshipLabel: "stranger" }), "public");
  });

  it("trip takes precedence over a follow relationship", () => {
    assert.equal(classifyViewerContext({ ...base, sharedTrip: true, relationshipLabel: "following" }), "trip_crew");
  });
});

describe("toCallerContext", () => {
  it("self ⇒ owner", () => assert.equal(toCallerContext("self", perms({ relationshipLabel: "self" })), "owner"));
  it("trip contexts ⇒ trip_crew", () => {
    assert.equal(toCallerContext("trip_crew", perms()), "trip_crew");
    assert.equal(toCallerContext("trip_host", perms()), "trip_crew");
  });
  it("a VERIFIED circle relationship ⇒ circle", () => {
    assert.equal(toCallerContext("following", perms({ canSeeFriendOnlyPosts: true })), "circle");
  });
  // canViewFullProfile is a literal `true` for every non-blocked viewer in
  // resolveInteractionPermissions ("the profile page is not gated"), so it must
  // NOT promote a caller to the circle tier — that made circle_only == public.
  it("canViewFullProfile alone does NOT grant the circle tier", () => {
    assert.equal(toCallerContext("public", perms({ canViewFullProfile: true })), "public");
    assert.equal(toCallerContext("follower", perms({ canViewFullProfile: true })), "public");
  });
  it("plain public ⇒ public", () => {
    assert.equal(toCallerContext("public", perms()), "public");
  });
});

describe("buildOwnerCapabilities (TABLE 14)", () => {
  it("a new traveler cannot host or make large plans", () => {
    const caps = buildOwnerCapabilities({
      publicLevel: "new_traveler",
      verified: false,
      buddyVerified: false,
      restrictions: { hosting: false, privatePlan: false, messaging: false, locationPlan: false },
    });
    assert.equal(caps.canHostTrip, false);
    assert.equal(caps.canCreateLargePlan, false);
    assert.equal(caps.canJoinPublicTrip, true);
  });

  it("a trusted verified traveler unlocks hosting + large plans + buddy", () => {
    const caps = buildOwnerCapabilities({
      publicLevel: "trusted_traveler",
      verified: true,
      buddyVerified: false,
      restrictions: { hosting: false, privatePlan: false, messaging: false, locationPlan: false },
    });
    assert.equal(caps.canHostTrip, true);
    assert.equal(caps.canCreateLargePlan, true);
    assert.equal(caps.canBecomeBuddy, true);
    assert.equal(caps.canContributeLiveIntel, true);
  });

  it("a hosting restriction removes canHostTrip even at high trust", () => {
    const caps = buildOwnerCapabilities({
      publicLevel: "highly_trusted",
      verified: true,
      buddyVerified: false,
      restrictions: { hosting: true, privatePlan: false, messaging: false, locationPlan: false },
    });
    assert.equal(caps.canHostTrip, false);
    assert.equal(caps.canCreateLargePlan, false);
  });
});

describe("buildViewerActions (TABLE 29 — server-projected)", () => {
  const ownerCaps = buildOwnerCapabilities({
    publicLevel: "trusted_traveler", verified: true, buddyVerified: false,
    restrictions: { hosting: false, privatePlan: false, messaging: false, locationPlan: false },
  });

  it("a blocked viewer gets every action false", () => {
    const a = buildViewerActions(perms({ isBlocked: true, canFollow: true, canMessage: true }), ownerCaps);
    assert.deepEqual(a, {
      can_follow: false, can_message: false, can_make_plan: false,
      can_invite_trip: false, can_view_availability: false, can_view_trust: false,
    });
  });

  it("can_make_plan requires BOTH invite permission AND owner join capability", () => {
    // Viewer may invite, owner can join → true.
    assert.equal(buildViewerActions(perms({ canInviteToTripCrew: true }), ownerCaps).can_make_plan, true);
    // Viewer may invite, but owner cannot join a plan → false.
    const blockedOwner = buildOwnerCapabilities({
      publicLevel: "new_traveler", verified: false, buddyVerified: false,
      restrictions: { hosting: false, privatePlan: true, messaging: false, locationPlan: true },
    });
    assert.equal(buildViewerActions(perms({ canInviteToTripCrew: true }), blockedOwner).can_make_plan, false);
  });

  it("message action reflects direct-message OR request permission", () => {
    assert.equal(buildViewerActions(perms({ canMessage: false, canSendMessageRequest: true }), ownerCaps).can_message, true);
  });
});

describe("resolvePassportViewerContext", () => {
  it("self when viewer === owner (no DB relationship needed)", async () => {
    const db = makePassportDb({});
    const r = await resolvePassportViewerContext(db, OWNER, OWNER);
    assert.equal(r.context, "self");
    assert.equal(r.permissions.canSeeAvailability, true);
    assert.equal(r.permissions.canViewFullProfile, true);
  });

  it("public for an unauthenticated viewer", async () => {
    const db = makePassportDb({});
    const r = await resolvePassportViewerContext(db, OWNER, null);
    assert.equal(r.context, "public");
    assert.equal(r.permissions.canSeeAvailability, false);
    assert.equal(r.permissions.canFollow, true);
  });

  it("following — driven end-to-end through the canonical permission engine", async () => {
    const db = makePassportDb({
      profiles: [{ id: OWNER, is_private: false, tag_permission: "everyone" }],
      user_follows: [{ follower_id: VIEWER, following_id: OWNER }],
    });
    const r = await resolvePassportViewerContext(db, OWNER, VIEWER);
    assert.equal(r.context, "following");
    assert.equal(r.permissions.relationshipLabel, "following");
    assert.equal(r.permissions.isBlocked, false);
  });
});
