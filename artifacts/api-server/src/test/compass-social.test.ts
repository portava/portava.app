/**
 * Compass Phase 9 — social intelligence tests.
 *
 * Covers:
 *  A. computeTravelCompatibility — deterministic, overlap-only reveal
 *  B. Group aggregation + event group constraints (budget, capacity, age, verification)
 *  C. get_whos_around — permission gate, approximate-only, blocked users never surface,
 *     no coordinates / needs_help leak, @handle default
 *  D. get_travel_compatibility — relationship gate, uniform "not available" answers
 *     (adversarial: strangers, blocked users, nonexistent users all indistinguishable)
 *  E. get_group_recommendation — group constraints enforced, blocked-host exclusion,
 *     cross-circle probing defense, sanitized output
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/compass-social.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCompassTool } from "../compass/CompassTools.js";
import {
  computeTravelCompatibility,
  aggregateGroupPreferences,
  buildGroupRankingProfile,
  eventSatisfiesGroup,
  ageFromDob,
} from "../compass/CompassSocialEngine.js";
import { loadCircleMemoryPreferenceTags } from "../compass/CompassRecommendationEngine.js";
import type { CompassProfile } from "../compass/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const CARA_ID  = "c3c3c3c3-cccc-cccc-cccc-000000000003";
const EVE_ID   = "e5e5e5e5-eeee-eeee-eeee-000000000005";
const TRIP_ID  = "eeee0000-eeee-eeee-eeee-000000000001";
const EVENT_ID = "eeee0000-eeee-eeee-eeee-000000000002";

function profileFor(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: ALICE_ID,
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    ...overrides,
  } as unknown as CompassProfile;
}

// ── Fake Supabase client (same pattern as compass-tools.test.ts) ─────────────

type Db = Record<string, any[]>;

function makeDb(overrides: Db = {}): Db {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles: [],
    trips: [],
    trip_members: [],
    trip_plan_items: [],
    discovery_places: [],
    events: [],
    event_rsvps: [],
    event_attendees: [],
    circles: [],
    circle_memberships: [],
    circle_visibility_settings: [],
    circle_context_settings: [],
    circle_presence: [],
    blocks: [],
    user_mutes: [],
    user_account_states: [],
    profile_privacy_settings: [],
    trust_profiles: [],
    compass_user_preferences: [],
    compass_memories: [],
    user_interactions: [],
    ...overrides,
  };
}

function makeClient(db: Db) {
  function builder(table: string, rows: any[]) {
    let filtered = [...rows];

    const likeFilter = (col: string, pat: string) => {
      const re = new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
    };

    const b: any = {
      select: (_c?: string) => b,
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is:  (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      gte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") >= String(val)); return b; },
      lte: (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") <= String(val)); return b; },
      gt:  (col: string, val: any) => { filtered = filtered.filter((r) => String(r[col] ?? "") > String(val)); return b; },
      ilike: (col: string, pat: string) => { likeFilter(col, pat); return b; },
      like:  (col: string, pat: string) => { likeFilter(col, pat); return b; },
      or:  (_expr: string) => b, // free-text OR is a no-op in the fake — rows pass through
      not: () => b,
      order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } }),
      then: (resolve: any) => resolve({ data: filtered, error: null }),
      update: () => b,
      insert: (payload: any) => {
        (db[table] ??= []).push(Array.isArray(payload) ? payload[0] : payload);
        return b;
      },
    };
    return b;
  }

  return { from: (table: string) => builder(table, db[table] ?? []) } as any;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Alice + Bob (+ optionally more) accepted members of an active trip. */
