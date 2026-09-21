/**
 * Layover: "we could not look" is never served as an answer about the world.
 *
 * node:test + node:assert/strict (NOT vitest). Real router, table-backed fake
 * DB. The verdict is the EXIT CODE.
 *
 * THE DEFECT CLASS. supabase-js RESOLVES on a database error — it does not
 * throw — so `const { data } = await sc.from(...)` reads a failed query as an
 * empty result, and every `try/catch` wrapped around one of these reads was
 * dead code. On the layover surface that turned three failures into three
 * confident, wrong statements to a traveller sitting in a terminal:
 *
 *   1. `layover_sessions` unreadable  → 404 "Session not found" on EIGHT
 *      routes, `/safety` and `/return-deadline` among them. The session
 *      exists; the server was not in a position to say otherwise. And
 *      `/sessions/active` answered `session: null`, which the client renders
 *      as "you are not in a layover" — hiding the return countdown entirely.
 *   2. `airport_profiles` unreadable  → silently fell through to
 *      buildFallbackProfile, whose buffers are the GENERIC defaults, and every
 *      hard-return time was then computed from those instead of the airport's
 *      admin-configured ones. The wrong "head back at" time, with nothing on
 *      screen saying so.
 *   3. `layover_plan_stops` unreadable → "no stops", which `computePlanFit`
 *      turns into `fitsWindow: true`: the traveller was told their itinerary
 *      fits inside the window before the flight leaves.
 *   4. `layover_recommendations` unreadable → "no recommendations", i.e. "there
 *      is nothing to do on your layover".
 *
 * WHAT IS ASSERTED, AND THE TRAPS AVOIDED
 *   - The exact STATUS CODE and error code, never merely `!== 200`.
 *   - A genuinely MISSING session must still be 404. Answering 503 for
 *     everything would be a different lie, so both arms are pinned.
 *   - Positive controls first: the clean read must produce the exact wrong
 *     answer the failure used to produce (`fitsWindow: true`, `session: null`,
 *     `recommendations: []`), so the failure arm is proven to be a change of
 *     behaviour and not a coincidence.
 *   - `req.log` is installed, because the real server installs it — otherwise
 *     a handler throw becomes a 500 that reads like a considered refusal.
 *   - The listening callback is awaited on the explicit loopback address.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverUnreadableReads.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "unreadable-token";
const USER_ID = "user-1";

let server: http.Server;
let base: string;

// ── HTTP ─────────────────────────────────────────────────────────────────────

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
 * Stage the whole layover world, optionally with one table+op made to RESOLVE
 * `{ data: null, error }` — which is how supabase-js reports a failure.
 */
function stage(opts: {
  failures?: Record<string, { message: string }>;
  session?: Record<string, any>;
  airport?: Record<string, any>;
  stops?: any[];
  recs?: any[];
} = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: false },
    ],
    airport_profiles: [airportRow(opts.airport ?? {})],
    layover_sessions: [sessionRow({ user_id: USER_ID, ...(opts.session ?? {}) })],
    layover_plan_stops: opts.stops ?? [],
    layover_recommendations: opts.recs ?? [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures: opts.failures ?? {} }),
    true, // also stands in for getServiceClient() — every airport route uses it
  );
  return tables;
}

const UNREADABLE = { message: "could not connect to server" };

/**
 * A window pinned to fixed instants so the buffer arithmetic is deterministic.
 * The cutoff is 2030-06-15T04:00Z = 12:00 in Asia/Taipei, where the
 * time-of-day band is 0 and the 20-minute ramp ahead of it is also 0 — so the
 * only terms left are the airport's own configured ones. A `now`-relative
 * window would drift across the 20:00 and 22:00 bands and make the expected
 * number a coin flip.
 */
