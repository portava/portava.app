/**
 * Trust restrictions at the Discovery publishing doors and the Trips doors that
 * do what Compass refuses (census-trust TRV2-08; OD-TRUST-5; census-discovery
 * §84 and census-trips §84). The mapping is LANE C'S READING
 * (lib/discoveryTrustGate.ts, lib/tripTrustGate.ts), for the owner to confirm.
 *
 * WHAT WAS WRONG: none of these doors read getRestrictionState. An account
 * restricted from hosting started Trails (published to every user), linked
 * them, and added, rewrote, removed and reordered a group trip's plans; one
 * restricted from hosting or messaging put proposals in front of a whole crew
 * through /commands and /replan; one restricted from messaging submitted gems
 * and community places and pushed content into Trails.
 *
 * WHAT IS ASSERTED, per door, through the real routes over the certification
 * harness:
 *   R. restricted by the mapped type → 403 trust_restriction, the restriction's
 *      OWN sentence (TrustPrivacyGuard), and no write;
 *   U. the restriction state unreadable → 503, retryable, with no "restricted"
 *      wording, and no write;
 *   C. CONTROL: unrestricted → the gate passes (whatever the route says next);
 *   N. not more than told: a restriction of a type the door is not mapped to
 *      does not refuse it; a SOLO trip is not a group trip;
 *   S. a safety path (DECLARE_DISRUPTION) is not gated.
 * And the Trail allowance: three started per rolling day, the fourth 429 with
 * Retry-After, an unreadable count 503; 3975's SQL by its text.
 *
 * Mutation per door: that door's gate call removed — its R and U die
 * (census-discovery §84 lists each).
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/trustRestrictionDoors.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import trailsRouter from "../routes/trails.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import discoveryRouter from "../routes/discovery.js";
import tripsRouter from "../routes/trips.js";
import planRouter from "../routes/plan.js";
import commandRouter from "../server/trips/commandRoute.js";
import tripProjectionsRouter from "../server/trips/readRoutes/tripProjections.js";
import tripReservationsRouter from "../routes/tripReservations.js";
import eventsRouter from "../routes/events.js";
import airportRouter from "../routes/airport.js";
import telegraphChatRouter from "../routes/telegraphChat.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";
import { RESTRICTION_SENTENCES, RESTRICTION_UNVERIFIABLE_MESSAGE } from "../lib/discoveryTrustGate.js";
import { decideTripActionRestriction, readTripShape } from "../lib/tripTrustGate.js";
import { TRAIL_PROPOSALS_PER_DAY } from "../services/trails/TrailService.js";
import { makeFakeClient, startRouter, call, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001";
const ANA = "22222222-0000-4000-8000-000000000002";
const BEN = "33333333-0000-4000-8000-000000000003";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const SOLO = "aaaaaaaa-0000-4000-8000-0000000000b0";
const ITEM = "bbbbbbbb-0000-4000-8000-00000000000b";
const SOLO_ITEM = "bbbbbbbb-0000-4000-8000-0000000000b1";
const TRAIL = "dddddddd-0000-4000-8000-00000000000d";
const TRAIL2 = "dddddddd-0000-4000-8000-00000000000e";
const GEM = "99999999-0000-4000-8000-000000000099";
const PLACE = "ffffffff-0000-4000-8000-00000000000f";
const MEETUP = "eeeeeeee-0000-4000-8000-00000000000e";
const RESV = "cccccccc-0000-4000-8000-0000000000a1";
const EVENT = "e0e0e0e0-0000-4000-8000-0000000000e0";
const SESSION = "5e5e5e5e-0000-4000-8000-00000000005e";
const THREAD = "7e7e7e7e-0000-4000-8000-00000000007e";
const SUGGESTION = "5a5a5a5a-0000-4000-8000-00000000005a";
const SOLO_RESV = "cccccccc-0000-4000-8000-0000000000a2";
const day = new Date().toISOString().slice(0, 10);
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Rows = Array<Record<string, unknown>>;
type Restriction = "hosting" | "messaging" | null;

function seed(restriction: Restriction, actor = ANA): Record<string, Rows> {
  return {
    feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }, { flag: "trip_operational_projections_enabled", enabled: true }, { flag: "reservation_import_enabled", enabled: true },
      { flag: "airport_mode_enabled", enabled: true }, { flag: "layover_plans_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: BEN, state: "published", visibility: "public", title: "Fado night", starts_at: iso(6), ends_at: iso(8) }],
    layover_sessions: [{ id: SESSION, user_id: actor, airport_code: "LIS", status: "active", arrival_at: iso(-1), departure_at: iso(6), created_at: iso(-2) }],
    message_thread_members: [{ thread_id: THREAD, user_id: actor, left_at: null }],
    telegraph_chat_suggestions: [{ id: SUGGESTION, user_id: actor, thread_id: THREAD, title: "Tram 28", location_context: null, time_context: null }],
    profiles: [ORGANIZER, ANA, BEN].map((id) => ({ id, handle: id.slice(0, 4), name: id.slice(0, 4), role: "user" })),
    trust_restrictions: restriction ? [{ user_id: actor, restriction_type: restriction, lifted_at: null, expires_at: null }] : [],
    trips: [
      { id: TRIP, owner_id: ORGANIZER, version: 3, status: "active", plan_edit_permission: "all_members", start_date: day, end_date: day, title: "Group" },
      { id: SOLO, owner_id: ANA, version: 1, status: "active", plan_edit_permission: "all_members", start_date: day, end_date: day, title: "Solo" },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: ORGANIZER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" },
      { trip_id: SOLO, user_id: ANA, role: "owner", status: "accepted" },
    ],
    trip_plan_items: [
      { id: ITEM, trip_id: TRIP, creator_id: ANA, title: "Dinner", category: "food", status: "planned", location_is_private: false, lat: 38.7, lng: -9.1, day_date: day, starts_at: iso(2), ends_at: iso(3), sort_order: 0, removed_at: null },
      { id: SOLO_ITEM, trip_id: SOLO, creator_id: ANA, title: "Walk", category: "activity", status: "planned", location_is_private: false, lat: 38.7, lng: -9.1, day_date: day, starts_at: iso(2), ends_at: iso(3), sort_order: 0, removed_at: null },
    ],
    trails: [
      { id: TRAIL, slug: "lisbon-tiles", title: "Lisbon Tiles", destination: "lisbon", lifecycle_status: "active", created_by: ANA, created_at: iso(-72), parent_trail_id: null },
      { id: TRAIL2, slug: "porto-wine", title: "Porto Wine", destination: "porto", lifecycle_status: "active", created_by: BEN, created_at: iso(-72), parent_trail_id: null },
    ],
    hidden_gems: [{ id: GEM, status: "active", title: "Gem", submitted_by: BEN, created_at: iso(-72) }],
    places: [{ id: PLACE, name: "Cafe", category: "dining", latitude: 38.7, longitude: -9.1 }],
    meetups: [{ id: MEETUP, title: "Meetup", starts_at: iso(4), trip_id: null }],
    trip_reservations: [
      { id: RESV, trip_id: TRIP, user_id: ANA, status: "pending", reservation_type: "lodging", title: "Hotel", starts_at: iso(5), ends_at: iso(30) },
      { id: SOLO_RESV, trip_id: SOLO, user_id: ANA, status: "pending", reservation_type: "lodging", title: "Hotel", starts_at: iso(5), ends_at: iso(30) },
    ],
  };
}

const UNREADABLE: FakeDbOptions = { errors: { trust_restrictions: { message: "restrictions unavailable", code: "57P01", ops: ["select"] } } };

interface Door {
  name: string;
  mapped: Array<"hosting" | "messaging">;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  as?: string;
  /** A trip door: the same request on the actor's SOLO trip is not gated. */
  solo?: { path: string; body?: unknown };
}

