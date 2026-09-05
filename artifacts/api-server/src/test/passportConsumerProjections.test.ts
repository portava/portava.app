/**
 * Passport consumer projections — §21 (TABLE 22), §33, §8.
 *
 * Verifies that each consumer VARIANT reuses the single assembler and is
 * stripped to its TABLE 22 field allow-list (no field a variant does not list
 * can appear on it), that a blocked viewer collapses every variant to its
 * minimal restricted shape, and that §8 explicit-window intent both populates
 * the discovery_card `intent` and drives the bounded intent weighting so
 * ordering changes ONLY when an explicit window exists.
 *
 * Run: node --import tsx/esm --test src/test/passportConsumerProjections.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildConsumerProjection,
  explicitIntentBoost,
  genericInterestWeight,
  sharedCount,
  viewerContextToWindowRelationship,
  INTENT_WEIGHT_PER_MATCH,
  GENERIC_WEIGHT_PER_MATCH,
  MAX_INTENT_WEIGHT,
} from "../services/passport/PassportConsumerProjections.js";
import {
  buildPassportProjection,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: true,
    canFollow: true, canInviteToTripCrew: false,
  };
}
function permsFollowing(): ViewerPermissions {
  return {
    relationshipLabel: "following", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: true, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: true,
  };
}

function resolution(context: ViewerResolution["context"], permissions: ViewerPermissions): ViewerResolution {
  return { context, permissions, sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
}
function inject(res: ViewerResolution) {
  return { resolveViewerContext: async () => res };
}

function seedDb(opts: { windows?: any[] } = {}) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
      avatar_url: "https://x/a.png", cover_photo_url: "https://x/c.png",
      verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
      home_city: "Hanoi", home_country: "Vietnam", current_city: "Da Nang",
      is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true,
      interests: ["Nightlife", "Food"], availability_tags: ["Explore"],
      spoken_languages: ["English"], travel_pace: "packed", planning_style: "planner",
      budget_style: "budget", travel_group_style: ["social"], open_to_meet: true,
      created_at: "2023-01-01",
    }],
    user_stamps: [
      { user_id: OWNER, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { category: "trip", name: "Vietnam" } },
    ],
    passport_stamps: [],
    trip_members: [],
    trips: [],
    passport_memories: [
      { id: "m-priv", user_id: OWNER, status: "active", title: "Journal", city: "Da Nang", country: "Vietnam", trip_id: null, visibility: "private", earned_at: "2025-03-06", photo_url: null, category: "note" },
    ],
    quick_availability_status: [{ user_id: OWNER, status: "free_tonight", expires_at: FUTURE }],
    user_availability: [{ user_id: OWNER, weekly_days: { fri: ["evening"] }, open_to_meet: true }],
    passport_visibility_preferences: [{ user_id: OWNER, stamps_visible: "public", memories_visible: "public" }],
    trust_profiles: [{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50, guide_accuracy: 40, passport_authenticity: 66,
    }],
    availability_windows: opts.windows ?? [],
  });
}

function explicitWindow(intents: string[], visibility = "public") {
  return {
    id: `w-${Math.random().toString(16).slice(2)}`, user_id: OWNER, type: "one_time",
    start_at: PAST, end_at: FUTURE, trip_id: null, open_to_plans: true, intents,
    group_preference: "small_group", max_travel_minutes: 20, visibility,
    source: "explicit", social_availability: "open", expires_at: FUTURE,
    created_at: PAST, updated_at: PAST,
  };
}

// ── discovery_card allow-list ─────────────────────────────────────────────────

describe("discovery_card variant — allow-list", () => {
  it("carries only person-card fields; leaks none of the full aggregate", async () => {
    const card = (await buildConsumerProjection(
      seedDb(), "discovery_card", OWNER, VIEWER,
      inject(resolution("following", permsFollowing())),
    ))!;
    assert.equal(card.variant, "discovery_card");
    assert.equal(card.identity.handle, "wanderer");
    // Fields that must NOT appear on a person card.
    for (const k of ["stamps", "memories", "upcomingPlans", "featuredJourney", "credentials", "travelIdentity", "identity_homeBase"]) {
      assert.ok(!(k in (card as any)), `leaked top-level field: ${k}`);
    }
    assert.ok(!("homeBase" in card.identity), "identity.homeBase must not leak");
    assert.ok(!("coverUrl" in card.identity), "identity.coverUrl must not leak");
    // Trust summary present, numeric score stripped (§9).
    assert.ok(card.trust, "trust summary present");
    assert.ok(!("score" in (card.trust as any)), "numeric trust score must not leak to a viewer");
  });
});

// ── §8 explicit intent + weighting ────────────────────────────────────────────

describe("discovery_card variant — §8 explicit current intent", () => {
  it("sources intent from an active explicit window (not generic tags) and flags it", async () => {
    const db = seedDb({ windows: [explicitWindow(["Nightlife", "Food"])] });
    const card = (await buildConsumerProjection(
      db, "discovery_card", OWNER, VIEWER,
      inject(resolution("public", permsPublic())),
    ))!;
    assert.ok(card.intent, "intent present");
    assert.equal(card.intent?.explicit, true);
    assert.equal(card.intent?.source, "explicit");
    assert.equal(card.hasExplicitWindow, true);
    assert.deepEqual(card.intent?.current.slice().sort(), ["Food", "Nightlife"]);
  });

  it("without an explicit window, does not claim explicit intent", async () => {
    const card = (await buildConsumerProjection(
      seedDb({ windows: [] }), "discovery_card", OWNER, VIEWER,
      inject(resolution("public", permsPublic())),
    ))!;
    assert.equal(card.hasExplicitWindow, false);
    assert.notEqual(card.intent?.explicit, true);
  });

  it("does not surface an explicit window whose visibility excludes the viewer", async () => {
    // A crew-only window must not reach a public viewer (§7 visibility).
    const db = seedDb({ windows: [explicitWindow(["Nightlife"], "crew")] });
    const card = (await buildConsumerProjection(
      db, "discovery_card", OWNER, VIEWER,
      inject(resolution("public", permsPublic())),
    ))!;
    assert.equal(card.hasExplicitWindow, false);
  });
});

describe("§8 bounded weighting — order changes only with an explicit window", () => {
  it("one explicit-intent match outweighs one generic-interest match", () => {
    assert.ok(INTENT_WEIGHT_PER_MATCH > GENERIC_WEIGHT_PER_MATCH);
    assert.ok(explicitIntentBoost(1, true) > genericInterestWeight(1));
  });

  it("explicit boost is zero without an active window (ordering unchanged)", () => {
    assert.equal(explicitIntentBoost(3, false), 0);
    assert.equal(explicitIntentBoost(0, true), 0);
  });

  it("boost is bounded", () => {
    assert.equal(explicitIntentBoost(100, true), MAX_INTENT_WEIGHT);
  });

  it("reorders two equal-interest candidates only when the explicit window exists", () => {
    // A and B tie on generic interests. B additionally shares an explicit intent.
    const genericA = genericInterestWeight(2);
    const genericB = genericInterestWeight(2);
    const sharedExplicitB = sharedCount(["Nightlife", "Food"], ["Nightlife"]); // 1

    // Without an active window for B, the boost is 0 → scores tie, order preserved.
    const scoreA_noWin = genericA + explicitIntentBoost(sharedExplicitB, false);
    const scoreB_noWin = genericB + explicitIntentBoost(0, false);
    assert.equal(scoreB_noWin, scoreA_noWin, "no window ⇒ no reorder");

    // With an active window, B's explicit-intent overlap lifts it above A.
    const scoreA_win = genericA + explicitIntentBoost(0, true);
    const scoreB_win = genericB + explicitIntentBoost(sharedExplicitB, true);
    assert.ok(scoreB_win > scoreA_win, "explicit window ⇒ B reorders above A");
  });

  it("sharedCount is case-insensitive and dedupes", () => {
    assert.equal(sharedCount(["Food", "food", "NIGHTLIFE"], ["Food", "nightlife"]), 2);
  });
});

// ── telegraph allow-list ───────────────────────────────────────────────────────

describe("telegraph variant — allow-list", () => {
  it("carries identity + shared context + header actions only", async () => {
    const h = (await buildConsumerProjection(
      seedDb(), "telegraph", OWNER, VIEWER,
      inject(resolution("following", permsFollowing())),
    ))!;
    assert.equal(h.variant, "telegraph");
    assert.equal(h.identity.handle, "wanderer");
    assert.ok(h.actions, "header actions present");
    for (const k of ["availability", "intent", "trust", "stats", "stamps", "memories", "upcomingPlans", "capabilities", "travelerState", "credentials"]) {
      assert.ok(!(k in (h as any)), `telegraph header leaked: ${k}`);
    }
    assert.ok(!("homeCountry" in h.identity), "telegraph identity must not carry homeCountry");
  });
});

// ── buddy allow-list ────────────────────────────────────────────────────────────

describe("buddy variant — allow-list", () => {
  it("carries identity + verification + reputation summary + availability only", async () => {
    const b = (await buildConsumerProjection(
      seedDb(), "buddy", OWNER, VIEWER,
      inject(resolution("buddy_customer", permsFollowing())),
    ))!;
    assert.equal(b.variant, "buddy");
    assert.ok(Array.isArray(b.credentials));
    assert.ok(b.trust, "reputation summary present");
    assert.ok(!("score" in (b.trust as any)), "buddy variant must not expose a numeric trust score");
    for (const k of ["stamps", "memories", "upcomingPlans", "featuredJourney", "intent", "sharedContext", "travelIdentity", "travelerState"]) {
      assert.ok(!(k in (b as any)), `buddy variant leaked: ${k}`);
    }
  });
});

// ── trips allow-list (TABLE 22 Trips row) ─────────────────────────────────────

describe("trips variant — allow-list", () => {
  it("carries identity + trip eligibility + languages + travel style + host/guest only", async () => {
    const t = (await buildConsumerProjection(
      seedDb(), "trips", OWNER, VIEWER,
      inject(resolution("trip_host", permsFollowing())),
    ))!;
    assert.equal(t.variant, "trips");
    assert.equal(t.identity.handle, "wanderer");
    assert.equal(t.hostGuestContext, "host", "owner hosts the shared trip");
    // Sections a crew list has no business receiving.
    for (const k of [
      "stamps", "memories", "upcomingPlans", "featuredJourney", "credentials",
      "availability", "intent", "sharedContext", "travelerState", "stats",
      "capabilities", "trust", "travelIdentity",
    ]) {
      assert.ok(!(k in (t as any)), `trips variant leaked: ${k}`);
    }
    // TABLE 24 user-controlled location fields never ride a crew card.
    for (const k of ["homeCountry", "homeBase", "coverUrl"]) {
      assert.ok(!(k in (t.identity as any)), `trips identity leaked: ${k}`);
    }
    // Eligibility is the four TABLE 14 trip capabilities and nothing else.
    assert.deepEqual(
      Object.keys(t.eligibility).sort(),
      ["canCreateLargePlan", "canHostTrip", "canJoinPublicTrip", "canUseCrewLocation"],
    );
  });

  it("shows only the trip-role trust domains, as words — never a numeric score", async () => {
    const t = (await buildConsumerProjection(
      seedDb(), "trips", OWNER, VIEWER,
      inject(resolution("trip_crew", permsFollowing())),
    ))!;
    assert.equal(t.hostGuestContext, "crew");
    assert.ok(t.trustDomains.length > 0, "trip-domain trust words present");
    for (const d of t.trustDomains) {
      assert.ok(["trip_guest", "trip_host"].includes(d.key), `non-trip trust domain leaked: ${d.key}`);
      assert.equal(typeof d.presentation, "string");
      assert.ok(!("score" in (d as any)), "a domain must not carry a score");
    }
    assert.ok(!JSON.stringify(t).includes("\"score\""), "no numeric trust score anywhere on the trips variant");
  });

  it("projects the owner's languages and travel-style axes from the aggregate", async () => {
    const t = (await buildConsumerProjection(
      seedDb(), "trips", OWNER, VIEWER,
      inject(resolution("trip_crew", permsFollowing())),
    ))!;
    assert.deepEqual(t.languages, ["English"]);
    const keys = t.travelStyle.map((d) => d.key).sort();
    assert.deepEqual(keys, ["group_style", "planning", "social", "travel_pace"]);
    // Discovery/Compass-only axes must not ride along.
    for (const forbidden of ["interests", "spend_style", "discovery", "energy", "rhythm"]) {
      assert.ok(!t.travelStyle.some((d) => d.key === forbidden), `trips travelStyle leaked axis: ${forbidden}`);
    }
  });

  it("reports languages as [] (never a fabricated 'Not set') when the owner set none", async () => {
    // Same owner, minus spoken_languages — the axis then reads "Not set" and is
    // flagged `inferred`, which must NOT become a language string.
    const noLangDb = makePassportDb({
      profiles: [{
        id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
        verified: true, is_private: false, passport_visibility: "public",
        show_profile_picture_publicly: true, spoken_languages: [], created_at: "2023-01-01",
      }],
      trust_profiles: [{ user_id: OWNER, overall_score: 60, public_level: "trusted_traveler" }],
    });
    const t = (await buildConsumerProjection(
      noLangDb, "trips", OWNER, VIEWER,
      inject(resolution("trip_crew", permsFollowing())),
    ))!;
    assert.deepEqual(t.languages, []);
  });

  it("leaks nothing the FULL projection would not have shown this viewer", async () => {
    // The property the variant exists to guarantee: it is a NARROWING. Every
    // value it carries must be traceable to the same assembler output for the
    // same viewer — so compare field by field against the full aggregate.
    const res = resolution("trip_crew", permsFollowing());
    const full = (await buildPassportProjection(seedDb(), OWNER, VIEWER, inject(res)))!;
    const t = (await buildConsumerProjection(seedDb(), "trips", OWNER, VIEWER, inject(res)))!;

    assert.equal(t.userId, full.userId);
    assert.equal(t.viewerContext, full.viewerContext);
    assert.equal(t.identity.name, full.identity.name);
    assert.equal(t.identity.handle, full.identity.handle);
    assert.equal(t.identity.avatarUrl, full.identity.avatarUrl);
    assert.equal(t.identity.verified, full.identity.verified);
    assert.equal(t.identity.verificationLevel, full.identity.verificationLevel);
    assert.equal(t.identity.isOfficial, full.identity.isOfficial);
    assert.equal(t.eligibility.canHostTrip, full.capabilities.owner.canHostTrip);
    assert.equal(t.eligibility.canJoinPublicTrip, full.capabilities.owner.canJoinPublicTrip);
    assert.equal(t.eligibility.canCreateLargePlan, full.capabilities.owner.canCreateLargePlan);
    assert.equal(t.eligibility.canUseCrewLocation, full.capabilities.owner.canUseCrewLocation);
    assert.equal(t.actions.can_message, full.capabilities.actions.can_message);
    assert.equal(t.actions.can_invite_trip, full.capabilities.actions.can_invite_trip);
    assert.equal(t.actions.can_make_plan, full.capabilities.actions.can_make_plan);

    // Every trust domain on the variant appears verbatim on the full aggregate.
    for (const d of t.trustDomains) {
      const src = (full.trust?.domains ?? []).find((x) => x.key === d.key);
      assert.ok(src, `variant invented trust domain ${d.key}`);
      assert.equal(d.presentation, src!.presentation);
      assert.equal(d.applicable, src!.applicable);
    }
    // Every travel-style axis appears verbatim on the full aggregate.
    for (const d of t.travelStyle) {
      const src = (full.travelIdentity?.dimensions ?? []).find((x) => x.key === d.key);
      assert.ok(src, `variant invented travel axis ${d.key}`);
      assert.equal(d.value, src!.value);
    }
    // Languages come from the same (viewer-filtered) languages axis.
    const langAxis = (full.travelIdentity?.dimensions ?? []).find((x) => x.key === "languages");
    assert.equal(t.languages.join(", "), langAxis && !langAxis.inferred ? langAxis.value : "");
  });

  it("host/guest context is 'none' outside a shared trip", async () => {
    const t = (await buildConsumerProjection(
      seedDb(), "trips", OWNER, VIEWER,
      inject(resolution("following", permsFollowing())),
    ))!;
    assert.equal(t.hostGuestContext, "none");
  });
});

// ── safety allow-list ────────────────────────────────────────────────────────────

describe("safety variant — restricted purpose-specific only", () => {
  it("carries only userId/handle/verified/blocked", async () => {
    const s = (await buildConsumerProjection(
      seedDb(), "safety", OWNER, VIEWER,
      inject(resolution("public", permsPublic())),
    ))!;
    assert.equal(s.variant, "safety");
    assert.equal(typeof s.blocked, "boolean");
    for (const k of ["identity", "availability", "intent", "trust", "stats", "stamps", "memories", "capabilities", "sharedContext", "travelerState", "credentials"]) {
      assert.ok(!(k in (s as any)), `safety variant leaked: ${k}`);
    }
  });
});

// ── blocked propagation across every variant (§24) ────────────────────────────

describe("blocked viewer collapses every variant to its restricted shape (§24)", () => {
  function blockedRes(): ViewerResolution {
    const p = permsPublic();
    p.isBlocked = true;
    return resolution("public", p);
  }

  it("discovery_card: restricted, no availability/intent/trust/shared context", async () => {
    const card = (await buildConsumerProjection(seedDb(), "discovery_card", OWNER, VIEWER, inject(blockedRes())))!;
    assert.ok(card.restricted, "restricted present");
    assert.equal(card.availability, undefined);
    assert.equal(card.intent, undefined);
    assert.equal(card.trust, undefined);
    assert.equal(card.sharedContext, undefined);
    assert.equal(card.hasExplicitWindow, false);
    assert.equal(card.capabilities.actions.can_message, false);
  });

  it("telegraph: restricted, no shared context", async () => {
    const h = (await buildConsumerProjection(seedDb(), "telegraph", OWNER, VIEWER, inject(blockedRes())))!;
    assert.ok(h.restricted);
    assert.equal(h.sharedContext, undefined);
    assert.equal(h.actions.can_message, false);
  });

  it("buddy: restricted, empty credentials, no reputation", async () => {
    const b = (await buildConsumerProjection(seedDb(), "buddy", OWNER, VIEWER, inject(blockedRes())))!;
    assert.ok(b.restricted);
    assert.deepEqual(b.credentials, []);
    assert.equal(b.trust, undefined);
    assert.equal(b.availability, undefined);
  });

  it("trips: restricted, no trust words, languages or travel style", async () => {
    const t = (await buildConsumerProjection(seedDb(), "trips", OWNER, VIEWER, inject(blockedRes())))!;
    assert.ok(t.restricted);
    assert.deepEqual(t.trustDomains, []);
    assert.deepEqual(t.languages, []);
    assert.deepEqual(t.travelStyle, []);
    assert.equal(t.hostGuestContext, "none", "a block collapses the relationship to the least-privileged context");
    assert.equal(t.actions.can_message, false);
  });

  it("safety: restricted + blocked flag true", async () => {
    const s = (await buildConsumerProjection(seedDb(), "safety", OWNER, VIEWER, inject(blockedRes())))!;
    assert.ok(s.restricted);
    assert.equal(s.blocked, true);
  });
});

// ── viewer-context → window relationship mapping ───────────────────────────────

describe("viewerContextToWindowRelationship", () => {
  it("maps trip contexts to crew and unknown social contexts to public", () => {
    assert.equal(viewerContextToWindowRelationship("self"), "self");
    assert.equal(viewerContextToWindowRelationship("follower"), "follower");
    assert.equal(viewerContextToWindowRelationship("following"), "following");
    assert.equal(viewerContextToWindowRelationship("trip_crew"), "crew");
    assert.equal(viewerContextToWindowRelationship("trip_host"), "crew");
    assert.equal(viewerContextToWindowRelationship("buddy_customer"), "public");
    assert.equal(viewerContextToWindowRelationship("event_group"), "public");
  });
});

describe("buildConsumerProjection — missing owner", () => {
  it("returns null when the owner has no Passport", async () => {
    const p = await buildConsumerProjection(makePassportDb({}), "discovery_card", "ghost", null, inject(resolution("public", permsPublic())));
    assert.equal(p, null);
  });
});