function tripFixture(extraMembers: string[] = []): Db {
  return makeDb({
    trips: [{ id: TRIP_ID, title: "Cebu Trip", destination_city: "Cebu", status: "active", owner_id: ALICE_ID, start_date: "2026-07-18", end_date: "2026-07-28" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member", status: "accepted" },
      ...extraMembers.map((id) => ({ trip_id: TRIP_ID, user_id: id, role: "member", status: "accepted" })),
    ],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice Real", interests: ["food", "diving"], travel_styles: ["backpacker"], budget_style: "budget", travel_pace: "balanced", spoken_languages: ["en"], verified: true, date_of_birth: "1996-01-15" },
      { id: BOB_ID,   handle: "bob",   name: "Bob Real",   interests: ["food", "hiking"], travel_styles: ["backpacker"], budget_style: "luxury", travel_pace: "balanced", spoken_languages: ["en", "fr"], verified: true, date_of_birth: "1994-05-02" },
      { id: CARA_ID,  handle: "cara",  name: "Cara Real",  interests: ["museums"], travel_styles: [], budget_style: "mid-range", travel_pace: "slow", spoken_languages: ["de"], verified: false, date_of_birth: "2004-03-10" },
      { id: EVE_ID,   handle: "eve",   name: "Eve Real",   interests: ["food"], travel_styles: [], budget_style: null, travel_pace: null, spoken_languages: [], verified: true, date_of_birth: null },
    ],
  });
}

function sharingOn(userId: string) {
  return {
    user_id: userId,
    global_enabled: true,
    visibility_mode: "status_only",
    trip_sharing_default: "approximate_area",
    event_sharing_default: "status_only",
    is_paused: false,
    consent_version: "v1",
    consented_at: "2026-07-01T00:00:00Z",
  };
}

function presenceRow(userId: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    context_type: "trip",
    context_id: TRIP_ID,
    status: "arrived",
    status_label: "Grabbing dinner",
    approximate_label: "Lahug area",
    venue_label: "Secret Exact Bar, 123 Real St",
    checked_in: false,
    stale_after_secs: 999999,
    last_seen_at: new Date().toISOString(),
    expires_at: null,
    is_stale: false,
    needs_help: false,
    ...extra,
  };
}

// ── A. Travel compatibility (pure) ────────────────────────────────────────────

describe("A. computeTravelCompatibility", () => {
  const alice = { interests: ["Food", "diving", "surf"], travelStyles: ["backpacker"], budgetStyle: "budget", travelPace: "balanced", languages: ["en", "es"] };
  const bob   = { interests: ["food", "hiking"], travelStyles: ["backpacker", "luxury"], budgetStyle: "mid-range", travelPace: "balanced", languages: ["en"] };

  it("is deterministic and reveals ONLY the overlap", () => {
    const r1 = computeTravelCompatibility(alice, bob);
    const r2 = computeTravelCompatibility(alice, bob);
    assert.deepEqual(r1, r2, "must be deterministic");
    assert.deepEqual(r1.sharedInterests, ["food"], "only shared interests appear (case-insensitive)");
    assert.deepEqual(r1.sharedStyles, ["backpacker"]);
    assert.deepEqual(r1.sharedLanguages, ["en"]);
    assert.ok(!JSON.stringify(r1).toLowerCase().includes("hiking"), "the OTHER person's non-shared interests must never appear");
    assert.equal(r1.budgetAlignment, "compatible", "budget/mid-range are adjacent");
    assert.equal(r1.paceAlignment, "same");
    assert.ok(r1.score > 40 && r1.score <= 100);
  });

  it("scores no-overlap pairs low and flexible budgets as compatible", () => {
    const r = computeTravelCompatibility(
      { interests: ["opera"], travelStyles: [], budgetStyle: "flexible", travelPace: "slow", languages: [] },
      { interests: ["surf"],  travelStyles: [], budgetStyle: "luxury",   travelPace: "packed", languages: [] },
    );
    assert.equal(r.budgetAlignment, "compatible");
    assert.equal(r.paceAlignment, "different");
    assert.deepEqual(r.sharedInterests, []);
    assert.ok(r.score <= 50);
  });
});

// ── B. Group aggregation + event constraints ─────────────────────────────────

