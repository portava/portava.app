/**
 * Passport projection aggregate assembly + server-side privacy filtering
 * (§4/§29/§30, TABLE 28).
 *
 * buildPassportProjection is exercised with an INJECTED viewer-context resolver
 * so the assembly + privacy logic is tested deterministically (the resolver
 * itself is covered by passportViewerContext.test.ts). Verifies:
 *   • self view assembles the full §29 aggregate (identity, traveler state,
 *     availability, intent, trust w/ numeric score, credentials, stats, stamps,
 *     featured journey, plans, memories, travel identity, capabilities);
 *   • a public viewer is stripped server-side: no availability/intent, no
 *     numeric trust score, private plans + private memories removed, no shared
 *     context, home base hidden;
 *   • a blocked viewer receives only a minimal restricted card.
 *
 * Run: node --import tsx/esm --test src/test/passportProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

function permsFull(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
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

function resolver(res: ViewerResolution) {
  return async () => res;
}

function seedDb() {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
      avatar_url: "https://x/a.png", cover_photo_url: "https://x/c.png",
      verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
      home_city: "Hanoi", home_country: "Vietnam", current_city: "Da Nang",
      is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true,
      interests: ["Nightlife", "Food"], availability_tags: ["Food", "Nightlife"],
      spoken_languages: ["English"], travel_pace: "packed", planning_style: "planner",
      budget_style: "budget", travel_group_style: ["social"], open_to_meet: true,
      created_at: "2023-01-01",
    }],
    user_stamps: [
      { user_id: OWNER, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { category: "trip", name: "Vietnam" } },
      { user_id: OWNER, city: "Bangkok", country: "Thailand", is_revoked: false, earned_at: "2025-02-01", stamp_definitions: { category: "city", name: "Bangkok" } },
    ],
    passport_stamps: [],
    trip_members: [
      { trip_id: "trip-past", user_id: OWNER, role: "owner" },
      { trip_id: "trip-now", user_id: OWNER, role: "owner" },
      { trip_id: "trip-up", user_id: OWNER, role: "owner" },
      { trip_id: "trip-up-priv", user_id: OWNER, role: "owner" },
    ],
    trips: [
      { id: "trip-past", owner_id: OWNER, title: "Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: "trip-now", owner_id: OWNER, title: "Da Nang now", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-09-01", end_date: "2025-09-20", status: "active", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: "trip-up", owner_id: OWNER, title: "Bangkok soon", destination_city: "Bangkok", destination_country: "Thailand", start_date: "2025-12-01", end_date: "2025-12-05", status: "upcoming", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: "trip-up-priv", owner_id: OWNER, title: "Secret plan", destination_city: "Tokyo", destination_country: "Japan", start_date: "2025-12-20", end_date: "2025-12-25", status: "upcoming", visibility: "private", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m-pub", user_id: OWNER, status: "active", title: "Beach", city: "Da Nang", country: "Vietnam", trip_id: "trip-past", visibility: "public", earned_at: "2025-03-05", photo_url: null, category: "moment" },
      { id: "m-priv", user_id: OWNER, status: "active", title: "Journal", city: "Da Nang", country: "Vietnam", trip_id: "trip-past", visibility: "private", earned_at: "2025-03-06", photo_url: null, category: "note" },
    ],
    quick_availability_status: [{ user_id: OWNER, status: "free_tonight", expires_at: FUTURE }],
    user_availability: [{ user_id: OWNER, weekly_days: { fri: ["evening"] }, open_to_meet: true }],
    passport_visibility_preferences: [{ user_id: OWNER, stamps_visible: "public", memories_visible: "public" }],
    trust_profiles: [{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50, guide_accuracy: 40, passport_authenticity: 66,
    }],
  });
}

describe("buildPassportProjection — self view", () => {
  it("assembles the full §29 aggregate for the owner", async () => {
    const res: ViewerResolution = { context: "self", permissions: permsFull(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(seedDb(), OWNER, OWNER, { resolveViewerContext: resolver(res) }))!;

    assert.ok(p, "projection built");
    assert.equal(p.viewerContext, "self");
    assert.equal(p.restricted, undefined);

    // Identity — home base visible to self.
    assert.equal(p.identity.handle, "wanderer");
    assert.equal(p.identity.verified, true);
    assert.equal(p.identity.homeBase, "Hanoi");
    assert.equal(p.identity.avatarUrl, "https://x/a.png");

    // Traveler state — active trip ⇒ traveling, city visible to self.
    assert.equal(p.travelerState?.state, "traveling");
    assert.equal(p.travelerState?.city, "Da Nang");

    // Availability + intent present for self, current window non-stale.
    assert.ok(p.availability, "availability present");
    assert.equal(p.availability?.openToPlans, true);
    assert.equal(p.availability?.currentWindow?.status, "free_tonight");
    assert.deepEqual(p.intent?.current, ["Food", "Nightlife"]);

    // Trust — numeric score exposed only on the self view.
    assert.equal(p.trust?.score, 78);
    assert.equal(p.trust?.publicLevel, "trusted_traveler");
    assert.ok(["low", "medium", "high"].includes(p.trust!.confidence));

    // Stats.
    assert.equal(p.stats.countries, 2);
    assert.equal(p.stats.cities, 2);
    assert.equal(p.stats.stamps, 2);

    // Stamps present as verified travel facts.
    assert.equal(p.stamps.length, 2);
    assert.equal(p.stamps[0].verification, "verified");

    // Featured journey + upcoming plans (owner sees the active + private plans).
    assert.ok(p.featuredJourney, "featured journey present");
    const planIds = p.upcomingPlans.map((x) => x.tripId).sort();
    assert.deepEqual(planIds, ["trip-now", "trip-up", "trip-up-priv"]);

    // Memories — owner sees the private one.
    assert.equal(p.memories.length, 2);

    // Travel identity present + editable for self.
    assert.ok(p.travelIdentity, "travel identity present");
    assert.equal(p.travelIdentity?.editable, true);

    // No shared context on a self view.
    assert.equal(p.sharedContext, undefined);

    // Capabilities projected.
    assert.equal(p.capabilities.owner.canHostTrip, true);
    assert.ok(p.capabilities.actions);
  });
});

describe("buildPassportProjection — public viewer (server-side privacy)", () => {
  it("strips availability/intent, numeric trust, private plans/memories, shared context, home base", async () => {
    const res: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(seedDb(), OWNER, null, { resolveViewerContext: resolver(res) }))!;

    assert.equal(p.viewerContext, "public");
    // Availability + intent are WITHHELD.
    assert.equal(p.availability, undefined);
    assert.equal(p.intent, undefined);
    // Trust badge present but numeric score withheld.
    assert.ok(p.trust);
    assert.equal(p.trust?.score, null);
    // Traveler city hidden (no location context), state may still read traveling.
    assert.equal(p.travelerState?.city, null);
    // Home base hidden for a public viewer; country still allowed.
    assert.equal(p.identity.homeBase, null);
    // Private plan removed; public upcoming plans kept (per-plan visibility, §16).
    const planIds = p.upcomingPlans.map((x) => x.tripId);
    assert.ok(planIds.includes("trip-up"), "public upcoming plan shown");
    assert.ok(planIds.includes("trip-now"), "active public plan shown");
    assert.ok(!planIds.includes("trip-up-priv"), "private plan hidden from public");
    // Private memory removed; public memory kept.
    const memIds = p.memories.map((m) => m.id);
    assert.ok(memIds.includes("m-pub"));
    assert.ok(!memIds.includes("m-priv"), "private memory hidden from public");
    // No shared context for an unauthenticated viewer.
    assert.equal(p.sharedContext, undefined);
    // Public still sees stats + stamps.
    assert.equal(p.stats.stamps, 2);
    assert.equal(p.stamps.length, 2);
  });
});

describe("buildPassportProjection — blocked viewer", () => {
  it("returns a minimal restricted card with no owner data", async () => {
    const blocked = permsPublic();
    blocked.isBlocked = true;
    const res: ViewerResolution = { context: "public", permissions: blocked, sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(seedDb(), OWNER, VIEWER, { resolveViewerContext: resolver(res) }))!;

    assert.ok(p.restricted, "restricted flag present");
    assert.equal(p.restricted?.reason, "blocked");
    assert.deepEqual(p.stamps, []);
    assert.deepEqual(p.upcomingPlans, []);
    assert.deepEqual(p.memories, []);
    assert.equal(p.availability, undefined);
    assert.equal(p.identity.homeBase, null);
    assert.equal(p.identity.homeCountry, null);
    // Every viewer action is false for a blocked relationship.
    assert.equal(p.capabilities.actions.can_follow, false);
    assert.equal(p.capabilities.actions.can_message, false);
  });

  it("returns null for a non-existent user", async () => {
    const db = makePassportDb({});
    const res: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = await buildPassportProjection(db, "ghost", null, { resolveViewerContext: resolver(res) });
    assert.equal(p, null);
  });
});

describe("buildPassportProjection — TABLE 12 domain trust + §20 reputation credentials", () => {
  function repSeed() {
    return makePassportDb({
      profiles: [{
        id: OWNER, handle: "host", display_name: "Host", name: "Host",
        verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
        is_official: false, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true, created_at: "2023-01-01",
      }],
      trust_profiles: [{
        user_id: OWNER, overall_score: 82, public_level: "highly_trusted",
        plan_attendance: 88, host_quality: 55, communication: 70, respect_safety: 90,
        location_honesty: 84, content_quality: 92, community_value: 90, guide_accuracy: 88, passport_authenticity: 80,
      }],
      rent_buddy_profiles: [{ user_id: OWNER, average_rating: 4.8, review_count: 12, completed_bookings: 9 }],
      passport_contribution_events: [
        { user_id: OWNER, event_type: "pulse_contribution", metadata: { city: "Bangkok", category: "nightlife" }, created_at: "2026-01-01" },
        { user_id: OWNER, event_type: "city_visit_verified", metadata: { city: "Bangkok", category: "food" }, created_at: "2026-01-02" },
        { user_id: OWNER, event_type: "hidden_gem_verified", metadata: { city: "Bangkok", category: "events" }, created_at: "2026-01-03" },
      ],
    });
  }

  it("projects per-domain presentations with NO raw score, and Buddy applicable for a buddy", async () => {
    const res: ViewerResolution = { context: "self", permissions: permsFull(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(repSeed(), OWNER, OWNER, { resolveViewerContext: resolver(res) }))!;

    const domains = p.trust?.domains ?? [];
    const byKey = Object.fromEntries(domains.map((d) => [d.key, d]));
    assert.ok(byKey.overall && byKey.traveler && byKey.trip_guest && byKey.trip_host && byKey.contributor && byKey.buddy, "all six TABLE 12 domains present");
    // Presentation words, never numbers.
    for (const d of domains) {
      assert.equal(typeof d.presentation, "string");
      assert.ok(!/\d/.test(d.presentation), `domain ${d.key} presentation must carry no raw number`);
    }
    // host_quality 55 → "Established"; content/community/guide high → Contributor "Excellent".
    assert.equal(byKey.trip_host.presentation, "Established");
    assert.equal(byKey.contributor.presentation, "Excellent");
    // This owner IS a buddy → Buddy domain applicable.
    assert.equal(byKey.buddy.applicable, true);
    assert.notEqual(byKey.buddy.presentation, "Not applicable");
  });

  it("surfaces the §20 Host Reputation + Knows-<city>-well credentials", async () => {
    const res: ViewerResolution = { context: "self", permissions: permsFull(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(repSeed(), OWNER, OWNER, { resolveViewerContext: resolver(res) }))!;

    const host = p.credentials.find((c) => c.key === "host_reputation");
    assert.ok(host, "host reputation credential present");
    assert.equal(host!.label, "Host Reputation");
    assert.equal(host!.detail, "4.8");

    const city = p.credentials.find((c) => c.key.startsWith("city_expertise_"));
    assert.ok(city, "city expertise credential present");
    assert.equal(city!.label, "Knows Bangkok well");
  });

  it("marks the Buddy domain Not applicable and omits Host Reputation for a non-buddy", async () => {
    const db = makePassportDb({
      profiles: [{
        id: OWNER, handle: "trav", display_name: "Trav", name: "Trav",
        verified: false, is_official: false, is_private: false,
        passport_visibility: "public", show_profile_picture_publicly: true, created_at: "2023-01-01",
      }],
      trust_profiles: [{
        user_id: OWNER, overall_score: 50, public_level: "reliable_traveler",
        plan_attendance: 50, host_quality: 50, communication: 50, respect_safety: 50,
        location_honesty: 50, content_quality: 50, community_value: 50, guide_accuracy: 50, passport_authenticity: 50,
      }],
      rent_buddy_profiles: [], // not a buddy
    });
    const res: ViewerResolution = { context: "self", permissions: permsFull(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(db, OWNER, OWNER, { resolveViewerContext: resolver(res) }))!;

    const buddy = (p.trust?.domains ?? []).find((d) => d.key === "buddy")!;
    assert.equal(buddy.applicable, false);
    assert.equal(buddy.presentation, "Not applicable");
    // Neutral 50 everywhere reads "Established" — non-stigmatizing (§10).
    const overall = (p.trust?.domains ?? []).find((d) => d.key === "overall")!;
    assert.equal(overall.presentation, "Established");
    assert.equal(p.credentials.find((c) => c.key === "host_reputation"), undefined);
  });
});
