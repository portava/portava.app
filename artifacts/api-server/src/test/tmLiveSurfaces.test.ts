/**
 * Testing-mode lane TM-live (WP-11) — the server half of the live decision
 * surfaces this lane put on screen.
 *
 * Every surface below renders a server answer about the world or about the
 * viewer's own day. The rule each one has to obey before it is worth
 * rendering is DV-83's: a read that FAILED is never served as an empty or a
 * complete answer. The live-claim read (lib/liveClaimRead) already MARKS a
 * failed read (`liveClaimReadFailed`, census-discovery §94) while still
 * handing every caller `[]`; the consumers below did not ask, so each turned
 * "the snapshot table could not be read" into "we looked and nothing is live":
 *
 *   WALL-F13  /wall/moments        a failed current read was `refusal: null, moments: 0`
 *   COMP-F15  /compass/decision    WAIT `no_live_evidence`, `liveIntelligenceReadable: true`
 *   SEN-F07   /intel/opportunities `no_opportunity` (and from-opportunity 409 `no_opportunity`)
 *   SEN-F08   /v1/experiences/:id/live-state   `state: unknown`, indistinguishable from silence
 *
 * and two reads/writes on the viewer's own day:
 *
 *   COMP-F11  /compass/sense/nudges  a failed nudge read answered `nudges: []`
 *   COMP-F14  /daily-brief/dismiss   a failed dismissal write answered `{ ok: true }`,
 *             and a dismissed recommendation came back on the next GET
 *
 * Each failure case is paired with the healthy twin that must still serve.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tmLiveSurfaces.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import wallMomentsRouter from "../routes/wallMoments.js";
import compassDecisionRouter from "../routes/compassDecision.js";
import opportunitiesRouter from "../routes/opportunities.js";
import experienceSessionsRouter from "../routes/experienceSessions.js";
import intelReadModelsRouter from "../routes/intelReadModels.js";
import compassSenseRouter from "../routes/compassSense.js";
import dailyBriefRouter from "../routes/dailyBrief.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const TOKEN = "tm-live-token";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const SNAPSHOT_READ_FAILED = { error: { message: "canceling statement due to statement timeout" } };

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

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

function world(flags: { flag: string; enabled: boolean }[], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }, { scope_key: "|vibe.state" }, { scope_key: "|queue.wait" }],
    intel_state_snapshots: [snapshot(PLACE_ID)],
    intel_state_snapshot_versions: [],
    intel_historical_patterns: [],
    places: [{ id: PLACE_ID, name: "Han Market", latitude: 16.0678, longitude: 108.2208, status: "active", merged_into_place_id: null }],
    notification_preferences: [],
    notifications: [],
    canonical_events: [],
    ...over,
  };
}

let app: ProjectionApp | null = null;
beforeEach(() => _clearPromotedScopeCache());
afterEach(async () => { if (app) await app.close(); app = null; });

async function call(router: express.Router, state: FakeState, method: "GET" | "POST", path: string, body?: unknown) {
  app = await startRouterApp(router, state, { token: TOKEN, userId: VIEWER });
  const r = await fetch(`${app.baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

// ── WALL-F13 ─────────────────────────────────────────────────────────────────

describe("WALL-F13 GET /wall/moments — a failed current read is a refusal, not 'no moments'", () => {
  const ON = [{ flag: "wall_enabled", enabled: true }, { flag: "wall_moments_enabled", enabled: true }];
  it("healthy: a subject with nothing that changed is `refusal: null`", async () => {
    const r = await call(wallMomentsRouter, world(ON), "GET", `/wall/moments?subjectIds=${PLACE_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: null, moments: 0 }]);
  });
  it("the snapshot read FAILED: the subject is refused `error`, never counted as looked-at", async () => {
    const r = await call(wallMomentsRouter, world(ON, { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "GET", `/wall/moments?subjectIds=${PLACE_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.subjects, [{ subjectId: PLACE_ID, refusal: "error", moments: 0 }]);
    assert.deepEqual(r.body.moments, []);
  });
});

// ── COMP-F15 ─────────────────────────────────────────────────────────────────

describe("COMP-F15 GET /compass/decision — a failed live read is 'could not look', not 'no evidence'", () => {
  const ON = [{ flag: "compass_decision_enabled", enabled: true }];
  it("healthy: the live read is readable and the decision rests on it", async () => {
    const r = await call(compassDecisionRouter, world(ON), "GET", `/compass/decision?subjectId=${PLACE_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.liveIntelligenceReadable, true);
    assert.ok(!r.body.reasons.includes("live_intelligence_unavailable"));
  });
  it("the snapshot read FAILED: WAIT, `live_intelligence_unavailable`, and the answer says it could not read", async () => {
    const r = await call(compassDecisionRouter, world(ON, { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "GET", `/compass/decision?subjectId=${PLACE_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.decision, "WAIT");
    assert.ok(r.body.reasons.includes("live_intelligence_unavailable"), JSON.stringify(r.body.reasons));
    assert.ok(!r.body.reasons.includes("no_live_evidence"), "a failed read is not an absence of evidence");
    assert.equal(r.body.liveIntelligenceReadable, false);
  });
});

// ── SEN-F07 ──────────────────────────────────────────────────────────────────

describe("SEN-F07 opportunities and the from-opportunity bridge — a failed read is not 'no opportunity'", () => {
  const ON = [{ flag: "opportunity_engine_enabled", enabled: true }, { flag: "experience_session_enabled", enabled: true }];
  it("GET /intel/opportunities: a failed read refuses the subject `live_intelligence_unavailable`", async () => {
    const r = await call(opportunitiesRouter, world(ON, { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "GET", `/intel/opportunities?subjectIds=${PLACE_ID}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.opportunities, []);
    assert.equal(r.body.refusals[0]?.reason, "live_intelligence_unavailable");
  });
  it("POST from-opportunity: a failed read is 409 `live_intelligence_unavailable` and opens nothing", async () => {
    const r = await call(experienceSessionsRouter, world(ON, { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "POST", "/intel/experience-sessions/from-opportunity", { subjectId: PLACE_ID });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.reason, "live_intelligence_unavailable");
  });
});

// ── SEN-F08 ──────────────────────────────────────────────────────────────────

describe("SEN-F08 GET /v1/experiences/:id/live-state — a failed live read is marked", () => {
  it("healthy: `live_read_failed: false`", async () => {
    const r = await call(intelReadModelsRouter, world([]), "GET", `/v1/experiences/${PLACE_ID}/live-state`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.live_read_failed, false);
  });
  it("the snapshot read FAILED: `live_read_failed: true`, so `unknown` is not silence", async () => {
    const r = await call(intelReadModelsRouter, world([], { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "GET", `/v1/experiences/${PLACE_ID}/live-state`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "unknown");
    assert.equal(r.body.live_read_failed, true);
  });
  it("a failed read does not share an ETag with a real `unknown` (a 304 must not serve the wrong body)", async () => {
    const ok = await call(intelReadModelsRouter, world([], { intel_state_snapshots: [] }), "GET", `/v1/experiences/${PLACE_ID}/live-state`);
    const failed = await call(intelReadModelsRouter, world([], { intel_state_snapshots: SNAPSHOT_READ_FAILED }), "GET", `/v1/experiences/${PLACE_ID}/live-state`);
    assert.equal(ok.body.state, "unknown");
    assert.notEqual(ok.body.state_version, failed.body.state_version);
  });
});

// ── helpers for the two routes on the viewer's own day ───────────────────────

function listen(router: express.Router): Promise<{ base: string; close: () => Promise<void> }> {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  a.use("/api", router);
  return new Promise((resolve) => {
    const srv = http.createServer(a);
    srv.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(srv.address() as any).port}`;
      resolve({ base, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) });
    });
  });
}
async function send(base: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
/** failClosedSupabase has no `.like()`; Compass's flag read uses one. A no-op here reads every flag row. */
function withLike(c: any): any {
  const orig = c.from.bind(c);
  c.from = (t: string) => { const b = orig(t); b.like = () => b; return b; };
  return c;
}