describe("B. Group aggregation", () => {
  const members = [
    { userId: ALICE_ID, handle: "alice", interests: ["food", "diving"], travelStyles: ["backpacker"], budgetStyle: "luxury", travelPace: "balanced", verified: true,  age: 30 },
    { userId: BOB_ID,   handle: "bob",   interests: ["food", "hiking"], travelStyles: [],             budgetStyle: "budget", travelPace: "slow",     verified: false, age: 22 },
  ];

  it("aggregates most-restrictive budget, shared interests, youngest age, all-verified", () => {
    const agg = aggregateGroupPreferences(members);
    assert.equal(agg.size, 2);
    assert.equal(agg.budgetStyle, "budget", "most restrictive concrete budget wins");
    assert.deepEqual(agg.sharedInterests, ["food"]);
    assert.equal(agg.youngestAge, 22);
    assert.equal(agg.allVerified, false);
  });

  it("event constraints: capacity, age, verification are all group-enforced", () => {
    const agg = aggregateGroupPreferences(members);
    assert.equal(eventSatisfiesGroup({ max_attendees: 10, going_count: 9 }, agg).ok, false, "room for 1, group of 2");
    assert.equal(eventSatisfiesGroup({ max_attendees: 10, going_count: 8 }, agg).ok, true);
    assert.equal(eventSatisfiesGroup({ age_min: 25 }, agg).ok, false, "youngest member is 22");
    assert.equal(eventSatisfiesGroup({ age_min: 21 }, agg).ok, true);
    assert.equal(eventSatisfiesGroup({ requires_verification: true }, agg).ok, false, "one member unverified");
  });

  it("age gate fails CLOSED when no member age is known", () => {
    const agg = aggregateGroupPreferences(members.map((m) => ({ ...m, age: null })));
    assert.equal(agg.youngestAge, null);
    assert.equal(eventSatisfiesGroup({ age_min: 18 }, agg).ok, false);
  });

  it("group ranking profile unions blocks and adopts group constraints", () => {
    const agg = aggregateGroupPreferences(members);
    const gp = buildGroupRankingProfile(profileFor({ blockedUserIds: [CARA_ID] }), agg, [EVE_ID]);
    assert.ok(gp.blockedUserIds.includes(CARA_ID) && gp.blockedUserIds.includes(EVE_ID), "blocks are the union of everyone's");
    assert.equal(gp.budgetStyle, "budget");
    assert.equal(gp.viewerAge, 22, "youngest age drives age-gated eligibility");
  });

  it("ageFromDob computes server-side age and rejects garbage", () => {
    assert.equal(ageFromDob("not-a-date"), null);
    assert.equal(ageFromDob(null), null);
    const age = ageFromDob("2000-01-01");
    assert.ok(typeof age === "number" && age >= 25 && age <= 27);
  });
});

// ── C. get_whos_around ────────────────────────────────────────────────────────

describe("C. get_whos_around", () => {
  it("shows a sharing co-member at approximate granularity, @handle default, no precise data", async () => {
    const db = tripFixture();
    db.circle_visibility_settings = [sharingOn(BOB_ID)];
    db.circle_presence = [presenceRow(BOB_ID)];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.equal(result.people.length, 1);
    const p = result.people[0];
    assert.equal(p.handle, "@bob");
    assert.equal(p.label, "@bob", "@handle default — real name only with opt-in");
    assert.equal(p.status, "arrived");
    assert.ok(String(p.approximateArea).includes("Lahug area"), "approximate area shared in approximate_area mode");
    assert.equal(p.venue, null, "venue label must NOT leak outside venue_checkin mode");
    const json = JSON.stringify(result);
    assert.ok(!json.includes("Secret Exact Bar"), "precise venue string must never leak");
    assert.ok(!json.toLowerCase().includes("needs_help") && !json.includes("needsHelp"), "needs_help must never be exposed");
    assert.ok(!("lat" in p) && !("lng" in p) && !json.includes('"lat"'), "no coordinates, ever");
  });

  it("uses the real name only when the person opted in via show_real_name", async () => {
    const db = tripFixture();
    db.circle_visibility_settings = [sharingOn(BOB_ID)];
    db.circle_presence = [presenceRow(BOB_ID)];
    db.profile_privacy_settings = [{ user_id: BOB_ID, show_real_name: true }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.equal(result.people[0].label, "Bob Real");
  });

  it("excludes members with sharing off and never surfaces blocked users — even with a presence row", async () => {
    const db = tripFixture([CARA_ID, EVE_ID]);
    // Bob shares; Cara has sharing off; Eve shares but is BLOCKED by Alice.
    db.circle_visibility_settings = [sharingOn(BOB_ID), sharingOn(EVE_ID)];
    db.circle_presence = [presenceRow(BOB_ID), presenceRow(CARA_ID), presenceRow(EVE_ID)];
    // The blocks TABLE is the source of truth — social tools re-resolve it per call.
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: EVE_ID }];
    const profile = profileFor({ blockedUserIds: [EVE_ID] });
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profile, "get_whos_around", {});
    const handles = result.people.map((p: any) => p.handle);
    assert.deepEqual(handles, ["@bob"], "sharing-off and blocked users must not appear");
    assert.ok(!JSON.stringify(result).includes("@eve") && !JSON.stringify(result).includes(EVE_ID), "blocked user must leave no trace");
  });

  it("mutual block at the DB level also hides presence (defense-in-depth beyond the profile arrays)", async () => {
    const db = tripFixture();
    db.circle_visibility_settings = [sharingOn(BOB_ID)];
    db.circle_presence = [presenceRow(BOB_ID)];
    db.blocks = [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }];
    // Profile arrays empty on purpose — the guard's own block check must catch it.
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.deepEqual(result.people, []);
  });

  it("venue is shared ONLY on explicit check-in in venue_checkin mode", async () => {
    const db = tripFixture();
    db.circle_visibility_settings = [{ ...sharingOn(BOB_ID), trip_sharing_default: "venue_checkin" }];
    db.circle_presence = [presenceRow(BOB_ID, { checked_in: true, venue_label: "Lantaw Cafe" })];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.ok(String(result.people[0].venue).includes("Lantaw Cafe"), "explicit check-in venue is shared");
    assert.equal(result.people[0].approximateArea, null, "approximate label not shown in venue mode");
  });

  it("is honest when the user has no active contexts", async () => {
    const result: any = await executeCompassTool(makeClient(makeDb()), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.deepEqual(result.people, []);
    assert.ok(String(result.info).toLowerCase().includes("no active"), "honest empty answer");
  });
});

