/**
 * Sensing §9 / §15 through the REAL route — GET /api/wall/moments behind
 * `wall_enabled` and `wall_moments_enabled` (migration 2801, seeded FALSE),
 * over the fake PostgREST double the Map gateway suites use.
 *
 * OFF is the load-bearing case: with either flag absent or false the route
 * answers feature_disabled and reads nothing. ON, a changed value is a
 * moment routed through the Attention Engine for the viewer; an unchanged
 * value is not; a sub-k previous version is never read; a missing versions
 * table is a per-subject REFUSAL, never "no moments".
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import wallMomentsRouter from "../routes/wallMoments.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const TOKEN = "wall-moments-token";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const OTHER_ID = "99999999-cccc-4ccc-8ccc-999999999999";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const WALL_ON = { flag: "wall_enabled", enabled: true };
const ON = { flag: "wall_moments_enabled", enabled: true };
const OFF = { flag: "wall_moments_enabled", enabled: false };

function snapshot(subject: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "packed" },
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
function version(subject: string, level: string, generatedMinutes: number, over: Record<string, unknown> = {}) {
  return {
    id: `ver-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject,
    zone_id: "",
    claim_type: "crowd.level",
    value: { level },
    privacy_eligible: true,
    observed_at: iso(generatedMinutes - 1),
    generated_at: iso(generatedMinutes),
    ...over,
  };
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, WALL_ON, ...flags],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }, { scope_key: "|vibe.state" }, { scope_key: "|queue.wait" }],
    intel_state_snapshots: [snapshot(PLACE_ID)],
    intel_state_snapshot_versions: [version(PLACE_ID, "busy", -40), version(PLACE_ID, "packed", -20)],
    notification_preferences: [],
    notifications: [],
    ...over,
  };
}

interface Body {
  error?: string;
  moments?: Array<{ id: string; transition: { kind: string; claimType: string; from: string | null; to: string | null }; occurredAt: string; truthClass: string; attention: { route: string; reasons: string[] } }>;
  subjects?: Array<{ subjectId: string; refusal: string | null; moments: number }>;
  viewer?: { relevance: string; available: boolean | null; notifiesInWindow: number | null };
  liveIntelligenceReadable?: boolean;
}

describe("GET /api/wall/moments", () => {
  let app: ProjectionApp | null = null;
  beforeEach(() => _clearPromotedScopeCache());
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function get(state: FakeState, query: string, token: string = TOKEN) {
    app = await startRouterApp(wallMomentsRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/wall/moments?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Body };
  }

  it("wall_moments_enabled ABSENT (production's state): feature_disabled, and nothing else is read", async () => {
    const r = await get(world([], { intel_state_snapshots: { error: { message: "must not be read" } } }), `subjectIds=${PLACE_ID}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("wall_moments_enabled FALSE: identical; wall_enabled FALSE with moments ON: still disabled — the master gate holds", async () => {
    assert.equal((await get(world([OFF]), `subjectIds=${PLACE_ID}`)).body.error, "feature_disabled");
    assert.equal((await get(world([ON, { flag: "wall_enabled", enabled: false }]), `subjectIds=${PLACE_ID}`)).body.error, "feature_disabled");
  });
  it("unauthenticated is refused; a malformed subject list is invalid_payload", async () => {
    assert.equal((await get(world([ON]), `subjectIds=${PLACE_ID}`, "stranger")).status, 401);
    assert.equal((await get(world([ON]), `subjectIds=not-a-uuid`)).body.error, "invalid_payload");
  });

  it("ON: a changed value is a moment with its transition, occurred_at, truth and an attention route for this viewer", async () => {
    const r = await get(world([ON]), `subjectIds=${PLACE_ID}&relevance=saved`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.moments?.length, 1);
    const m = r.body.moments![0]!;
    assert.deepEqual(m.transition, { kind: "crowd_shift", claimType: "crowd.level", from: "busy", to: "packed" });
    assert.equal(m.occurredAt, iso(-20));
    assert.equal(m.truthClass, "corroborated");
    assert.equal(m.attention.route, "WALL"); // urgency 0.5 < the NOTIFY floor
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: null, moments: 1 }]);
    assert.equal(r.body.viewer?.available, true, "no preferences row ⇒ defaults, readable");
    assert.equal(r.body.viewer?.notifiesInWindow, 0);
    assert.doesNotMatch(JSON.stringify(r.body), /distinct_actors|actor_id|latitude|longitude|privacy_eligible/);
  });
  it("ON: an UNCHANGED value is not a moment", async () => {
    const r = await get(world([ON], { intel_state_snapshot_versions: [version(PLACE_ID, "packed", -40), version(PLACE_ID, "packed", -20)] }), `subjectIds=${PLACE_ID}`);
    assert.deepEqual(r.body.moments, []);
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: null, moments: 0 }]);
  });
  it("ON: a safety activation for a saved place is NOTIFY even in quiet hours; the moment the viewer has seen is IGNORE", async () => {
    const state = world([ON], {
      intel_state_snapshots: [snapshot(PLACE_ID, { value: { level: "unsafe_density" } })],
      intel_state_snapshot_versions: [version(PLACE_ID, "packed", -30), version(PLACE_ID, "unsafe_density", -6)],
      notification_preferences: [{ user_id: VIEWER, push_enabled: true, quiet_hours_enabled: true, quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC" }],
    });
    const r = await get(state, `subjectIds=${PLACE_ID}&relevance=saved`);
    assert.equal(r.body.viewer?.available, false, "quiet hours");
    assert.equal(r.body.moments![0]!.transition.kind, "safety_notice_activated");
    assert.equal(r.body.moments![0]!.attention.route, "NOTIFY");
    assert.deepEqual(r.body.moments![0]!.attention.reasons, ["safety_override"]);
    const seen = await get(state, `subjectIds=${PLACE_ID}&relevance=saved&seen=${encodeURIComponent(r.body.moments![0]!.id)}`);
    assert.equal(seen.body.moments![0]!.attention.route, "IGNORE");
  });
  it("ON: an urgent change for a saved place is NOTIFY when available and within budget; the budget is the hour's delivered notifications", async () => {
    const state = world([ON], {
      intel_state_snapshots: [snapshot(PLACE_ID, { claim_type: "crowd.trajectory", value: { trajectory: "peaking" } })],
      intel_state_snapshot_versions: [version(PLACE_ID, "building", -30, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }), version(PLACE_ID, "peaking", -6, { claim_type: "crowd.trajectory", value: { trajectory: "peaking" } })],
      notifications: [
        { id: "n1", user_id: VIEWER, created_at: iso(-10) },
        { id: "n2", user_id: VIEWER, created_at: iso(-20) },
        { id: "n3", user_id: VIEWER, created_at: iso(-30) },
        { id: "old", user_id: VIEWER, created_at: iso(-120) },
      ],
    });
    const r = await get(state, `subjectIds=${PLACE_ID}&relevance=saved`);
    assert.equal(r.body.viewer?.notifiesInWindow, 3);
    assert.equal(r.body.moments![0]!.transition.kind, "peaking");
    assert.equal(r.body.moments![0]!.attention.route, "WALL");
    assert.deepEqual(r.body.moments![0]!.attention.reasons, ["budget_exhausted_deferred_to_wall"]);
  });
  it("ON: a sub-k previous version is never read — without an eligible previous there is no change on record", async () => {
    const r = await get(world([ON], { intel_state_snapshot_versions: [version(PLACE_ID, "busy", -40, { privacy_eligible: false })] }), `subjectIds=${PLACE_ID}`);
    assert.deepEqual(r.body.moments, []);
  });
  it("ON: the versions table missing is a per-subject REFUSAL, never 'no moments'", async () => {
    const r = await get(world([ON], { intel_state_snapshot_versions: { error: { message: 'relation "public.intel_state_snapshot_versions" does not exist' } } }), `subjectIds=${PLACE_ID}`);
    assert.deepEqual(r.body.moments, []);
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: "versions_unavailable", moments: 0 }]);
  });
  it("ON but the Live pilot CLOSED: every subject refused with live_intelligence_unavailable", async () => {
    const r = await get(world([ON, { flag: "intel_limited_live", enabled: false }]), `subjectIds=${PLACE_ID},${OTHER_ID}`);
    assert.equal(r.body.liveIntelligenceReadable, false);
    assert.deepEqual(r.body.subjects?.map((s) => s.refusal), ["live_intelligence_unavailable", "live_intelligence_unavailable"]);
  });
  it("ON with nothing served for a place (production's empty tables): no moments and no refusal — the read happened", async () => {
    const r = await get(world([ON], { intel_state_snapshots: [] }), `subjectIds=${PLACE_ID}`);
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: null, moments: 0 }]);
  });
});
