/**
 * Passport projection — owner-controlled state the projection must honor
 * (Passport backend audit 2026-09-04, findings P1 + P2).
 *
 *   P1 (TABLE 14, authorization): the owner capability chips are derived from
 *   the owner's LIVE trust restrictions, not a hard-coded "unrestricted". An
 *   owner under an active hosting restriction must not project canHostTrip /
 *   canCreateLargePlan (for ANY viewer — they are the owner's credentials); a
 *   lifted restriction no longer bites; a location restriction also switches
 *   off the viewer's server-projected can_make_plan.
 *
 *   P2 (TABLE 24 / §22, privacy): profile_privacy_settings.show_home_country
 *   and show_current_city are honored on the projection path for non-owner
 *   viewers; the owner's self view always sees their own data; a failed
 *   settings read fails CLOSED (hide) for non-owners.
 *
 * Run: node --import tsx/esm --test src/test/passportProjectionOwnerControls.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassportProjection,
  ownerRestrictionsFromState,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import type { RestrictionState } from "../services/trust/TrustRestrictionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";

function permsSelf(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
/** A non-owner who is otherwise allowed everything (friend w/ location context). */
function permsFriend(over: Partial<ViewerPermissions> = {}): ViewerPermissions {
  return {
    relationshipLabel: "friend", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: true, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: true,
    ...over,
  };
}
function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}

const SELF: ViewerResolution = { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const FRIEND: ViewerResolution = { context: "follower", permissions: permsFriend(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const PUBLIC: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };

function resolver(res: ViewerResolution) {
  return async () => res;
}

/** Owner: trusted (rank 3 ⇒ can host / large plans / crew location), traveling (current ≠ home). */
function seedDb(extra: Record<string, any[]> = {}) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
      avatar_url: "https://x/a.png", verified: true, verified_at: "2024-01-01",
      home_city: "Hanoi", home_country: "Vietnam", current_city: "Da Nang",
      is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true, open_to_meet: false, created_at: "2023-01-01",
    }],
    trust_profiles: [{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50, guide_accuracy: 40, passport_authenticity: 66,
    }],
    ...extra,
  });
}

async function project(db: any, res: ViewerResolution) {
  const viewerId = res.context === "self" ? OWNER : res.context === "public" ? null : VIEWER;
  const p = await buildPassportProjection(db, OWNER, viewerId, { resolveViewerContext: resolver(res) });
  assert.ok(p, "projection built");
  return p!;
}