// ── D. get_travel_compatibility ───────────────────────────────────────────────

describe("D. get_travel_compatibility", () => {
  it("computes compatibility for a trip co-member and reveals only the overlap", async () => {
    const db = tripFixture();
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "@bob" });
    assert.ok(result.compatibility, "co-members can be compared");
    assert.equal(result.compatibility.handle, "@bob");
    assert.deepEqual(result.compatibility.sharedInterests, ["food"]);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("hiking"), "Bob's non-shared interests must never leak");
    assert.ok(!json.includes("1994"), "DOB must never leak");
    assert.ok(!json.includes("Bob Real"), "real name must not appear without opt-in");
  });

  it("ADVERSARIAL: stranger, blocked user, and nonexistent user get the SAME uniform answer", async () => {
    const db = tripFixture();
    // Cara exists but shares no context with Alice; Eve is a co-member but blocked.
    db.trip_members.push({ trip_id: TRIP_ID, user_id: EVE_ID, role: "member", status: "accepted" });
    // The blocks TABLE is the source of truth — social tools re-resolve it per call.
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: EVE_ID }];
    const profile = profileFor({ blockedUserIds: [EVE_ID] });
    const client = makeClient(db);
    const stranger: any = await executeCompassTool(client, ALICE_ID, profile, "get_travel_compatibility", { handle: "cara" });
    const blocked:  any = await executeCompassTool(client, ALICE_ID, profile, "get_travel_compatibility", { handle: "eve" });
    const missing:  any = await executeCompassTool(client, ALICE_ID, profile, "get_travel_compatibility", { handle: "ghost" });
    assert.equal(stranger.compatibility, null);
    assert.deepEqual(stranger, blocked, "blocked must be indistinguishable from stranger");
    assert.deepEqual(stranger, missing, "nonexistent must be indistinguishable from stranger");
  });

  it("Trust gate: below-floor accounts are not surfaced", async () => {
    const db = tripFixture();
    db.trust_profiles = [{ user_id: BOB_ID, overall_score: 5 }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" });
    assert.equal(result.compatibility, null);
  });
});

// ── D2. §8 explicit current-intent weighting ──────────────────────────────────
//
// Compass reads both travelers' EXPLICIT availability windows through the ONE
// Passport projection layer and weights a shared CURRENT intent above generic
// long-term interests — but ONLY when the target has an active explicit window,
// so ordering is unchanged for travelers who declared no explicit intent (§8).

