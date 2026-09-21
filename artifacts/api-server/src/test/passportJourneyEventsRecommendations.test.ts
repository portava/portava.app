/**
 * Passport §14 — the two Featured Journey elements the spec names and the
 * projection did not carry: EVENTS and RECOMMENDATIONS (census-passport P75).
 *
 * §14: "Featured Journey can include route, timeline, places, memories, stamps,
 * people, events and recommendations." Six of those eight were projected;
 * `PassportJourneyService` had no event join and no recommendation producer at
 * all (`grep -ci event` and `grep -ci recommend` over the file both returned 0).
 *
 * What is asserted here, and why each case exists:
 *
 *   A. THE JOIN EXISTS AND IS CANONICAL. Events reach a journey two ways, both
 *      from canonical event storage: `events.trip_id` (an event rooted to the
 *      Trip) and an accepted `event_rsvps` row for an event that happened INSIDE
 *      the trip's own date window. Neither invents storage (§34).
 *   B. IT NEVER WIDENS. A non-owner sees only what event visibility already
 *      permits them — `public` always, `friends_only` only with the same
 *      relationship `tripVisibleToViewer` already requires for a buddies trip,
 *      `invite_only` never. Dead states (draft/cancelled/archived) are not part
 *      of anyone's journey.
 *   C. RECOMMENDATIONS GO THROUGH THE DATABASE'S OWN PREDICATE. The producer
 *      calls `mayDiscloseGemIdentity` — the shipped choke point that restates
 *      migration 0043's `hidden_gems_public_read` policy — rather than a second
 *      copy of the rule. A pending or non-public gem is the owner's to see and
 *      nobody else's.
 *   D. ATTRIBUTION IS BOUNDED. A gem submitted in a city the traveller never
 *      went to on this trip, or years outside the trip window, is not a
 *      recommendation FROM this journey.
 *
 * Run: node --import tsx/esm --test src/test/passportJourneyEventsRecommendations.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildJourneys,
  buildFeaturedJourney,
} from "../services/passport/PassportJourneyService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";
const VIEWER = "viewer-9";
const T_VN = "trip-vn";
const T_TH = "trip-th";

const SELF = { isSelf: true, canSeeTrips: true, canSeeRestricted: true, viewerId: OWNER };
const FRIEND = { isSelf: false, canSeeTrips: true, canSeeRestricted: true, viewerId: VIEWER };
const PUBLIC = { isSelf: false, canSeeTrips: true, canSeeRestricted: false, viewerId: VIEWER };

/**
 * One rich Vietnam trip (the Featured pick) and one thin Thailand trip.
 * Every event/gem below is deliberately on a different axis of the rules.
 */