const DOORS: Door[] = [
  // Discovery publishing doors (lib/discoveryTrustGate.ts)
  { name: "trail-start", mapped: ["hosting"], method: "POST", path: "/v1/discovery/trails", body: { title: "Lisbon Night Tiles", destination: "lisbon" } },
  { name: "trail-relations", mapped: ["hosting"], method: "POST", path: `/v1/discovery/trails/${TRAIL}/relations`, body: { toTrailId: TRAIL2, edgeType: "related" } },
  { name: "trail-content", mapped: ["messaging"], method: "POST", path: `/v1/discovery/trails/${TRAIL}/content`, body: { sourceType: "place", sourceId: PLACE, labels: [] } },
  { name: "trail-suggestions", mapped: ["messaging"], method: "POST", path: `/v1/discovery/trails/${TRAIL2}/suggestions`, body: { sourceType: "place", sourceId: PLACE, labels: [] } },
  { name: "gem-submit", mapped: ["messaging"], method: "POST", path: "/hidden-gems", body: { name: "Tile Alley", city: "Lisbon" } },
  { name: "gem-contribute", mapped: ["messaging"], method: "POST", path: `/hidden-gems/${GEM}/contribute`, body: { type: "tip", text: "go early" } },
  { name: "gem-edit", mapped: ["messaging"], method: "PATCH", path: `/hidden-gems/${GEM}`, body: { safetyNotes: "go before dusk" } },
  { name: "community-submit", mapped: ["messaging"], method: "POST", path: "/discovery/community", body: { city: "Lisbon", name: "Cafe", place_type: "cafe" } },
  // Trips doors (lib/tripTrustGate.ts)
  { name: "plan-add", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/plan/items`, body: { title: "Museum", category: "activity" },
    solo: { path: `/trips/${SOLO}/plan/items`, body: { title: "Museum", category: "activity" } } },
  { name: "plan-patch", mapped: ["hosting"], method: "PATCH", path: `/trips/${TRIP}/plan/items/${ITEM}`, body: { startsAt: iso(5) },
    solo: { path: `/trips/${SOLO}/plan/items/${SOLO_ITEM}`, body: { startsAt: iso(5) } } },
  { name: "plan-remove", mapped: ["hosting"], method: "PATCH", path: `/trips/${TRIP}/plan/items/${ITEM}/remove`,
    solo: { path: `/trips/${SOLO}/plan/items/${SOLO_ITEM}/remove` } },
  { name: "plan-delete", mapped: ["hosting"], method: "DELETE", path: `/trips/${TRIP}/plan/items/${ITEM}`,
    solo: { path: `/trips/${SOLO}/plan/items/${SOLO_ITEM}` } },
  { name: "plan-reorder", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/plan/items/${ITEM}/reorder`, body: { sortOrder: 3 }, as: ORGANIZER,
    solo: { path: `/trips/${SOLO}/plan/items/${SOLO_ITEM}/reorder`, body: { sortOrder: 3 } } },
  { name: "plan-reorder-batch", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/plan/reorder`, body: { orderedItemIds: [ITEM] }, as: ORGANIZER,
    solo: { path: `/trips/${SOLO}/plan/reorder`, body: { orderedItemIds: [SOLO_ITEM] } } },
  { name: "place-add-to-plan", mapped: ["hosting"], method: "POST", path: `/places/${PLACE}/add-to-trip-plan`, body: { tripId: TRIP },
    solo: { path: `/places/${PLACE}/add-to-trip-plan`, body: { tripId: SOLO } } },
  { name: "meetup-add-to-plan", mapped: ["hosting"], method: "POST", path: `/meetups/${MEETUP}/add-to-trip-plan`, body: { tripId: TRIP },
    solo: { path: `/meetups/${MEETUP}/add-to-trip-plan`, body: { tripId: SOLO } } },
  { name: "gem-add-to-plan", mapped: ["hosting"], method: "POST", path: `/hidden-gems/${GEM}/plan`, body: { tripId: TRIP },
    solo: { path: `/hidden-gems/${GEM}/plan`, body: { tripId: SOLO } } },
  { name: "reservation-confirm-add-to-plan", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/reservations/${RESV}/confirm`, body: { addToPlan: true },
    solo: { path: `/trips/${SOLO}/reservations/${SOLO_RESV}/confirm`, body: { addToPlan: true } } },
  { name: "event-add-to-trip", mapped: ["hosting"], method: "POST", path: `/events/${EVENT}/add-to-trip`, body: { tripId: TRIP },
    solo: { path: `/events/${EVENT}/add-to-trip`, body: { tripId: SOLO } } },
  { name: "layover-plan", mapped: ["hosting"], method: "POST", path: `/airport/sessions/${SESSION}/plan`, body: { tripId: TRIP, title: "Coffee near gate" },
    solo: { path: `/airport/sessions/${SESSION}/plan`, body: { tripId: SOLO, title: "Coffee near gate" } } },
  { name: "telegraph-suggestion-add-to-plan", mapped: ["hosting"], method: "POST", path: `/threads/${THREAD}/telegraph/suggestions/${SUGGESTION}/add-to-plan`, body: { tripId: TRIP },
    solo: { path: `/threads/${THREAD}/telegraph/suggestions/${SUGGESTION}/add-to-plan`, body: { tripId: SOLO } } },
  { name: "trip-invite", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/invite`, body: { userId: BEN }, as: ORGANIZER },
  { name: "trip-invite-link", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/invite-link`, body: {}, as: ORGANIZER },
  { name: "command-create-proposal", mapped: ["hosting", "messaging"], method: "POST", path: `/trips/${TRIP}/commands`,
    body: { type: "CREATE_PROPOSAL", idempotency_key: "p-1", payload: { proposal_type: "move", decision_rule: "majority", payload_json: {} } },
    solo: { path: `/trips/${SOLO}/commands`, body: { type: "CREATE_PROPOSAL", idempotency_key: "p-2", payload: { proposal_type: "move", decision_rule: "majority", payload_json: {} } } } },
  { name: "replan-create-proposals", mapped: ["hosting", "messaging"], method: "POST", path: `/trips/${TRIP}/replan`, body: { createProposals: true },
    solo: { path: `/trips/${SOLO}/replan`, body: { createProposals: true } } },
];

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  for (const r of [trailsRouter, hiddenGemsRouter, discoveryRouter, tripsRouter, planRouter, commandRouter, tripProjectionsRouter, tripReservationsRouter, eventsRouter, airportRouter, telegraphChatRouter, tripsExpansionRouter]) all.use(r);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

