/**
 * POST /api/airport/sessions/:id/disruption — spec §15.2, and the memory the
 * disruption state machine never had.
 *
 * ── THE DEFECT THIS SUITE PINS ───────────────────────────────────────────────
 * `nextDisruptionState` guarantees that the delay chain cannot be re-entered
 * from the cancellation chain: once CANCELLED, a delay event leaves it
 * CANCELLED. That guarantee was defeated at the only place the machine was
 * called. `handleEvent` reads the prior state from `ctx.disruptionStates?.[id]
 * ?? "CONNECTION"` (LayoverEventReplanner.ts:884) and NOTHING populates that
 * map, so `PATCH /airport/sessions/:id` published `disruptionState: "DELAYED"`
 * for a session whose flight had been cancelled. The API told a traveller whose
 * flight was cancelled that it was merely late.
 *
 * Every case below drives the REAL Express router over the REAL handlers. None
 * of them calls `nextDisruptionState`, `recomputeForDisruption` or
 * `readDisruptionState` directly — an earlier round here was rejected for
 * testing the helper instead of the route, and a helper that is right while its
 * caller drops the state is exactly the failure that produced this file.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * A crash. Every case asserts a status code AND a body shape; `req.log` is
 *    installed so the handler's own error logging is not the crash.
 *  * A route that refuses everything. Every refusal is paired with a positive
 *    control on the same fixture (unreadable-ledger vs readable; cancelled-then-
 *    delayed vs fresh-then-delayed).
 *  * The ledger looking written when it was not. Ledger assertions read the
 *    fake's own `layover_events` table back, never the response body.
 *  * The session looking updated when it was not. The recompute cases assert
 *    `layover_sessions[0].departure_time` by table state.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/layoverDisruptionRoute.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";

const TOKEN = "disruption-token";
const OTHER_TOKEN = "disruption-other-token";
const USER = "dis-user-1";
const OTHER = "dis-user-2";
const SESSION = "session-1";

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function send(
  method: "POST" | "PATCH",
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = JSON.stringify(body ?? {});
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(raw);
    r.end();
  });
}

const post = (b: unknown, token = TOKEN) => send("POST", PATH, token, b);
const patch = (b: unknown, token = TOKEN) => send("PATCH", `/api/airport/sessions/${SESSION}`, token, b);
const PATH = `/api/airport/sessions/${SESSION}/disruption`;

/** The fake's created_at has millisecond resolution; the real column does not. */
const tick = () => new Promise((r) => setTimeout(r, 3));

const HOUR = 3_600_000;
let NOW = 0;

function stage(opts: { status?: string; failures?: Record<string, any>; events?: any[] } = {}) {
  NOW = Date.now();
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: opts.status ?? "active",
        arrival_time: new Date(NOW + 5 * 60_000).toISOString(),
        departure_time: new Date(NOW + 8 * HOUR).toISOString(),
      }),
    ],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: opts.events ?? [],
    trip_plan_items: [],
    trips: [],
    trip_members: [],
  };
  _setTestClient(
    makeLayoverDb(tables, { users: { [TOKEN]: USER, [OTHER_TOKEN]: OTHER }, failures: opts.failures }) as any,
    true,
  );
  return tables;
}

/** Transitions as the LEDGER holds them — never as the response reported them. */
const recorded = () =>
  (tables.layover_events ?? [])
    .filter((e) => e.metadata?.disruption)
    .map((e) => ({ type: e.event_type, ...e.metadata.disruption }));

const departureInTable = () => tables.layover_sessions[0].departure_time as string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  // listen(0) with no address binds the IPv6 wildcard, and the kernel may hand
  // back a port a foreign process already holds on 127.0.0.1 — see
  // `src/test/loopbackBindGuard.test.ts`. Naming the host makes the bind
  // DEFERRED, so the "listening" callback must be awaited before reading
  // `server.address()`.
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

