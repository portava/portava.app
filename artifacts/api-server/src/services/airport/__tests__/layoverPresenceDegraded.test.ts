/**
 * census L294 — "C2. Never swallow a schema/data error into plausible empty
 * operational state **without structured logging and degraded confidence**."
 *
 * The row's ORIGINAL evidence named four swallows outside
 * `LayoverSessionService`, and `cityPresence` is the one that produces the most
 * confident-looking lie:
 *
 *     if (error) return empty;          // layover_sessions unreadable
 *     if (blockErr) return empty;       // blocks unreadable
 *     } catch { return empty; }         // anything else
 *
 * `empty` is `{ count: 0, travelers: [] }`, and the presence surface renders
 * that as **"nobody else is here"** — a statement about other travellers, made
 * from a read that did not happen. Failing CLOSED is right (an outage must not
 * publish people); reporting the closure as a measurement is not.
 *
 * The row's second clause is the one nothing in this surface had: DEGRADED
 * CONFIDENCE. `PresenceDisclosure` already carries a `degraded` flag, and it
 * was fed only by the sharing GATE — a failed presence read left it `false`.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverPresenceDegraded.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { disclosePresence } from "../LayoverPrivacyGuard.js";
import { cityPresence } from "../../../routes/airport.js";

let server: http.Server;
let base: string;
const TOKEN = "presence-degraded-token";
const USER_ID = "user-1";

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
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

function stage(failures: Record<string, { message: string }> = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    // TWO sessions: the blocks read only happens when there is a candidate to
    // filter, so a single-session fixture never reaches it.
    layover_sessions: [
      sessionRow({ user_id: USER_ID, share_city_status: true }),
      sessionRow({ id: "session-2", user_id: "user-2", share_city_status: true, manual_city: "Taoyuan", airport_id: null }),
    ],
    layover_events: [], layover_plan_stops: [], trip_plan_items: [],
    blocks: [], profiles: [], location_preferences: [], trips: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID }, failures }), true);
  return tables;
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

const PRESENCE = "/api/airport/sessions/session-1/presence";

describe("L294/C2 — an unreadable presence read degrades visibly", () => {
  /**
   * The presence query and the OWNERSHIP check both read `layover_sessions`,
   * and this double keys failure injection by `table:op` — so a route test
   * cannot fail one without failing the other (which correctly answers 503,
   * L294's read half, already closed). `cityPresence` is therefore exercised
   * directly; the route case below covers the wire.
   */
  it("an unreadable layover_sessions still serves nothing, and SAYS the count is not a measurement", async () => {
    const db = makeLayoverDb(
      { layover_sessions: [], blocks: [], profiles: [], location_preferences: [] },
      { failures: { "layover_sessions:select": { message: "relation unavailable" } } },
    );
    const r = await cityPresence(db as any, USER_ID, "Taoyuan");
    assert.equal(r.count, 0, "failing closed is right — nobody is published on an outage");
    assert.equal(r.degraded, true, "…and the zero must not be reported as a measurement");
    assert.ok(r.degradedReasons.includes("presence_unreadable"),
      `expected a named reason, got ${JSON.stringify(r.degradedReasons)}`);
  });

  it("an unreadable blocks table degrades too, with its own reason", async () => {
    stage({ "blocks:select": { message: "relation unavailable" } });
    const r = await get(PRESENCE);
    assert.equal(r.body.count, 0);
    assert.equal(r.body.degraded, true);
    assert.ok((r.body.degradedReasons ?? []).includes("blocks_unreadable"),
      JSON.stringify(r.body.degradedReasons));
  });

  it("positive control: a clean read is NOT degraded and names no reason", async () => {
    stage();
    const r = await get(PRESENCE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.degraded, false, "a working read must not claim to be degraded");
    assert.deepEqual(r.body.degradedReasons ?? [], []);
  });

  /**
   * ADDED BY THE §20 MUTATION PASS. The three tests above all leave
   * `cityPresence` through its FINAL return or through `refuse(...)`; none of
   * them leaves through the `empty` constant, so a mutation that made `empty`
   * itself claim `degraded: true` turned NOTHING red. That is the other
   * direction of the same requirement and it is not cosmetic: a city where
   * nobody is sharing is a MEASURED zero, and reporting it as degraded teaches
   * a client to distrust a number the server is entitled to stand behind — the
   * fastest way for a degraded flag to stop being read at all.
   *
   * The read below succeeds and matches nobody: `user-2` is in a different
   * city, so `userIds` is empty and the `empty` constant is the return.
   */
  it("a genuinely empty city is a MEASURED zero, not a degraded one", async () => {
    const db = makeLayoverDb(
      {
        layover_sessions: [
          sessionRow({ id: "session-9", user_id: "user-9", share_city_status: true, manual_city: "Reykjavik", airport_id: null }),
        ],
        blocks: [], profiles: [], location_preferences: [],
      },
      {},
    );
    const r = await cityPresence(db as any, USER_ID, "Taoyuan");
    assert.equal(r.count, 0);
    assert.equal(r.degraded, false, "a successful read that found nobody is a measurement, not an outage");
    assert.deepEqual(r.degradedReasons, []);
  });
});

describe("disclosePresence carries the read's degradation, not only the gate's", () => {
  const allowed = { allowed: true, reasons: [] as string[], degraded: false } as any;

  it("a degraded READ degrades the disclosure even when the GATE is clean", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: true, ladderEnabled: false, count: 0, travelers: [],
      presenceRead: { degraded: true, reasons: ["presence_unreadable"] },
    });
    assert.equal(d.degraded, true);
    assert.deepEqual(d.degradedReasons, ["presence_unreadable"]);
  });

  it("omitting the read keeps the previous behaviour exactly", () => {
    const d = disclosePresence({
      gate: allowed, sessionOptedIn: true, ladderEnabled: false, count: 3, travelers: [],
    });
    assert.equal(d.degraded, false);
    assert.deepEqual(d.degradedReasons, []);
    assert.equal(d.count, 3);
  });
});