function use(s: Record<string, Rows>, opts: FakeDbOptions = {}): FakeClient {
  const c = makeFakeClient(s, opts);
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}
const writes = (c: FakeClient) => c._observed.inserts.length + c._observed.updates.length + c._observed.upserts.length + c._observed.deletes.length;
const gateRefused = (r: { status: number; body: any }) =>
  (r.status === 403 && r.body?.error === "trust_restriction") || (r.status === 503 && r.body?.message === RESTRICTION_UNVERIFIABLE_MESSAGE);

for (const d of DOORS) {
  const actor = d.as ?? ANA;
  describe(`door ${d.name} (${d.mapped.join(" or ")})`, () => {
    for (const t of d.mapped) {
      it(`${d.name} R-${t}. THE POINT: restricted from ${t} → 403 in the restriction's own words, nothing written`, async () => {
        const c = use(seed(t, actor));
        const r = await call(harness.base, d.method, d.path, actor, d.body);
        assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
        assert.equal(r.body.error, "trust_restriction");
        assert.equal(r.body.message, RESTRICTION_SENTENCES[t]);
        assert.deepEqual(r.body.restrictionTypes, [t]);
        assert.equal(writes(c), 0);
      });
    }
    it(`${d.name} U. THE POINT: an unreadable restriction state → 503, retryable, never "restricted", nothing written`, async () => {
      const c = use(seed(null, actor), UNREADABLE);
      const r = await call(harness.base, d.method, d.path, actor, d.body);
      assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.message, RESTRICTION_UNVERIFIABLE_MESSAGE);
      assert.doesNotMatch(JSON.stringify(r.body), /restrict/i);
      assert.equal(writes(c), 0);
    });
    it(`${d.name} C. CONTROL: unrestricted → the gate passes`, async () => {
      use(seed(null, actor));
      const r = await call(harness.base, d.method, d.path, actor, d.body);
      assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
    });
    const other = (["hosting", "messaging"] as const).filter((t) => !d.mapped.includes(t));
    for (const t of other) {
      it(`${d.name} N-${t}. not more than told: a ${t} restriction does not refuse it`, async () => {
        use(seed(t, actor));
        const r = await call(harness.base, d.method, d.path, actor, d.body);
        assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
      });
    }
    if (d.solo) {
      it(`${d.name} N-solo. a trip that is the person's alone is not a group trip: not refused`, async () => {
        use(seed(d.mapped[0]!, ANA));
        const r = await call(harness.base, d.method, d.solo!.path, ANA, d.solo!.body);
        assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
      });
    }
  });
}