describe("§15.2 — the ladder walks, and it is written down", () => {
  it("a delay moves CONNECTION → DELAYED and the ledger holds it", async () => {
    stage();
    const r = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.disruption.previousState, "CONNECTION");
    assert.equal(r.body.disruption.previousStateSource, "default");
    assert.equal(r.body.disruption.state, "DELAYED");

    const led = recorded();
    assert.equal(led.length, 1, "exactly one transition should be recorded");
    assert.equal(led[0].state, "DELAYED");
    assert.equal(led[0].previousState, "CONNECTION");
    // The CHECK on layover_events.event_type is closed; a dedicated
    // 'disruption_recorded' value would be rejected in production.
    assert.equal(led[0].type, "session_updated");
  });

  it("three hours is SEVERE_DELAY and eight is OVERNIGHT, through the route", async () => {
    stage();
    let r = await post({ kind: "delay", delayMinutes: 180 });
    assert.equal(r.body.disruption.state, "SEVERE_DELAY");
    await tick();
    r = await post({ kind: "delay", delayMinutes: 8 * 60 });
    assert.equal(r.body.disruption.state, "OVERNIGHT");
  });

  it("the cancellation chain runs CANCELLED → REBOOKING → RECOVERY", async () => {
    stage();
    let r = await post({ kind: "cancellation" });
    assert.equal(r.body.disruption.state, "CANCELLED");
    await tick();
    r = await post({ kind: "rebooking_offered" });
    assert.equal(r.body.disruption.state, "REBOOKING");
    await tick();
    r = await post({ kind: "rebooking_confirmed" });
    assert.equal(r.body.disruption.state, "RECOVERY");
  });
});

