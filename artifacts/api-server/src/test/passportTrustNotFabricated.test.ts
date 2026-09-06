/**
 * passportTrustNotFabricated.test.ts
 *
 * A Passport must not present a constant as a measurement.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DEFECT
 * ══════════════════════════════════════════════════════════════════════════════
 * `buildDomainTrust` defaulted every missing category — and the overall score —
 * to the neutral 50, with the stated intent that "a brand-new account reads
 * 'Established' everywhere rather than an alarming zero". But
 * `presentationWord(50)` IS "Established", so the kindness became a claim:
 *
 *   trust_engine_enabled is seeded false
 *     → nothing writes trust_events
 *       → trust_profiles is empty
 *         → getTrustProfile returns null
 *           → every domain renders "Established", for every user alive.
 *
 * The same 50 also absorbed a FAILED read, because `getTrustProfile` never
 * destructures `error` and returns null for both "no row" and "could not read".
 * So "this person is an established member of the community" and "we could not
 * reach the trust engine" were the same six words on the screen.
 *
 * No test caught it. The existing Passport suites all seed a populated
 * `trust_profiles` row, so they only ever exercised the path where the number is
 * real — which is exactly how a fabricated default survives a green suite.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT REPLACES IT
 * ══════════════════════════════════════════════════════════════════════════════
 * `applicable: false`, which this contract already carried for the Buddy domain
 * and which clients already treat as "do not render a rating". No new field, no
 * new vocabulary, and still no alarming zero — the domain simply declines to
 * make a claim it cannot support.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPassportProjection, type ViewerResolution, type ViewerPermissions } from "../services/passport/PassportProjectionService.js";
import { getTrustProfileResult } from "../services/trust/TrustScoreService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "11111111-2222-4333-8444-555555555555";

/** Copied from passportProjection.test.ts — the real ViewerPermissions shape. */
function permsFull(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
const resolver = (res: ViewerResolution) => async () => res;
const selfRes: ViewerResolution = {
  context: "self", permissions: permsFull(), sharedTrip: false,
  sharedEvent: false, ownerIsTripHost: false, buddyRole: null,
};

/** The minimum a projection needs, with trust_profiles under the test's control. */
function db(trustRows: any[] = []) {
  return makePassportDb({
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "W", name: "W", verified: false,
      home_city: "Hanoi", home_country: "Vietnam", is_official: false, is_private: false,
      passport_visibility: "public", created_at: "2023-01-01",
    }],
    user_stamps: [], passport_stamps: [], trip_members: [], trips: [],
    passport_memories: [], quick_availability_status: [], user_availability: [],
    passport_visibility_preferences: [{ user_id: OWNER, stamps_visible: "public", memories_visible: "public" }],
    trust_profiles: trustRows,
  });
}

/** Wraps a fake so `trust_profiles` resolves `{data:null,error}` — the real failure shape. */
function withTrustReadError(base: any) {
  const failing: any = {
    select: () => failing, eq: () => failing, in: () => failing, is: () => failing,
    gt: () => failing, lt: () => failing, lte: () => failing, gte: () => failing,
    order: () => failing, limit: () => failing, not: () => failing, or: () => failing,
    maybeSingle: async () => ({ data: null, error: { message: "trust read failed" } }),
    single: async () => ({ data: null, error: { message: "trust read failed" } }),
    then: (res: any, rej?: any) =>
      Promise.resolve({ data: null, error: { message: "trust read failed" } }).then(res, rej),
  };
  return { ...base, from: (t: string) => (t === "trust_profiles" ? failing : base.from(t)) };
}

const domainsOf = (p: any) => (p.trust?.domains ?? []) as Array<{ key: string; presentation: string; applicable: boolean }>;

// ══ THE THREE STATES ══════════════════════════════════════════════════════════

