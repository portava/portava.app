/**
 * meeting_point producer (Map spec §6 "Checkpoint pin = Meeting point", §11 Trip
 * Map meeting points, §12 "temporary and auto-expiring", §23 Trip Crew rung).
 *
 * The record projected is a trip plan item of category `meeting_point` — the
 * only meeting record in the schema that carries a coordinate (meetups are
 * text-located by rule; circle_meeting_points are labels only). See the
 * producer header for the derivation.
 *
 * WHAT IS PINNED HERE
 *   privacy class      place_level, never sharper, for the trip's own members
 *   isServable         a projected point clears the last gate before the wire
 *   protection gate    withheld in a suppress-class zone; coarsened, not
 *                      suppressed, in a coarsen-class zone (relationship-gated,
 *                      not ambient presence)
 *   TTL                ends_at, else starts_at + grace; expired and undated
 *                      items never leave the producer
 *   participants only  the read is scoped by trip membership; a non-member
 *                      gets nothing, not a coarse pin
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapMeetingPointProducer.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { makeFakeMapDb, startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import {
  MEETING_POINT_GRACE_MINUTES,
  MEETING_POINT_MEMBER_ROLES,
  MEETING_POINT_PRIVACY_CLASS,
  meetingPointExpiryMs,
  projectMeetingPoint,
  readMeetingPoints,
  type MeetingPointItemLike,
} from "../lib/mapProducers/meetingPointProducer.js";
import {
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  isServable,
  type MapObject,
} from "../lib/mapObjects.js";
import { applyProtection, type ProtectedZone } from "../lib/protectedLocations.js";
import { parseBbox } from "../lib/mapProjection.js";
import { NEVER_AGGREGATED_KINDS, type BBox } from "../lib/mapAggregation.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const VIEWER = "11111111-aaaa-4aaa-8aaa-111111111111";
const STRANGER = "22222222-bbbb-4bbb-8bbb-222222222222";
/** The trip's owner — a THIRD party. VIEWER reads trip-1 through an accepted
 * membership row (the plan_items_select path we want to exercise), not through
 * ownership, and STRANGER then owns nothing here and is a genuine outsider. */
const HOST = "55555555-eeee-4eee-8eee-555555555555";
const TOKEN = "meeting-point-token";
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const BBOX_STR = "108.0,15.9,108.4,16.2";
const BBOX: BBox = parseBbox(BBOX_STR) as BBox;
/** Dragon Bridge, Da Nang. Unmistakable digits so a leak is greppable. */
const SPOT = { lat: 16.0611, lng: 108.2272 };
const FAR = { lat: 10.7769, lng: 106.7009 }; // Saigon: outside BBOX

function iso(offsetMinutes: number): string {
  return new Date(NOW + offsetMinutes * 60_000).toISOString();
}

/** Real-clock-relative ISO for the gateway-integration fixtures (see gatewayWorld). */
const REAL_NOW = Date.now();
function realIso(offsetMinutes: number): string {
  return new Date(REAL_NOW + offsetMinutes * 60_000).toISOString();
}

/** A trip_plan_items row as routes/plan.ts add-to-trip-plan writes it. */
function item(over: Partial<MeetingPointItemLike> = {}): MeetingPointItemLike {
  return {
    id: "item-1",
    trip_id: "trip-1",
    title: "Meet at Dragon Bridge",
    category: "meeting_point",
    status: "tentative",
    source_type: "meetup",
    source_id: "meetup-1",
    starts_at: iso(30),
    ends_at: null,
    location_name: "Dragon Bridge",
    lat: SPOT.lat,
    lng: SPOT.lng,
    location_is_private: false,
    lock_type: null,
    removed_at: null,
    ...over,
  };
}

function projected(over: Partial<MeetingPointItemLike> = {}): MapObject {
  const r = projectMeetingPoint(item(over), { now: NOW });
  assert.ok(r.object, `expected an object, got skipped=${r.skipped}`);
  return r.object as MapObject;
}

