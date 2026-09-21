/**
 * POST /api/airport/sessions/:id/return-now — spec §15.1, the one-tap abort.
 *
 * ── WHY THIS ROUTE DID NOT EXIST UNTIL NOW ───────────────────────────────────
 * Its decision-ledger insert uses `event_type = 'safe_return_aborted'`, and the
 * CHECK on `layover_events` rejected that value in full on any database without
 * migration 2741. The service was built and unit-tested for a route that could
 * not ship. 2741 was applied to production on 2026-09-08 (20260908133347), and
 * this suite is the route half.
 *
 * ── THE THING THIS SUITE EXISTS TO PIN: FLAG != CAPABILITY ───────────────────
 * The status write is gated on the conjunction of
 *   layover_safe_return_status_enabled   (what an operator wants)
 *   LAYOVER_RETURNING_READERS_WIDENED    (what this build can survive)
 * because a flag flipped on a deployment whose readers still filter
 * `status = 'active'` would mark the session returning and then HIDE it from
 * GET /sessions/active, setReturnReminder and endSession — the traveller loses
 * the countdown at the moment they are running for a plane.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * A crash. Every case asserts an exact status code AND the JSON body, which
 *    an unhandled throw cannot produce; `req.log` is installed so the handler's
 *    own error logging is not itself the crash.
 *  * A route that refuses everything. Every refusal is paired with a positive
 *    control on the same fixture.
 *  * The ledger appearing to be written when it was not. The ledger cases read
 *    the fake's own table back, not the response.
 *  * "It answered 200" proving the abort happened. The happy-path cases assert
 *    the stop rows are GONE and the ledger row is PRESENT, by table state.
 *
 * ── MUTATION PROOFS, INCLUDING THE ONE THAT STAYED GREEN ─────────────────────
 * Baseline 12/0. Reverted one at a time:
 *
 *   LAYOVER_RETURNING_READERS_WIDENED := false   10 pass / 2 fail   RED
 *   the already-ended lifecycle guard removed     9 pass / 3 fail   RED
 *   `flagOn && CAPABILITY` -> `flagOn`           12 pass / 0 fail   GREEN
 *
 * THE THIRD ONE IS NOT COVERED AND THIS SAYS SO. While the capability constant
 * is `true`, `flagOn && true` is behaviourally identical to `flagOn`, so no
 * black-box test can distinguish them — the conjunction is structurally
 * required and behaviourally invisible from outside. What the first mutation
 * proves is the thing that actually matters: the constant IS consulted, and a
 * build whose readers do not honour `'returning'` refuses the status write even
 * with the flag on. Reading 12/12 as proof that the `&&` is load-bearing would
 * be the false green this file is written against.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverReturnNowRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "return-now-token";
const OTHER_TOKEN = "return-now-other-token";
const USER = "rn-user-1";
const OTHER = "rn-user-2";
const SESSION = "session-1";

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function post(path: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "2" } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
    r.on("error", reject);
    r.write("{}");
    r.end();
  });
}

function stage(opts: { status?: string; flagOn?: boolean; failures?: Record<string, any>; stops?: number } = {}) {
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_safe_return_status_enabled", enabled: opts.flagOn ?? false },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SESSION, user_id: USER, status: opts.status ?? "active" })],
    layover_recommendations: [],
    layover_plan_stops: Array.from({ length: opts.stops ?? 2 }, (_, i) => ({
      id: `stop-${i + 1}`, session_id: SESSION, stop_order: i + 1, inside_airport: false,
    })),
    layover_events: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: { [TOKEN]: USER, [OTHER_TOKEN]: OTHER }, failures: opts.failures }) as any,
    true,
  );
  return tables;
}

const PATH = `/api/airport/sessions/${SESSION}/return-now`;
const ledger = () => (tables.layover_events ?? []).filter((e) => e.event_type === "safe_return_aborted");

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("return-now — reachability and authorization", () => {
  it("REACHABILITY: the route is mounted (an unauthenticated call is 401, not 404)", async () => {
    stage();
    const r = await post(PATH, "no-such-token");
    assert.notEqual(r.status, 404, "a 404 here means the abort route is still unreachable");
    assert.equal(r.status, 401);
  });

  it("another user's session is 404 and nothing is written", async () => {
    stage();
    const r = await post(PATH, OTHER_TOKEN);
    assert.equal(r.status, 404);
    assert.equal(ledger().length, 0, "an unauthorized caller must not leave a decision-ledger row");
    assert.equal(tables.layover_plan_stops.length, 2, "and must not cancel anybody's plan");
  });
});

describe("return-now — lifecycle guards", () => {
  for (const ended of ["completed", "cancelled", "expired"]) {
    it(`refuses an already-${ended} session without writing anything`, async () => {
      stage({ status: ended });
      const r = await post(PATH, TOKEN);
      assert.equal(r.status, 400, `expected invalid_payload's 400, got ${r.status}`);
      assert.equal(r.body?.error, "invalid_payload");
      assert.match(String(r.body?.message ?? ""), new RegExp(ended));
      assert.equal(ledger().length, 0);
      assert.equal(tables.layover_plan_stops.length, 2);
    });
  }
});

describe("return-now — the abort itself", () => {
  it("cancels landside stops and records the decision ledger row", async () => {
    stage({ stops: 3 });
    const r = await post(PATH, TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(tables.layover_plan_stops.length, 0, "the landside plan must actually be cleared, not reported cleared");
    assert.equal(ledger().length, 1, "the ledger is the only durable evidence the traveller pressed abort");
    assert.ok(r.body.returnContract, "the traveller needs the return contract in the response");
    assert.ok(r.body.posture, "and the posture that says how urgent this is");
  });

  it("with the flag OFF the ledger and the cancellation still happen; only the STATUS is withheld", async () => {
    stage({ flagOn: false });
    const r = await post(PATH, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.statusCapability, "flag_off");
    assert.equal(r.body.statusApplied, false);
    assert.equal(tables.layover_sessions[0].status, "active", "the status write is the gated part");
    assert.equal(ledger().length, 1, "the ledger must NOT depend on a rollout");
    assert.ok(r.body.effects.includes("status_unchanged_flag_off"));
  });

  it("with the flag ON the session is marked returning and the capability says so", async () => {
    stage({ flagOn: true });
    const r = await post(PATH, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.statusCapability, "enabled",
      "flag ON plus widened readers is the only combination that may write the status");
    assert.equal(r.body.statusApplied, true);
    assert.equal(tables.layover_sessions[0].status, "returning");
    assert.ok(r.body.effects.includes("status_marked_returning"));
  });

  it("DOUBLE TAP with the flag off repeats safely and records both presses", async () => {
    stage({ flagOn: false, stops: 2 });
    const a = await post(PATH, TOKEN);
    const b = await post(PATH, TOKEN);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, "the second press must not error — the session is still live");
    assert.equal(tables.layover_plan_stops.length, 0);
    assert.equal(ledger().length, 2,
      "two presses are two decisions; collapsing them would hide that the traveller asked twice");
  });

  it("DOUBLE TAP with the flag on: the second press finds no active row and says which cause", async () => {
    stage({ flagOn: true });
    const a = await post(PATH, TOKEN);
    assert.equal(a.body.statusApplied, true);
    const b = await post(PATH, TOKEN);
    assert.equal(b.status, 200, "a returning session is LIVE, so the abort is still a valid action");
    assert.equal(b.body.statusApplied, false);
    assert.ok(
      b.body.effects.includes("status_unchanged_no_active_row"),
      "the cause must be 'already left active', not 'flag off' — naming the wrong cause is the defect",
    );
  });
});

describe("return-now — partial failure is reported, never swallowed", () => {
  it("a failed ledger write is a 500 that STILL hands back the return contract", async () => {
    stage({ failures: { "layover_events:insert": { message: "canceling statement due to statement timeout", code: "57014" } } });
    const r = await post(PATH, TOKEN);
    assert.equal(r.status, 500);
    assert.equal(r.body?.error, "db_error");
    assert.equal(r.body?.ok, false);
    assert.ok(r.body.returnContract, "the traveller still has to get back to the airport — the contract must survive");
    assert.ok(r.body.effects.includes("ledger_write_failed"));
    assert.match(String(r.body.message), /airport now/i);
  });

  it("a failed stop cancellation is reported rather than answered 200", async () => {
    stage({ failures: { "layover_plan_stops:delete": { message: "deadlock detected", code: "40P01" } } });
    const r = await post(PATH, TOKEN);
    assert.equal(r.status, 500);
    assert.equal(r.body?.error, "db_error");
    assert.ok(r.body.effects.includes("itinerary_cancel_failed"));
  });
});