const WIN_PAST = new Date(Date.now() - 3_600_000).toISOString();
const WIN_FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();
function windowRow(userId: string, intents: string[], visibility = "public") {
  return {
    id: `w-${userId}-${Math.random().toString(16).slice(2)}`, user_id: userId, type: "one_time",
    start_at: WIN_PAST, end_at: WIN_FUTURE, trip_id: null, open_to_plans: true, intents,
    group_preference: "small_group", max_travel_minutes: 20, visibility,
    source: "explicit", social_availability: "open", expires_at: WIN_FUTURE,
    created_at: WIN_PAST, updated_at: WIN_PAST,
  };
}

describe("D2. get_travel_compatibility — §8 explicit current-intent weighting", () => {
  it("a shared explicit current intent lifts the score above the generic-only baseline (order changes only WITH a window)", async () => {
    // Baseline: co-members, no explicit windows → no intent weighting at all.
    const baseline: any = await executeCompassTool(
      makeClient(tripFixture()), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" },
    );
    assert.ok(baseline.compatibility, "co-members can be compared");
    assert.deepEqual(baseline.compatibility.sharedIntents, [], "no window ⇒ no explicit current intent");
    assert.equal(baseline.compatibility.intentBoosted, false, "no window ⇒ ordering unchanged");

    // Both now hold an active explicit window sharing 'Nightlife'.
    const db = tripFixture();
    db.availability_windows = [
      windowRow(ALICE_ID, ["Nightlife", "Food"]),
      windowRow(BOB_ID, ["Nightlife"], "public"),
    ];
    const boosted: any = await executeCompassTool(
      makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" },
    );
    assert.ok(boosted.compatibility);
    assert.deepEqual(boosted.compatibility.sharedIntents, ["Nightlife"], "only the SHARED explicit intent is revealed");
    assert.equal(boosted.compatibility.intentBoosted, true);
    assert.ok(
      boosted.compatibility.score > baseline.compatibility.score,
      "explicit current-intent overlap must outweigh the generic-only baseline",
    );
    // Alice's own non-shared intent ("Food") must never surface as shared.
    assert.ok(!boosted.compatibility.sharedIntents.includes("Food"), "non-shared intent must not surface");
  });

  it("§7: a window the caller may NOT see (private) never weights the score", async () => {
    const db = tripFixture();
    db.availability_windows = [
      windowRow(ALICE_ID, ["Nightlife"]),
      windowRow(BOB_ID, ["Nightlife"], "private"), // §7: private/inferred is never shared
    ];
    const result: any = await executeCompassTool(
      makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" },
    );
    assert.ok(result.compatibility);
    assert.deepEqual(result.compatibility.sharedIntents, [], "a private window is invisible to the caller");
    assert.equal(result.compatibility.intentBoosted, false);
  });
});

// ── E. get_group_recommendation ───────────────────────────────────────────────

function groupFixture(): Db {
  const db = tripFixture();
  db.circles = [{ id: "circ-1", name: "Dive Crew", owner_id: ALICE_ID }];
  db.circle_memberships = [{ user_id: ALICE_ID, other_id: BOB_ID, status: "accepted" }];
  const soon = new Date(Date.now() + 86400_000).toISOString();
  db.events = [
    { id: "ev-open",     title: "Food Market Night", city: "Cebu", starts_at: soon, category: "food",      host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 30, going_count: 3, age_min: null, verified_only: false },
    { id: "ev-full",     title: "Tiny Tasting",      city: "Cebu", starts_at: soon, category: "food",      host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 4,  going_count: 3, age_min: null, verified_only: false },
    { id: "ev-verified", title: "Verified Mixer",    city: "Cebu", starts_at: soon, category: "social",    host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 30, going_count: 0, age_min: null, verified_only: true },
    { id: "ev-agegate",  title: "Casino Night",      city: "Cebu", starts_at: soon, category: "nightlife", host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 30, going_count: 0, age_min: 35,   verified_only: false },
    { id: "ev-blocked",  title: "Rooftop Party",     city: "Cebu", starts_at: soon, category: "nightlife", host_id: EVE_ID,  state: "published", visibility: "public", max_attendees: 30, going_count: 0, age_min: null, verified_only: false },
  ];
  return db;
}

