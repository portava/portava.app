/**
 * CX-15 / S54 — `ExperienceSession` bridges OPPORTUNITY → ACTION → OUTCOME
 * without being a tracking history.
 *
 * ── WHAT THE CENSUS FOUND, AND WHAT THIS SUITE PINS ──────────────────────────
 * CX-15 (`docs/architecture/census-compass.md:122`) read:
 *
 *   "An equivalent exists under another name and a narrower scope:
 *    `compass/CompassOutcomeEngine.ts` ties recommended → viewed → saved → went
 *    → stayed → liked → invited → made_memory → returned back to
 *    `compass_served_recommendations`. It bridges a *recommendation* to an
 *    outcome, not a *world opportunity*; nothing outside Compass can start one."
 *
 * Two defects, pinned separately here.
 *
 *   1. SCOPE. The bridge must start from the PLATFORM's world opportunity —
 *      `lib/opportunityEngine.OpportunityProjection`, the §5/§6 stage's own
 *      output, served by `routes/opportunities.ts` — and not from a kind a
 *      caller merely asserts. `openSessionForOpportunity` derives the subject,
 *      the kind and the claim refs FROM the projection, stamps
 *      `origin: "world_opportunity"`, and bounds the session by the
 *      opportunity's own §18.2 window. `origin: "world_opportunity"` cannot be
 *      self-asserted through the declared path.
 *
 *   2. REACH. `POST /api/intel/experience-sessions/from-opportunity` is the
 *      public, non-Compass seam. It never takes the caller's word for the
 *      opportunity: it re-derives it server-side through the context kernel and
 *      the opportunity engine, and REFUSES a subject the viewer may not act on
 *      — a §20 safety-suppressed subject is 403 and writes nothing.
 *
 * ── AND THE CONSTRAINT THAT IS HALF THE REQUIREMENT ──────────────────────────
 * S54: *"It is not a raw tracking history."* The bridge is a live window over
 * ONE current experience, not a durable log of everywhere a person has been.
 * Pinned here as NON-ACCUMULATION at the seam: after sessions over three
 * different subjects are opened and CLOSED, and after one EXPIRES, no route
 * this module registers returns any of those subjects — the module registers no
 * list, no history and no by-subject route at all, and `GET …/open` answers
 * null. A session's life is additionally bounded by the opportunity's own
 * window, so the bridge cannot be used to hold a long-lived marker on a place.
 *
 * NOTE (reported, not closable here): `canonical_events` is append-only by
 * construction (migration 2120 blocks UPDATE/DELETE/TRUNCATE by trigger), so
 * the underlying rows persist. Non-accumulation is therefore a property of the
 * READ SEAM — no query in `lib/experienceSessionStore` or in this router can
 * reach further back than one session lifetime, and none is by-subject — not of
 * the storage layer. That boundary is what this suite pins.
 *
 * ── TEST-FIRST ───────────────────────────────────────────────────────────────
 * Written before the implementation and watched fail for the right reason:
 * `openSessionForOpportunity` did not exist, the envelope had no `origin`, and
 * `POST /intel/experience-sessions/from-opportunity` 404'd.
 *
 * ── MUTATION LOG (each applied ALONE, suite re-run, source restored) ──────────
 * Baseline: 17 pass / 0 fail.
 *   M1 THE OPPORTUNITY ORIGIN DROPPED — `openSessionForOpportunity` stamps
 *      `compass_recommendation` instead of `world_opportunity`, so only a
 *      recommendation ever bridges                    → RED (14 pass / 3 fail)
 *   M2 THE OUTSIDE-COMPASS ENTRY POINT'S AUTHORIZATION REMOVED — the
 *      from-opportunity route stops refusing when the engine produced no
 *      projection and fabricates one over the caller's subject, so a
 *      safety-suppressed subject opens a session       → RED (14 pass / 3 fail)
 *   M3 `requireUser` dropped from the from-opportunity seam (flag gate kept),
 *      so an anonymous caller opens a session          → RED (13 pass / 4 fail)
 *   M4 THE NON-ACCUMULATION BOUNDARY REMOVED — `sessionState` never reports
 *      `expired`, so a session stays live past its window and keeps naming its
 *      subject on the wire                             → RED (16 pass / 1 fail)
 *   M5 the opportunity-window bound removed — the session takes the caller's
 *      hours and may outlive the opportunity it bridges → RED (15 pass / 2 fail)
 * No mutation came back green; none was discarded.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import experienceSessionsRouter from "../routes/experienceSessions.js";
import { _setTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import {
  DEFAULT_SESSION_HOURS,
  EXPERIENCE_SESSION_PAYLOAD_KEY,
  MAX_SESSION_HOURS,
  SESSION_OPEN_VERB,
  SESSION_ORIGINS,
  closeExperienceSession,
  openExperienceSession,
  openSessionForOpportunity,
  sessionForbiddenKeys,
  sessionState,
  type ExperienceSessionEnvelope,
} from "../lib/experienceSession.js";
import { opportunityWorldValueKeys, type OpportunityProjection } from "../lib/opportunityEngine.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "88888888-aaaa-4aaa-8aaa-888888888888";
const TOKEN = "experience-bridge-token";
const PLACE_A = "aaaaaaa1-bbbb-4bbb-8bbb-aaaaaaaaaaa1";
const PLACE_B = "aaaaaaa2-bbbb-4bbb-8bbb-aaaaaaaaaaa2";
const PLACE_C = "aaaaaaa3-bbbb-4bbb-8bbb-aaaaaaaaaaa3";
const SESSION_ID = "99999999-cccc-4ccc-8ccc-999999999999";
const ACTOR = VIEWER;

const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

// ── The pure half: a real OpportunityProjection, the §5/§6 stage's own output ──

function projection(over: Partial<OpportunityProjection> = {}): OpportunityProjection {
  return {
    subjectId: PLACE_A,
    kind: "go_now",
    relevance: 0.72,
    reasons: ["live_reading", "intent_compatible"],
    decision: "GO_NOW",
    decisionReasons: ["live_evidence"] as never,
    window: {
      observedAt: iso(-3),
      effectiveFrom: iso(-3),
      effectiveUntil: iso(27),
      expiresAt: iso(27),
      freshness: "fresh" as never,
      predictedFor: null,
    },
    truth: {
      truthClass: "corroborated",
      confidenceBand: "high",
      sourceClass: "firsthand_unverified",
      conflictState: "none",
    } as never,
    reachable: true,
    claimRefs: ["snap-a-1", "snap-a-2"],
    ...over,
  } as OpportunityProjection;
}

describe("CX-15 · S54 — the bridge starts from a WORLD OPPORTUNITY, not a recommendation", () => {
  it("derives subject, kind and claim refs FROM the projection — the caller cannot name its own", () => {
    const opp = projection();
    const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: opp }, NOW);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.envelope.origin, "world_opportunity");
    assert.equal(r.envelope.subject_id, PLACE_A, "the subject is the opportunity's");
    assert.equal(r.envelope.opportunity_kind, "go_now", "the kind is the engine's verdict");
    assert.deepEqual(r.envelope.claim_refs, ["snap-a-1", "snap-a-2"], "the claims the opportunity rested on");
    assert.equal(r.envelope.opportunity_decision, "GO_NOW");
    assert.equal(r.envelope.opportunity_valid_until, iso(27));
    // ACTION: the opening event is the spine's own verb, one subject, bounded.
    assert.equal(r.event.verb, SESSION_OPEN_VERB);
    assert.equal(r.event.subjectId, PLACE_A);
    assert.equal(r.event.actorId, ACTOR);
    assert.ok(r.event.expiresAt, "the opening event itself carries the bound");
  });

  it("`world_opportunity` cannot be SELF-ASSERTED through the declared path", () => {
    const declared = openExperienceSession(
      ACTOR,
      { sessionId: SESSION_ID, subjectId: PLACE_A, opportunityKind: "go_now", claimRefs: [] },
      NOW,
    );
    assert.ok(declared.ok);
    assert.equal(declared.envelope.origin, "declared", "a kind a caller asserted is not a world opportunity");

    const claimed = openExperienceSession(
      ACTOR,
      { sessionId: SESSION_ID, subjectId: PLACE_A, opportunityKind: "go_now", claimRefs: [], origin: "world_opportunity" as never },
      NOW,
    );
    assert.equal(claimed.ok, false);
    assert.equal(claimed.ok === false && claimed.refusal, "origin_not_earned");

    // Compass's own origin stays expressible — the bridge is origin-plural, and
    // a Compass recommendation is ONE origin rather than the only one (CX-15).
    const compass = openExperienceSession(
      ACTOR,
      { sessionId: SESSION_ID, subjectId: PLACE_A, opportunityKind: "go_now", claimRefs: [], origin: "compass_recommendation" },
      NOW,
    );
    assert.ok(compass.ok);
    assert.equal(compass.envelope.origin, "compass_recommendation");
    assert.deepEqual([...SESSION_ORIGINS].sort(), ["compass_recommendation", "declared", "world_opportunity"]);
  });

  it("the session may not OUTLIVE the opportunity it bridges — a bridge, not a marker on a place", () => {
    // The fixture's opportunity is good for 27 minutes; the default session life
    // is hours. The shorter of the two wins, unasked.
    const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: projection(), hours: MAX_SESSION_HOURS }, NOW);
    assert.ok(r.ok);
    assert.equal(Date.parse(r.envelope.expires_at), Date.parse(iso(27)));
    assert.ok(
      Date.parse(r.envelope.expires_at) < NOW + DEFAULT_SESSION_HOURS * 3_600_000,
      "the opportunity's window, not the session default, is the bound",
    );
    // An opportunity with NO window end still cannot be unbounded.
    const noWindow = openSessionForOpportunity(
      ACTOR,
      { sessionId: SESSION_ID, opportunity: projection({ window: { ...projection().window, expiresAt: null } }) },
      NOW,
    );
    assert.ok(noWindow.ok);
    assert.equal(Date.parse(noWindow.envelope.expires_at), NOW + DEFAULT_SESSION_HOURS * 3_600_000);
  });

  it("an opportunity whose window has already PASSED is not a bridge", () => {
    const stale = projection({ window: { ...projection().window, expiresAt: iso(-1) } });
    const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: stale }, NOW);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "opportunity_window_passed");
  });

  it("a malformed projection is refused rather than coerced into a bridge", () => {
    for (const bad of [
      projection({ subjectId: "" }),
      projection({ kind: "wandering" as never }),
      projection({ claimRefs: [1] as never }),
      null,
      { subjectId: PLACE_A },
    ]) {
      const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: bad as never }, NOW);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.ok === false && r.refusal, "not_an_opportunity");
    }
  });

  it("an opportunity carrying a WORLD VALUE is never turned into a durable envelope (§5)", () => {
    const leaky = projection({ truth: { density: "busy" } as never });
    assert.ok(opportunityWorldValueKeys(leaky).length > 0, "the fixture really is leaky");
    const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: leaky }, NOW);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "opportunity_claims_world_truth");
  });

  it("the bridged envelope carries NO trail key and NO coordinate, at any depth", () => {
    const r = openSessionForOpportunity(ACTOR, { sessionId: SESSION_ID, opportunity: projection() }, NOW);
    assert.ok(r.ok);
    assert.deepEqual(sessionForbiddenKeys(r.envelope), []);
    assert.deepEqual(sessionForbiddenKeys(r.event.payload ?? {}), []);
    // …and it still closes with the OUTCOME's own existing verb: the third arrow.
    const closed = closeExperienceSession(r.envelope, ACTOR, { outcome: "better" }, NOW + 60_000);
    assert.ok(closed.ok);
    assert.equal(closed.envelope.origin, "world_opportunity", "the origin survives the close");
    assert.equal(closed.envelope.outcome, "better");
    assert.deepEqual(sessionForbiddenKeys(closed.envelope), []);
  });
});

// ── The reachable half: the public, non-Compass seam ──────────────────────────

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const ON = { flag: "experience_session_enabled", enabled: true };
const OFF = { flag: "experience_session_enabled", enabled: false };

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
    intel_live_promoted_scopes: [
      { scope_key: "|crowd.level" },
      { scope_key: "|crowd.trajectory" },
      { scope_key: "|vibe.state" },
      { scope_key: "|queue.wait" },
    ],
    intel_state_snapshots: [
      snapshot(PLACE_A),
      snapshot(PLACE_A, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
      snapshot(PLACE_B),
      snapshot(PLACE_B, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
      snapshot(PLACE_C),
      snapshot(PLACE_C, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
    ],
    places: [
      { id: PLACE_A, latitude: 48.8584, longitude: 2.2945 },
      { id: PLACE_B, latitude: 48.86, longitude: 2.3 },
      { id: PLACE_C, latitude: 48.87, longitude: 2.31 },
    ],
    notification_preferences: [],
    notifications: [],
    canonical_events: [],
    ...over,
  };
}

interface Stored {
  rows: Array<Record<string, any>>;
}

/** Record inserts into `canonical_events` and serve them back on the next read. */
function writableEvents(app: ProjectionApp, stored: Stored, opts: { failInsert?: boolean } = {}) {
  const base = app.client;
  const wrapped = {
    ...base,
    from(table: string) {
      if (table !== "canonical_events") return base.from(table);
      const live = base.from("canonical_events");
      return {
        ...live,
        insert(row: Record<string, unknown>) {
          const fail = { data: null, error: { code: "42501", message: "denied" } };
          if (!opts.failInsert) {
            stored.rows.push({ id: `evt-${stored.rows.length + 1}`, occurred_at: new Date().toISOString(), ...row });
          }
          const result = opts.failInsert ? fail : { data: null, error: null };
          return {
            then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
            select: () => ({
              single: async () =>
                opts.failInsert ? fail : { data: { id: stored.rows[stored.rows.length - 1]!.id }, error: null },
            }),
          };
        },
      };
    },
  };
  _setTestClient(wrapped, true);
}

