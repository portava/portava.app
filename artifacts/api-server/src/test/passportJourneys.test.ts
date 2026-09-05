/**
 * Passport Journeys projection (§14, TABLE 26).
 *
 * Verifies:
 *   • trips project into a year → country → city → Trip grouping;
 *   • memories and stamps attach to their Trip;
 *   • a single Featured Journey is derived (richest trip), never stored;
 *   • trip visibility is honoured per viewer (private hidden from non-friends,
 *     buddies visible to a full-profile viewer, owner sees all);
 *   • exact dates are coarsened when show_exact_dates is false for non-owners.
 *
 * Run: node --import tsx/esm --test src/test/passportJourneys.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildJourneys, buildFeaturedJourney } from "../services/passport/PassportJourneyService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const T_VN = "trip-vn";
const T_TH = "trip-th";
const T_PRIV = "trip-priv";

function db() {
  return makePassportDb({
    trip_members: [
      { trip_id: T_VN, user_id: OWNER, role: "owner" },
      { trip_id: T_TH, user_id: OWNER, role: "member" },
      { trip_id: T_PRIV, user_id: OWNER, role: "owner" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: T_TH, owner_id: "someone", title: "Bangkok Weekend", destination_city: "Bangkok", destination_country: "Thailand", start_date: "2024-11-10", end_date: "2024-11-12", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: false },
      { id: T_PRIV, owner_id: OWNER, title: "Secret Trip", destination_city: "Hoi An", destination_country: "Vietnam", start_date: "2025-01-01", end_date: "2025-01-05", status: "completed", visibility: "private", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
      { id: "m2", user_id: OWNER, status: "active", title: "Old town", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-06" },
    ],
    user_stamps: [
      { user_id: OWNER, source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { name: "Vietnam" } },
    ],
  });
}

describe("buildJourneys", () => {
  it("groups the owner's trips by year → country → city and attaches memories/stamps", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.equal(r.totalJourneys, 3);
    // Years present: 2025 (VN + priv) and 2024 (TH), newest first.
    assert.equal(r.years[0].year, 2025);
    const vnYear = r.years.find((y) => y.year === 2025)!;
    const vietnam = vnYear.countries.find((c) => c.country === "Vietnam")!;
    const daNang = vietnam.cities.find((c) => c.city === "Da Nang")!;
    const vn = daNang.journeys.find((j) => j.tripId === T_VN)!;
    assert.equal(vn.memoryCount, 2);
    assert.equal(vn.stampCount, 1);
    assert.equal(vn.durationLabel, "30 days");
  });

  it("derives a single Featured Journey (the richest trip)", async () => {
    const featured = await buildFeaturedJourney(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.ok(featured);
    assert.equal(featured!.tripId, T_VN); // most memories + stamps + longest
    assert.equal(featured!.featured, true);

    const r = await buildJourneys(db(), OWNER, { isSelf: true, canSeeTrips: true, canSeeRestricted: true });
    assert.ok(r.featured);
    assert.equal(r.featured!.tripId, T_VN);
    // The same trip is flagged featured inside the grouped list.
    const flagged = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).filter((j) => j.featured);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].tripId, T_VN);
  });

  it("hides a private trip from a non-friend public viewer, keeps public ones", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: false });
    const ids = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).map((j) => j.tripId);
    assert.ok(ids.includes(T_VN));
    assert.ok(ids.includes(T_TH));
    assert.ok(!ids.includes(T_PRIV), "private trip must not appear to a public viewer");
  });

  it("coarsens exact dates for non-owners when show_exact_dates is false", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: false });
    const th = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).find((j) => j.tripId === T_TH)!;
    assert.equal(th.startDate, null, "exact start date hidden");
    assert.equal(th.endDate, null, "exact end date hidden");
    assert.equal(th.durationLabel, null);
  });

  it("returns empty for a non-owner who cannot see trips", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: false, canSeeRestricted: false });
    assert.equal(r.totalJourneys, 0);
    assert.equal(r.featured, null);
  });
});

// ── D1 regression — a PUBLIC trip must not leak its non-public MEMORIES.
//    Journey/featured memories run the SAME per-memory visibility gate
//    (filterMemories) the standalone §29 step-9 `memories` array does. Before the
//    fix, a viewer who could see a public trip also received that trip's private /
//    circle_only / trip_crew memories.
function dbWithMixedMemoryVisibility() {
  return makePassportDb({
    trip_members: [{ trip_id: T_VN, user_id: OWNER, role: "owner" }],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m-pub", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
      { id: "m-priv", user_id: OWNER, status: "active", title: "Secret spot", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "private", earned_at: "2025-03-06" },
      { id: "m-circle", user_id: OWNER, status: "active", title: "Circle only", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "circle_only", earned_at: "2025-03-07" },
    ],
    user_stamps: [],
  });
}

function journeyMemoryIds(r: Awaited<ReturnType<typeof buildJourneys>>): string[] {
  const j = r.years
    .flatMap((y) => y.countries)
    .flatMap((c) => c.cities)
    .flatMap((c) => c.journeys)
    .find((jj) => jj.tripId === T_VN)!;
  return j.memories.map((m) => m.id).sort();
}

describe("buildJourneys — per-memory visibility (D1)", () => {
  it("hides a public trip's PRIVATE and CIRCLE_ONLY memories from a public viewer", async () => {
    const r = await buildJourneys(dbWithMixedMemoryVisibility(), OWNER, {
      isSelf: false, canSeeTrips: true, canSeeRestricted: false, callerCtx: "public",
    });
    assert.deepEqual(journeyMemoryIds(r), ["m-pub"], "only the public memory reaches a public viewer");
    const j = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).find((jj) => jj.tripId === T_VN)!;
    assert.equal(j.memoryCount, 1, "memoryCount reflects the gated set");
  });

  it("shows circle_only (but not private) to a circle viewer", async () => {
    const r = await buildJourneys(dbWithMixedMemoryVisibility(), OWNER, {
      isSelf: false, canSeeTrips: true, canSeeRestricted: true, callerCtx: "circle",
    });
    assert.deepEqual(journeyMemoryIds(r), ["m-circle", "m-pub"], "circle sees public + circle_only, never private");
  });

  it("shows ALL memories to the owner (self)", async () => {
    const r = await buildJourneys(dbWithMixedMemoryVisibility(), OWNER, {
      isSelf: true, canSeeTrips: true, canSeeRestricted: true, callerCtx: "owner",
    });
    assert.deepEqual(journeyMemoryIds(r), ["m-circle", "m-priv", "m-pub"], "owner sees everything");
  });

  it("featuredJourney also gates the featured trip's memories for a non-owner", async () => {
    const featured = await buildFeaturedJourney(dbWithMixedMemoryVisibility(), OWNER, {
      isSelf: false, canSeeTrips: true, canSeeRestricted: false, callerCtx: "public",
    });
    assert.ok(featured);
    assert.equal(featured!.tripId, T_VN);
    assert.deepEqual(featured!.memories.map((m) => m.id).sort(), ["m-pub"], "featured leaks no private memory");
  });
});

// ── §14/§24 — journey people context: coarse companions, block-filtered ────────
const VIEWER = "viewer-p";
const FRIEND = "friend-p";     // trip co-member
const MATE = "mate-p";         // shared-moment member
const BLOCKED_BY_VIEWER = "blk-viewer-p";
const BLOCKED_BY_OWNER = "blk-owner-p";
const INVITEE = "invitee-p";   // invited, not accepted

/** The table map behind `dbWithPeople`, so a case can override one table. */
function tablesWithPeople(
  blocks: Array<{ blocker_id: string; blocked_id: string }> = [],
  includeBlockCandidates = true,
): Record<string, any[]> {
  return {
    trip_members: [
      { trip_id: T_VN, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: T_VN, user_id: FRIEND, role: "member", status: "accepted" },
      ...(includeBlockCandidates ? [
        { trip_id: T_VN, user_id: BLOCKED_BY_VIEWER, role: "member", status: "accepted" },
        { trip_id: T_VN, user_id: BLOCKED_BY_OWNER, role: "member", status: "accepted" },
      ] : []),
      { trip_id: T_VN, user_id: INVITEE, role: "member", status: "invited" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [],
    user_stamps: [],
    shared_moments: [{ id: "sm-1", trip_id: T_VN }],
    shared_moment_memberships: [
      { moment_id: "sm-1", user_id: MATE, status: "accepted" },
      { moment_id: "sm-1", user_id: "declined-p", status: "declined" },
    ],
    profiles: [
      { id: FRIEND, display_name: "Friend F", name: "Friend", username: "friendf", handle: "friendf", avatar_url: "https://x/f.png", show_profile_picture_publicly: true },
      { id: MATE, display_name: null, name: "Mate M", username: "matem", handle: "matem", avatar_url: "https://x/m.png", show_profile_picture_publicly: false },
      { id: BLOCKED_BY_VIEWER, display_name: "Blk V", name: "Blk", username: "blkv", handle: "blkv", avatar_url: null, show_profile_picture_publicly: true },
      { id: BLOCKED_BY_OWNER, display_name: "Blk O", name: "Blk", username: "blko", handle: "blko", avatar_url: null, show_profile_picture_publicly: true },
      { id: "declined-p", display_name: "Declined", name: "D", username: "dec", handle: "dec", avatar_url: null, show_profile_picture_publicly: true },
    ],
    // These cases are about block-filtering and coarseness, not name visibility:
    // every companion has opted in to `show_real_name`, so the universal
    // display-name rule is satisfied and the name assertions stay meaningful.
    // (The rule itself is covered by passportProjectionNameVisibility.test.ts.)
    profile_privacy_settings: [
      { user_id: FRIEND, show_real_name: true },
      { user_id: MATE, show_real_name: true },
      { user_id: BLOCKED_BY_VIEWER, show_real_name: true },
      { user_id: BLOCKED_BY_OWNER, show_real_name: true },
      { user_id: "declined-p", show_real_name: true },
    ],
    blocks,
  };
}

function dbWithPeople(
  blocks: Array<{ blocker_id: string; blocked_id: string }> = [],
  includeBlockCandidates = true,
) {
  return makePassportDb(tablesWithPeople(blocks, includeBlockCandidates));
}

function peopleOfTVN(r: Awaited<ReturnType<typeof buildJourneys>>) {
  const j = r.years.flatMap((y) => y.countries).flatMap((c) => c.cities).flatMap((c) => c.journeys).find((jj) => jj.tripId === T_VN)!;
  return j.people;
}

describe("buildJourneys — §14 people context", () => {
  it("attaches coarse companions from trip members AND shared moments", async () => {
    const r = await buildJourneys(dbWithPeople([], false), OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER });
    const people = peopleOfTVN(r);
    const ids = people.map((p) => p.id).sort();
    assert.deepEqual(ids, [FRIEND, MATE].sort(), "trip member + shared-moment member, owner/viewer/invitee excluded");

    // Coarse fields only, name falls back name→display, avatar honours photo privacy.
    const friend = people.find((p) => p.id === FRIEND)!;
    assert.equal(friend.name, "Friend F");
    assert.equal(friend.handle, "friendf");
    assert.equal(friend.avatarUrl, "https://x/f.png");
    const mate = people.find((p) => p.id === MATE)!;
    assert.equal(mate.name, "Mate M", "falls back to name when display_name is null");
    assert.equal(mate.avatarUrl, null, "a companion who hides their photo has avatarUrl nulled");

    // Coarse: no dates/location/contact fields leak onto a person.
    assert.deepEqual(Object.keys(friend).sort(), ["avatarUrl", "handle", "id", "name"]);
    // Invited-but-not-accepted member never appears.
    assert.ok(!ids.includes(INVITEE));
  });

  it("honors each companion's show_real_name — the strip is a third-party identity list", async () => {
    // FRIEND opted in; MATE did not. Same fixture, one row flipped.
    const db = dbWithPeople([], false);
    const r = await buildJourneys(db, OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER });
    const people = peopleOfTVN(r);
    // POSITIVE CONTROL: the opted-in companion is still named.
    assert.equal(people.find((p) => p.id === FRIEND)!.name, "Friend F");
    assert.equal(people.find((p) => p.id === MATE)!.name, "Mate M");

    // Now the same trip with MATE opted OUT (no privacy row at all ⇒ unknown ⇒ hidden).
    const optedOut = makePassportDb({
      ...tablesWithPeople([], false),
      profile_privacy_settings: [{ user_id: FRIEND, show_real_name: true }],
    });
    const r2 = await buildJourneys(optedOut, OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER });
    const p2 = peopleOfTVN(r2);
    assert.equal(p2.find((p) => p.id === MATE)!.name, null, "a companion who did not opt in must not be named");
    assert.equal(p2.find((p) => p.id === MATE)!.handle, "matem", "…but still renders by handle");
    assert.equal(p2.find((p) => p.id === FRIEND)!.name, "Friend F", "POSITIVE CONTROL: the opted-in companion is unaffected");
  });

  it("fails CLOSED when the privacy table is unreadable", async () => {
    const base = makePassportDb({
      ...tablesWithPeople([], false),
      profile_privacy_settings: [
        { user_id: FRIEND, show_real_name: true },
        { user_id: MATE, show_real_name: true },
      ],
    });
    const broken: any = {
      ...base,
      from(t: string) {
        if (t === "profile_privacy_settings") throw new Error("privacy table unavailable");
        return base.from(t);
      },
    };
    const r = await buildJourneys(broken, OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER });
    const people = peopleOfTVN(r);
    assert.ok(people.length >= 2, "the people strip still renders");
    for (const p of people) assert.equal(p.name, null, `unknown visibility must hide ${p.handle}'s name, not show it`);
  });

  it("block-filters people in BOTH directions (viewer-blocked and owner-blocked) — §24", async () => {
    const r = await buildJourneys(
      dbWithPeople([
        { blocker_id: VIEWER, blocked_id: BLOCKED_BY_VIEWER },
        { blocker_id: OWNER, blocked_id: BLOCKED_BY_OWNER },
      ]),
      OWNER,
      { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER },
    );
    const ids = peopleOfTVN(r).map((p) => p.id);
    assert.ok(!ids.includes(BLOCKED_BY_VIEWER), "a companion the viewer blocked is hidden");
    assert.ok(!ids.includes(BLOCKED_BY_OWNER), "a companion the owner blocked is hidden");
    assert.ok(ids.includes(FRIEND), "un-blocked companions remain");
  });

  it("fails CLOSED — an unreadable block list yields NO people, never a leak", async () => {
    const base = dbWithPeople();
    const guarded: any = {
      from(table: string) {
        if (table === "blocks") throw new Error("blocks unavailable");
        return base.from(table);
      },
      auth: base.auth,
    };
    const r = await buildJourneys(guarded, OWNER, { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER });
    assert.deepEqual(peopleOfTVN(r), [], "uncertain block state ⇒ show nobody");
  });
});
