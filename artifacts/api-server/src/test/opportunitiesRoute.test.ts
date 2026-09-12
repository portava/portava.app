/**
 * Sensing §6 through the REAL route — GET /api/intel/opportunities behind
 * `opportunity_engine_enabled` (migration 2840, seeded FALSE), over the fake
 * PostgREST double the Map gateway suites use.
 *
 * OFF is the load-bearing case: with the flag absent or false the route answers
 * feature_disabled and reads nothing. ON, the kernel is assembled from the ONE
 * live read path and the viewer's own notification preferences, the stage runs
 * over it, and the answer carries the requested surface's fields — with no
 * world value anywhere on the wire, a safety reading suppressed rather than
 * ranked, and "could not look" spelled differently from "nothing to act on".
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import opportunitiesRouter from "../routes/opportunities.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "55555555-aaaa-4aaa-8aaa-555555555555";
const TOKEN = "opportunities-token";
const PLACE_ID = "66666666-bbbb-4bbb-8bbb-666666666666";
const OTHER_ID = "77777777-cccc-4ccc-8ccc-777777777777";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const ON = { flag: "opportunity_engine_enabled", enabled: true };
const OFF = { flag: "opportunity_engine_enabled", enabled: false };

function snapshot(subject: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "busy" },
    confidence: 0.85,
    source_count: 30,
    observed_at: iso(-3),
    expires_at: iso(27),
    privacy_eligible: true,
    conflict_state: "none",
    source_class: "firsthand_unverified",
    computed_at: iso(-3),
    ...over,
  };
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }, { scope_key: "|vibe.state" }, { scope_key: "|queue.wait" }],
    intel_state_snapshots: [
      snapshot(PLACE_ID),
      snapshot(PLACE_ID, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
    ],
    places: [{ id: PLACE_ID, latitude: 48.8584, longitude: 2.2945 }, { id: OTHER_ID, latitude: 48.86, longitude: 2.3 }],
    notification_preferences: [],
    notifications: [],
    ...over,
  };
}

interface Body {
  error?: string;
  surface?: string;
  liveIntelligenceReadable?: boolean;
  opportunities?: Array<Record<string, any>>;
  refusals?: Array<{ subjectId: string; reason: string; decision: string | null; decisionReasons: string[] }>;
  contexts?: {
    unknown?: string[];
    temporal?: { localHour: number | null; dayPart: string | null };
    attention?: { available: boolean | null; deliveredInWindow: number | null; budgetPerWindow: number };
    safety?: { suppressedSubjectIds: string[] };
    world?: Array<{
      subjectId: string;
      readable: boolean;
      crowd: { density: string | null; momentum: string | null; balance: unknown; refusals: string[]; truth: Record<string, any>; temporal: Record<string, any> };
      forecast: Record<string, any> | null;
      forecastRefusal: string | null;
    }>;
  };
}

describe("GET /api/intel/opportunities", () => {
  let app: ProjectionApp | null = null;
  beforeEach(() => _clearPromotedScopeCache());
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function get(state: FakeState, query: string, token: string = TOKEN) {
    app = await startRouterApp(opportunitiesRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/intel/opportunities?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Body };
  }

  it("the flag ABSENT (production's state): feature_disabled, and nothing else is read", async () => {
    const r = await get(world([], { intel_state_snapshots: { error: { message: "must not be read" } } }), `subjectIds=${PLACE_ID}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("the flag FALSE: identical", async () => {
    const r = await get(world([OFF], { intel_state_snapshots: { error: { message: "must not be read" } } }), `subjectIds=${PLACE_ID}`);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("unauthenticated is refused; a malformed subject list is invalid_payload", async () => {
    assert.equal((await get(world([ON]), `subjectIds=${PLACE_ID}`, "stranger")).status, 401);
    assert.equal((await get(world([ON]), "subjectIds=not-a-uuid")).body.error, "invalid_payload");
    assert.equal((await get(world([ON]), "subjectIds=")).body.error, "invalid_payload");
  });

  it("ON: a live reading is one go_now opportunity, with the evidence's truth and window and NO world value", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&intent=social&relevance=saved&lat=48.8584&lng=2.2945`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.surface, "compass");
    assert.equal(r.body.opportunities?.length, 1);
    const o = r.body.opportunities![0]!;
    assert.equal(o.subjectId, PLACE_ID);
    assert.equal(o.kind, "go_now");
    assert.equal(o.decision, "GO_NOW");
    assert.equal(o.truth.truthClass, "corroborated");
    assert.equal(o.window.observedAt, iso(-3));
    assert.equal(o.reachable, true, "the viewer is on top of the place: a 0-minute walk");
    assert.ok(o.relevance > 0);
    assert.deepEqual(r.body.refusals, []);
    assert.doesNotMatch(JSON.stringify(r.body.opportunities), /busy|building|density|trajectory|distinct_actors|actor_id|latitude|longitude/);
  });

  it("ON: a safety reading is SUPPRESSED, not ranked — no opportunity, and the refusal says why", async () => {
    const state = world([ON], {
      intel_state_snapshots: [
        snapshot(PLACE_ID, { value: { level: "unsafe_density" } }),
        snapshot(PLACE_ID, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
      ],
    });
    const r = await get(state, `subjectIds=${PLACE_ID}&relevance=saved&intent=high_energy&lat=48.8584&lng=2.2945`);
    assert.deepEqual(r.body.opportunities, []);
    assert.deepEqual(r.body.refusals, [{ subjectId: PLACE_ID, reason: "safety_suppressed", decision: null, decisionReasons: [] }]);
    assert.deepEqual(r.body.contexts?.safety?.suppressedSubjectIds, [PLACE_ID]);
  });

  it("ON but the Live pilot CLOSED: every subject refused with live_intelligence_unavailable, and no opportunity is invented", async () => {
    const r = await get(world([ON, { flag: "intel_limited_live", enabled: false }]), `subjectIds=${PLACE_ID},${OTHER_ID}`);
    assert.equal(r.body.liveIntelligenceReadable, false);
    assert.deepEqual(r.body.opportunities, []);
    assert.deepEqual(r.body.refusals?.map((x) => x.reason), ["live_intelligence_unavailable", "live_intelligence_unavailable"]);
  });

  it("ON with nothing served (production's empty tables): a refusal that says the read HAPPENED", async () => {
    const r = await get(world([ON], { intel_state_snapshots: [] }), `subjectIds=${PLACE_ID}`);
    assert.equal(r.body.liveIntelligenceReadable, true);
    assert.deepEqual(r.body.opportunities, []);
    assert.equal(r.body.refusals?.[0]!.reason, "no_opportunity");
    assert.equal(r.body.refusals?.[0]!.decision, "WAIT");
    assert.ok(r.body.refusals?.[0]!.decisionReasons.includes("no_live_evidence"));
  });

  it("ON: surface=map receives four fields and nothing else; the default surface is compass", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&surface=map&relevance=saved&lat=48.8584&lng=2.2945`);
    assert.equal(r.body.surface, "map");
    assert.deepEqual(Object.keys(r.body.opportunities![0]!), ["subjectId", "kind", "relevance", "truth"]);
    const compass = await get(world([ON]), `subjectIds=${PLACE_ID}&relevance=saved&lat=48.8584&lng=2.2945`);
    assert.ok("decisionReasons" in compass.body.opportunities![0]!);
  });

  it("ON: the viewer's own attention context reaches the kernel — quiet hours are read, an unreadable preference is null", async () => {
    const quiet = await get(
      world([ON], {
        notification_preferences: [{ user_id: VIEWER, push_enabled: true, quiet_hours_enabled: true, quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC" }],
        notifications: [{ id: "n1", user_id: VIEWER, created_at: iso(-10) }],
      }),
      `subjectIds=${PLACE_ID}`,
    );
    assert.equal(quiet.body.contexts?.attention?.available, false);
    assert.equal(quiet.body.contexts?.attention?.deliveredInWindow, 1);
    const unreadable = await get(
      world([ON], { notification_preferences: { error: { message: "permission denied" } } }),
      `subjectIds=${PLACE_ID}`,
    );
    assert.equal(unreadable.body.contexts?.attention?.available, null, "an unreadable preference is never read as available");
  });

  it("ON: the contexts the caller did not supply are reported UNKNOWN, and a declared offset gives a local hour", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&utcOffsetMinutes=120`);
    assert.deepEqual(r.body.contexts?.unknown, ["trip", "social", "experience"]);
    assert.equal(typeof r.body.contexts?.temporal?.localHour, "number");
    assert.ok(r.body.contexts?.temporal?.dayPart);
    const withTrip = await get(world([ON]), `subjectIds=${PLACE_ID}&tripNextStopSubjectId=${PLACE_ID}&tripDayIndex=2`);
    assert.deepEqual(withTrip.body.contexts?.unknown, ["social", "experience"]);
  });

  it("ON: the WORLD block carries the Crowd state and the Forecast — and the forecast is PREDICTED and below the Live floor", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&horizonMinutes=90`);
    const w = r.body.contexts?.world?.[0]!;
    assert.equal(w.subjectId, PLACE_ID);
    assert.equal(w.crowd.density, "busy");
    assert.equal(w.crowd.momentum, "building");
    assert.equal(w.crowd.balance, null, "no crowd.direction claim is served: unknown, not 'holding'");
    assert.equal(w.forecastRefusal, null);
    assert.equal(w.forecast!.horizonMinutes, 90);
    assert.equal(w.forecast!.expectedDensity, "packed", "one rung from busy");
    assert.equal(w.forecast!.direction, "rising");
    assert.equal(w.forecast!.truth.truthClass, "predicted");
    assert.equal(w.forecast!.truth.confidence, "provisional", "uncalibrated: below the Live floor");
    assert.equal(w.forecast!.calibrated, false);
    assert.equal(w.forecast!.calibration, null);
    assert.equal(typeof w.forecast!.temporal.predictedFor, "string");
  });

  it("ON: a subject with no trajectory gets a NAMED forecast refusal, never a flat forecast", async () => {
    const r = await get(world([ON], { intel_state_snapshots: [snapshot(PLACE_ID)] }), `subjectIds=${PLACE_ID}`);
    const w = r.body.contexts?.world?.[0]!;
    assert.equal(w.crowd.density, "busy");
    assert.equal(w.forecast, null);
    assert.equal(w.forecastRefusal, "no_trajectory_evidence");
  });

  it("ON: a safety reading is refused as a density in the world block too, with its reason", async () => {
    const r = await get(
      world([ON], { intel_state_snapshots: [snapshot(PLACE_ID, { value: { level: "unsafe_density" } })] }),
      `subjectIds=${PLACE_ID}`,
    );
    const w = r.body.contexts?.world?.[0]!;
    assert.equal(w.crowd.density, null);
    assert.deepEqual(w.crowd.refusals, ["unsafe_density_is_a_safety_claim"]);
    assert.equal(w.forecastRefusal, "safety_level_not_forecastable");
  });

  it("ON: the place the viewer is already at is context, not an offer", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&currentSubjectId=${PLACE_ID}&currentSinceMinutes=20`);
    assert.deepEqual(r.body.opportunities, []);
    assert.deepEqual(r.body.refusals, []);
  });
});