interface Body {
  ok?: boolean;
  error?: string;
  refusal?: string;
  reason?: string;
  state?: string | null;
  session?: ExperienceSessionEnvelope | null;
  opportunity?: { kind?: string; relevance?: number; decision?: string; validUntil?: string | null } | null;
}

const FROM_OPPORTUNITY = "/intel/experience-sessions/from-opportunity";

describe("CX-15 — a NON-COMPASS surface can start one, and only over a real opportunity", () => {
  let app: ProjectionApp | null = null;
  beforeEach(() => _clearPromotedScopeCache());
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function start(state: FakeState, stored: Stored, opts: { failInsert?: boolean } = {}) {
    app = await startRouterApp(experienceSessionsRouter, state, { token: TOKEN, userId: VIEWER });
    writableEvents(app, stored, opts);
    return app;
  }
  async function post(path: string, body: unknown, token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Body };
  }
  async function get(path: string, token = TOKEN) {
    const r = await fetch(`${app!.baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Body };
  }

  it("the seam exists on a router that is NOT Compass, and is flag-gated fail-closed", async () => {
    const stored: Stored = { rows: [] };
    await start(world([]), stored); // flag ABSENT — production's state
    assert.equal((await post(FROM_OPPORTUNITY, { subjectId: PLACE_A })).body.error, "feature_disabled");
    await app!.close();
    app = null;
    await start(world([OFF]), stored);
    assert.equal((await post(FROM_OPPORTUNITY, { subjectId: PLACE_A })).body.error, "feature_disabled");
    assert.equal(stored.rows.length, 0, "nothing was written behind a closed flag");
  });

  it("AUTHORIZATION: it requires a user, and an anonymous caller writes nothing", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const anon = await post(FROM_OPPORTUNITY, { subjectId: PLACE_A }, "stranger");
    assert.equal(anon.status, 401);
    assert.equal(stored.rows.length, 0);
  });

  it("ON: a live world opportunity opens a session whose KIND is the ENGINE's, not the caller's", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const r = await post(FROM_OPPORTUNITY, {
      subjectId: PLACE_A,
      intent: "social",
      relevance: "saved",
      lat: 48.8584,
      lng: 2.2945,
      surface: "wall",
      // A caller's assertion about the opportunity is not read: there is no
      // `opportunityKind` on this seam at all, and a stray one changes nothing.
      opportunityKind: "switch_now",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.state, "open");
    assert.equal(r.body.session?.origin, "world_opportunity");
    assert.equal(r.body.session?.subject_id, PLACE_A);
    assert.equal(r.body.session?.opportunity_kind, "go_now", "the engine's verdict, not the caller's claim");
    assert.equal(r.body.opportunity?.decision, "GO_NOW");
    assert.ok((r.body.session?.claim_refs?.length ?? 0) > 0, "the claims the opportunity rested on came with it");

    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]!.verb, SESSION_OPEN_VERB);
    assert.equal(stored.rows[0]!.actor_id, VIEWER);
    assert.equal(stored.rows[0]!.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].origin, "world_opportunity");
    assert.doesNotMatch(
      JSON.stringify(stored.rows),
      /latitude|longitude|"lat"|"lng"|waypoint|"trail"|"path"/,
      "no coordinate and no trail reached the spine",
    );
    // The session is bounded by the opportunity's own window.
    const expires = Date.parse(r.body.session!.expires_at);
    assert.ok(expires > NOW, "still live");
    assert.ok(expires <= NOW + MAX_SESSION_HOURS * 3_600_000, "bounded");
    assert.ok(
      expires <= Date.parse(r.body.opportunity!.validUntil!),
      "the session cannot outlive the opportunity it bridges",
    );
  });

  it("AUTHORIZATION: a §20 SAFETY-SUPPRESSED subject is refused, and nothing is written", async () => {
    const stored: Stored = { rows: [] };
    await start(
      world([ON], {
        intel_state_snapshots: [
          snapshot(PLACE_A, { value: { level: "unsafe_density" } }),
          snapshot(PLACE_A, { claim_type: "crowd.trajectory", value: { trajectory: "building" } }),
        ],
      }),
      stored,
    );
    const r = await post(FROM_OPPORTUNITY, { subjectId: PLACE_A, intent: "high_energy", relevance: "saved", lat: 48.8584, lng: 2.2945 });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.refusal, "subject_not_actionable");
    assert.equal(r.body.reason, "safety_suppressed");
    assert.equal(stored.rows.length, 0, "a subject the viewer may not act on opened nothing");
  });

  it("AUTHORIZATION: a subject the engine gives NO opportunity for cannot be bridged either", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON], { intel_state_snapshots: [] }), stored);
    const r = await post(FROM_OPPORTUNITY, { subjectId: PLACE_A, relevance: "saved" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.refusal, "subject_not_actionable");
    assert.equal(r.body.reason, "no_opportunity", "and 'we looked and there is nothing' is spelled as itself");
    assert.equal(stored.rows.length, 0);
  });

  it("AUTHORIZATION: with the Live pilot CLOSED nothing is invented to bridge (§20)", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON, { flag: "intel_limited_live", enabled: false }]), stored);
    const r = await post(FROM_OPPORTUNITY, { subjectId: PLACE_A, relevance: "saved" });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "live_intelligence_unavailable", "'could not look' is not 'nothing to act on'");
    assert.equal(stored.rows.length, 0);
  });

  it("ONE open session per viewer holds across BOTH seams — a second is refused", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const first = await post(FROM_OPPORTUNITY, { subjectId: PLACE_A, relevance: "saved", intent: "social", lat: 48.8584, lng: 2.2945 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await app!.close();
    app = null;
    await start(world([ON], { canonical_events: stored.rows }), stored);
    const second = await post(FROM_OPPORTUNITY, { subjectId: PLACE_B, relevance: "saved", intent: "social" });
    assert.equal(second.status, 409);
    assert.equal(second.body.refusal, "already_open");
    const declared = await post("/intel/experience-sessions", { subjectId: PLACE_B, opportunityKind: "go_now" });
    assert.equal(declared.status, 409);
    assert.equal(declared.body.refusal, "already_open");
    assert.equal(stored.rows.length, 1, "sessions cannot accumulate into a parallel trail");
  });
});

describe("S54 — NOT a tracking history: the bridge leaves no queryable trail", () => {
  let app: ProjectionApp | null = null;
  beforeEach(() => _clearPromotedScopeCache());
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  async function start(state: FakeState, stored: Stored) {
    app = await startRouterApp(experienceSessionsRouter, state, { token: TOKEN, userId: VIEWER });
    writableEvents(app, stored);
    return app;
  }

  it("the module registers NO list, NO history and NO by-subject route — there is nothing to ask", () => {
    const paths = (experienceSessionsRouter as unknown as { stack: any[] }).stack
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route.methods).join("|").toUpperCase()} ${l.route.path}`)
      .sort();
    assert.deepEqual(paths, [
      "GET /intel/experience-sessions/open",
      "POST /intel/experience-sessions",
      "POST /intel/experience-sessions/:sessionId/close",
      "POST /intel/experience-sessions/from-opportunity",
    ].sort());
    // None of them is a list, a history or a by-subject read.
    for (const p of paths) {
      assert.doesNotMatch(p, /history|list|subjects?\/|by-subject|visits|places\//i, p);
    }
  });

  it("CLOSING sessions over three subjects leaves NO seam that names any of them", async () => {
    const stored: Stored = { rows: [] };
    const visited = [PLACE_A, PLACE_B, PLACE_C];
    for (const subject of visited) {
      await start(world([ON], { canonical_events: stored.rows }), stored);
      const opened = await (async () => {
        const r = await fetch(`${app!.baseUrl}/api${FROM_OPPORTUNITY}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ subjectId: subject, relevance: "saved", intent: "social" }),
        });
        return { status: r.status, body: (await r.json()) as Body };
      })();
      assert.equal(opened.status, 201, `${subject}: ${JSON.stringify(opened.body)}`);
      await app!.close();
      app = null;

      await start(world([ON], { canonical_events: stored.rows }), stored);
      const closed = await fetch(
        `${app!.baseUrl}/api/intel/experience-sessions/${opened.body.session!.session_id}/close`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ outcome: "better" }),
        },
      );
      assert.equal(closed.status, 200);
      await app!.close();
      app = null;
    }

    // Three experiences have been bridged to outcomes. Now ask the seam
    // everything it can be asked.
    await start(world([ON], { canonical_events: stored.rows }), stored);
    const open = await fetch(`${app!.baseUrl}/api/intel/experience-sessions/open`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await open.json()) as Body;
    assert.equal(body.session, null, "no session is open");
    assert.equal(body.refusal, null, "and that is a fact, not a failed read");
    const wire = JSON.stringify(body);
    for (const subject of visited) {
      assert.doesNotMatch(wire, new RegExp(subject), `${subject} is not recoverable from the seam`);
    }
    // And a closed session cannot be re-opened by asking for it by id, because
    // no route takes a session id except the (terminal) close.
    assert.equal(stored.rows.length, 6, "two rows per session — an open and an outcome, not a trail of six places");
  });

  it("an EXPIRED session is not live either: the window ends, and the subject goes with it", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const r = await fetch(`${app!.baseUrl}/api${FROM_OPPORTUNITY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId: PLACE_A, relevance: "saved", intent: "social" }),
    });
    const opened = (await r.json()) as Body;
    assert.equal(r.status, 201, JSON.stringify(opened));
    const env = opened.session!;
    assert.equal(sessionState(env, Date.parse(env.expires_at) + 1), "expired");

    // Age the stored row past its own window, exactly as the clock would.
    const aged = stored.rows.map((row) => ({
      ...row,
      payload: {
        ...row.payload,
        [EXPERIENCE_SESSION_PAYLOAD_KEY]: { ...env, expires_at: new Date(NOW - 60_000).toISOString() },
      },
    }));
    await app!.close();
    app = null;
    await start(world([ON], { canonical_events: aged }), stored);
    const openRes = await fetch(`${app!.baseUrl}/api/intel/experience-sessions/open`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await openRes.json()) as Body;
    assert.equal(body.session, null, "an expired session is not an open one");
    assert.doesNotMatch(JSON.stringify(body), new RegExp(PLACE_A), "and the subject is not served back");
  });
});