describe("U2. a restriction table that is not there is not 'no restriction' either (lane L's Compass rule, so the two cannot disagree)", () => {
  for (const name of ["trail-start", "plan-add"]) {
    it(`U2 ${name}: trust_restrictions absent (42P01) → 503, never "restricted"`, async () => {
      const d = DOORS.find((x) => x.name === name)!;
      use(seed(null), { errors: { trust_restrictions: { message: 'relation "public.trust_restrictions" does not exist', code: "42P01", ops: ["select"] } } });
      const r = await call(harness.base, d.method, d.path, d.as ?? ANA, d.body);
      assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.message, RESTRICTION_UNVERIFIABLE_MESSAGE);
    });
  }
});

describe("R5 (census-trips §85). A membership restored to an ENDED trip's retained record only reads it and changes nothing", () => {
  // 3974 stamps trip_members.permissions.access = 'retained_record_only' when an
  // upheld appeal restores someone after the trip ended (owner, 2026-10-04: "if
  // a trip has ended, restore access to its retained record only"). The
  // verifier found nothing read it, so the restored person could change the trip.
  const retained = (access: string): Record<string, Rows> => {
    const s = seed(null);
    s.trip_members = s.trip_members!.map((m) => (m.trip_id === TRIP && m.user_id === ANA ? { ...m, permissions: { access, restored_by_appeal: "appeal-1" } } : m));
    s.trips = s.trips!.map((t) => (t.id === TRIP ? { ...t, status: "completed" } : t));
    return s;
  };
  // The reorder doors are owner-only and refuse Ana before any of this.
  const doors = DOORS.filter((d) => (d.path.startsWith(`/trips/${TRIP}/plan`) && !d.name.includes("reorder")) || d.name === "place-add-to-plan" || d.name === "command-create-proposal");
  for (const d of doors) {
    it(`R5 ${d.name}: retained_record_only → 403 trip_record_read_only, never "restricted", nothing written`, async () => {
      const c = use(retained("retained_record_only"));
      const r = await call(harness.base, d.method, d.path, ANA, d.body);
      assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.error, "trip_record_read_only");
      assert.doesNotMatch(String(r.body.message), /restrict/i);
      assert.equal(writes(c), 0);
    });
  }
  it("R5 /commands, any non-safety command (ADD_GOAL): refused, nothing written", async () => {
    const c = use(retained("retained_record_only"));
    const r = await call(harness.base, "POST", `/trips/${TRIP}/commands`, ANA, { type: "ADD_GOAL", idempotency_key: "r5-add", payload: { title: "Late goal" } });
    assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.error, "trip_record_read_only");
    assert.equal(writes(c), 0);
  });
  it("R5 CONTROL: the same member restored with access 'membership' is not refused by this rule", async () => {
    use(retained("membership"));
    const r = await call(harness.base, "POST", `/trips/${TRIP}/plan/items`, ANA, { title: "Museum", category: "activity" });
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 300));
    const k = await call(harness.base, "POST", `/trips/${TRIP}/commands`, ANA, { type: "ADD_GOAL", idempotency_key: "r5-ctl", payload: { title: "Late goal" } });
    assert.notEqual(k.body?.error, "trip_record_read_only", JSON.stringify(k.body).slice(0, 300));
  });
  it("R5 a safety path (DECLARE_DISRUPTION) is never refused by it", async () => {
    use(retained("retained_record_only"));
    const r = await call(harness.base, "POST", `/trips/${TRIP}/commands`, ANA, { type: "DECLARE_DISRUPTION", idempotency_key: "r5-d", payload: { kind: "lodging", severity: "major" } });
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 300));
  });
  it("R5 the shared helper says so to Compass too (decideTripActionRestriction)", async () => {
    const c = use(retained("retained_record_only"));
    const v = await decideTripActionRestriction(c as never, TRIP, ANA, "change_shared_plan");
    assert.equal(v.allowed, false);
    assert.equal(!v.allowed && v.kind, "read_only");
  });
});