function db() {
  return makePassportDb({
    trip_members: [
      { trip_id: T_VN, user_id: OWNER, role: "owner" },
      { trip_id: T_TH, user_id: OWNER, role: "owner" },
    ],
    trips: [
      { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
      { id: T_TH, owner_id: OWNER, title: "Bangkok Weekend", destination_city: "Bangkok", destination_country: "Thailand", start_date: "2024-11-10", end_date: "2024-11-12", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
    ],
    passport_memories: [
      { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
      { id: "m2", user_id: OWNER, status: "active", title: "Old town", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-06" },
    ],
    user_stamps: [
      { user_id: OWNER, source_type: "trips", source_id: T_VN, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { name: "Vietnam" } },
    ],
    events: [
      // Rooted to the trip by FK — the strongest link there is.
      { id: "e-rooted", trip_id: T_VN, host_id: OWNER, title: "Crew dinner", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-10T12:00:00Z", ends_at: "2025-03-10T15:00:00Z", state: "completed", visibility: "public" },
      // Not rooted; reached only through the owner's RSVP + the trip window.
      { id: "e-rsvp", trip_id: null, host_id: "someone", title: "Lantern festival", city: "Hoi An", country: "Vietnam", starts_at: "2025-03-12T10:00:00Z", ends_at: "2025-03-12T20:00:00Z", state: "completed", visibility: "public" },
      // RSVP'd, but happened long after the trip ended — not this journey's.
      { id: "e-outside", trip_id: null, host_id: "someone", title: "Autumn meetup", city: "Hanoi", country: "Vietnam", starts_at: "2025-09-01T10:00:00Z", ends_at: "2025-09-01T20:00:00Z", state: "completed", visibility: "public" },
      // Visibility ladder, all inside the window.
      { id: "e-friends", trip_id: T_VN, host_id: OWNER, title: "Friends-only hike", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-14T01:00:00Z", ends_at: "2025-03-14T09:00:00Z", state: "completed", visibility: "friends_only" },
      { id: "e-invite", trip_id: T_VN, host_id: OWNER, title: "Invite-only supper", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-16T01:00:00Z", ends_at: "2025-03-16T09:00:00Z", state: "completed", visibility: "invite_only" },
      // A real, live, in-window, public event the owner DECLINED. Everything
      // about it passes except the RSVP status, so only the status filter can
      // keep it off the journey.
      { id: "e-declined", trip_id: null, host_id: "someone", title: "Karaoke night", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-20T10:00:00Z", ends_at: "2025-03-20T20:00:00Z", state: "completed", visibility: "public" },
      // Dead states — never part of a journey for anyone, owner included.
      { id: "e-cancelled", trip_id: T_VN, host_id: OWNER, title: "Cancelled boat trip", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-18T01:00:00Z", ends_at: "2025-03-18T09:00:00Z", state: "cancelled", visibility: "public" },
      { id: "e-draft", trip_id: T_VN, host_id: OWNER, title: "Draft idea", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-19T01:00:00Z", ends_at: "2025-03-19T09:00:00Z", state: "draft", visibility: "public" },
    ],
    event_rsvps: [
      { event_id: "e-rsvp", user_id: OWNER, status: "going" },
      { event_id: "e-outside", user_id: OWNER, status: "going" },
      // A "not going" RSVP is not attendance.
      { event_id: "e-declined", user_id: OWNER, status: "not_going" },
    ],
    hidden_gems: [
      // Active + public, in the trip's city, inside the window.
      { id: "g-public", submitted_by: OWNER, name: "Rooftop noodle stall", category: "food", city: "Da Nang", country: "Vietnam", neighborhood: "An Hai", status: "active", sensitivity_level: "public", merged_into: null, created_at: "2025-03-08T00:00:00Z" },
      // Same city + window, but still pending moderation — owner-only.
      { id: "g-pending", submitted_by: OWNER, name: "Unreviewed alley bar", category: "nightlife", city: "Da Nang", country: "Vietnam", neighborhood: null, status: "pending", sensitivity_level: "public", merged_into: null, created_at: "2025-03-09T00:00:00Z" },
      // Active but PROTECTED — the database's own policy says public readers never see it.
      { id: "g-protected", submitted_by: OWNER, name: "Fragile lagoon", category: "nature", city: "Da Nang", country: "Vietnam", neighborhood: null, status: "active", sensitivity_level: "protected", merged_into: null, created_at: "2025-03-11T00:00:00Z" },
      // Right city, wrong decade — outside the trip window.
      { id: "g-oldwindow", submitted_by: OWNER, name: "Ancient find", category: "food", city: "Da Nang", country: "Vietnam", neighborhood: null, status: "active", sensitivity_level: "public", merged_into: null, created_at: "2019-01-01T00:00:00Z" },
      // Right window, wrong city — belongs to no journey here.
      { id: "g-othercity", submitted_by: OWNER, name: "Kyoto teahouse", category: "food", city: "Kyoto", country: "Japan", neighborhood: null, status: "active", sensitivity_level: "public", merged_into: null, created_at: "2025-03-12T00:00:00Z" },
      // Merged away — no longer a gem anyone may be handed.
      { id: "g-merged", submitted_by: OWNER, name: "Duplicate stall", category: "food", city: "Da Nang", country: "Vietnam", neighborhood: null, status: "active", sensitivity_level: "public", merged_into: "g-public", created_at: "2025-03-13T00:00:00Z" },
    ],
  });
}

function vnJourney(r: Awaited<ReturnType<typeof buildJourneys>>) {
  return r.years
    .flatMap((y) => y.countries)
    .flatMap((c) => c.cities)
    .flatMap((c) => c.journeys)
    .find((j) => j.tripId === T_VN)!;
}

describe("§14 P75 — events reach the journey", () => {
  it("A1: the owner's journey carries BOTH the FK-rooted event and the RSVP'd in-window one", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    assert.ok(f, "featured journey present");
    assert.equal(f!.tripId, T_VN);
    const ids = f!.events.map((e) => e.id).sort();
    assert.ok(ids.includes("e-rooted"), "events.trip_id join missing");
    assert.ok(ids.includes("e-rsvp"), "event_rsvps + trip-window join missing");
  });

  it("A2: an event rooted to the trip is labelled by the owner's real role", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    const rooted = f!.events.find((e) => e.id === "e-rooted")!;
    assert.equal(rooted.role, "host", "owner hosted this one");
    const rsvp = f!.events.find((e) => e.id === "e-rsvp")!;
    assert.equal(rsvp.role, "attendee");
    assert.equal(rsvp.city, "Hoi An");
    assert.equal(rsvp.startsAt, "2025-03-12T10:00:00Z");
  });

  it("A3: an RSVP'd event OUTSIDE the trip's date window is not part of that journey", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    assert.ok(!f!.events.some((e) => e.id === "e-outside"), "a September event is not on a March trip");
  });

  it("A4: a 'not_going' RSVP is not attendance", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    assert.ok(!f!.events.some((e) => e.id === "e-declined"));
  });

  it("B1: draft and cancelled events are on nobody's journey, the owner's included", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    const ids = f!.events.map((e) => e.id);
    assert.ok(!ids.includes("e-cancelled"), "a cancelled event did not happen");
    assert.ok(!ids.includes("e-draft"), "a draft event did not happen");
  });

  it("B2: a public viewer gets public events only", async () => {
    const r = await buildJourneys(db(), OWNER, PUBLIC);
    const ids = vnJourney(r).events.map((e) => e.id);
    assert.ok(ids.includes("e-rooted"));
    assert.ok(!ids.includes("e-friends"), "friends_only leaked to a public viewer");
    assert.ok(!ids.includes("e-invite"), "invite_only leaked to a public viewer");
  });

  it("B3: a related viewer gets friends_only too — and invite_only still never", async () => {
    const r = await buildJourneys(db(), OWNER, FRIEND);
    const ids = vnJourney(r).events.map((e) => e.id);
    assert.ok(ids.includes("e-friends"), "a buddies-level viewer may see a friends_only event");
    assert.ok(!ids.includes("e-invite"), "invite_only is the owner's alone");
  });

  it("B4: the owner sees their own invite_only event", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    assert.ok(f!.events.some((e) => e.id === "e-invite"));
  });

  it("B5: an unreadable ATTENDANCE read yields NO events, not the half that happened to be readable", async () => {
    // `events` reads fine and has a rooted event; `event_rsvps` does not read at
    // all. A projection that fell through would show the rooted event and
    // silently drop everything the owner merely ATTENDED — a journey that looks
    // complete and is not. The fail-closed arm is what makes that impossible,
    // and this is the case that can tell the two apart.
    const broken = makePassportDb(
      {
        trip_members: [{ trip_id: T_VN, user_id: OWNER, role: "owner" }],
        trips: [
          { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
        ],
        passport_memories: [
          { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
        ],
        user_stamps: [],
        events: [
          { id: "e-rooted", trip_id: T_VN, host_id: OWNER, title: "Crew dinner", city: "Da Nang", country: "Vietnam", starts_at: "2025-03-10T12:00:00Z", ends_at: "2025-03-10T15:00:00Z", state: "completed", visibility: "public" },
        ],
        event_rsvps: [],
      },
      { failReads: { event_rsvps: { message: "boom" } } },
    );
    const f = await buildFeaturedJourney(broken, OWNER, SELF);
    assert.ok(f, "the journey itself still projects");
    assert.deepEqual(f!.events, [], "a readable half is not a journey");
  });
});

describe("§14 P75 — recommendations reach the journey", () => {
  it("C1: the owner's own active public gem in the trip's city is a recommendation", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    const ids = f!.recommendations.map((g) => g.id);
    assert.ok(ids.includes("g-public"), "no recommendation producer");
    const g = f!.recommendations.find((x) => x.id === "g-public")!;
    assert.equal(g.name, "Rooftop noodle stall");
    assert.equal(g.city, "Da Nang");
    assert.equal(g.kind, "hidden_gem");
  });

  it("C2: the OWNER sees their own pending and protected gems", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    const ids = f!.recommendations.map((g) => g.id);
    assert.ok(ids.includes("g-pending"), "owner bypass — their own gem");
    assert.ok(ids.includes("g-protected"));
  });

  it("C3: NOBODY else sees a pending or protected gem — migration 0043's own policy", async () => {
    for (const perms of [FRIEND, PUBLIC]) {
      const r = await buildJourneys(db(), OWNER, perms);
      const ids = vnJourney(r).recommendations.map((g) => g.id);
      assert.ok(ids.includes("g-public"), "the active public gem is still shown");
      assert.ok(!ids.includes("g-pending"), "a pending gem is not a gem yet");
      assert.ok(!ids.includes("g-protected"), "a protected gem never leaves the owner");
    }
  });

  it("C4: a merged-away gem is handed to nobody, the owner included", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    assert.ok(!f!.recommendations.some((g) => g.id === "g-merged"));
  });

  it("D1: attribution is bounded by the trip's city AND its date window", async () => {
    const f = await buildFeaturedJourney(db(), OWNER, SELF);
    const ids = f!.recommendations.map((g) => g.id);
    assert.ok(!ids.includes("g-othercity"), "a Kyoto gem is not a Vietnam journey's recommendation");
    assert.ok(!ids.includes("g-oldwindow"), "a 2019 gem is not a 2025 journey's recommendation");
  });

  it("D2: a trip with neither events nor gems projects empty arrays, never undefined", async () => {
    const r = await buildJourneys(db(), OWNER, SELF);
    const th = r.years
      .flatMap((y) => y.countries)
      .flatMap((c) => c.cities)
      .flatMap((c) => c.journeys)
      .find((j) => j.tripId === T_TH)!;
    assert.deepEqual(th.events, []);
    assert.deepEqual(th.recommendations, []);
  });

  // NOTE ON WHAT D3 DOES AND DOES NOT PROVE. `loadTripRecommendations` makes ONE
  // read, and a PostgREST failure resolves as `{ data: null, error }` — so its
  // explicit `error` arm and its `data ?? []` arm reach the same answer, and
  // deleting the `error` check leaves this test green (mutation M9, recorded as
  // a SURVIVING mutation rather than hidden). The check stays because it is the
  // file's fail-closed convention and because the two arms would diverge the
  // moment a second read joins this one — but this case pins the OUTCOME, not
  // that line.
  it("D3: an unreadable hidden_gems read yields no recommendations and still projects the journey", async () => {
    const broken = makePassportDb(
      {
        trip_members: [{ trip_id: T_VN, user_id: OWNER, role: "owner" }],
        trips: [
          { id: T_VN, owner_id: OWNER, title: "30 Days in Vietnam", destination_city: "Da Nang", destination_country: "Vietnam", start_date: "2025-03-01", end_date: "2025-03-30", status: "completed", visibility: "public", show_on_profile: true, show_exact_dates: true },
        ],
        passport_memories: [
          { id: "m1", user_id: OWNER, status: "active", title: "Beach day", city: "Da Nang", country: "Vietnam", trip_id: T_VN, visibility: "public", earned_at: "2025-03-05" },
        ],
        user_stamps: [],
        hidden_gems: [],
      },
      { failReads: { hidden_gems: { message: "boom" } } },
    );
    const f = await buildFeaturedJourney(broken, OWNER, SELF);
    assert.ok(f);
    assert.deepEqual(f!.recommendations, []);
  });
});

describe("§14 P75 — the grouped list and the featured pick agree", () => {
  it("E1: buildJourneys and buildFeaturedJourney project the same events/recommendations", async () => {
    const grouped = await buildJourneys(db(), OWNER, SELF);
    const featured = await buildFeaturedJourney(db(), OWNER, SELF);
    const vn = vnJourney(grouped);
    assert.deepEqual(
      vn.events.map((e) => e.id).sort(),
      featured!.events.map((e) => e.id).sort(),
      "the featured card and the list must not disagree about what happened",
    );
    assert.deepEqual(
      vn.recommendations.map((g) => g.id).sort(),
      featured!.recommendations.map((g) => g.id).sort(),
    );
  });

  it("E2: neither element widens a trip the viewer may not see at all", async () => {
    const r = await buildJourneys(db(), OWNER, { isSelf: false, canSeeTrips: false, canSeeRestricted: false, viewerId: VIEWER });
    assert.equal(r.totalJourneys, 0);
    assert.equal(r.featured, null);
  });
});
