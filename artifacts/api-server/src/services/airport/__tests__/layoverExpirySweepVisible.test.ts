/**
 * census L294 — "C2. Never swallow a schema/data error into plausible empty
 * operational state **without structured logging and degraded confidence**."
 *
 * §19.2 closed the write half of this row and then listed, by name, the three
 * things still true of it. This suite is the first of them:
 *
 *   > `expireOldSessions` now answers `number | null` so a failed sweep is not
 *   > a counted zero — and **both callers ignore the return value entirely**
 *   > (`routes/airport.ts`, the `/sessions` and `/sessions/active` handlers),
 *   > so at the route the failed sweep is still invisible.
 *
 * WHAT THE INVISIBILITY COSTS A TRAVELLER. The sweep is what moves a session
 * whose flight has gone from `active` to `expired`. When it fails, those rows
 * stay live, and the two endpoints that read them serve them as a LAYOVER THAT
 * IS STILL HAPPENING:
 *
 *   - `GET /airport/sessions?status=active` lists a layover that is over.
 *   - `GET /airport/sessions/active` returns it as THE active session, which is
 *     what mounts the whole Layover surface — hard-return countdown included.
 *     A countdown to a flight that has already departed is the most confident
 *     lie this surface can tell.
 *
 * Neither response had any way to say the sweep failed, so the stale row was
 * indistinguishable from a live one. That is C2's "plausible empty operational
 * state" in its other direction: not an empty list presented as a measurement,
 * but a STALE list presented as a current one.
 *
 * The fix is not a 503. The list is readable and mostly right, and failing a
 * whole endpoint because a housekeeping sweep failed would cost a traveller the
 * countdown they actually need. The fix is C2's own second clause — DEGRADED
 * CONFIDENCE — plus the one measurement the server can honestly make: how many
 * of the rows it is about to serve as live have a departure time in the past.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverExpirySweepVisible.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { expirySweepDisclosure } from "../LayoverSessionService.js";

let server: http.Server;
let base: string;
const TOKEN = "expiry-sweep-token";
const USER_ID = "user-1";

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const HOUR = 3_600_000;

/**
 * A session whose flight has ALREADY GONE but whose row is still `active` —
 * exactly the row the sweep exists to retire, staged as it looks when the
 * sweep could not run.
 */
function departedSession(over: Record<string, any> = {}) {
  const now = Date.now();
  return sessionRow({
    id: "session-gone",
    user_id: USER_ID,
    status: "active",
    arrival_time:   new Date(now - 6 * HOUR).toISOString(),
    departure_time: new Date(now - 1 * HOUR).toISOString(),
    boarding_time:  null,
    ...over,
  });
}

/** A session whose flight has not gone yet. The sweep leaves it alone. */
function liveSession(over: Record<string, any> = {}) {
  const now = Date.now();
  return sessionRow({
    id: "session-live",
    user_id: USER_ID,
    status: "active",
    arrival_time:   new Date(now - 1 * HOUR).toISOString(),
    departure_time: new Date(now + 6 * HOUR).toISOString(),
    boarding_time:  null,
    ...over,
  });
}

