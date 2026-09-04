/**
 * §10 inferred cause — lib/mapProducers/eventContextProducer and its wiring in
 * routes/mapProjection.ts.
 *
 * "Observed movement and inferred cause must be separately represented."
 * lib/crowdFlowProducer made that structural — `event_context` is a CAUSE-ONLY
 * family, admitted only through `attachCauseHypotheses` — and then nothing
 * ever supplied a hypothesis, so `payload.inferred` was null on every flow the
 * gateway could serve. This suite pins the producer that fills it and the
 * three things §10 / §37 require of it:
 *
 *   1. present ONLY with an event adjacent in space AND time to the flow's
 *      destination zone — otherwise null, and null for a failed event read is
 *      reported as such;
 *   2. labelled as an inference (INFERRED_CAUSE_LABEL), capped at provisional,
 *      based on the event id and nothing else — no coordinate, no host;
 *   3. inert on the observation: the observed half is identical with and
 *      without the cause, and no flow STATE is ever proposed (the recorded
 *      ruling in lib/crowdFlowProducer.ts: `dispersing` / `unusual` are
 *      explicitly-flagged facts, never deduced).
 *
 * The route-level tests reuse the shape of src/test/mapCrowdFlowLayer.test.ts's
 * gate-clearing cohort: two families, 15 actors, 15 independent groups, inside
 * the freshness window, past the publication delay.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mapInferredCause.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// The accepted_plan family derives an HMAC party token and refuses without a
// secret. Set before the route module loads, as mapCrowdFlowLayer does.
process.env.INTEL_GROUP_KEY_SECRET = process.env.INTEL_GROUP_KEY_SECRET ?? "inferred-cause-test-secret";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
} from "../routes/mapProjection.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import {
  EVENT_CAUSE_ADJACENCY_METERS,
  EVENT_CAUSE_ENDED_MINUTES,
  EVENT_CAUSE_NEAR_START_MINUTES,
  EVENT_CAUSE_UPCOMING_MINUTES,
  causeTitle,
  deriveEventCauseHypotheses,
  eventAdjacentToZone,
  eventPhaseAt,
  type EventContextLike,
} from "../lib/mapProducers/eventContextProducer.js";
import {
  CAUSE_ONLY_SIGNAL_FAMILIES,
  MAX_INFERRED_CAUSE_CONFIDENCE,
  SIGNAL_MAX_AGE_MINUTES,
  attachCauseHypotheses,
  type CauseHypothesis,
} from "../lib/crowdFlowProducer.js";
import { parseFlowZones, type FlowZone } from "../lib/mapProjection.js";
import { CONFIDENCE_STATES } from "../lib/mapObjects.js";
import {
  INFERRED_CAUSE_LABEL,
  type CrowdFlowPayload,
  type ZoneTransition,
} from "../lib/mapAggregation.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { haversineMeters } from "../lib/protectedLocations.js";

// ── zones (production parser over geo_zones rows) ─────────────────────────────

const ZONE_A = { id: "zone-a", name: "An Thuong", lat: 16.05, lng: 108.2 };
const ZONE_B = { id: "zone-b", name: "Han Riverside", lat: 16.06, lng: 108.22 };
const ZONE_RADIUS_M = 600;

function zoneRow(z: { id: string; name: string; lat: number; lng: number }): Record<string, unknown> {
  return {
    id: z.id,
    name: z.name,
    zone_type: "neighborhood",
    center_lat: z.lat,
    center_lng: z.lng,
    radius_meters: ZONE_RADIUS_M,
    polygon_geojson: null,
  };
}

const ZONES: FlowZone[] = parseFlowZones([ZONE_A, ZONE_B].map(zoneRow));

const NOW = Date.parse("2026-09-04T21:00:00.000Z");
const HOST = "host-sentinel-uuid";

function iso(base: number, offsetMinutes: number): string {
  return new Date(base + offsetMinutes * 60_000).toISOString();
}

/** An events row as loadNearbyEvents returns it (public, current, exact location shown). */
function event(base: number, over: Partial<EventContextLike> & Record<string, unknown> = {}): EventContextLike & Record<string, unknown> {
  return {
    id: "ev-1",
    host_id: HOST,
    title: "Riverside Night Market",
    location_name: "Han River",
    location_lat: ZONE_B.lat,
    location_lng: ZONE_B.lng,
    show_exact_location: true,
    starts_at: iso(base, -30),
    ends_at: iso(base, 90),
    cover_url: null,
    visibility: "public",
    state: "published",
    age_min: null,
    age_max: null,
    trust_score_min: null,
    verified_only: false,
    ...over,
  };
}

