/**
 * Sensing §10 through the REAL route — GET /api/compass/decision behind
 * `compass_decision_enabled` (migration 2800, seeded FALSE), over the same
 * fake PostgREST double the Map gateway suites use.
 *
 * The OFF case is the load-bearing one: with the flag absent (production's
 * state) or false the route answers feature_disabled and reads no place and
 * no claim. ON, it answers a §10 decision from the claims the ONE read path
 * serves, with its grounding; with the Live pilot closed it answers WAIT and
 * says the intelligence was unavailable rather than inventing a reading.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import compassDecisionRouter from "../routes/compassDecision.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const TOKEN = "compass-decision-token";
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

function snapshot(subject: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
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
    places: [
      { id: PLACE_ID, name: "Han Market", latitude: 16.0678, longitude: 108.2208, status: "active" },
      { id: OTHER_ID, name: "Dragon Bridge", latitude: 16.0611, longitude: 108.2272, status: "active" },
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: [snapshot(PLACE_ID)],
    ...over,
  };
}
/** The wire shape this suite reads back — typed so a fixture cannot drift from the route. */
interface DecisionBody {
  ok?: boolean;
  error?: string;
  decision?: string;
  reasons?: string[];
  grounding?: { truthClass: string; confidence: string; coverage: string; freshness: string };
  summary?: string;
  interception?: { reachable: boolean | null; marginMinutes: number | null };
  switchingCost?: { applied: boolean; currentValue: number | null; candidateValue: number | null };
  candidate?: { live: boolean; crowdLevel: string | null };
  current?: { live: boolean; crowdLevel: string | null } | null;
  liveIntelligenceReadable?: boolean;
}

const ON = { flag: "compass_decision_enabled", enabled: true };
const OFF = { flag: "compass_decision_enabled", enabled: false };

describe("GET /api/compass/decision", () => {
  let app: ProjectionApp | null = null;
  beforeEach(() => _clearPromotedScopeCache());
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function get(state: FakeState, query: string, token: string = TOKEN) {
    app = await startRouterApp(compassDecisionRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/compass/decision?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as DecisionBody };
  }

  it("flag ABSENT (production's state): feature_disabled, and no place or claim is read", async () => {
    const state = world([], { places: { error: { message: "must not be read" } }, intel_state_snapshots: { error: { message: "must not be read" } } });
    const r = await get(state, `subjectId=${PLACE_ID}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("flag FALSE (2800 applied, nothing flipped): identical", async () => {
    const r = await get(world([OFF]), `subjectId=${PLACE_ID}`);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("an UNREADABLE feature_flags table is OFF (fail-closed)", async () => {
    const r = await get(world([ON], { feature_flags: { error: { message: "boom" } } }), `subjectId=${PLACE_ID}`);
    assert.equal(r.body.error, "feature_disabled");
  });
  it("unauthenticated is refused before anything else", async () => {
    const r = await get(world([ON]), `subjectId=${PLACE_ID}`, "stranger");
    assert.equal(r.status, 401);
  });
  it("a malformed query is invalid_payload; an unknown place is not_found", async () => {
    assert.equal((await get(world([ON]), `subjectId=not-a-uuid`)).body.error, "invalid_payload");
    assert.equal((await get(world([ON]), `subjectId=11111111-1111-4111-8111-111111111111`)).body.error, "not_found");
  });

  it("ON: a live, reachable, compatible place is GO NOW, with §5.1 grounding and the interception margin", async () => {
    const r = await get(world([ON]), `subjectId=${PLACE_ID}&intent=social&etaMinutes=10`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.decision, "GO_NOW");
    assert.deepEqual(r.body.reasons, ["live_reachable_compatible"]);
    // source_count 30 ⇒ the read path's "several" bucket ⇒ corroborated.
    assert.equal(r.body.grounding?.truthClass, "corroborated");
    assert.equal(r.body.grounding?.coverage, "several");
    assert.equal(r.body.grounding?.confidence, "live");
    assert.equal(r.body.interception?.reachable, true);
    assert.equal(r.body.liveIntelligenceReadable, true);
    assert.match(r.body.summary ?? "", /^Go now\. Crowd busy \(corroborated by several, live\)\./);
    // Nothing person-shaped: no contributor, no coordinate, no count on the wire.
    const text = JSON.stringify(r.body);
    assert.doesNotMatch(text, /distinct_actors|actor_id|latitude|longitude/);
  });
  it("ON: a walking ETA from the viewer's position decides interception when the client sends none", async () => {
    // ~15 km away at 5 km/h ≈ 180 min > the +27 min horizon.
    const r = await get(world([ON]), `subjectId=${PLACE_ID}&intent=social&lat=16.2&lng=108.2`);
    assert.equal(r.body.decision, "WAIT");
    assert.deepEqual(r.body.reasons, ["window_may_decay_before_arrival"]);
    assert.equal(r.body.interception?.reachable, false);
  });
  it("ON: a Live unsafe_density reading is SKIP — safety outranks the opportunity", async () => {
    const r = await get(world([ON], { intel_state_snapshots: [snapshot(PLACE_ID, { value: { level: "unsafe_density" } })] }), `subjectId=${PLACE_ID}&intent=high_energy&etaMinutes=1`);
    assert.equal(r.body.decision, "SKIP");
    assert.deepEqual(r.body.reasons, ["safety_outranks_opportunity"]);
  });
  it("ON: the current experience is read through the same seam, and a switch that does not clear the cost is STAY", async () => {
    const state = world([ON], { intel_state_snapshots: [snapshot(PLACE_ID, { value: { level: "moderate" } }), snapshot(OTHER_ID, { value: { level: "busy" } })] });
    const r = await get(state, `subjectId=${PLACE_ID}&intent=social&etaMinutes=5&currentSubjectId=${OTHER_ID}&currentSinceMinutes=20`);
    assert.equal(r.body.decision, "STAY");
    assert.deepEqual(r.body.reasons, ["switching_cost_not_exceeded"]);
    assert.equal(r.body.switchingCost?.applied, true);
    assert.equal(r.body.current?.crowdLevel, "busy");
  });
  it("ON but the Live pilot CLOSED (intel_limited_live false): WAIT with live_intelligence_unavailable — no reading is invented", async () => {
    const r = await get(world([ON, { flag: "intel_limited_live", enabled: false }]), `subjectId=${PLACE_ID}&intent=social&etaMinutes=5`);
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, "WAIT");
    assert.deepEqual(r.body.reasons, ["live_intelligence_unavailable"]);
    assert.equal(r.body.liveIntelligenceReadable, false);
    assert.equal(r.body.grounding?.truthClass, "unknown");
  });
  it("ON with the gates open and NOTHING served for this place (production's empty tables): WAIT with no_live_evidence", async () => {
    const r = await get(world([ON], { intel_state_snapshots: [] }), `subjectId=${PLACE_ID}&intent=social&etaMinutes=5`);
    assert.equal(r.body.decision, "WAIT");
    assert.deepEqual(r.body.reasons, ["no_live_evidence"]);
  });
});