function stage(sessions: any[], failures: Record<string, { message: string }> = {}) {
  _setTestClient(
    makeLayoverDb(
      {
        feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
        airport_profiles: [airportRow()],
        layover_sessions: sessions,
        layover_events: [], layover_plan_stops: [], trip_plan_items: [],
        blocks: [], profiles: [], location_preferences: [], trips: [],
      },
      { users: { [TOKEN]: USER_ID }, failures },
    ),
    true,
  );
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── The rule, as a function ──────────────────────────────────────────────────

describe("expirySweepDisclosure — a sweep that did not run is not a sweep that found nothing", () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  const gone = { status: "active" as const, departureTime: new Date(now - HOUR).toISOString() };
  const soon = { status: "active" as const, departureTime: new Date(now + HOUR).toISOString() };

  it("a sweep that ran degrades nothing, however many it expired", () => {
    for (const swept of [0, 1, 37]) {
      const d = expirySweepDisclosure(swept, [gone, soon], now);
      assert.equal(d.degraded, false, `a completed sweep of ${swept} is a measurement`);
      assert.deepEqual(d.degradedReasons, []);
      assert.equal(d.possiblyExpired, 0, "nothing is possibly-expired once the sweep has run");
    }
  });

  it("a sweep that FAILED degrades, names itself, and counts what it could not retire", () => {
    const d = expirySweepDisclosure(null, [gone, soon], now);
    assert.equal(d.degraded, true);
    assert.deepEqual(d.degradedReasons, ["session_expiry_sweep_failed"]);
    assert.equal(d.possiblyExpired, 1, "one of the two served rows has a departure in the past");
  });

  it("only LIVE statuses are counted — an already-expired row is not a stale live one", () => {
    const d = expirySweepDisclosure(null, [
      { status: "expired",   departureTime: new Date(now - HOUR).toISOString() },
      { status: "completed", departureTime: new Date(now - HOUR).toISOString() },
      { status: "cancelled", departureTime: new Date(now - HOUR).toISOString() },
    ], now);
    assert.equal(d.degraded, true, "the sweep still failed");
    assert.equal(d.possiblyExpired, 0, "a terminal row is not something the sweep owed the traveller");
  });

  it("`returning` is live — an aborting traveller's stale row counts too", () => {
    const d = expirySweepDisclosure(null, [
      { status: "returning", departureTime: new Date(now - HOUR).toISOString() },
    ], now);
    assert.equal(d.possiblyExpired, 1);
  });

  it("an unparseable departure is not counted as past — a guess is not a measurement", () => {
    const d = expirySweepDisclosure(null, [{ status: "active", departureTime: "not a date" }], now);
    assert.equal(d.degraded, true);
    assert.equal(d.possiblyExpired, 0);
  });
});

// ── The rule, on the wire ────────────────────────────────────────────────────

describe("GET /airport/sessions — a failed sweep is visible on the list", () => {
  it("the list still serves, and SAYS the sweep that should have pruned it failed", async () => {
    // The sweep is an UPDATE on layover_sessions; the list is a SELECT. Failing
    // only the update is what isolates "the sweep failed" from "the table is
    // unreadable", which is already a 503 and already covered.
    stage([departedSession(), liveSession()], { "layover_sessions:update": { message: "deadlock detected" } });
    const r = await get("/api/airport/sessions?status=active");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded, true, "a list the sweep could not prune is not a clean list");
    assert.ok((r.body.degradedReasons ?? []).includes("session_expiry_sweep_failed"),
      JSON.stringify(r.body.degradedReasons));
    assert.equal(r.body.possiblyExpiredSessions, 1,
      "one of the listed sessions has a departure time in the past");
  });

  it("positive control: a sweep that ran leaves the list undegraded", async () => {
    stage([liveSession()]);
    const r = await get("/api/airport/sessions?status=active");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded ?? false, false);
    assert.deepEqual(r.body.degradedReasons ?? [], []);
  });

  it("the sweep is not run at all for a historical filter, and nothing claims it was", async () => {
    stage([departedSession({ status: "completed" })], { "layover_sessions:update": { message: "deadlock detected" } });
    const r = await get("/api/airport/sessions?status=completed");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded ?? false, false,
      "no sweep was attempted on a completed-history read, so there is nothing to degrade");
  });
});

describe("GET /airport/sessions/active — the countdown surface says when it may be stale", () => {
  it("a departed session served as ACTIVE after a failed sweep is flagged", async () => {
    stage([departedSession()], { "layover_sessions:update": { message: "deadlock detected" } });
    const r = await get("/api/airport/sessions/active");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.session, "the session is still served — hiding it would cost more than flagging it");
    assert.equal(r.body.degraded, true);
    assert.ok((r.body.degradedReasons ?? []).includes("session_expiry_sweep_failed"),
      JSON.stringify(r.body.degradedReasons));
    assert.equal(r.body.possiblyExpiredSessions, 1,
      "this is the session the countdown is about, and its flight has gone");
  });

  it("a genuinely live session after a failed sweep degrades but is NOT called stale", async () => {
    stage([liveSession()], { "layover_sessions:update": { message: "deadlock detected" } });
    const r = await get("/api/airport/sessions/active");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded, true, "the sweep still failed and the answer still says so");
    assert.equal(r.body.possiblyExpiredSessions, 0,
      "this session's flight has not gone — the sweep owed it nothing");
  });

  it("positive control: a clean sweep and a live session degrade nothing", async () => {
    stage([liveSession()]);
    const r = await get("/api/airport/sessions/active");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded ?? false, false);
    assert.deepEqual(r.body.degradedReasons ?? [], []);
  });
});