function skipReason(over: Partial<MeetingPointItemLike> = {}): string | undefined {
  return projectMeetingPoint(item(over), { now: NOW }).skipped;
}

function zone(over: Partial<ProtectedZone> & { category: string }): ProtectedZone {
  return {
    id: "zone-1",
    shape: "circle",
    center: { lat: SPOT.lat, lng: SPOT.lng },
    radiusMeters: 400,
    ...over,
  } as ProtectedZone;
}

// ── projectMeetingPoint — shape ───────────────────────────────────────────────

describe("projectMeetingPoint — shape", () => {
  it("is a meeting_point at the trip-crew tier, place_level, and servable", () => {
    const o = projected();
    assert.equal(o.id, "meeting_point:item-1");
    assert.equal(o.kind, "meeting_point");
    assert.equal(o.privacyClass, "place_level");
    assert.equal(o.privacyClass, MEETING_POINT_PRIVACY_CLASS);
    assert.equal(o.renderingPriority, KIND_DEFAULT_PRIORITY.meeting_point);
    assert.equal(o.renderingPriority, RENDERING_PRIORITY.trip_crew);
    assert.equal(isServable(o), true);
    // GeoJSON order: [lng, lat].
    assert.deepEqual(o.geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
    assert.equal(o.title, "Meet at Dragon Bridge");
    assert.equal(o.subtitle, "Dragon Bridge · 2026-09-04 12:30");
    assert.equal(o.interaction?.detailRoute, "/trip/trip-1");
  });

  it("never rises above place_level — a meeting point is a venue, not a person", () => {
    assert.notEqual(MEETING_POINT_PRIVACY_CLASS, "precise_temporary");
    assert.equal(projected().privacyClass, "place_level");
  });

  it("a plan is not an observation: no observedAt, freshness, confidence, activity or trend", () => {
    const o = projected();
    assert.equal(o.observedAt, undefined);
    assert.equal(o.freshness, undefined);
    assert.equal(o.confidence, undefined);
    assert.equal(o.activity, undefined);
    assert.equal(o.trend, undefined);
    assert.equal(o.sourceClass, undefined);
    assert.equal(o.count, undefined);
  });

  it("carries the meetup id only for meetup-sourced items", () => {
    const fromMeetup = projected().payload as { meetupId: string | null; sourceType: string | null };
    assert.equal(fromMeetup.meetupId, "meetup-1");
    assert.equal(fromMeetup.sourceType, "meetup");
    const manual = projected({ source_type: null, source_id: null }).payload as { meetupId: string | null };
    assert.equal(manual.meetupId, null);
    // A source id on a non-meetup source is not a meetup id.
    const place = projected({ source_type: "place", source_id: "place-9" }).payload as { meetupId: string | null };
    assert.equal(place.meetupId, null);
  });

  it("falls back to a generic title rather than serving an empty one", () => {
    assert.equal(projected({ title: "   " }).title, "Meeting point");
    assert.equal(projected({ title: null }).title, "Meeting point");
  });

  it("is never collapsed into an activity zone (§31 trip crew tier passes through)", () => {
    assert.ok(NEVER_AGGREGATED_KINDS.includes("meeting_point"));
  });
});

// ── TTL (§12 temporary and auto-expiring) ─────────────────────────────────────

describe("projectMeetingPoint — TTL", () => {
  it("expires at ends_at when one is recorded", () => {
    const o = projected({ starts_at: iso(30), ends_at: iso(120) });
    assert.equal(o.expiresAt, iso(120));
    assert.equal(meetingPointExpiryMs(item({ starts_at: iso(30), ends_at: iso(120) })), NOW + 120 * 60_000);
  });

  it("expires MEETING_POINT_GRACE_MINUTES after starts_at when no end is recorded", () => {
    const o = projected({ starts_at: iso(30), ends_at: null });
    assert.equal(o.expiresAt, iso(30 + MEETING_POINT_GRACE_MINUTES));
  });

  it("an ends_at that is not after starts_at is ignored in favour of the grace rule", () => {
    const o = projected({ starts_at: iso(30), ends_at: iso(10) });
    assert.equal(o.expiresAt, iso(30 + MEETING_POINT_GRACE_MINUTES));
  });

  it("a meeting point that has already expired is dropped, never served with a past expiresAt", () => {
    assert.equal(skipReason({ starts_at: iso(-200), ends_at: iso(-5) }), "expired");
    // Exactly at expiry is expired too.
    assert.equal(skipReason({ starts_at: iso(-120), ends_at: new Date(NOW).toISOString() }), "expired");
    // Started but still inside the grace window is current.
    assert.equal(skipReason({ starts_at: iso(-(MEETING_POINT_GRACE_MINUTES - 1)), ends_at: null }), undefined);
  });

  it("an undated item has no meeting time to expire to and is not a temporary object — skipped", () => {
    assert.equal(skipReason({ starts_at: null, ends_at: null }), "undated");
    assert.equal(skipReason({ starts_at: "not a date", ends_at: null }), "undated");
    assert.equal(meetingPointExpiryMs(item({ starts_at: null })), null);
  });
});

// ── skips ─────────────────────────────────────────────────────────────────────

describe("projectMeetingPoint — what never renders", () => {
  it("a private-location item is DROPPED, not coarsened (the trip surface nulls it for every reader)", () => {
    assert.equal(skipReason({ location_is_private: true }), "private_location");
  });

  it("removed, cancelled, uncoordinated and non-meeting items", () => {
    assert.equal(skipReason({ removed_at: iso(-1) }), "removed");
    assert.equal(skipReason({ status: "cancelled" }), "cancelled");
    assert.equal(skipReason({ lat: null, lng: null }), "no_coordinate");
    assert.equal(skipReason({ lat: 91, lng: SPOT.lng }), "no_coordinate");
    assert.equal(skipReason({ lat: Number.NaN, lng: SPOT.lng }), "no_coordinate");
    assert.equal(skipReason({ category: "food" }), "not_meeting_point");
  });
});

// ── §24 protection gate ───────────────────────────────────────────────────────

describe("meeting_point through the §24 gate", () => {
  it("is withheld inside a suppress-class zone (shelter)", () => {
    const out = applyProtection([projected()], [zone({ category: "shelter" })]);
    assert.equal(out.objects.length, 0);
    assert.equal(out.report.suppressed, 1);
    assert.equal(out.report.safetyExempt, 0);
  });

  it("is coarsened, not suppressed, inside a coarsen-class zone (relationship-gated, not ambient presence)", () => {
    const hospital = zone({ category: "medical_facility", center: { lat: SPOT.lat + 0.001, lng: SPOT.lng } });
    const out = applyProtection([projected()], [hospital]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.coarsened, 1);
    assert.equal(out.report.suppressed, 0);
    const o = out.objects[0];
    // The exact spot does not survive: the point is moved to the zone's anchor.
    assert.notDeepEqual(o.geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
    // The plan's clock is stripped with everything else time-bound.
    assert.equal(o.expiresAt, undefined);
  });

  it("passes untouched when no zone covers it", () => {
    const out = applyProtection([projected()], [zone({ category: "shelter", center: FAR })]);
    assert.equal(out.objects.length, 1);
    assert.equal(out.report.allowed, 1);
    assert.deepEqual(out.objects[0].geometry, { type: "Point", coordinates: [SPOT.lng, SPOT.lat] });
  });
});

// ── readMeetingPoints — participants only ─────────────────────────────────────

function world(over: FakeState = {}): FakeState {
  return {
    trip_members: [{ trip_id: "trip-1", user_id: VIEWER, role: "member", status: "accepted" }],
    trips: [{ id: "trip-1", owner_id: HOST, status: "planning" }],
    trip_plan_items: [item()],
    meetups: [{ id: "meetup-1", status: "scheduled" }],
    ...over,
  };
}

function client(state: FakeState) {
  return makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
}

describe("readMeetingPoints — participants only", () => {
  it("the roles it scopes to are the plan_items_select roles (0010)", () => {
    assert.deepEqual([...MEETING_POINT_MEMBER_ROLES], ["owner", "member"]);
  });

  it("an accepted member reads the trip's meeting point", async () => {
    const r = await readMeetingPoints(client(world()), VIEWER, { bbox: BBOX, now: NOW });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.trips, 1);
    assert.equal(r.report.candidates, 1);
    assert.equal(r.points.length, 1);
    assert.equal(r.points[0].id, "meeting_point:item-1");
  });

  it("a non-member gets NOTHING — not a coarse pin", async () => {
    const r = await readMeetingPoints(client(world()), STRANGER, { bbox: BBOX, now: NOW });
    assert.ok(r.ok);
    if (!r.ok) return;
    // STRANGER owns no trip here and has no membership row.
    assert.equal(r.report.trips, 0);
    assert.equal(r.points.length, 0);
  });

  it("an invited-but-not-accepted member is not a participant", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_members: [{ trip_id: "trip-1", user_id: VIEWER, role: "member", status: "invited" }] })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.trips, 0);
    assert.equal(r.points.length, 0);
  });

  it("a viewer-role member cannot read plan items and gets nothing", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_members: [{ trip_id: "trip-1", user_id: VIEWER, role: "viewer", status: "accepted" }] })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.points.length, 0);
  });

  it("the trip owner is a participant even without a trip_members row", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_members: [], trips: [{ id: "trip-1", owner_id: VIEWER, status: "planning" }] })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.trips, 1);
    assert.equal(r.points.length, 1);
  });

  it("is viewport-scoped", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_plan_items: [item({ lat: FAR.lat, lng: FAR.lng })] })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.candidates, 0);
    assert.equal(r.points.length, 0);
  });

  it("a cancelled meetup takes its plan item off the map; a manual item on the same trip stays", async () => {
    const r = await readMeetingPoints(
      client(
        world({
          trip_plan_items: [
            item(),
            item({ id: "item-2", source_type: null, source_id: null, title: "Manual checkpoint" }),
          ],
          meetups: [{ id: "meetup-1", status: "cancelled" }],
        }),
      ),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.cancelledMeetups, 1);
    assert.deepEqual(r.points.map((p: MapObject) => p.id), ["meeting_point:item-2"]);
  });

  it("when the meetup cross-check cannot be read, meetup-sourced items are WITHHELD (fail-closed); manual ones serve", async () => {
    const r = await readMeetingPoints(
      client(
        world({
          trip_plan_items: [item(), item({ id: "item-2", source_type: null, source_id: null })],
          meetups: { error: { message: "meetups down" } },
        }),
      ),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.report.meetupReadFailed, true);
    assert.deepEqual(r.points.map((p: MapObject) => p.id), ["meeting_point:item-2"]);
  });

  it("an unreadable membership table is a refusal, not an empty trip list", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_members: { error: { message: "down" } } })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.deepEqual(r, { ok: false, reason: "membership_read_failed" });
  });

  it("an unreadable plan-items table is a refusal", async () => {
    const r = await readMeetingPoints(
      client(world({ trip_plan_items: { error: { message: "down" } } })),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.deepEqual(r, { ok: false, reason: "items_read_failed" });
  });

  it("expired and private items are counted, never served", async () => {
    const r = await readMeetingPoints(
      client(
        world({
          trip_plan_items: [
            item({ id: "gone", starts_at: iso(-300), ends_at: iso(-200) }),
            item({ id: "secret", location_is_private: true }),
          ],
        }),
      ),
      VIEWER,
      { bbox: BBOX, now: NOW },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.points.length, 0);
    assert.equal(r.report.skipped.expired, 1);
    assert.equal(r.report.skipped.private_location, 1);
  });
});

