/**
 * Sensing §5.4 through the REAL routes — the ExperienceSession bridge behind
 * `experience_session_enabled` (migration 2841, seeded FALSE), over the fake
 * PostgREST double the Map gateway suites use.
 *
 * OFF is the load-bearing case: with the flag absent or false all three routes
 * answer feature_disabled and neither read nor write. ON: an action on an
 * opportunity opens ONE session on the canonical spine; a second while one is
 * open is refused; a close writes the outcome's own existing verb; a close of a
 * closed session and a close after the window are refused; a failed read is a
 * refusal rather than "you have no session"; and nothing written carries a
 * coordinate or a trail.
 *
 * fakeMapDb refuses writes by design; these cases wrap its client so
 * `canonical_events` records inserts and serves them back on the next read —
 * which is what a two-event fold needs to be observed at all.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import experienceSessionsRouter from "../routes/experienceSessions.js";
import { _setTestClient } from "../lib/http.js";
import { EXPERIENCE_SESSION_PAYLOAD_KEY, SESSION_OPEN_VERB, type ExperienceSessionEnvelope } from "../lib/experienceSession.js";
import { OUTCOME_VERB, OUTCOME_VERBS } from "../lib/intelOutcomes.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "11111111-aaaa-4aaa-8aaa-111111111111";
const TOKEN = "experience-session-token";
const PLACE_ID = "22222222-bbbb-4bbb-8bbb-222222222222";
const ON = { flag: "experience_session_enabled", enabled: true };
const OFF = { flag: "experience_session_enabled", enabled: false };

interface Stored {
  rows: Array<Record<string, any>>;
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return { feature_flags: [...flags], canonical_events: [], ...over };
}

/**
 * Wrap the fake so `canonical_events` records inserts and serves them back.
 * Reads go through the fake's own builder over the accumulating row set, so
 * the route's filters (actor, verb, window, order, limit) are really applied.
 */
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
          if (!opts.failInsert) stored.rows.push({ id: `evt-${stored.rows.length + 1}`, occurred_at: new Date().toISOString(), ...row });
          const result = opts.failInsert ? fail : { data: null, error: null };
          // Thenable like PostgREST, and also chainable — the outcome path
          // asks for the inserted id with .select("id").single().
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
  state?: string | null;
  verb?: string;
  session?: ExperienceSessionEnvelope | null;
}

