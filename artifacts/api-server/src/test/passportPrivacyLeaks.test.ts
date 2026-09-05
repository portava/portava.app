/**
 * Passport privacy leaks — three HIGH defects fixed together (§22, TABLE 24).
 *
 * 1. PER-STAMP VISIBILITY WAS DROPPED ON THE PROJECTION PATH.
 *    PassportProjectionService step 7 mapped the whole unified stamp collection
 *    straight to the wire, consulting only the COLLECTION-level tier. A stamp
 *    the owner marked `private` or `circle_only` reached any viewer that
 *    cleared the collection gate. `UnifiedStamp` did not even carry the row's
 *    `visibility`.
 *
 * 2. THE CIRCLE GATE WAS A CONSTANT.
 *    `toCallerContext` promoted a viewer to the "circle" tier on
 *    `canViewFullProfile`, which `resolveInteractionPermissions` returns as a
 *    literal `true` for every non-blocked viewer. "circle_only" was therefore
 *    equivalent to "everyone". The circle tier now rests on the canonical
 *    verified relationship (`canSeeFriendOnlyPosts`, set from the single
 *    `user_friendships` normalized-pair read).
 *
 * 3. SHARED CONTEXT DISCLOSED AN OPTED-OUT CITY.
 *    The main projection honours `profile_privacy_settings.show_current_city`;
 *    the sibling Shared Context path read `profiles.current_city` directly and
 *    published it as the both-in-city fact detail AND as the Compass handoff
 *    city. Both paths now use the one canonical reader
 *    (`PassportPrivacyGuard.loadOwnerFieldVisibility`).
 *
 * Run: node --import tsx/esm --test src/test/passportPrivacyLeaks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassportProjection,
  toCallerContext,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { buildSharedContext } from "../services/passport/SharedContextService.js";
import {
  isUnifiedStampVisible,
  filterUnifiedStamps,
  type UnifiedStamp,
} from "../services/passport/UnifiedStampService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const STRANGER = "stranger-1";
const FRIEND = "friend-1";

// user_friendships stores the pair normalized (user_a < user_b).
function friendship(a: string, b: string) {
  return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
}

const STAMP_BASE = {
  user_id: OWNER,
  stamp_type: "destination",
  verification_level: "gps",
  source_type: "gps",
  created_at: "2026-01-01T00:00:00Z",
};

/** Owner with one public, one private, one circle_only and one trip_crew stamp. */
function stampWorld(over: Record<string, any[]> = {}) {
  return makePassportDb({
    profiles: [
      { id: OWNER, display_name: "Owner", handle: "owner", home_city: "Hanoi", home_country: "VN", is_private: false },
      { id: STRANGER, display_name: "Stranger", handle: "stranger", is_private: false },
      { id: FRIEND, display_name: "Friend", handle: "friend", is_private: false },
    ],
    passport_stamps: [
      { ...STAMP_BASE, id: "s-public", country: "VN", city: "Da Nang", visibility: "public", awarded_at: "2026-01-04T00:00:00Z" },
      { ...STAMP_BASE, id: "s-private", country: "JP", city: "Tokyo", visibility: "private", awarded_at: "2026-01-03T00:00:00Z" },
      { ...STAMP_BASE, id: "s-circle", country: "TH", city: "Bangkok", visibility: "circle_only", awarded_at: "2026-01-02T00:00:00Z" },
      { ...STAMP_BASE, id: "s-crew", country: "PH", city: "Manila", visibility: "trip_crew", awarded_at: "2026-01-01T00:00:00Z" },
    ],
    user_stamps: [],
    user_friendships: [],
    ...over,
  });
}