// ── through the gateway ───────────────────────────────────────────────────────

function gatewayWorld(over: FakeState = {}): FakeState {
  return world({
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }],
    blocks: [],
    protected_zones: [],
    // The gateway ages plan items against Date.now() (routes/mapProjection.ts
    // nowMs), not the fixed NOW the pure-function tests inject, so the served
    // item must be current on the real clock or it drops out as expired.
    trip_plan_items: [item({ starts_at: realIso(30), ends_at: realIso(120) })],
    ...over,
  });
}

describe("meeting_point through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, userId: string, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId });
    return app.projection(query);
  }

  it("arrives for a participant, ranked at the trip-crew tier, and reports its layer", async () => {
    const r = await serve(gatewayWorld(), VIEWER, `bbox=${BBOX_STR}&zoom=14&kinds=meeting_point`);
    assert.equal(r.status, 200);
    const objs = r.body.objects as MapObject[];
    assert.equal(objs.length, 1);
    assert.equal(objs[0].kind, "meeting_point");
    assert.equal(objs[0].privacyClass, "place_level");
    assert.equal(objs[0].renderingPriority, RENDERING_PRIORITY.trip_crew);
    assert.ok(typeof objs[0].expiresAt === "string");
    assert.ok(r.body.sources.includes("meeting_points"));
    assert.deepEqual(r.body.producers.meeting_point, { refusal: null, collected: 1 });
    assert.equal(r.body.protection.evaluated, 1);
  });

  it("is never folded into an activity zone, even at city zoom", async () => {
    const r = await serve(gatewayWorld(), VIEWER, `bbox=${BBOX_STR}&zoom=10&kinds=meeting_point`);
    assert.equal(r.body.objects.length, 1);
    assert.equal(r.body.objects[0].kind, "meeting_point");
    assert.equal(r.body.aggregation.aggregated, 0);
  });

  it("a non-participant is served nothing, and the layer says it looked", async () => {
    const r = await serve(gatewayWorld(), STRANGER, `bbox=${BBOX_STR}&zoom=14&kinds=meeting_point`);
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.meeting_point, { refusal: null, collected: 0 });
  });

  it("is not read at all when the kind is not requested", async () => {
    const r = await serve(gatewayWorld(), VIEWER, `bbox=${BBOX_STR}&zoom=14&kinds=hidden_gem`);
    assert.equal(r.body.producers.meeting_point, null);
    assert.ok(!r.body.sources.includes("meeting_points"));
  });

  it("a membership read failure is a refusal in the envelope, not an empty layer", async () => {
    const r = await serve(
      gatewayWorld({ trip_members: { error: { message: "down" } } }),
      VIEWER,
      `bbox=${BBOX_STR}&zoom=14&kinds=meeting_point`,
    );
    assert.deepEqual(r.body.objects, []);
    assert.deepEqual(r.body.producers.meeting_point, { refusal: "membership_read_failed", collected: 0 });
    assert.ok(!r.body.sources.includes("meeting_points"));
  });

  it("is withheld by the §24 gate inside a suppress-class protected zone", async () => {
    const r = await serve(
      gatewayWorld({
        protected_zones: [
          {
            id: "pz-1", category: "shelter", action: null, privacy_floor: null, shape: "circle",
            center_lat: SPOT.lat, center_lng: SPOT.lng, radius_meters: 400, ring: null,
            jurisdiction: null, policy_ref: null, active: true,
          },
        ],
      }),
      VIEWER,
      `bbox=${BBOX_STR}&zoom=14&kinds=meeting_point`,
    );
    assert.deepEqual(r.body.objects, []);
    // Collected by the producer, removed by the gate — both are visible.
    assert.deepEqual(r.body.producers.meeting_point, { refusal: null, collected: 1 });
    assert.equal(r.body.protection.suppressed, 1);
  });
});