describe("getTrustProfileResult — absent and unreadable are different answers", () => {
  it("reports a real profile", async () => {
    const r = await getTrustProfileResult(db([{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50,
      guide_accuracy: 40, passport_authenticity: 66,
    }]) as any, OWNER);
    assert.equal(r.state, "ok");
    if (r.state === "ok") assert.equal(Number(r.profile.overall_score), 78);
  });

  it("reports ABSENT for a user with no trust profile", async () => {
    const r = await getTrustProfileResult(db([]) as any, OWNER);
    assert.equal(r.state, "absent");
  });

  it("reports UNAVAILABLE when the read fails — never absent", async () => {
    const r = await getTrustProfileResult(withTrustReadError(db([])) as any, OWNER);
    assert.equal(r.state, "unavailable",
      "a failed read is not an empty trust_profiles table; collapsing the two is " +
      "what let a constant be presented as a measurement");
  });
});

// ══ THE PASSPORT SURFACE ══════════════════════════════════════════════════════

describe("Passport trust domains — no constant presented as a measurement", () => {
  it("a user with NO trust profile is not described as Established", async () => {
    // The defect, stated as an assertion. Every user alive was in this state,
    // because trust_engine_enabled is off and trust_profiles is empty.
    const p = (await buildPassportProjection(db([]) as any, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    const domains = domainsOf(p);
    assert.ok(domains.length > 0, "precondition: domains are projected at all");
    for (const d of domains) {
      assert.notEqual(d.presentation, "Established",
        `domain ${d.key} claimed "Established" with no trust data behind it`);
      assert.equal(d.applicable, false,
        `domain ${d.key} must not be applicable when nothing has been rated`);
    }
  });

  it("an UNREADABLE trust profile says so, and is not confused with a new account", async () => {
    const p = (await buildPassportProjection(withTrustReadError(db([])) as any, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    const domains = domainsOf(p);
    assert.ok(domains.every((d) => d.applicable === false));
    assert.ok(domains.every((d) => d.presentation === "Unavailable"),
      'a failed read must read as "Unavailable", not as "Not yet rated" and ' +
      "certainly not as a rating");
  });

  it("a REAL profile still projects real words — the fix must not blank the feature", async () => {
    const p = (await buildPassportProjection(db([{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
      location_honesty: 60, content_quality: 45, community_value: 50,
      guide_accuracy: 40, passport_authenticity: 66,
    }]) as any, OWNER, OWNER, { resolveViewerContext: resolver(selfRes) }))!;
    const domains = domainsOf(p);
    const overall = domains.find((d) => d.key === "overall")!;
    assert.equal(overall.applicable, true);
    assert.equal(overall.presentation, "Strong", "78 is Strong");
    const host = domains.find((d) => d.key === "trip_host")!;
    assert.equal(host.applicable, true);
    assert.equal(host.presentation, "Strong", "host_quality 68 is Strong");
  });

  it("a PARTIAL profile rates only the domains it can, and declines the rest", async () => {
    // The subtler half: a profile that exists but is missing categories used to
    // borrow 50 for each gap, so an unrated domain read "Established" beside a
    // genuinely rated one.
    const p = (await buildPassportProjection(db([{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      host_quality: 68,
      // every other category absent
    }]) as any, OWNER, OWNER, { resolveViewerContext: resolver(selfRes) }))!;
    const domains = domainsOf(p);
    const host = domains.find((d) => d.key === "trip_host")!;
    assert.equal(host.applicable, true, "host_quality exists, so Trip Host is rateable");
    const contributor = domains.find((d) => d.key === "contributor")!;
    assert.equal(contributor.applicable, false,
      "no contributor category exists — the domain must not borrow a neutral 50");
    assert.notEqual(contributor.presentation, "Established");
  });

  it("Buddy stays 'Not applicable' for a non-buddy, unchanged", async () => {
    const p = (await buildPassportProjection(db([]) as any, OWNER, OWNER, {
      resolveViewerContext: resolver(selfRes),
    }))!;
    const buddy = domainsOf(p).find((d) => d.key === "buddy")!;
    assert.equal(buddy.applicable, false);
  });
});