describe("E. get_group_recommendation", () => {
  it("enforces every group constraint: capacity, verification, age, and member blocks", async () => {
    const db = groupFixture();
    // Bob (a member) has blocked Eve — Eve's event must vanish for the WHOLE group.
    db.blocks = [{ blocker_id: BOB_ID, blocked_id: EVE_ID }];
    // Make Bob unverified so verified_only events fail the group.
    db.profiles = db.profiles.map((p: any) => (p.id === BOB_ID ? { ...p, verified: false } : p));
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    const ids = result.candidates.map((c: any) => c.id);
    assert.deepEqual(ids, ["ev-open"], `only the unconstrained event survives (got ${ids})`);
    const reasons = result.groupConstraintsApplied;
    assert.ok(reasons.includes("not_enough_capacity_for_group"), "capacity constraint reported");
    assert.ok(reasons.includes("verification_required_not_all_members_verified"), "verification constraint reported");
    assert.ok(reasons.includes("age_restriction_not_met_by_all_members"), "age constraint reported");
    assert.ok(!JSON.stringify(result).includes("Rooftop Party"), "event hosted by a member-blocked user must never surface");
    assert.equal(result.group.size, 2);
    assert.deepEqual(result.group.budgetStyle, "budget", "most restrictive budget");
    assert.ok(result.group.memberHandles.includes("@alice") && result.group.memberHandles.includes("@bob"));
  });

  it("ADVERSARIAL cross-circle probing: a circle the user is not in is indistinguishable from a nonexistent one", async () => {
    const db = groupFixture();
    db.circles.push({ id: "circ-2", name: "Others Only", owner_id: CARA_ID }); // Alice not a member
    const client = makeClient(db);
    const notMember: any = await executeCompassTool(client, ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Others Only", kind: "events" });
    const missing:   any = await executeCompassTool(client, ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "No Such Circle", kind: "events" });
    assert.deepEqual(notMember.candidates, []);
    assert.deepEqual(notMember, missing, "membership must not be probeable via circle names");
  });

  it("falls back to the current trip group and never leaks DOB or coordinates", async () => {
    const db = groupFixture();
    db.discovery_places = [
      { id: "p-1", name: "Lantaw Cafe", category: "food", city: "Cebu", rating: 4.6, saved_count: 12, verified: true, lat: 10.3, lng: 123.9 },
    ];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor({ currentCity: "Cebu" } as any), "get_group_recommendation", {});
    assert.equal(result.candidates.length, 1);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('"lat"') && !json.includes('"lng"'), "no coordinates");
    assert.ok(!json.includes("1996") && !json.includes("date_of_birth"), "no DOB");
    assert.ok(String(result.group.label).includes("Cebu Trip"));
  });

  it("uses the circle's remembered preferences to boost matching candidates", async () => {
    const db = groupFixture();
    const soon = new Date(Date.now() + 86400_000).toISOString();
    db.events.push({ id: "ev-veg", title: "Garden Feast", city: "Cebu", starts_at: soon, category: "vegetarian", host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 30, going_count: 0, age_min: null, verified_only: false });
    db.compass_memories = [
      { id: "m-1", user_id: BOB_ID, scope: "circle", circle_owner_id: ALICE_ID, category: "food", content: "The group always wants vegetarian options", source: "taught", confidence: 1 },
    ];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    const veg = result.candidates.find((c: any) => c.id === "ev-veg");
    assert.ok(veg, "vegetarian event surfaces");
    assert.ok(
      String(veg.whyThis ?? "").toLowerCase().includes("matches your circle's remembered preferences"),
      `circle memory must ground a circle_memory_preference factor with the group label (got whyThis=${veg.whyThis})`,
    );
    assert.ok(
      !String(veg.whyThis ?? "").toLowerCase().includes("told compass"),
      `a circle-memory hit must not reuse the personal-memory label (got whyThis=${veg.whyThis})`,
    );
  });

  it("ISOLATION: another circle's memories never influence this circle's group ranking", async () => {
    const db = groupFixture();
    const soon = new Date(Date.now() + 86400_000).toISOString();
    db.events.push({ id: "ev-veg", title: "Garden Feast", city: "Cebu", starts_at: soon, category: "vegetarian", host_id: CARA_ID, state: "published", visibility: "public", max_attendees: 30, going_count: 0, age_min: null, verified_only: false });
    db.circles.push({ id: "circ-2", name: "Others Only", owner_id: CARA_ID });
    // The vegetarian memory belongs to CARA's circle — NOT Dive Crew.
    db.compass_memories = [
      { id: "m-2", user_id: CARA_ID, scope: "circle", circle_owner_id: CARA_ID, category: "food", content: "The group always wants vegetarian options", source: "taught", confidence: 1 },
    ];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    const veg = result.candidates.find((c: any) => c.id === "ev-veg");
    assert.ok(veg, "vegetarian event still surfaces (no gating, just no boost)");
    assert.ok(
      !String(veg.whyThis ?? "").toLowerCase().includes("told compass") &&
        !String(veg.whyThis ?? "").toLowerCase().includes("circle's remembered preferences"),
      "cross-circle memory must not create any memory factor",
    );
  });

  it("FAIL-CLOSED: loadCircleMemoryPreferenceTags returns nothing for a non-member", async () => {
    const db = groupFixture();
    db.compass_memories = [
      { id: "m-3", user_id: CARA_ID, scope: "circle", circle_owner_id: CARA_ID, category: "food", content: "vegetarian options always", source: "taught", confidence: 1 },
    ];
    const client = makeClient(db);
    const asStranger = await loadCircleMemoryPreferenceTags(client, ALICE_ID, CARA_ID); // Alice not in Cara's circle
    assert.equal(asStranger.size, 0, "non-member must get an empty tag set");
    const asOwner = await loadCircleMemoryPreferenceTags(client, CARA_ID, CARA_ID);
    assert.ok(asOwner.has("vegetarian"), "owner sees the circle's tags");
  });

  it("is honest when no candidates satisfy the whole group", async () => {
    const db = groupFixture();
    db.events = db.events.filter((e: any) => e.id === "ev-agegate"); // only the 35+ event remains
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    assert.deepEqual(result.candidates, []);
    assert.ok(String(result.info).toLowerCase().includes("no candidates"), "honest empty answer");
  });
});