function cities(p: { stamps: Array<{ city: string | null }> } | null): string[] {
  return (p?.stamps ?? []).map((s) => s.city ?? "").sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 1 — per-stamp visibility on the projection path
// ─────────────────────────────────────────────────────────────────────────────

describe("passport projection — per-stamp visibility (§22)", () => {
  it("hides private and circle_only stamps from a non-member viewer", async () => {
    const proj = await buildPassportProjection(stampWorld(), OWNER, STRANGER);
    assert.ok(proj, "projection built");
    assert.deepEqual(cities(proj), ["Da Nang"]);
    // Explicit, per-defect assertions so a regression names the leaked tier.
    assert.ok(!cities(proj).includes("Tokyo"), "private stamp must not reach a stranger");
    assert.ok(!cities(proj).includes("Bangkok"), "circle_only stamp must not reach a non-member");
    assert.ok(!cities(proj).includes("Manila"), "trip_crew stamp must not reach a non-crew viewer");
  });

  it("shows every stamp to the owner", async () => {
    const proj = await buildPassportProjection(stampWorld(), OWNER, OWNER);
    assert.deepEqual(cities(proj), ["Bangkok", "Da Nang", "Manila", "Tokyo"]);
  });

  it("an unauthenticated viewer sees only public stamps", async () => {
    const proj = await buildPassportProjection(stampWorld(), OWNER, null);
    assert.deepEqual(cities(proj), ["Da Nang"]);
  });

  it("a VERIFIED circle member sees circle_only but still not private", async () => {
    const db = stampWorld({ user_friendships: [friendship(OWNER, FRIEND)] });
    const proj = await buildPassportProjection(db, OWNER, FRIEND);
    assert.deepEqual(cities(proj), ["Bangkok", "Da Nang"]);
    assert.ok(!cities(proj).includes("Tokyo"), "private is private even inside the circle");
  });

  it("fails closed on an absent or unrecognised visibility tier", () => {
    const mk = (over: Partial<UnifiedStamp>): UnifiedStamp => ({
      source: "v1_gps",
      stampSource: "system_observed",
      verification: "verified",
      visibility: "public",
      userStampId: null,
      definitionId: null,
      catalogId: null,
      stampType: "destination",
      city: "X",
      country: "Y",
      earnedAt: null,
      name: null,
      rarity: null,
      artworkUrl: null,
      ...over,
    });
    assert.equal(isUnifiedStampVisible(mk({ visibility: null }), "public"), false);
    assert.equal(isUnifiedStampVisible(mk({ visibility: "" }), "public"), false);
    assert.equal(isUnifiedStampVisible(mk({ visibility: "whatever" }), "circle"), false);
    // …but the owner always sees their own, whatever the tier says.
    assert.equal(isUnifiedStampVisible(mk({ visibility: null }), "owner"), true);
    // v2 rows use their own vocabulary (public|friends_only|private).
    const v2 = mk({ source: "v2_achievement", visibility: "friends_only" });
    assert.equal(isUnifiedStampVisible(v2, "public"), false);
    assert.equal(isUnifiedStampVisible(v2, "circle"), true);
    assert.equal(filterUnifiedStamps([mk({ visibility: "private" }), mk({})], "public").length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 2 — the circle gate must be a real relationship, not a constant
// ─────────────────────────────────────────────────────────────────────────────

describe("passport circle gate — real membership, not a constant (§22)", () => {
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

  it("canViewFullProfile really is a constant true for a total stranger", async () => {
    const p = await resolveInteractionPermissions(stampWorld(), STRANGER, OWNER);
    // Documents WHY the gate cannot rest on this flag. If this ever becomes a
    // real relationship signal the gate can be revisited — but not before.
    assert.equal(p.canViewFullProfile, true);
    assert.equal(p.canSeeFriendOnlyPosts, false, "no friendship row ⇒ not in the circle");
  });

  it("refuses the circle tier to a viewer with no verified relationship", () => {
    assert.equal(toCallerContext("public", perms({ canViewFullProfile: true })), "public");
    assert.equal(toCallerContext("follower", perms({ canViewFullProfile: true })), "public");
    assert.equal(toCallerContext("following", perms({ canViewFullProfile: true })), "public");
  });

  it("grants the circle tier only on the canonical verified relationship", () => {
    assert.equal(toCallerContext("following", perms({ canSeeFriendOnlyPosts: true })), "circle");
  });

  it("end-to-end: a circle_only disclosure is refused without a friendship row", async () => {
    const withoutRow = await buildPassportProjection(stampWorld(), OWNER, STRANGER);
    assert.ok(!cities(withoutRow).includes("Bangkok"));
    const withRow = await buildPassportProjection(
      stampWorld({ user_friendships: [friendship(OWNER, STRANGER)] }),
      OWNER,
      STRANGER,
    );
    assert.ok(cities(withRow).includes("Bangkok"), "a real circle member does get circle_only");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFECT 3 — Shared Context must honour show_current_city
// ─────────────────────────────────────────────────────────────────────────────

describe("shared context — show_current_city opt-out (TABLE 24, §22)", () => {
  const ALL = { canSeeAvailability: true, canSeeMutuals: true, canSeeTrips: true, canMakePlan: true };

  function cityWorld(showCurrentCity: boolean) {
    return makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Hanoi", interests: ["Food"], availability_tags: [] },
        { id: STRANGER, current_city: "Da Nang", home_city: "Da Nang", interests: ["Food"], availability_tags: [] },
      ],
      profile_privacy_settings: [
        { user_id: OWNER, show_home_country: true, show_current_city: showCurrentCity },
      ],
    });
  }

  function bothInCity(p: { facts: Array<{ key: string; detail: string | null }> }) {
    return p.facts.find((f) => f.key === "both_in_city") ?? null;
  }

  it("hides the city from a non-owner viewer when the owner opted out", async () => {
    const r = await buildSharedContext(cityWorld(false), OWNER, STRANGER, ALL);
    assert.equal(bothInCity(r), null, "the whole both-in-city fact is withheld");
    assert.equal(r.compassHandoff.city, null, "the Compass handoff must not carry it either");
    // The fact must not be smuggled back through any other field.
    assert.ok(!JSON.stringify(r).includes("Da Nang"), "no field discloses the opted-out city");
  });

  it("still discloses the city when the owner has NOT opted out", async () => {
    const r = await buildSharedContext(cityWorld(true), OWNER, STRANGER, ALL);
    assert.equal(bothInCity(r)?.detail, "Da Nang");
    assert.equal(r.compassHandoff.city, "Da Nang");
  });

  it("show-by-default: an absent settings row still discloses", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Hanoi" },
        { id: STRANGER, current_city: "Da Nang", home_city: "Da Nang" },
      ],
    });
    const r = await buildSharedContext(db, OWNER, STRANGER, ALL);
    assert.equal(bothInCity(r)?.detail, "Da Nang");
  });

  it("the owner's own view is unaffected by the opt-out", async () => {
    // Shared Context is a viewer↔owner projection; the owner's own passport
    // reads travelerState, which the projection path exempts from the opt-out.
    const proj = await buildPassportProjection(cityWorld(false), OWNER, OWNER);
    assert.equal(proj?.travelerState?.city, "Da Nang");
    const forStranger = await buildPassportProjection(cityWorld(false), OWNER, STRANGER);
    assert.equal(forStranger?.travelerState?.city, null);
  });
});