describe("D-24a. ONE solo/group test (readTripShape), the one lane L's Compass gate calls", () => {
  it("solo: nobody but the actor is an accepted member", async () => {
    const c = use(seed(null));
    assert.deepEqual(await readTripShape(c as never, SOLO, ANA), { kind: "solo", actorAccess: "full" });
  });
  it("group: someone else is an accepted member", async () => {
    const c = use(seed(null));
    const s = await readTripShape(c as never, TRIP, ANA);
    assert.equal(s.kind, "group");
  });
  it("an invited (not accepted) person does not make it a group trip", async () => {
    const st = seed(null);
    st.trip_members = [...st.trip_members!, { trip_id: SOLO, user_id: BEN, role: "member", status: "pending" }];
    const c = use(st);
    assert.equal((await readTripShape(c as never, SOLO, ANA)).kind, "solo");
  });
  it("unreadable membership → unreadable, and the decision is 'try again', never 'restricted' (even with a restriction on file)", async () => {
    const c = use(seed("hosting"), { errors: { trip_members: { message: "members down", code: "57P01", ops: ["select"] } } });
    assert.equal((await readTripShape(c as never, SOLO, ANA)).kind, "unreadable");
    const v = await decideTripActionRestriction(c as never, SOLO, ANA, "change_shared_plan");
    assert.equal(!v.allowed && v.kind, "unverifiable");
  });
  it("a trip that is not there is unreadable, not solo", async () => {
    const c = use(seed(null));
    assert.equal((await readTripShape(c as never, "aaaaaaaa-0000-4000-8000-0000000000ff", ANA)).kind, "unreadable");
  });
  it("a solo trip is decided without reading the restriction state (an unreadable state does not refuse it)", async () => {
    const c = use(seed("hosting"), UNREADABLE);
    const v = await decideTripActionRestriction(c as never, SOLO, ANA, "change_shared_plan");
    assert.deepEqual(v, { allowed: true, shape: "solo" });
  });
});