/** A point `meters` east of a zone's centre along the parallel. */
function eastOf(z: { lat: number; lng: number }, meters: number): { lat: number; lng: number } {
  const dLng = meters / (111_320 * Math.cos((z.lat * Math.PI) / 180));
  return { lat: z.lat, lng: z.lng + dLng };
}

// ── the producer, pure ────────────────────────────────────────────────────────

describe("deriveEventCauseHypotheses — adjacency in time", () => {
  it("an ongoing event is a cause (provisional)", () => {
    const r = deriveEventCauseHypotheses([event(NOW)], ZONES, { now: NOW });
    assert.equal(r.hypotheses.length, 1);
    assert.deepEqual(r.hypotheses[0], {
      zoneId: ZONE_B.id,
      cause: "Event nearby: Riverside Night Market is happening now",
      basis: ["event:ev-1"],
      confidence: "provisional",
    });
    assert.equal(r.candidates[0].phase, "ongoing");
  });

  it("an event starting within the upcoming window is a cause; near the start it is provisional, further out unverified", () => {
    const soon = deriveEventCauseHypotheses([event(NOW, { starts_at: iso(NOW, 20), ends_at: iso(NOW, 120) })], ZONES, { now: NOW });
    assert.equal(soon.hypotheses[0].cause, "Event nearby: Riverside Night Market starts in 20 min");
    assert.equal(soon.hypotheses[0].confidence, "provisional");
    assert.ok(20 <= EVENT_CAUSE_NEAR_START_MINUTES);

    const later = deriveEventCauseHypotheses(
      [event(NOW, { starts_at: iso(NOW, EVENT_CAUSE_UPCOMING_MINUTES - 5), ends_at: iso(NOW, 240) })],
      ZONES,
      { now: NOW },
    );
    assert.equal(later.hypotheses.length, 1);
    assert.equal(later.hypotheses[0].confidence, "unverified");

    const tooFar = deriveEventCauseHypotheses(
      [event(NOW, { starts_at: iso(NOW, EVENT_CAUSE_UPCOMING_MINUTES + 1), ends_at: iso(NOW, 240) })],
      ZONES,
      { now: NOW },
    );
    assert.equal(tooFar.hypotheses.length, 0);
  });

  it("an event that ended within the ended window is a cause (unverified); older is not", () => {
    const just = deriveEventCauseHypotheses([event(NOW, { starts_at: iso(NOW, -180), ends_at: iso(NOW, -15) })], ZONES, { now: NOW });
    assert.equal(just.hypotheses[0].cause, "Event nearby: Riverside Night Market ended 15 min ago");
    assert.equal(just.hypotheses[0].confidence, "unverified");

    const old = deriveEventCauseHypotheses(
      [event(NOW, { starts_at: iso(NOW, -300), ends_at: iso(NOW, -(EVENT_CAUSE_ENDED_MINUTES + 1)) })],
      ZONES,
      { now: NOW },
    );
    assert.equal(old.hypotheses.length, 0);
  });

  it("an event with no ends_at is assumed on for the default duration, then to have ended", () => {
    assert.equal(eventPhaseAt(event(NOW, { starts_at: iso(NOW, -60), ends_at: null }), NOW)?.phase, "ongoing");
    assert.equal(eventPhaseAt(event(NOW, { starts_at: iso(NOW, -200), ends_at: null }), NOW)?.phase, "ended");
    assert.equal(eventPhaseAt(event(NOW, { starts_at: null }), NOW), null);
  });
});

