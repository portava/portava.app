/**
 * The airport-row lookup has ONE implementation, and this file is the pin that
 * says so.
 *
 * "Which airport is this session at?" has THREE answers, not two:
 *
 *   1. the `airport_profiles` row          — the admin-configured buffers
 *   2. no row (genuinely absent)           — the manual-field fallback profile,
 *                                            whose buffers are the GENERIC
 *                                            defaults and whose timezone is UTC
 *   3. the table could not be READ         — not an airport at all; every
 *                                            deadline-bearing surface refuses
 *
 * Answer 3 is the one that costs a traveller their flight if it is confused
 * with answer 2: the generic buffers are indistinguishable, on screen, from the
 * airport's own, so a five-second outage would quietly serve the wrong "head
 * back at" time. supabase-js RESOLVES on a database error, so the confusion is
 * one missing `error` binding away at all times.
 *
 * The rule was written TWICE — privately in `routes/airport.ts`
 * (`resolveAirportForSession`) and privately again in
 * `services/airport/LayoverSnapshot.ts` (`resolveAirport`) — and duplicated
 * business logic drifts. This file is a CHARACTERIZATION test: it was written
 * against the DUPLICATED code and passed GREEN there, which is the correct and
 * intended result for a characterization test — its job is to describe the
 * behaviour that exists so that collapsing the two copies is provably a
 * refactor and not a behaviour change. It must stay green across the collapse,
 * and it pins BOTH doors against the SAME fixtures so neither can drift again:
 *
 *   route  : GET  /api/airport/sessions/:id/safety, POST …/return-deadline
 *   contract: `certifiedLayoverSnapshot`
 *
 * The deadline is asserted as an EXACT equality between the two doors, not
 * merely "both answered", because "both answered" is satisfied by two different
 * wrong numbers.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/airport/__tests__/layoverAirportResolutionParity.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { certifiedLayoverSnapshot } from "../LayoverSnapshot.js";

const TOKEN = "airport-resolution-parity-token";
const USER_ID = "user-1";

let server: http.Server;
let base: string;

function call(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let p: any; try { p = raw ? JSON.parse(raw) : null; } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (p: string) => call("GET", p);

/**
 * A window pinned to fixed instants so the buffer arithmetic is deterministic
 * and the deadline does not drift between the two doors' calls.
 */
const FIXED_WINDOW = {
  arrival_time: "2030-06-15T00:00:00.000Z",
  departure_time: "2030-06-15T04:00:00.000Z",
  boarding_time: null,
  layover_minutes: 240,
};

/** Deliberately far from the generic defaults, so the two are not confusable. */
const CURATED = { international_buffer_min: 200, immigration_extra_min: 55, traffic_extra_min: 0 };

const UNREADABLE = { message: "could not connect to server" };

/** The one fixture set both doors are asked about. */
function tables(opts: { session?: Record<string, any>; airport?: Record<string, any> } = {}) {
  return {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: false },
    ],
    airport_profiles: [airportRow(opts.airport ?? CURATED)],
    layover_sessions: [sessionRow({ user_id: USER_ID, ...FIXED_WINDOW, ...(opts.session ?? {}) })],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  } as Record<string, any[]>;
}

function stage(opts: {
  session?: Record<string, any>;
  airport?: Record<string, any>;
  failures?: Record<string, { message: string }>;
} = {}) {
  const t = tables(opts);
  const db = makeLayoverDb(t, { users: { [TOKEN]: USER_ID }, failures: opts.failures ?? {} });
  _setTestClient(db, true);
  return db;
}

/** A second, independent client over the SAME fixtures, for the contract door. */
function contractDb(opts: {
  session?: Record<string, any>;
  airport?: Record<string, any>;
  failures?: Record<string, { message: string }>;
} = {}) {
  return makeLayoverDb(tables(opts), {
    users: { [TOKEN]: USER_ID },
    failures: opts.failures ?? {},
  }) as any;
}

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ═══════════════════════════════════════════════════════════════════════════
// ANSWER 1 — the row is there
// ═══════════════════════════════════════════════════════════════════════════