describe("S. safety paths are not gated", () => {
  it("S1. DECLARE_DISRUPTION through /commands is not refused for a hosting- or messaging-restricted member", async () => {
    for (const t of ["hosting", "messaging"] as const) {
      use(seed(t));
      const r = await call(harness.base, "POST", `/trips/${TRIP}/commands`, ANA, { type: "DECLARE_DISRUPTION", idempotency_key: `d-${t}`, payload: { kind: "lodging", severity: "major" } });
      assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
    }
  });
  it("S2. the words are TrustPrivacyGuard's, so nobody is refused more than they are told", () => {
    const src = readFileSync(new URL("../services/trust/TrustPrivacyGuard.ts", import.meta.url), "utf8");
    assert.ok(src.includes(`hosting:             "${RESTRICTION_SENTENCES.hosting}"`));
    assert.ok(src.includes(`messaging:           "${RESTRICTION_SENTENCES.messaging}"`));
  });
});

describe("T. the Trail allowance (census-discovery §84)", () => {
  const propose = (title: string) => call(harness.base, "POST", "/v1/discovery/trails", ANA, { title, destination: `dest-${title}` });
  const withProposals = (c: FakeClient) => {
    (c as any).rpc = async (name: string, args: any) => {
      if (name !== "trail_propose") return { data: null, error: { message: `rpc ${name} not modelled` } };
      const row = { id: `t-${(c._store.trails ?? []).length}`, slug: String(args.p_title).toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: args.p_title,
        description: args.p_description, destination: args.p_destination, place_scope: null, parent_trail_id: null, lifecycle_status: "proposed",
        created_by: args.p_created_by, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      c._store.trails = [...(c._store.trails ?? []), row];
      return { data: { outcome: "created", trail: row }, error: null };
    };
    return c;
  };
  it(`T1. THE POINT: ${TRAIL_PROPOSALS_PER_DAY} Trails a day are started; the next is 429 with Retry-After, and nothing is written`, async () => {
    const c = withProposals(use(seed(null)));
    for (let i = 0; i < TRAIL_PROPOSALS_PER_DAY; i += 1) {
      const r = await propose(`Unique Theme ${"abcdefgh"[i]}${i} Walk`);
      assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    }
    const before = (c._store.trails ?? []).length;
    const res = await fetch(`${harness.base}/v1/discovery/trails`, { method: "POST", headers: { authorization: `Bearer ${ANA}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Yet Another Distinct Zebra Theme", destination: "zz" }) });
    const body = (await res.json()) as { error?: string };
    assert.equal(res.status, 429, JSON.stringify(body));
    assert.equal(body.error, "rate_limited");
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.equal((c._store.trails ?? []).length, before);
  });
  it("T2. a Trail started more than a day ago does not count", async () => {
    const s = seed(null);
    s.trails = [...s.trails!, ...[1, 2, 3].map((n) => ({ id: `old-${n}`, slug: `old-${n}`, title: `Old ${n}`, destination: "x", lifecycle_status: "active", created_by: ANA, created_at: iso(-25 - n), parent_trail_id: null }))];
    withProposals(use(s));
    const r = await propose("Fresh Distinct Harbour Theme");
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  });
  it("T3. an unreadable allowance count is 503, not 'none started'", async () => {
    withProposals(use(seed(null), { errors: { trails: { message: "trails down", code: "57P01", ops: ["select"] } } }));
    const r = await propose("Another Distinct Theme");
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
  });
  it("T4. 3975: the same number, decided in SQL under a per-proposer lock taken BEFORE the token locks; 3415's body otherwise unchanged", () => {
    const m = readFileSync(new URL("../migrations/3975_trail_proposal_daily_allowance.sql", import.meta.url), "utf8");
    const old = readFileSync(new URL("../migrations/3415_trail_proposal_serialised.sql", import.meta.url), "utf8");
    const fnOf = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.trail_propose("), sql.indexOf("$fn$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.trail_propose(")));
    const fn = fnOf(m);
    assert.ok(fn.indexOf("trail_propose:proposer:") > 0 && fn.indexOf("trail_propose:proposer:") < fn.indexOf("trail_propose:token:"));
    assert.match(fn, new RegExp(`created_at > now\\(\\) - interval '24 hours'\\) >= ${TRAIL_PROPOSALS_PER_DAY} THEN`));
    assert.match(fn, /'outcome', 'rate_limited'/);
    const step0 = fn.slice(fn.indexOf("  -- 0. census-discovery §84"), fn.indexOf("  -- 1. Serialise against every proposal"));
    assert.equal(fn.replace(step0, ""), fnOf(old), "everything but step 0 is 3415's, byte for byte");
  });
});