const FIXED_WINDOW = {
  arrival_time: "2030-06-15T00:00:00.000Z",
  departure_time: "2030-06-15T04:00:00.000Z",
  boarding_time: null,
  layover_minutes: 240,
};

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
// 1. layover_sessions
// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable layover_sessions is not 'your layover does not exist'", () => {
  it("positive control: the session reads and /safety answers with a deadline", async () => {
    stage();
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.hardReturnTime, "string");
  });

  it("a genuinely MISSING session is still 404 — both arms are pinned", async () => {
    stage();
    const r = await get("/api/airport/sessions/no-such-session/safety");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });

  const routes: Array<[string, string, any?]> = [
    ["GET", "/api/airport/sessions/session-1/safety"],
    ["GET", "/api/airport/sessions/session-1/overview"],
    ["GET", "/api/airport/sessions/session-1/recommendations"],
    ["GET", "/api/airport/sessions/session-1/stops"],
    ["POST", "/api/airport/sessions/session-1/return-deadline", { minutesBefore: 30 }],
  ];
  for (const [method, path, body] of routes) {
    it(`${method} ${path} → 503 degraded_unavailable, not 404`, async () => {
      stage({ failures: { "layover_sessions:select": UNREADABLE } });
      const r = await call(method, path, body);
      assert.equal(r.status, 503, "404 would claim the layover does not exist; the server could not look");
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.retryable, true);
    });
  }

  it("GET /airport/sessions → 503, not an empty list that reads as 'you have no layovers'", async () => {
    stage({ failures: { "layover_sessions:select": UNREADABLE } });
    const r = await get("/api/airport/sessions");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("GET /airport/sessions/active → 503, not `session: null` (which hides the return countdown)", async () => {
    // Positive control: with a readable table and no active session, `null` is
    // the honest answer and still 200. That is the exact answer the failure
    // used to borrow.
    stage({ session: { status: "completed" } });
    const clean = await get("/api/airport/sessions/active");
    assert.equal(clean.status, 200);
    assert.equal(clean.body.session, null);

    stage({ failures: { "layover_sessions:select": UNREADABLE } });
    const r = await get("/api/airport/sessions/active");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. airport_profiles — the buffers every hard-return time is computed from
// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable airport_profiles does not silently become the DEFAULT buffers", () => {
  it("positive control: the airport's own buffers reach the answer", async () => {
    // Deliberately far from the generic defaults (120 international + 30
    // immigration = 150) so the two are not confusable.
    stage({
      session: FIXED_WINDOW,
      airport: { international_buffer_min: 200, immigration_extra_min: 55, traffic_extra_min: 0 },
    });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.returnBufferMin, 255,
      "the ADMIN-CONFIGURED buffers must be what the deadline is built from",
    );
  });

  it("the generic-default answer is a real, reachable number — so the failure arm means something", async () => {
    // No airport row at all: the manual-field fallback is the honest answer and
    // is deliberately UNCHANGED. This is the number the unreadable case used to
    // serve while pretending to be the airport's own.
    stage({ session: { ...FIXED_WINDOW, airport_id: null, manual_iata: "TPE", manual_city: "Taoyuan" } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    // 120 international + 30 immigration + 20 traffic + 20 time-of-day.
    // That last term is the tell: buildFallbackProfile's timezone is "UTC", so
    // the 04:00Z cutoff lands in the 22:00–06:00 night band instead of Taipei's
    // 12:00 noon band. The fallback silently loses the AIRPORT'S TIMEZONE too,
    // not just its buffers — one more reason an unreadable profile must not
    // quietly become this.
    assert.equal(r.body.returnBufferMin, 190);
  });

  it("unreadable → 503, NOT the 170-minute default masquerading as this airport's", async () => {
    stage({
      session: FIXED_WINDOW,
      airport: { international_buffer_min: 200, immigration_extra_min: 55, traffic_extra_min: 0 },
      failures: { "airport_profiles:select": UNREADABLE },
    });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.returnBufferMin, undefined, "no deadline may be served from buffers nobody could read");
    // Neither the airport's 255 nor the fallback's 190 — nothing at all.
  });

  it("the same refusal on /return-deadline — the route that names the instant to leave", async () => {
    stage({ failures: { "airport_profiles:select": UNREADABLE } });
    const r = await call("POST", "/api/airport/sessions/session-1/return-deadline", { minutesBefore: 30 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.hardReturnTime, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. layover_plan_stops — the table whose emptiness means "your plan fits"
// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable layover_plan_stops does not answer 'your plan fits'", () => {
  it("positive control: an EMPTY plan really does report fitsWindow true", async () => {
    stage();
    const r = await get("/api/airport/sessions/session-1/stops");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.stops, []);
    assert.equal(r.body.planFit.fitsWindow, true, "this is the exact claim a failed read used to borrow");
    assert.equal(r.body.planFit.neededMin, 0);
  });

  it("GET /stops unreadable → 503, not an empty plan that fits", async () => {
    stage({ failures: { "layover_plan_stops:select": UNREADABLE } });
    const r = await get("/api/airport/sessions/session-1/stops");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.planFit, undefined);
  });

  it("GET /overview unreadable → 503, not a dashboard whose planFit is a guess", async () => {
    stage({ failures: { "layover_plan_stops:select": UNREADABLE } });
    const r = await get("/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("POST /stops unreadable → 503, and NOTHING is written", async () => {
    // `existing.length` was both the 12-stop cap check and the new row's
    // stop_order, so an unreadable read wrote a second stop at order 0 and
    // walked past the cap.
    const tables = stage({ failures: { "layover_plan_stops:select": UNREADABLE } });
    const r = await call("POST", "/api/airport/sessions/session-1/stops", {
      title: "Din Tai Fung", durationMin: 60, travelMin: 25,
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(tables.layover_plan_stops.length, 0, "no stop may be ordered against a count nobody could read");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. layover_recommendations
// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable layover_recommendations is not 'there is nothing to do here'", () => {
  it("positive control: recommendations are produced and served", async () => {
    stage();
    const r = await get("/api/airport/sessions/session-1/recommendations");
    assert.equal(r.status, 200);
    assert.ok(r.body.recommendations.length > 0, "vacuity: the clean path must actually produce cards");
  });

  it("unreadable → 503, not `recommendations: []`", async () => {
    stage({ failures: { "layover_recommendations:select": UNREADABLE } });
    const r = await get("/api/airport/sessions/session-1/recommendations");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.recommendations, undefined);
  });
});