describe("answer 1: the profile row — the ADMIN-CONFIGURED buffers reach both doors", () => {
  it("the route serves the airport's own buffers, not the generic ones", async () => {
    stage();
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    // 200 international + 55 immigration + 0 traffic. The generic answer for
    // this same session is 190; if these ever coincide the whole suite is blind.
    assert.equal(r.body.returnBufferMin, 255);
    assert.equal(typeof r.body.hardReturnTime, "string");
  });

  it("the contract resolves the SAME row to the SAME deadline, to the millisecond", async () => {
    stage();
    const viaRoute = await get("/api/airport/sessions/session-1/safety");
    const snap = await certifiedLayoverSnapshot(contractDb(), USER_ID, { sessionId: "session-1" });
    assert.equal(snap.ok, true);
    assert.equal(
      (snap as any).snapshot.hardReturnBy,
      viaRoute.body.hardReturnTime,
      "two lookups of one row that disagree on the deadline are the drift this collapse exists to prevent",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ANSWER 2 — there is no row (two ways to have none)
// ═══════════════════════════════════════════════════════════════════════════

describe("answer 2: no row — the manual-field fallback, and it is a 200", () => {
  const NO_AIRPORT_ID = { airport_id: null, manual_iata: "TPE", manual_city: "Taoyuan", manual_country: "Taiwan" };

  it("session.airportId is null → the generic-buffer fallback, served as a normal answer", async () => {
    stage({ session: NO_AIRPORT_ID });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    // 120 international + 30 immigration + 20 traffic + 20 time-of-day: the
    // fallback's timezone is UTC, so 04:00Z lands in the night band rather than
    // Taipei's noon. The fallback loses the airport's TIMEZONE as well as its
    // buffers, which is exactly why answer 3 must not become this.
    assert.equal(r.body.returnBufferMin, 190);
  });

  it("session.airportId names a row that is NOT THERE → the same fallback, still 200", async () => {
    // The `data == null, error == null` branch: the statement ran and matched
    // nothing. Distinct from both the null-airportId case above and the
    // unreadable case below, and it must keep answering.
    stage({ session: { ...NO_AIRPORT_ID, airport_id: "airport-does-not-exist" } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(r.body.returnBufferMin, 190, "an absent row is the fallback, never a refusal");
  });

  it("the fallback profile is built from the manual fields with the documented defaults", async () => {
    // No manual fields at all: the loader's own "UNK"/"Unknown" defaults. What
    // is pinned is that a session with nothing to say about its airport still
    // gets an ANSWER rather than a 500 or a refusal.
    stage({ session: { airport_id: null, manual_iata: null, manual_city: null, manual_country: null, manual_airport_name: null } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(r.body.returnBufferMin, 190);
  });

  it("the contract agrees with the route on the fallback deadline too", async () => {
    stage({ session: NO_AIRPORT_ID });
    const viaRoute = await get("/api/airport/sessions/session-1/safety");
    const snap = await certifiedLayoverSnapshot(contractDb({ session: NO_AIRPORT_ID }), USER_ID, {
      sessionId: "session-1",
    });
    assert.equal(snap.ok, true);
    assert.equal((snap as any).snapshot.hardReturnBy, viaRoute.body.hardReturnTime);
  });

  it("POSITIVE CONTROL: the curated row and the fallback are genuinely different answers", async () => {
    stage();
    const curated = await get("/api/airport/sessions/session-1/safety");
    stage({ session: NO_AIRPORT_ID });
    const fallback = await get("/api/airport/sessions/session-1/safety");
    assert.notEqual(
      curated.body.returnBufferMin,
      fallback.body.returnBufferMin,
      "if the curated buffers did not reach the answer, refusing on an unreadable read would protect nothing",
    );
    assert.notEqual(curated.body.hardReturnTime, fallback.body.hardReturnTime);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ANSWER 3 — the table could not be read. THE FAIL-CLOSED ARM.
// ═══════════════════════════════════════════════════════════════════════════

describe("answer 3: unreadable — a refusal, never 'no airport' and never a deadline", () => {
  const FAIL = { failures: { "airport_profiles:select": UNREADABLE } };

  it("GET /safety → 503 degraded_unavailable with NO deadline of any kind", async () => {
    stage(FAIL);
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 503, "200 with the generic buffers is the failure this arm exists to prevent");
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    assert.equal(r.body.returnBufferMin, undefined, "no deadline may be served from buffers nobody could read");
    assert.equal(r.body.hardReturnTime, undefined);
  });

  it("the refusal is NOT 'airport not found' and NOT 'session not found'", async () => {
    stage(FAIL);
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.notEqual(r.status, 404);
    assert.notEqual(r.body.error, "not_found");
    // And the session-missing arm still answers 404, so 503-for-everything
    // would not satisfy this file either.
    stage();
    const missing = await get("/api/airport/sessions/no-such-session/safety");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "not_found");
  });

  it("POST /return-deadline — the route that names the instant to leave — refuses identically", async () => {
    stage(FAIL);
    const r = await call("POST", "/api/airport/sessions/session-1/return-deadline", { minutesBefore: 30 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.hardReturnTime, undefined);
  });

  it("the contract refuses with the airport reason, never the session one", async () => {
    const snap = await certifiedLayoverSnapshot(contractDb(FAIL), USER_ID, { sessionId: "session-1" });
    assert.equal(snap.ok, false);
    assert.equal((snap as any).reason, "airport_profiles_unreadable");
    assert.notEqual((snap as any).reason, "session_not_found");
  });

  it("the failure is scoped to the profile read: a readable table answers again immediately", async () => {
    stage(FAIL);
    const failed = await get("/api/airport/sessions/session-1/safety");
    assert.equal(failed.status, 503);
    stage();
    const recovered = await get("/api/airport/sessions/session-1/safety");
    assert.equal(recovered.status, 200, "the refusal must be about THIS read, not a latched state");
    assert.equal(recovered.body.returnBufferMin, 255);
  });
});