// ── F. Mid-conversation block freshness ──────────────────────────────────────
// The CompassProfile passed into the tool loop is a snapshot taken at ask time
// (cached ~2 min). If the user blocks someone mid-conversation, the NEXT tool
// call in the SAME conversation must not surface that person — social tools
// must re-resolve hidden users from the blocks/user_mutes tables per call,
// never trust the stale snapshot arrays.

describe("F. mid-conversation block freshness", () => {
  it("get_whos_around: a block written AFTER the profile snapshot hides the person immediately", async () => {
    const db = tripFixture([EVE_ID]);
    db.circle_visibility_settings = [sharingOn(BOB_ID), sharingOn(EVE_ID)];
    db.circle_presence = [presenceRow(BOB_ID), presenceRow(EVE_ID)];
    // Stale snapshot: Alice's profile arrays are EMPTY (block happened after ask).
    const staleProfile = profileFor();
    // The block only exists in the DB — as it would mid-conversation.
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: EVE_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, staleProfile, "get_whos_around", {});
    const handles = result.people.map((p: any) => p.handle);
    assert.deepEqual(handles, ["@bob"], "just-blocked user must vanish despite the stale snapshot");
    assert.ok(!JSON.stringify(result).includes("@eve") && !JSON.stringify(result).includes(EVE_ID), "no trace of the just-blocked user");
  });

  it("get_whos_around: a mid-conversation MUTE also hides the person immediately", async () => {
    const db = tripFixture([EVE_ID]);
    db.circle_visibility_settings = [sharingOn(BOB_ID), sharingOn(EVE_ID)];
    db.circle_presence = [presenceRow(BOB_ID), presenceRow(EVE_ID)];
    db.user_mutes = [{ muter_id: ALICE_ID, muted_id: EVE_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_whos_around", {});
    assert.deepEqual(result.people.map((p: any) => p.handle), ["@bob"], "just-muted user must vanish");
  });

  it("get_whos_around: a mid-conversation UNBLOCK/UNMUTE surfaces the person again despite the stale snapshot", async () => {
    const db = tripFixture([EVE_ID]);
    db.circle_visibility_settings = [sharingOn(BOB_ID), sharingOn(EVE_ID)];
    db.circle_presence = [presenceRow(BOB_ID), presenceRow(EVE_ID)];
    // Stale snapshot still says Eve is blocked AND muted — but the DB rows are gone.
    const staleProfile = profileFor({ blockedUserIds: [EVE_ID], mutedUserIds: [EVE_ID] });
    db.blocks = [];
    db.user_mutes = [];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, staleProfile, "get_whos_around", {});
    const handles = result.people.map((p: any) => p.handle).sort();
    assert.deepEqual(handles, ["@bob", "@eve"], "just-unblocked/unmuted user must reappear immediately — fresh DB read replaces the stale snapshot");
  });

  it("get_group_recommendation: a just-blocked fellow MEMBER drops out of the group despite the stale snapshot", async () => {
    const db = groupFixture();
    // Alice blocks Bob mid-conversation — DB row only, snapshot arrays empty.
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    assert.equal(result.group.size, 1, "just-blocked member must not count toward the group");
    assert.ok(!result.group.memberHandles.includes("@bob"), "just-blocked member's handle must not appear");
    assert.ok(!JSON.stringify(result).includes(BOB_ID), "no trace of the just-blocked member");
  });

  it("get_group_recommendation: a just-blocked event HOST's events vanish despite the stale snapshot", async () => {
    const db = groupFixture();
    // Eve hosts ev-blocked; Alice blocks Eve mid-conversation (DB row only).
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: EVE_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_group_recommendation", { circleName: "Dive Crew", kind: "events", city: "Cebu" });
    const ids = result.candidates.map((c: any) => c.id);
    assert.ok(!ids.includes("ev-blocked"), "event hosted by the just-blocked user must not surface");
    assert.ok(!JSON.stringify(result).includes("Rooftop Party"), "no trace of the just-blocked host's event");
  });

  it("get_travel_compatibility: a just-blocked co-member becomes 'not available' despite the stale snapshot", async () => {
    const db = tripFixture();
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: BOB_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" });
    assert.equal(result.compatibility, null, "just-blocked user must not be comparable");
  });

  it("search_events: a just-blocked event HOST's events vanish despite the stale snapshot", async () => {
    const db = groupFixture();
    // Eve hosts ev-blocked; Alice blocks Eve mid-conversation (DB row only —
    // the snapshot arrays are empty, exactly as they'd be mid-conversation).
    db.blocks = [{ blocker_id: ALICE_ID, blocked_id: EVE_ID }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "search_events", { city: "Cebu" });
    const ids = (result.candidates ?? []).map((c: any) => c.id);
    assert.ok(!ids.includes("ev-blocked"), "event hosted by the just-blocked user must not surface in plain search");
    assert.ok(!JSON.stringify(result).includes("Rooftop Party"), "no trace of the just-blocked host's event");
  });

  it("fails safe: if the blocks refresh errors, the snapshot's hidden set still applies", async () => {
    const db = tripFixture([EVE_ID]);
    db.circle_visibility_settings = [sharingOn(BOB_ID), sharingOn(EVE_ID)];
    db.circle_presence = [presenceRow(BOB_ID), presenceRow(EVE_ID)];
    // Snapshot says Eve is muted; the refresh query itself blows up.
    // (user_mutes is only touched by the refresh — the presence guard's own
    // blocks check keeps working, so Bob stays visible.)
    const snapshot = profileFor({ mutedUserIds: [EVE_ID] });
    const inner = makeClient(db);
    const erroring = {
      from: (table: string) =>
        table === "user_mutes"
          ? { select: () => { throw new Error("db down"); } }
          : inner.from(table),
    } as any;
    const result: any = await executeCompassTool(erroring, ALICE_ID, snapshot, "get_whos_around", {});
    const handles = result.people.map((p: any) => p.handle);
    assert.deepEqual(handles, ["@bob"], "on refresh failure the stale hidden set must still hide Eve — never widen visibility");
  });
});