describe("Sensing §5.4 — the ExperienceSession routes", () => {
  let app: ProjectionApp | null = null;
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

  it("the flag ABSENT (production's state): all three routes answer feature_disabled and write nothing", async () => {
    const stored: Stored = { rows: [] };
    await start(world([]), stored);
    assert.equal((await get("/intel/experience-sessions/open")).body.error, "feature_disabled");
    assert.equal((await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" })).body.error, "feature_disabled");
    assert.equal(
      (await post(`/intel/experience-sessions/${PLACE_ID}/close`, { outcome: "better" })).body.error,
      "feature_disabled",
    );
    assert.equal(stored.rows.length, 0);
  });

  it("the flag FALSE: identical, and still nothing written", async () => {
    const stored: Stored = { rows: [] };
    await start(world([OFF]), stored);
    assert.equal((await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" })).body.error, "feature_disabled");
    assert.equal(stored.rows.length, 0);
  });

  it("unauthenticated is refused; a body with no opportunity kind is invalid_payload", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    assert.equal((await get("/intel/experience-sessions/open", "stranger")).status, 401);
    assert.equal((await post("/intel/experience-sessions", { subjectId: PLACE_ID }, TOKEN)).body.error, "invalid_payload");
    assert.equal((await post("/intel/experience-sessions", { subjectId: "nope", opportunityKind: "go_now" })).body.error, "invalid_payload");
    assert.equal(stored.rows.length, 0);
  });

  it("ON: an action on an opportunity opens ONE session on the canonical spine, with no coordinate and no trail", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const r = await post("/intel/experience-sessions", {
      subjectId: PLACE_ID,
      opportunityKind: "go_now",
      claimRefs: ["snap-1", "snap-2"],
      surface: "compass",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.state, "open");
    assert.equal(r.body.session?.subject_id, PLACE_ID);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]!.verb, SESSION_OPEN_VERB);
    assert.equal(stored.rows[0]!.actor_id, VIEWER);
    assert.deepEqual(stored.rows[0]!.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].claim_refs, ["snap-1", "snap-2"]);
    assert.doesNotMatch(JSON.stringify(stored.rows), /latitude|longitude|"lat"|"lng"|path|trail|waypoint/);
  });

  it("ON: the open session is readable back — and a SECOND session while one is open is refused", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    assert.equal(opened.status, 201);
    const state = world([ON], { canonical_events: stored.rows });
    await start(state, stored);
    const read = await get("/intel/experience-sessions/open");
    assert.equal(read.body.state, "open");
    assert.equal(read.body.session?.session_id, opened.body.session?.session_id);
    const second = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "switch_now" });
    assert.equal(second.status, 409);
    assert.equal(second.body.refusal, "already_open");
    assert.equal(stored.rows.length, 1, "the refused open wrote nothing");
  });

  it("ON: a close writes the OUTCOME's own existing verb, and closing twice is refused", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    const id = opened.body.session!.session_id;
    await start(world([ON], { canonical_events: stored.rows }), stored);
    const closed = await post(`/intel/experience-sessions/${id}/close`, { outcome: "better", experienceRating: 5 });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.state, "closed");
    assert.equal(closed.body.verb, OUTCOME_VERB.better);
    assert.equal(stored.rows.length, 2, "two rows, one fold");
    assert.equal(stored.rows[1]!.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].outcome, "better");
    assert.equal(stored.rows[1]!.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].experience_rating, 5);

    await start(world([ON], { canonical_events: stored.rows }), stored);
    const again = await post(`/intel/experience-sessions/${id}/close`, { outcome: "worse" });
    assert.equal(again.status, 409);
    assert.equal(again.body.refusal, "already_closed");
    assert.equal(stored.rows.length, 2);
    const afterClose = await get("/intel/experience-sessions/open");
    assert.equal(afterClose.body.session, null, "a closed session is not the open one");
    assert.equal(afterClose.body.refusal, null, "and that is a fact, not a refusal");
  });

  it("ON: a session the viewer does not own does not resolve", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    const id = opened.body.session!.session_id;
    const otherViewersRows = stored.rows.map((r) => ({ ...r, actor_id: "99999999-ffff-4fff-8fff-999999999999" }));
    await start(world([ON], { canonical_events: otherViewersRows }), stored);
    const closed = await post(`/intel/experience-sessions/${id}/close`, { outcome: "better" });
    assert.equal(closed.status, 404);
    assert.equal(closed.body.error, "not_found");
  });

  it("ON: a FAILED read is a refusal, never 'you have no open session' — and no second session is opened on it", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON], { canonical_events: { error: { message: "permission denied" } } }), stored);
    const read = await get("/intel/experience-sessions/open");
    assert.equal(read.body.session, null);
    assert.equal(read.body.refusal, "read_failed");
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    assert.equal(opened.status, 409);
    assert.equal(opened.body.refusal, "read_failed");
    assert.equal(stored.rows.length, 0, "nothing was written on the strength of a read that failed");
  });

  it("ON: a refused WRITE is reported, not swallowed", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored, { failInsert: true });
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    assert.equal(opened.status, 500);
    assert.equal(opened.body.refusal, "write_failed");
    assert.equal(stored.rows.length, 0);
  });

  it("ON: a close that NAMES the served snapshot writes ONE event the calibration report counts — with both envelopes", async () => {
    const stored: Stored = { rows: [] };
    const SNAP = "44444444-dddd-4ddd-8ddd-444444444444";
    const CLAIM = "55555555-eeee-4eee-8eee-555555555555";
    const served = new Date(Date.now() - 5 * 60_000).toISOString();
    const intelTables: FakeState = {
      intel_state_snapshots: [
        {
          id: SNAP,
          subject_id: PLACE_ID,
          zone_id: null,
          claim_type: "crowd.level",
          confidence: 0.8,
          source_count: 12,
          privacy_eligible: true,
          observed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
        },
      ],
      intel_claims: [{ id: CLAIM, subject_id: PLACE_ID, zone_id: null, claim_type: "crowd.level" }],
    };
    await start(world([ON], intelTables), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now", claimRefs: [SNAP] });
    const id = opened.body.session!.session_id;

    await start(world([ON], { ...intelTables, canonical_events: stored.rows }), stored);
    const closed = await post(`/intel/experience-sessions/${id}/close`, {
      outcome: "better",
      experienceRating: 4,
      snapshotId: SNAP,
      claimId: CLAIM,
      servedAt: served,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((closed.body as Record<string, unknown>).calibrated, true);
    assert.equal(stored.rows.length, 2, "one close event, not two");
    const event = stored.rows[1]!;
    // The exact envelope the daily calibration report filters on, and the
    // session's closure beside it.
    assert.equal(event.verb, OUTCOME_VERB.better);
    assert.deepEqual(event.payload.intel, {
      snapshot_id: SNAP,
      claim_id: CLAIM,
      subject_id: PLACE_ID,
      outcome: "better",
      experience_rating: 4,
      served_at: served,
    });
    assert.equal(event.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].session_id, id);
    assert.equal(event.payload[EXPERIENCE_SESSION_PAYLOAD_KEY].outcome, "better");
    // intelCalibrationScheduler's own predicate: verb ∈ OUTCOME_VERBS AND
    // payload->intel NOT NULL. This event satisfies both.
    assert.ok((OUTCOME_VERBS as readonly string[]).includes(event.verb));
    assert.notEqual(event.payload.intel, null);
  });

  it("ON: a close that names NO snapshot is honest about it — the session's own event, and calibration cannot see it", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    await start(world([ON], { canonical_events: stored.rows }), stored);
    const closed = await post(`/intel/experience-sessions/${opened.body.session!.session_id}/close`, { outcome: "same" });
    assert.equal(closed.status, 200);
    assert.equal((closed.body as Record<string, unknown>).calibrated, false);
    assert.equal(stored.rows[1]!.payload.intel, undefined, "no snapshot id was fabricated to be counted");
  });

  it("ON: a close naming a snapshot the viewer was NOT served is refused, and nothing is written", async () => {
    const stored: Stored = { rows: [] };
    const SNAP = "44444444-dddd-4ddd-8ddd-444444444444";
    const CLAIM = "55555555-eeee-4eee-8eee-555555555555";
    await start(world([ON], { intel_state_snapshots: [], intel_claims: [] }), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now" });
    await start(world([ON], { intel_state_snapshots: [], intel_claims: [], canonical_events: stored.rows }), stored);
    const closed = await post(`/intel/experience-sessions/${opened.body.session!.session_id}/close`, {
      outcome: "better",
      snapshotId: SNAP,
      claimId: CLAIM,
      servedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.refusal, "snapshot_not_found");
    assert.equal(stored.rows.length, 1, "the open event only");
  });

  it("ON: an EXPIRED session cannot be closed with an outcome", async () => {
    const stored: Stored = { rows: [] };
    await start(world([ON]), stored);
    const opened = await post("/intel/experience-sessions", { subjectId: PLACE_ID, opportunityKind: "go_now", hours: 0.25 });
    const env = opened.body.session!;
    const expired = stored.rows.map((r) => ({
      ...r,
      payload: {
        ...r.payload,
        [EXPERIENCE_SESSION_PAYLOAD_KEY]: { ...env, expires_at: new Date(Date.now() - 60_000).toISOString() },
      },
    }));
    await start(world([ON], { canonical_events: expired }), stored);
    const closed = await post(`/intel/experience-sessions/${env.session_id}/close`, { outcome: "better" });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.refusal, "expired");
    assert.equal(closed.body.state, "expired");
    assert.equal(stored.rows.length, 1, "no outcome was recorded for a window that had passed");
  });
});