// ── COMP-F11 ─────────────────────────────────────────────────────────────────

describe("COMP-F11 GET /compass/sense/nudges — a failed read is not 'no nudges'", () => {
  let srv: { base: string; close: () => Promise<void> } | null = null;
  beforeEach(() => invalidateFlagsCache());
  afterEach(async () => { if (srv) await srv.close(); srv = null; invalidateFlagsCache(); });
  const NUDGE = { id: "n1", user_id: VIEWER, nudge_type: "leave_earlier", category: "plans", title: "Leave now", body: "Traffic", action_url: null, confidence: 0.8, created_at: iso(-10) };

  it("healthy: the viewer's recent nudges", async () => {
    _setTestClient(withLike(makeFailClosedClient({ users: { [TOKEN]: VIEWER }, rows: { feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }], compass_sense_nudges: [NUDGE] } })), true);
    srv = await listen(compassSenseRouter);
    const r = await send(srv.base, "GET", "/compass/sense/nudges");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.nudges.length, 1);
    assert.equal(r.body.nudges[0].title, "Leave now");
  });
  it("the nudge read FAILED: an error status, never `nudges: []`", async () => {
    _setTestClient(withLike(makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: { feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }] },
      failOn: (ctx) => (ctx.table === "compass_sense_nudges" ? { message: "relation is locked", code: "55P03" } : null),
    })), true);
    srv = await listen(compassSenseRouter);
    const r = await send(srv.base, "GET", "/compass/sense/nudges");
    assert.ok(r.status >= 500, `expected a 5xx, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.nudges, undefined);
  });
});

// ── COMP-F14 ─────────────────────────────────────────────────────────────────

describe("COMP-F14 daily brief — a dismissal is recorded or refused, and a recorded one stays dismissed", () => {
  const TRIP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let srv: { base: string; close: () => Promise<void> } | null = null;
  afterEach(async () => { if (srv) await srv.close(); srv = null; });
  // Each case its own brief date: the route's L1 cache is module state keyed per user per day.
  const brief = (date: string) => ({
    briefType: "trip", date, summaryText: "Two ideas", activeTripId: null, destination: "Hoi An",
    suggestions: [
      { id: "rec_culture", title: "Old Town walk", category: "culture", reason: "x", estimatedTime: "1h", priceLevel: "$" },
      { id: "rec_food_market", title: "Night market", category: "food", reason: "y", estimatedTime: "1h", priceLevel: "$" },
    ],
    quickActions: [{ id: "qa_plan", label: "View plan", kind: "view_plan" }],
  });
  const stored = (date: string) => ({ user_id: VIEWER, brief_date: date, brief_json: JSON.stringify(brief(date)), generated_at: `${date}T06:00:00.000Z` });
  const member = { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" };

  it("a dismissal whose write FAILED is refused, not reported as dismissed", async () => {
    _setTestClient(makeFailClosedClient({
      users: { [TOKEN]: VIEWER }, rows: { trip_members: [member] },
      failWritesOn: (t) => (t === "user_preference_events" ? { message: "disk full", code: "53100" } : null),
    }), true);
    srv = await listen(dailyBriefRouter);
    const r = await send(srv.base, "POST", `/trips/${TRIP}/daily-brief/dismiss/rec_culture`, { category: "culture" });
    assert.ok(r.status >= 500, `expected a 5xx, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body.ok, true);
  });
  it("a recorded dismissal: 200, and the write names the recommendation", async () => {
    const inserted: Record<string, any[]> = {};
    _setTestClient(makeFailClosedClient({ users: { [TOKEN]: VIEWER }, rows: { trip_members: [member] }, inserted }), true);
    srv = await listen(dailyBriefRouter);
    const r = await send(srv.base, "POST", `/trips/${TRIP}/daily-brief/dismiss/rec_culture`, { category: "culture" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dismissed, "rec_culture");
    assert.equal(inserted.user_preference_events?.[0]?.recommendation_id, "rec_culture");
  });
  it("GET after a dismissal that day omits it; one dismissed on another day does not hide today's", async () => {
    const date = "2026-09-20";
    _setTestClient(makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: {
        trip_members: [member], daily_briefs: [stored(date)],
        user_preference_events: [
          { user_id: VIEWER, trip_id: TRIP, recommendation_id: "rec_culture", signal: "dismiss", created_at: `${date}T09:00:00.000Z` },
          { user_id: VIEWER, trip_id: TRIP, recommendation_id: "rec_food_market", signal: "dismiss", created_at: "2026-09-19T09:00:00.000Z" },
        ],
      },
    }), true);
    srv = await listen(dailyBriefRouter);
    const r = await send(srv.base, "GET", `/trips/${TRIP}/daily-brief?date=${date}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.brief.suggestions.map((s: any) => s.id), ["rec_food_market"]);
    assert.equal(r.body.brief.dismissalsApplied, true);
  });
  it("GET when the dismissal read FAILED: the brief is served whole and says its dismissals were not applied", async () => {
    const date = "2026-09-21";
    _setTestClient(makeFailClosedClient({
      users: { [TOKEN]: VIEWER },
      rows: { trip_members: [member], daily_briefs: [stored(date)] },
      failOn: (ctx) => (ctx.table === "user_preference_events" ? { message: "timeout", code: "57014" } : null),
    }), true);
    srv = await listen(dailyBriefRouter);
    const r = await send(srv.base, "GET", `/trips/${TRIP}/daily-brief?date=${date}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.brief.suggestions.length, 2);
    assert.equal(r.body.brief.dismissalsApplied, false);
  });
});
