/**
 * GET /api/airport/sessions/:id/presence — the sharing gate has to be applied by
 * the ROUTE, not merely to exist in a service.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `LayoverPrivacyGuard.ts` opens by saying the module "Enforces Ghost Mode,
 * location mode settings". It did not: `isSharingAllowed` had no reference
 * outside src/test/airport.test.ts, and the live presence path never called it.
 * The gate was then built and unit-tested — and a gate that is unit-tested and
 * unwired protects nobody. This suite is the wiring half.
 *
 * The distinction it pins: `layover_sessions.share_city_status` is what the
 * traveller chose WHEN THE SESSION BEGAN. The sharing gate is what they have
 * chosen SINCE — location mode off, sharing paused, ghost mode on. The route
 * consulted only the first, so a traveller who paused sharing afterwards was
 * still told `sharing: true` and still published.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * A crash. Every case asserts HTTP 200 and an exact body shape, not merely a
 *    non-200 or a falsy field; `req.log` is installed so a handler throw cannot
 *    masquerade as a considered refusal.
 *  * A route that refuses EVERYTHING. Every refusal case is paired with a
 *    positive control on the same fixture, differing only in the one preference
 *    under test, which must answer `sharing: true` and carry the real count.
 *  * The session flag doing the work instead of the gate. Every refusal fixture
 *    sets `share_city_status: true`, so the ONLY thing that can produce a
 *    refusal is the gate. If the gate were removed, these cases would report
 *    sharing: true — which is exactly what the pre-wiring build did.
 *
 * Runtime: node:test + node:assert/strict. The verdict is the exit code.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverPresenceRouteGate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "presence-gate-token";
const USER = "presence-user-1";
const TRIP = "trip-presence-1";

let server: http.Server;
let base = "";

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

/**
 * `prefs` is the row in location_preferences, or null for "no row" (the
 * permissive default). `ghost` is the trip_crew_location_preferences row.
 * The session ALWAYS opts in, so the gate is the only thing that can refuse.
 */
function stage(opts: { prefs?: Record<string, unknown> | null; ghost?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_presence_ladder_enabled", enabled: false },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER, trip_id: TRIP, share_city_status: true })],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
    location_preferences: opts.prefs === undefined || opts.prefs === null
      ? []
      : [{ user_id: USER, ...opts.prefs }],
    trip_crew_location_preferences: opts.ghost
      ? [{ trip_id: TRIP, user_id: USER, ghost_mode_enabled: true }]
      : [],
    blocks: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER } }) as any, true);
  return tables;
}

const PRESENCE = "/api/airport/sessions/session-1/presence";

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

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("presence route — the gate is applied here, not only in the service", () => {
  it("POSITIVE CONTROL: no stored preference row means the traveller is sharing", async () => {
    stage({ prefs: null });
    const r = await get(PRESENCE);
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.sharing, true, "an absent preference row is the permissive default and must not refuse");
    assert.equal(r.body.ok, true);
  });

  it("sharing PAUSED refuses, even though the session still says share_city_status", async () => {
    stage({ prefs: { location_mode: "city_only", sharing_paused: true } });
    const r = await get(PRESENCE);
    assert.equal(r.status, 200);
    assert.equal(
      r.body.sharing, false,
      "THE POINT: the session flag is the session-time choice; pausing sharing afterwards must stop publication. " +
      "The pre-wiring build answered sharing:true here.",
    );
    assert.equal(r.body.count, 0);
    assert.deepEqual(r.body.travelers, []);
  });

  it("location mode OFF refuses", async () => {
    stage({ prefs: { location_mode: "off", sharing_paused: false } });
    const r = await get(PRESENCE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sharing, false);
    assert.equal(r.body.count, 0);
  });

  it("GHOST MODE on the session's trip refuses", async () => {
    stage({ prefs: { location_mode: "city_only", sharing_paused: false }, ghost: true });
    const r = await get(PRESENCE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sharing, false, "ghost mode is a trip-scoped opt-out and the layover surface must honour it");
  });

  it("a stored preference row that permits sharing still publishes — the gate is not a blanket refusal", async () => {
    stage({ prefs: { location_mode: "city_only", sharing_paused: false } });
    const r = await get(PRESENCE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sharing, true);
  });

  it("the refusal carries the additive fields without dropping the old contract", async () => {
    stage({ prefs: { location_mode: "off" } });
    const r = await get(PRESENCE);
    // The three fields the old refusal carried, unchanged in name and value.
    assert.equal(r.body.ok, true);
    assert.equal(r.body.sharing, false);
    assert.equal(r.body.count, 0);
    assert.deepEqual(r.body.travelers, []);
    // Additive: a client that ignores these is unaffected.
    assert.ok("level" in r.body, "the disclosure level must be reported so a client can tell WHY it sees nothing");
    assert.ok("withheld" in r.body);
  });
});