describe("§15.2 — the memory, which is the whole point", () => {
  it("a delay reported AFTER a cancellation does not un-cancel the flight", async () => {
    stage();
    const first = await post({ kind: "cancellation" });
    assert.equal(first.body.disruption.state, "CANCELLED");
    await tick();

    const second = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(second.status, 200);
    assert.equal(second.body.disruption.previousState, "CANCELLED",
      "the prior state must come from the ledger, not from a CONNECTION default");
    assert.equal(second.body.disruption.state, "CANCELLED",
      "a cancelled flight reported as delayed is the defect this route exists for");
  });

  it("POSITIVE CONTROL — the same delay on a session with no cancellation IS a delay", async () => {
    stage();
    const r = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(r.body.disruption.state, "DELAYED");
  });

  it("delay totals against the BASELINE departure, not the last edit", async () => {
    stage();
    // Two ninety-minute slips. Against the baseline that is 180 minutes —
    // SEVERE_DELAY. Against the previous departure each is 90 — DELAYED.
    let r = await post({ kind: "delay", newDepartureTime: new Date(NOW + 9.5 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.equal(r.body.disruption.state, "DELAYED");
    await tick();

    r = await post({ kind: "delay", newDepartureTime: new Date(NOW + 11 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.equal(r.body.disruption.state, "SEVERE_DELAY",
      "two 90-minute slips are a three-hour delay, and the baseline is what makes them one");
    assert.equal(
      r.body.disruption.baselineDepartureTime,
      new Date(NOW + 8 * HOUR).toISOString(),
      "the baseline is the ORIGINAL departure, carried forward",
    );
  });
});

describe("§15.2 — recompute, do not append", () => {
  it("a moved departure is a full re-certification and the session actually moves", async () => {
    stage();
    const before = departureInTable();
    const r = await post({ kind: "delay", newDepartureTime: new Date(NOW + 10 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.ok(r.body.recompute, "a moved departure must publish a recompute");
    assert.equal(r.body.recompute.scheduleDeltaMinutes, 120);
    assert.equal(typeof r.body.recompute.recomputedNotAppended, "boolean");
    assert.equal(typeof r.body.recompute.before.usableMinutes, "number");
    assert.equal(typeof r.body.recompute.after.usableMinutes, "number");
    assert.notEqual(departureInTable(), before, "the new departure must be persisted, not just reported");
    assert.equal(departureInTable(), new Date(NOW + 10 * HOUR).toISOString());
  });

  it("a state-only report publishes no recompute and moves no schedule", async () => {
    stage();
    const before = departureInTable();
    const r = await post({ kind: "cancellation" });
    assert.equal(r.status, 200);
    assert.equal(r.body.recompute, null);
    assert.equal(departureInTable(), before);
  });
});

describe("§15.2 — fail closed", () => {
  it("an UNREADABLE ledger is a 503, not a CONNECTION", async () => {
    stage({ failures: { "layover_events:select": { message: "layover_events unreadable" } } });
    const r = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(recorded().length, 0, "nothing may be recorded from a state we could not read");
  });

  it("POSITIVE CONTROL — the same request on a readable ledger succeeds", async () => {
    stage();
    const r = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(r.status, 200);
  });

  it("a stored state this build does not recognise is a 503, not a CONNECTION", async () => {
    stage({
      events: [{
        id: "e-1", session_id: SESSION, user_id: USER, event_type: "session_updated",
        metadata: { disruption: { state: "DIVERTED", previousState: "CONNECTION" } },
        created_at: new Date(Date.now() - 1000).toISOString(),
      }],
    });
    const r = await post({ kind: "delay", delayMinutes: 45 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("a schedule the table refused is NOT recorded as having happened", async () => {
    stage({ failures: { "layover_sessions:update": { message: "layover_sessions unwritable" } } });
    const r = await post({ kind: "delay", newDepartureTime: new Date(NOW + 10 * HOUR).toISOString() });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(recorded().length, 0,
      "a ledger entry naming a departure the table never took is worse than no entry");
  });

  it("a transition the ledger refused is reported as NOT recorded", async () => {
    stage({ failures: { "layover_events:insert": { message: "layover_events unwritable" } } });
    const r = await post({ kind: "cancellation" });
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.disruption.stateRecorded, false);
    // The computed state is still handed back — the traveller needs it — but
    // the envelope says plainly that it will not survive.
    assert.equal(r.body.disruption.state, "CANCELLED");
  });

  it("someone else's session is 404 and an unreadable one is 503", async () => {
    stage();
    assert.equal((await post({ kind: "cancellation" }, OTHER_TOKEN)).status, 404);
    stage({ failures: { "layover_sessions:select": { message: "down" } } });
    assert.equal((await post({ kind: "cancellation" })).status, 503);
  });

  it("an ended layover refuses the report rather than reopening it", async () => {
    stage({ status: "completed" });
    const r = await post({ kind: "cancellation" });
    assert.equal(r.status, 400);
    assert.equal(recorded().length, 0);
  });

  it("a delay with neither a total nor a new departure is refused", async () => {
    stage();
    const r = await post({ kind: "delay" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("a new departure before arrival, or in the past, is refused", async () => {
    stage();
    assert.equal((await post({ kind: "delay", newDepartureTime: new Date(NOW - HOUR).toISOString() })).status, 400);
    assert.equal(recorded().length, 0);
  });
});

describe("§15 L145 — recovery help says what it has, which is nothing", () => {
  it("never claims a rebooking, airline or airport-help integration", async () => {
    stage();
    const r = await post({ kind: "cancellation" });
    assert.equal(r.body.recovery.recoveryNeeded, true);
    assert.equal(r.body.recovery.rebooking.available, false);
    assert.equal(r.body.recovery.rebooking.reason, "no_airline_integration");
    assert.equal(r.body.recovery.airlineContact.available, false);
    assert.equal(r.body.recovery.airportHelp.available, false);
  });
});

describe("§15.2 — PATCH /sessions/:id no longer resets the disruption state", () => {
  it("a window edit after a cancellation still publishes CANCELLED", async () => {
    stage();
    const c = await post({ kind: "cancellation" });
    assert.equal(c.body.disruption.state, "CANCELLED");
    await tick();

    const r = await patch({ departureTime: new Date(NOW + 9 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.replan.ran, true, "the replan must still run — this is a correction, not a suppression");
    assert.equal(r.body.replan.disruptionState, "CANCELLED",
      "before the ledger read, replanForWindowChange published DELAYED here");
    assert.equal(r.body.replan.disruptionPreviousState, "CANCELLED");
  });

  it("POSITIVE CONTROL — the same edit with no cancellation publishes DELAYED", async () => {
    stage();
    const r = await patch({ departureTime: new Date(NOW + 9 * HOUR).toISOString() });
    assert.equal(r.status, 200);
    assert.equal(r.body.replan.ran, true);
    assert.equal(r.body.replan.disruptionState, "DELAYED");
  });

  it("an unreadable ledger publishes NO disruption state, not CONNECTION", async () => {
    stage({ failures: { "layover_events:select": { message: "layover_events unreadable" } } });
    const r = await patch({ departureTime: new Date(NOW + 9 * HOUR).toISOString() });
    assert.equal(r.status, 200, "the edit itself has committed and must not be failed by the ledger");
    assert.equal(r.body.replan.ran, true);
    assert.equal(r.body.replan.disruptionState, null);
    assert.equal(r.body.replan.disruptionStateUnavailableReason, "ledger_unreadable");
  });
});