function hostingRestriction(over: Record<string, any> = {}) {
  return {
    id: "r-host", user_id: OWNER, restriction_type: "hosting", reason: "no-shows",
    lifted_at: null, expires_at: null, created_at: "2026-09-01T00:00:00.000Z", ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — owner capabilities honor the owner's ACTIVE trust restrictions
// ─────────────────────────────────────────────────────────────────────────────

describe("P1 — owner capability chips honor active trust restrictions (TABLE 14)", () => {
  it("an unrestricted trusted owner keeps canHostTrip / canCreateLargePlan / canUseCrewLocation", async () => {
    const p = await project(seedDb(), SELF);
    assert.equal(p.capabilities.owner.canHostTrip, true);
    assert.equal(p.capabilities.owner.canCreateLargePlan, true);
    assert.equal(p.capabilities.owner.canUseCrewLocation, true);
    assert.equal(p.capabilities.owner.canJoinPublicTrip, true);
  });

  it("an ACTIVE hosting restriction removes canHostTrip + canCreateLargePlan — for the owner and for other viewers", async () => {
    const db = seedDb({ trust_restrictions: [hostingRestriction()] });

    const self = await project(db, SELF);
    assert.equal(self.capabilities.owner.canHostTrip, false, "self: restricted owner must not see the Host chip");
    assert.equal(self.capabilities.owner.canCreateLargePlan, false);
    // Unrelated capabilities are untouched by a hosting restriction.
    assert.equal(self.capabilities.owner.canUseCrewLocation, true);
    assert.equal(self.capabilities.owner.canJoinPublicTrip, true);

    const pub = await project(db, PUBLIC);
    assert.equal(pub.capabilities.owner.canHostTrip, false, "public: the owner's credentials are the same for every viewer");
    assert.equal(pub.capabilities.owner.canCreateLargePlan, false);
  });

  it("a LIFTED hosting restriction no longer bites", async () => {
    const db = seedDb({ trust_restrictions: [hostingRestriction({ lifted_at: "2026-09-02T00:00:00.000Z" })] });
    const p = await project(db, SELF);
    assert.equal(p.capabilities.owner.canHostTrip, true);
    assert.equal(p.capabilities.owner.canCreateLargePlan, true);
  });

  it("an active location_plan_join restriction removes crew location + public-trip join AND the viewer's can_make_plan", async () => {
    const restricted = seedDb({
      trust_restrictions: [hostingRestriction({ id: "r-loc", restriction_type: "location_plan_join" })],
    });
    const p = await project(restricted, FRIEND);
    assert.equal(p.capabilities.owner.canUseCrewLocation, false);
    assert.equal(p.capabilities.owner.canJoinPublicTrip, false);
    assert.equal(p.capabilities.actions.can_make_plan, false, "viewer may invite, but the owner cannot join a plan");
    // Hosting is a separate restriction type — still on.
    assert.equal(p.capabilities.owner.canHostTrip, true);

    // Same viewer, unrestricted owner ⇒ the plan action is available.
    const open = await project(seedDb(), FRIEND);
    assert.equal(open.capabilities.actions.can_make_plan, true);
  });

  it("ownerRestrictionsFromState maps the structured state 1:1 and keeps a degraded read's fail-closed posture", () => {
    const active: RestrictionState = {
      canHost: false, canJoinPrivatePlans: false, canMessage: true, canJoinLocationPlans: true,
      activeRestrictions: ["hosting", "private_plan_access"],
    };
    assert.deepEqual(ownerRestrictionsFromState(active), {
      hosting: true, privatePlan: true, messaging: false, locationPlan: false,
    });

    // getRestrictionState's fail-closed degraded shape: hosting/messaging refused.
    const degraded: RestrictionState = {
      canHost: false, canJoinPrivatePlans: true, canMessage: false, canJoinLocationPlans: true,
      activeRestrictions: [], degraded: true, degradedReason: "fail_closed",
    };
    assert.deepEqual(ownerRestrictionsFromState(degraded), {
      hosting: true, privatePlan: false, messaging: true, locationPlan: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — TABLE 24 show_home_country / show_current_city on the projection path
// ─────────────────────────────────────────────────────────────────────────────

/** Make the profile_privacy_settings read resolve a PostgREST-style error. */
function withPrivacySettingsReadError(db: any) {
  const orig = db.from.bind(db);
  db.from = (table: string) => {
    if (table !== "profile_privacy_settings") return orig(table);
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: null, error: { code: "XX000", message: "boom" } }),
    };
    return b;
  };
  return db;
}

describe("P2 — show_home_country / show_current_city are honored for non-owner viewers (TABLE 24, §22)", () => {
  it("absent settings row ⇒ show-by-default (public still gets the coarse country; a friend sees the city)", async () => {
    const db = seedDb();
    const pub = await project(db, PUBLIC);
    assert.equal(pub.identity.homeCountry, "Vietnam");
    assert.equal(pub.identity.homeBase, null, "home base still needs a full-profile relationship");
    const friend = await project(db, FRIEND);
    assert.equal(friend.identity.homeCountry, "Vietnam");
    assert.equal(friend.identity.homeBase, "Hanoi");
    assert.equal(friend.travelerState?.city, "Da Nang");
  });

  it("show_home_country=false ⇒ non-owners get no homeCountry (nor homeBase); the owner still sees both", async () => {
    const db = seedDb({
      profile_privacy_settings: [{ user_id: OWNER, show_home_country: false, show_current_city: true }],
    });

    const pub = await project(db, PUBLIC);
    assert.equal(pub.identity.homeCountry, null, "public: opted-out country must not project");

    const friend = await project(db, FRIEND);
    assert.equal(friend.identity.homeCountry, null, "friend: opted-out country must not project");
    assert.equal(friend.identity.homeBase, null, "home base would disclose the hidden country");
    // The unrelated city toggle is still on for this friend.
    assert.equal(friend.travelerState?.city, "Da Nang");

    const self = await project(db, SELF);
    assert.equal(self.identity.homeCountry, "Vietnam", "owner always sees their own data");
    assert.equal(self.identity.homeBase, "Hanoi");
  });

  it("show_current_city=false ⇒ non-owners get no traveler city (structured field AND label); the owner still sees it", async () => {
    const db = seedDb({
      profile_privacy_settings: [{ user_id: OWNER, show_home_country: true, show_current_city: false }],
    });

    const friend = await project(db, FRIEND);
    assert.equal(friend.travelerState?.state, "traveling", "coarse state may still project");
    assert.equal(friend.travelerState?.city, null);
    assert.equal(friend.travelerState?.label, "Traveling", "label must not name the hidden city");
    // The unrelated country toggle is still on.
    assert.equal(friend.identity.homeCountry, "Vietnam");
    assert.equal(friend.identity.homeBase, "Hanoi");

    const self = await project(db, SELF);
    assert.equal(self.travelerState?.city, "Da Nang", "owner always sees their own data");
    assert.equal(self.travelerState?.label, "Traveling · Da Nang");
  });

  it("show_current_city=false also hides a city sourced from the owner's ACTIVE trip", async () => {
    const db = seedDb({
      profile_privacy_settings: [{ user_id: OWNER, show_home_country: true, show_current_city: false }],
      trips: [{
        id: "trip-now", owner_id: OWNER, title: "Bangkok now", destination_city: "Bangkok", destination_country: "Thailand",
        start_date: "2026-09-01", end_date: "2026-09-20", status: "active", visibility: "public", show_on_profile: true, show_exact_dates: true,
      }],
      trip_members: [{ trip_id: "trip-now", user_id: OWNER, role: "owner" }],
    });

    const friend = await project(db, FRIEND);
    assert.equal(friend.travelerState?.state, "traveling");
    assert.equal(friend.travelerState?.city, null);
    assert.equal(friend.travelerState?.label, "Traveling");

    const self = await project(db, SELF);
    assert.equal(self.travelerState?.city, "Bangkok");
  });

  it("a failed settings read fails CLOSED for non-owners and leaves the owner's self view intact", async () => {
    const db = withPrivacySettingsReadError(seedDb());

    const friend = await project(db, FRIEND);
    assert.equal(friend.identity.homeCountry, null);
    assert.equal(friend.identity.homeBase, null);
    assert.equal(friend.travelerState?.city, null);

    const self = await project(db, SELF);
    assert.equal(self.identity.homeCountry, "Vietnam");
    assert.equal(self.identity.homeBase, "Hanoi");
    assert.equal(self.travelerState?.city, "Da Nang");
  });
});
