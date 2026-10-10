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
import { readFileSync, readdirSync } from "node:fs";
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
import { decideTripActionRestriction, readTripShape } from "../lib/tripTrustGate.js"; import { tripRetainedRecordWriteGuard } from "../lib/tripRetainedRecordGuard.js"; import { globalErrorHandler } from "../lib/errorEnvelope.js";
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
const NEWU = "44444444-0000-4000-8000-000000000004"; // someone joining the group trip (R2)
const JOIN_REQ = "4a4a4a4a-0000-4000-8000-00000000004a";
const JOIN_REQ_SOLO = "4a4a4a4a-0000-4000-8000-0000000000b0"; // a request to join ANA's SOLO trip (verifier F1 on dc0107eda5)
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
      { flag: "airport_mode_enabled", enabled: true }, { flag: "layover_plans_enabled", enabled: true }, { flag: "trail_creation_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: BEN, state: "published", visibility: "public", title: "Fado night", starts_at: iso(6), ends_at: iso(8) }],
    layover_sessions: [{ id: SESSION, user_id: actor, airport_code: "LIS", status: "active", arrival_at: iso(-1), departure_at: iso(6), arrival_time: iso(-1), departure_time: iso(6), created_at: iso(-2) }], // *_time: the real NOT NULL columns (0127) — a session without a readable departure is refused since V-R9
    message_thread_members: [{ thread_id: THREAD, user_id: actor, left_at: null }],
    trip_join_requests: [{ id: JOIN_REQ, trip_id: TRIP, user_id: NEWU, status: "pending", created_at: iso(-3) },
      { id: JOIN_REQ_SOLO, trip_id: SOLO, user_id: NEWU, status: "pending", created_at: iso(-3) }],
    trip_invite_links: [{ id: "4b4b4b4b-0000-4000-8000-00000000004b", trip_id: TRIP, token: "link-token-r2", created_by: ORGANIZER, max_uses: null, use_count: 0, expires_at: null, revoked_at: null }],
    telegraph_chat_suggestions: [{ id: SUGGESTION, user_id: actor, thread_id: THREAD, title: "Tram 28", location_context: null, time_context: null }],
    profiles: [ORGANIZER, ANA, BEN, NEWU].map((id) => ({ id, handle: id.slice(0, 4), name: id.slice(0, 4), role: "user" })),
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
      { id: TRAIL, slug: "lisbon-tiles", title: "Lisbon Tiles", destination: "lisbon", review_state: "approved", lifecycle_status: "active", created_by: ANA, created_at: iso(-72), parent_trail_id: null },
      { id: TRAIL2, slug: "porto-wine", title: "Porto Wine", destination: "porto", review_state: "approved", lifecycle_status: "active", created_by: BEN, created_at: iso(-72), parent_trail_id: null },
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
  // verifier R2 (1867c97df): the two other doors that turn a trip into a group trip — gated whether it is solo or not.
  { name: "trip-members-add", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/members`, body: { userId: NEWU }, as: ORGANIZER },
  { name: "join-request-approve", mapped: ["hosting"], method: "POST", path: `/trips/${TRIP}/join-requests/${JOIN_REQ}/approve`, body: {}, as: ORGANIZER },
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

describe("R-solo (verifier F1 on dc0107eda5). Adding a member or approving a join request makes a SOLO trip a group trip, so the hosting gate holds there too", () => {
  // The D-24a solo exemption covers changing a trip that stays the person's alone. These two doors are the act
  // that ends that, so a hosting-restricted owner is refused on their solo trip exactly as on a group trip.
  const SOLO_DOORS = [
    { name: "trip-members-add", path: `/trips/${SOLO}/members`, body: { userId: NEWU } },
    { name: "join-request-approve", path: `/trips/${SOLO}/join-requests/${JOIN_REQ_SOLO}/approve`, body: {} },
  ];
  for (const d of SOLO_DOORS) {
    it(`${d.name} R-solo. THE POINT: restricted from hosting, on the person's SOLO trip → 403 in the restriction's own words, nothing written`, async () => {
      const c = use(seed("hosting", ANA));
      const r = await call(harness.base, "POST", d.path, ANA, d.body);
      assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.error, "trust_restriction");
      assert.equal(r.body.message, RESTRICTION_SENTENCES.hosting);
      assert.equal(writes(c), 0);
    });
    it(`${d.name} R-solo CONTROL: unrestricted, the same request on the solo trip passes the gate`, async () => {
      use(seed(null, ANA));
      const r = await call(harness.base, "POST", d.path, ANA, d.body);
      assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
    });
  }
});

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
  // census-trips §85.2 (verifier R3 on 1867c97df): ONE guard before every trip router refuses every member-level write.
  const WRITES: Array<["POST" | "PUT" | "PATCH" | "DELETE", string, unknown]> = [
    ["POST", `/trips/${TRIP}/notes`, { title: "n", body: "b" }],
    ["POST", `/trips/${TRIP}/documents`, { title: "d", url: "https://x.test/d.pdf" }],
    ["POST", `/trips/${TRIP}/checklists`, { title: "c" }],
    ["POST", `/trips/${TRIP}/reminders`, { title: "r", remindAt: iso(5) }],
    ["POST", `/trips/${TRIP}/saved-places`, { placeId: PLACE }],
    ["POST", `/trips/${TRIP}/reservations`, { title: "Hotel", reservationType: "lodging" }],
    ["POST", `/trips/${TRIP}/operations`, { kind: "x" }],
    ["POST", `/trips/${TRIP}/closeout/answers`, { answers: [] }],
    ["POST", `/trips/${TRIP}/opportunities/${PLACE}/accept`, {}],
    ["POST", `/trips/${TRIP}/meeting-point`, {}],
    ["POST", `/trips/${TRIP}/notifications/acted`, {}],
    ["PATCH", `/trips/${TRIP}/plan/items/${ITEM}`, { startsAt: iso(5) }],
    ["DELETE", `/trips/${TRIP}/notes/${ITEM}`, undefined],
    // verifier F5 on dc0107eda5: a PUT door, and a join request answered by a retained-record-only owner/co-host.
    ["PUT", `/trips/${TRIP}/transport-policy`, { policy: {} }],
    // verifier F6 on 1a0f6b7219: the other five PUT doors under /trips/:tripId (there are six, not one).
    ["PUT", `/trips/${TRIP}/crew/location-preferences`, {}],
    ["PUT", `/trips/${TRIP}/travelers/me/passport`, {}],
    ["PUT", `/trips/${TRIP}/area-preferences`, {}],
    ["PUT", `/trips/${TRIP}/budget`, {}],
    ["PUT", `/trips/${TRIP}/autopilot/settings`, {}],
    ["POST", `/trips/${TRIP}/join-requests/${JOIN_REQ}/approve`, {}],
    ["POST", `/trips/${TRIP}/join-requests/${JOIN_REQ}/reject`, {}],
  ];
  for (const [m, p, b] of WRITES) {
    it(`R5 guard ${m} ${p.replace(TRIP, ":tripId")}: 403 trip_record_read_only, nothing written`, async () => {
      const c = use(retained("retained_record_only"));
      const r = await call(harness.base, m, p, ANA, b);
      assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.error, "trip_record_read_only");
      assert.doesNotMatch(String(r.body.message), /restrict/i);
      assert.equal(writes(c), 0);
    });
  }
  it("R5 guard (verifier F6 on 1a0f6b7219): EVERY PUT door under /trips/:tripId is in the list above, and routes/index.ts mounts the guarded trips router before the router that owns it", () => {
    const routesDir = new URL("../routes/", import.meta.url);
    const index = readFileSync(new URL("index.ts", routesDir), "utf8").split("\n");
    const mountLine = (name: string) => index.findIndex((l) => l.trim() === `router.use(${name});`);
    const guarded = mountLine("tripsRouter");
    assert.ok(guarded >= 0, "routes/index.ts no longer mounts tripsRouter on its own line; re-derive this check");
    const listed = new Set(WRITES.filter(([m]) => m === "PUT").map(([, p]) => p.replace(TRIP, ":tripId")));
    const found: string[] = [];
    for (const f of readdirSync(routesDir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, routesDir), "utf8");
      for (const m of src.matchAll(/router\.put\(\s*"(\/trips\/:tripId[^"]*)"/g)) {
        found.push(m[1]!);
        assert.ok(listed.has(m[1]!), `${f}: PUT ${m[1]} is not pinned by the R5 guard list`);
        const imp = new RegExp(`^import (\\w+) from "\\./${f.replace(/\.ts$/, "")}(\\.js)?";`, "m").exec(index.join("\n"));
        assert.ok(imp, `routes/index.ts does not import ${f}`);
        const at = mountLine(imp![1]!);
        assert.ok(at > guarded, `${f} (${imp![1]}) must be mounted after tripsRouter (line ${guarded + 1}), is at ${at + 1}`);
      }
    }
    assert.equal(found.length, 6, `vacuity guard: six PUT doors under /trips/:tripId, found ${found.length}: ${found.join(", ")}`);
  });
  it("R5 guard CONTROL: a full member's note is not refused by it", async () => {
    use(retained("membership"));
    const r = await call(harness.base, "POST", `/trips/${TRIP}/notes`, ANA, { title: "n", body: "b" });
    assert.notEqual(r.body?.error, "trip_record_read_only", JSON.stringify(r.body).slice(0, 300));
  });
  it("R5 guard: rescue, stopping a live share, and leaving the trip are never refused by it", async () => {
    use(retained("retained_record_only"));
    for (const [m, p] of [["POST", `/trips/${TRIP}/rescue`], ["POST", `/trips/${TRIP}/crew/live-share/stop`], ["DELETE", `/trips/${TRIP}/members/${ANA}`]] as const) {
      const r = await call(harness.base, m, p, ANA, {});
      assert.notEqual(r.body?.error, "trip_record_read_only", `${m} ${p}: ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  });
  it("R5 guard: the access row unreadable → 503, retryable, nothing written", async () => {
    const c = use(retained("retained_record_only"), { errors: { trip_members: { message: "members down", code: "57P01", ops: ["select"] } } });
    const r = await call(harness.base, "POST", `/trips/${TRIP}/notes`, ANA, { title: "n", body: "b" });
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
    assert.equal(writes(c), 0);
  });
  it("R5 guard: a read that THROWS (not a resolved error) → 503 'try again', nothing written, never a 500 or a pass", async () => {
    const c = use(retained("retained_record_only"));
    _setTestServiceClient({ ...c, from: (t: string) => { if (t === "trip_members") throw new Error("socket hang up"); return c.from(t); } } as never);
    const r = await call(harness.base, "POST", `/trips/${TRIP}/notes`, ANA, { title: "n", body: "b" });
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(writes(c), 0);
  });
  it("R5 guard (verifier F6 on dc0107eda5): an Auth service THROW while resolving the caller → 503, never a pass-through the handler's own second call could turn into a write", async () => {
    const c = use(retained("retained_record_only"));
    // The guard's call throws; any later call (the handler's requireUser) succeeds — the differential failure.
    let calls = 0;
    const flaky = { ...c, auth: { getUser: async (token: string) => { calls += 1; if (calls === 1) throw new Error("auth transport down"); return c.auth.getUser(token); } } };
    _setTestServiceClient(flaky as never);
    _setTestClient(flaky as never, true);
    const r = await call(harness.base, "POST", `/trips/${TRIP}/notes`, ANA, { title: "n", body: "b" });
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.ok(calls >= 1, "vacuity guard: the guard asked the auth service");
    assert.equal(writes(c), 0);
  });
  it("R5 guard: the caller is resolved through the account gate — a banned account's write is the gate's 403, never served, nothing written", async () => {
    const s = retained("membership");
    s.profiles = s.profiles!.map((p) => (p.id === ANA ? { ...p, account_status: "active", user_account_states: [{ state: "banned", expires_at: null }] } : p));
    const c = use(s);
    const r = await call(harness.base, "POST", `/trips/${TRIP}/notes`, ANA, { title: "n", body: "b" });
    assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
    assert.notEqual(r.body?.error, "trip_record_read_only");
    assert.equal(writes(c), 0);
  });
  it("R5 guard, alone: a banned account's write is refused BY THE GUARD (the gate's 403 through the global handler), so a handler behind it never runs", async () => {
    const s = retained("membership");
    s.profiles = s.profiles!.map((p) => (p.id === ANA ? { ...p, account_status: "active", user_account_states: [{ state: "banned", expires_at: null }] } : p));
    use(s);
    let ran = 0;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
    app.use(tripRetainedRecordWriteGuard());
    app.post("/trips/:tripId/notes", (_req, res) => { ran += 1; res.status(201).json({ ok: true }); }); // no auth of its own: only the guard stands in front of it
    app.use(globalErrorHandler);
    const server = await new Promise<import("node:http").Server>((ok) => { const sv = app.listen(0, "127.0.0.1", () => ok(sv)); });
    try {
      const port = (server.address() as { port: number }).port;
      const r = await fetch(`http://127.0.0.1:${port}/trips/${TRIP}/notes`, { method: "POST", headers: { authorization: `Bearer ${ANA}`, "content-type": "application/json" }, body: "{}" });
      assert.equal(r.status, 403, await r.text());
      assert.equal(ran, 0, "the handler behind the guard ran for a banned account");
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
  it("R5 guard: routes/index.ts mounts the trips router (which carries the guard) before every other trip router", () => {
    const idx = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
    const uses = [...idx.matchAll(/router\.use\((\w+)\)/g)].map((x) => x[1]);
    assert.deepEqual(uses.slice(0, 3), ["healthRouter", "authRouter", "tripsRouter"]);
    assert.match(readFileSync(new URL("../routes/trips.ts", import.meta.url), "utf8"), /const router = Router\(\); router\.use\(tripRetainedRecordWriteGuard\(\)\);/);
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
  it("an owner with NO trip_members row still counts: an accepted member of that trip is on a GROUP trip (L's verifier)", async () => {
    // requireTripMember's owner fallback. Without it, the member alone would read
    // as "solo" and a hosting-restricted member would pass every door.
    const st = seed("hosting");
    st.trip_members = st.trip_members!.filter((m) => !(m.trip_id === TRIP && m.user_id !== ANA));
    const c = use(st);
    const shape = await readTripShape(c as never, TRIP, ANA);
    assert.deepEqual(shape, { kind: "group", otherAcceptedMembers: 1, actorAccess: "full" });
    const v = await decideTripActionRestriction(c as never, TRIP, ANA, "change_shared_plan");
    assert.equal(!v.allowed && v.kind, "restricted");
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

describe("R2 lead ruling: while the INVITER is hosting-restricted, their outstanding invites and links cannot be redeemed", () => {
  // The redeemer sees "This invite isn't available right now" — no reason, nothing about the inviter's restriction.
  const invited = (restriction: Restriction): Record<string, Rows> => {
    const s = seed(restriction, ORGANIZER);
    s.trip_members = [...s.trip_members!, { trip_id: TRIP, user_id: NEWU, role: "invited", status: "invited" }];
    return s;
  };
  const doors: Array<[string, string]> = [["accept-invite", `/trips/${TRIP}/accept-invite`], ["invite-link", "/trips/invite-link/link-token-r2/accept"]];
  for (const [name, path] of doors) {
    it(`R2-${name}. THE POINT: the inviter restricted from hosting → 403 invite_unavailable, no reason, nothing written`, async () => {
      const c = use(invited("hosting"));
      const r = await call(harness.base, "POST", path, NEWU, {});
      assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
      assert.deepEqual(r.body, { error: "invite_unavailable", message: "This invite isn't available right now." });
      assert.equal(writes(c), 0);
    });
    it(`R2-${name}. the inviter's restriction state unreadable → 503 in the same neutral words, nothing written`, async () => {
      const c = use(invited(null), UNREADABLE);
      const r = await call(harness.base, "POST", path, NEWU, {});
      assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
      assert.doesNotMatch(JSON.stringify(r.body), /restrict|host/i);
      assert.equal(writes(c), 0);
    });
    it(`R2-${name}. CONTROL: an unrestricted inviter's invite is not refused by this rule; a messaging restriction does not refuse it either`, async () => {
      for (const t of [null, "messaging"] as const) {
        use(invited(t));
        const r = await call(harness.base, "POST", path, NEWU, {});
        assert.notEqual(r.body?.error, "invite_unavailable", `${t}: ${JSON.stringify(r.body).slice(0, 200)}`);
      }
    });
  }
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
  it("S3. the gate keeps NO copy of them: lib/discoveryTrustGate.ts reads restrictionSentence() (lane L's patch, lead ruling D-24)", async () => {
    const { restrictionSentence } = await import("../services/trust/TrustPrivacyGuard.js");
    assert.equal(RESTRICTION_SENTENCES.hosting, restrictionSentence("hosting"));
    assert.equal(RESTRICTION_SENTENCES.messaging, restrictionSentence("messaging"));
    const gate = readFileSync(new URL("../lib/discoveryTrustGate.ts", import.meta.url), "utf8");
    assert.match(gate, /hosting: restrictionSentence\("hosting"\),\s*messaging: restrictionSentence\("messaging"\),/);
    assert.doesNotMatch(gate.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ""), /"You cannot/, "a sentence literal in the gate's code is a copy that can drift");
  });
});

describe("T. the Trail allowance (census-discovery §84)", () => {
  const propose = (title: string) => call(harness.base, "POST", "/v1/discovery/trails", ANA, { title, destination: `dest-${title}` });
  const withProposals = (c: FakeClient) => {
    (c as any).rpc = async (name: string, args: any) => {
      if (name !== "trail_propose") return { data: null, error: { message: `rpc ${name} not modelled` } };
      const row = { id: `t-${(c._store.trails ?? []).length}`, slug: String(args.p_title).toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: args.p_title,
        description: args.p_description, destination: args.p_destination, place_scope: null, parent_trail_id: null, review_state: "approved", lifecycle_status: "proposed",
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
    s.trails = [...s.trails!, ...[1, 2, 3].map((n) => ({ id: `old-${n}`, slug: `old-${n}`, title: `Old ${n}`, destination: "x", review_state: "approved", lifecycle_status: "active", created_by: ANA, created_at: iso(-25 - n), parent_trail_id: null }))];
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