describe("deriveEventCauseHypotheses — adjacency in space", () => {
  it("inside the zone, or within EVENT_CAUSE_ADJACENCY_METERS of its edge, counts; beyond does not", () => {
    const zoneB = ZONES.find((z: FlowZone) => z.id === ZONE_B.id) as FlowZone;
    const inside = eastOf(ZONE_B, ZONE_RADIUS_M - 50);
    const nearEdge = eastOf(ZONE_B, ZONE_RADIUS_M + EVENT_CAUSE_ADJACENCY_METERS - 20);
    const beyond = eastOf(ZONE_B, ZONE_RADIUS_M + EVENT_CAUSE_ADJACENCY_METERS + 50);
    assert.equal(eventAdjacentToZone(zoneB, inside.lat, inside.lng), true);
    assert.equal(eventAdjacentToZone(zoneB, nearEdge.lat, nearEdge.lng), true);
    assert.equal(eventAdjacentToZone(zoneB, beyond.lat, beyond.lng), false);
    // Sanity on the fixture geometry itself.
    assert.ok(haversineMeters(ZONE_B.lat, ZONE_B.lng, beyond.lat, beyond.lng) > ZONE_RADIUS_M + EVENT_CAUSE_ADJACENCY_METERS);

    const r = deriveEventCauseHypotheses(
      [event(NOW, { location_lat: beyond.lat, location_lng: beyond.lng })],
      ZONES,
      { now: NOW },
    );
    assert.equal(r.hypotheses.length, 0);
    assert.equal(r.considered, 1);
  });

  it("an event whose exact location was hidden (nulled by loadNearbyEvents) is skipped, never approximated", () => {
    const r = deriveEventCauseHypotheses([event(NOW, { location_lat: null, location_lng: null })], ZONES, { now: NOW });
    assert.equal(r.hypotheses.length, 0);
    assert.equal(r.skipped, 1);
  });

  it("one event adjacent to two zones proposes a cause for each; one zone with two events keeps the best", () => {
    const zoneA = ZONES.find((z: FlowZone) => z.id === ZONE_A.id) as FlowZone;
    // Two events at zone B: an upcoming one and an ongoing one — ongoing wins.
    const r = deriveEventCauseHypotheses(
      [
        event(NOW, { id: "ev-upcoming", starts_at: iso(NOW, 10), ends_at: iso(NOW, 100) }),
        event(NOW, { id: "ev-ongoing" }),
        event(NOW, { id: "ev-at-a", location_lat: zoneA.centroid.lat, location_lng: zoneA.centroid.lng }),
      ],
      ZONES,
      { now: NOW },
    );
    assert.deepEqual(
      r.hypotheses.map((h: CauseHypothesis) => [h.zoneId, h.basis?.[0]]),
      [[ZONE_A.id, "event:ev-at-a"], [ZONE_B.id, "event:ev-ongoing"]],
    );
    assert.equal(r.candidates.length, 3);
  });

  it("is deterministic: same world, same sentence; ties break on event id", () => {
    const evs = [event(NOW, { id: "ev-z" }), event(NOW, { id: "ev-a" })];
    const a = deriveEventCauseHypotheses(evs, ZONES, { now: NOW });
    const b = deriveEventCauseHypotheses([...evs].reverse(), ZONES, { now: NOW });
    assert.deepEqual(a.hypotheses, b.hypotheses);
    assert.deepEqual(a.hypotheses[0].basis, ["event:ev-a"]);
  });

  it("empty or missing inputs propose nothing", () => {
    assert.equal(deriveEventCauseHypotheses([], ZONES, { now: NOW }).hypotheses.length, 0);
    assert.equal(deriveEventCauseHypotheses([event(NOW)], [], { now: NOW }).hypotheses.length, 0);
    assert.equal(deriveEventCauseHypotheses(null, ZONES, { now: NOW }).hypotheses.length, 0);
    assert.equal(deriveEventCauseHypotheses([event(NOW)], ZONES, { now: "garbage" }).hypotheses.length, 0);
  });
});

describe("a hypothesis is an inference and nothing more", () => {
  it("carries only {zoneId, cause, basis, confidence}: no coordinate, no host, no count, no flow state", () => {
    const r = deriveEventCauseHypotheses([event(NOW)], ZONES, { now: NOW });
    assert.deepEqual(Object.keys(r.hypotheses[0]).sort(), ["basis", "cause", "confidence", "zoneId"]);
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(HOST), "host id leaked into a cause");
    // The whole result — hypotheses AND candidates — carries no coordinate key.
    assert.ok(!/"(lat|lng|location_lat|location_lng|latitude|longitude)"/.test(serialized), "event coordinate leaked");
    for (const forbidden of ["dispersing", "unusual", "flowState", "actorId", "groupKey", "cohort"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not appear`);
    }
  });

  it("proposes at most the producer ceiling, and the attach step caps at provisional and at the observation's band", () => {
    const provisional = CONFIDENCE_STATES.indexOf("provisional");
    for (const h of deriveEventCauseHypotheses([event(NOW)], ZONES, { now: NOW }).hypotheses) {
      assert.ok(CONFIDENCE_STATES.indexOf(h.confidence as (typeof CONFIDENCE_STATES)[number]) <= provisional);
    }
    assert.equal(MAX_INFERRED_CAUSE_CONFIDENCE, "provisional");
    // A hypothesis claiming 'strong' cannot raise itself above the ceiling or the observation.
    const t: ZoneTransition = {
      fromZoneId: ZONE_A.id,
      toZoneId: ZONE_B.id,
      from: { lat: ZONE_A.lat, lng: ZONE_A.lng },
      to: { lat: ZONE_B.lat, lng: ZONE_B.lng },
      distinctActors: 20,
      distinctGroups: 10,
      maxGroupShare: 0.1,
      signalFamilies: ["accepted_plan", "next_stop_contribution"],
      observedAt: iso(NOW, -15),
      windowMinutes: 30,
      confidence: "unverified",
    };
    const [attached] = attachCauseHypotheses([t], [{ zoneId: ZONE_B.id, cause: "Because", confidence: "strong" }]);
    assert.equal(attached.inferredCause?.confidence, "unverified");
    // And the observed fields are untouched by the attach.
    assert.equal(attached.distinctActors, 20);
    assert.equal(attached.dispersing, undefined);
    assert.equal(attached.unusual, undefined);
  });

  it("event_context is a cause-only family — a MovementSignal can never carry it", () => {
    assert.deepEqual([...CAUSE_ONLY_SIGNAL_FAMILIES], ["event_context"]);
  });

  it("titles are sanitised and bounded; an empty title reads as 'an event'", () => {
    assert.equal(causeTitle("  Night   Market \n"), "Night Market");
    assert.equal(causeTitle(""), "an event");
    assert.equal(causeTitle(null), "an event");
    assert.equal(causeTitle("x".repeat(200)).length, 80);
  });
});

// ── route level: the cause reaches payload.inferred, and only then ───────────
//
// The fixture below is the gate-clearing cohort of mapCrowdFlowLayer.test.ts.

const TOKEN = "inferred-cause-token";
const USER = "inferred-cause-viewer";
const ACTOR = (n: number) => `actor-sentinel-${n}`;
const GROUP = (n: number) => `groupkey-sentinel-${n}`;
const ORIGIN_PLACE_ID = "place-sentinel-origin";
const STOP_FROM = { lat: 16.0491234, lng: 108.2013579 };
const STOP_TO = { lat: 16.0609876, lng: 108.2197531 };
const PLACE_POINT = { lat: 16.0507654, lng: 108.2004321 };
const BBOX = "108.0,15.9,108.4,16.2";
const OBSERVED_AGO_MS = 15 * 60_000;
const COHORT_ACTORS = PRIVACY_THRESHOLD_V1.minUniqueActors;
const PLAN_ACTORS = 3;

function isoAgo(nowMs: number, agoMs: number): string {
  return new Date(nowMs - agoMs).toISOString();
}

function nextMoveRows(nowMs: number, count: number): Record<string, unknown>[] {
  const observedAt = isoAgo(nowMs, OBSERVED_AGO_MS);
  const expiresAt = new Date(nowMs - OBSERVED_AGO_MS + SIGNAL_MAX_AGE_MINUTES * 60_000).toISOString();
  return Array.from({ length: count }, (_v: unknown, i: number) => ({
    actor_id: ACTOR(i + 1),
    subject_id: ORIGIN_PLACE_ID,
    zone_id: null,
    value: { destinationArea: ZONE_B.name },
    group_key: GROUP(i + 1),
    observed_at: observedAt,
    expires_at: expiresAt,
    claim_type: "experience.next_move",
    moderation_state: "allowed",
  }));
}

function planRows(nowMs: number, count: number): FakeState {
  const acceptedAt = isoAgo(nowMs, OBSERVED_AGO_MS);
  const stopTouchedAt = isoAgo(nowMs, OBSERVED_AGO_MS + 60 * 60_000);
  const route_plans: Record<string, unknown>[] = [];
  const route_stops: Record<string, unknown>[] = [];
  const route_legs: Record<string, unknown>[] = [];
  const route_flow_contribution_consent: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const planId = `plan-${i + 1}`;
    const actorId = ACTOR(i + 1);
    route_plans.push({ id: planId, trip_id: null, accepted_by_user_id: actorId, accepted_at: acceptedAt, status: "active" });
    route_flow_contribution_consent.push({ user_id: actorId, enabled: true, withdrawn_at: null });
    route_stops.push(
      { id: `${planId}-from`, route_plan_id: planId, structured_location: { label: "start", ...STOP_FROM }, updated_at: stopTouchedAt },
      { id: `${planId}-to`, route_plan_id: planId, structured_location: { label: "end", ...STOP_TO }, updated_at: stopTouchedAt },
    );
    route_legs.push({ route_plan_id: planId, from_stop_id: `${planId}-from`, to_stop_id: `${planId}-to` });
  }
  return { route_plans, route_stops, route_legs, route_flow_contribution_consent };
}

/** The whole world, gates cleared; `events` is what this suite varies. */
function flowWorld(nowMs: number, events: Record<string, unknown>[] | { error: { message: string } }, over: FakeState = {}): FakeState {
  const actors = nextMoveRows(nowMs, COHORT_ACTORS);
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_crowd_flow_enabled", enabled: true },
    ],
    protected_zones: [],
    geo_zones: [ZONE_A, ZONE_B].map(zoneRow),
    places: [{ id: ORIGIN_PLACE_ID, latitude: PLACE_POINT.lat, longitude: PLACE_POINT.lng, status: "active", merged_into_place_id: null }],
    intel_observations: actors,
    intel_contribution_consent: actors.map((a: Record<string, unknown>) => ({ user_id: a.actor_id, enabled: true, withdrawn_at: null })),
    ...planRows(nowMs, PLAN_ACTORS),
    blocks: [],
    events,
    event_roles: [],
    user_friendships: [],
    ...over,
  };
}

type FlowObject = { kind: string; payload: CrowdFlowPayload };
const flowsIn = (body: { objects?: FlowObject[] }): FlowObject[] =>
  (body.objects ?? []).filter((o: FlowObject) => o.kind === "crowd_flow");

describe("§10 inferred cause through GET /api/map/projection", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => {
    _clearProtectedZoneCache();
    _clearFlowZoneCache();
  });
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function serve(state: FakeState, query = `bbox=${BBOX}&zoom=14&kinds=crowd_flow`) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: USER });
    return app.projection(query);
  }

  it("with an event adjacent to the destination zone, payload.inferred is populated and labelled as an inference", async () => {
    const now = Date.now();
    const r = await serve(flowWorld(now, [event(now)]));
    assert.equal(r.status, 200);
    const flows = flowsIn(r.body);
    assert.equal(flows.length, 1, `crowdFlow report: ${JSON.stringify(r.body.crowdFlow)}`);
    const inferred = flows[0].payload.inferred;
    assert.ok(inferred, "inferred half must be present");
    assert.equal(inferred.label, INFERRED_CAUSE_LABEL);
    assert.match(inferred.label, /inferred/i);
    assert.equal(inferred.cause, "Event nearby: Riverside Night Market is happening now");
    assert.deepEqual(inferred.basis, ["event:ev-1"]);
    // Capped: never above provisional, never above the observation's own band.
    const rank = (c: string) => CONFIDENCE_STATES.indexOf(c as (typeof CONFIDENCE_STATES)[number]);
    assert.ok(rank(inferred.confidence) <= rank("provisional"));
    assert.ok(rank(inferred.confidence) <= rank(String((flows[0] as unknown as { confidence: string }).confidence)));
    assert.deepEqual(r.body.crowdFlow.inferredCause, { events: 1, eventsReadFailed: false, hypotheses: 1, attached: 1 });
    // The event layer was not requested: the cause does not need the pin.
    assert.deepEqual(r.body.sources, ["crowd_flow"]);
  });

  it("without an adjacent event, inferred is null — never invented", async () => {
    const now = Date.now();
    const r = await serve(flowWorld(now, []));
    const flows = flowsIn(r.body);
    assert.equal(flows.length, 1);
    assert.equal(flows[0].payload.inferred, null);
    assert.deepEqual(r.body.crowdFlow.inferredCause, { events: 0, eventsReadFailed: false, hypotheses: 0, attached: 0 });
  });

  it("an event far from the zone, or long over, is not a cause", async () => {
    const now = Date.now();
    const far = eastOf(ZONE_B, ZONE_RADIUS_M + EVENT_CAUSE_ADJACENCY_METERS + 200);
    const a = await serve(flowWorld(now, [event(now, { location_lat: far.lat, location_lng: far.lng })]));
    assert.equal(flowsIn(a.body)[0].payload.inferred, null);
    assert.equal(a.body.crowdFlow.inferredCause.events, 1);
    assert.equal(a.body.crowdFlow.inferredCause.hypotheses, 0);
    await (app as ProjectionApp).close();
    app = null;

    const b = await serve(flowWorld(now, [event(now, { starts_at: iso(now, -400), ends_at: iso(now, -180) })]));
    assert.equal(flowsIn(b.body)[0].payload.inferred, null);
  });

  it("an event whose host hid the exact location cannot be a cause (loadNearbyEvents nulls it)", async () => {
    const now = Date.now();
    const r = await serve(flowWorld(now, [event(now, { show_exact_location: false })]));
    assert.equal(flowsIn(r.body)[0].payload.inferred, null);
    assert.equal(r.body.crowdFlow.inferredCause.hypotheses, 0);
  });

  it("a failed event read costs the cause, never the observation, and is reported", async () => {
    const now = Date.now();
    const r = await serve(flowWorld(now, { error: { message: "events down" } }));
    const flows = flowsIn(r.body);
    assert.equal(flows.length, 1, "the observed flow must still publish");
    assert.equal(flows[0].payload.inferred, null);
    assert.equal(r.body.crowdFlow.inferredCause.eventsReadFailed, true);
  });

  it("the observed half is identical with and without the cause, and no flow state is inferred", async () => {
    const now = Date.now();
    const withEvent = flowsIn((await serve(flowWorld(now, [event(now)]))).body)[0];
    await (app as ProjectionApp).close();
    app = null;
    const without = flowsIn((await serve(flowWorld(now, []))).body)[0];

    // observedAt derives from the cohort's timestamps, which the two worlds
    // share; the rest of the observed half must be byte-identical.
    assert.deepEqual(withEvent.payload.observed, without.payload.observed);
    assert.equal(withEvent.payload.observed.flowState, without.payload.observed.flowState);
    assert.equal(withEvent.payload.observed.cohortSize, COHORT_ACTORS);
    // The cause is not a signal family: the observed families are unchanged.
    assert.deepEqual(withEvent.payload.observed.signalFamilies, ["accepted_plan", "next_stop_contribution"]);
    assert.ok(!("cause" in withEvent.payload.observed));
    // Nothing about the host, the event coordinate or the actors reaches the wire.
    const serialized = JSON.stringify(withEvent);
    assert.ok(!serialized.includes(HOST));
    assert.ok(!serialized.includes(ACTOR(1)));
    assert.ok(!serialized.includes(GROUP(1)));
  });

  it("one event read per request when both the event layer and the cause need it", async () => {
    const now = Date.now();
    app = await startRouterApp(mapProjectionRouter, flowWorld(now, [event(now)]), { token: TOKEN, userId: USER });
    const originalFrom = app.client.from as (table: string) => unknown;
    let eventReads = 0;
    app.client.from = (table: string) => {
      if (table === "events") eventReads += 1;
      return originalFrom(table);
    };
    const r = await app.projection(`bbox=${BBOX}&zoom=14&kinds=crowd_flow,event`);
    assert.equal(eventReads, 1);
    const kinds = (r.body.objects as { kind: string }[]).map((o: { kind: string }) => o.kind).sort();
    assert.deepEqual(kinds, ["crowd_flow", "event"]);
    assert.ok(flowsIn(r.body)[0].payload.inferred);
    assert.deepEqual([...r.body.sources].sort(), ["crowd_flow", "events"]);
  });
});
