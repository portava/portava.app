/**
 * census-layover L175 — `LayoverFeasibilityService.evaluate(sessionId)` has a
 * route caller: `GET /api/airport/sessions/:id/safety`.
 *
 * The handler used to certify inline (`consumerLayoverRecord ?? certifySessionFeasibility`)
 * and hand the record to `persistDecision` itself. It now asks `evaluate()` —
 * owner-scoped read, live check, airport, the house's one derivation, and the
 * four-state persistence gate — and publishes what the service answered.
 *
 * ── WHAT MUST NOT CHANGE ─────────────────────────────────────────────────────
 * Production today has `layover_decision_persistence_enabled` absent (2700 /
 * 2992 / 3792 unapplied). In that world, and with the flag OFF, the response is
 * byte-identical to the inline handler's, for a live AND an ended session; so
 * is every flag-ON outcome the existing ledger suite pins (`recorded`,
 * `write_failed`, `read_failed`) and every 404/503. That parity was measured
 * against the pre-change handler over a frozen clock (lane handback); the
 * existing /safety suites (layoverDecisionLedger, layoverSnapshotConsumers C2,
 * layoverUnreadableReads, …) keep it pinned. The cases below pin what the
 * service CHANGES, and each is red on the inline handler:
 *
 *   1. the wiring itself (the handler asks `evaluate`, and writes nothing inline);
 *   2. an UNREADABLE persistence flag is said as `flag_unreadable`, not "off";
 *   3. an ENDED session is still answered and is never stored, even with the
 *      ledger ON (`evaluate` refuses a row about a layover that is over);
 *   4. a refusal `evaluate` reaches on its own read is answered with the same
 *      sentence as the handler's first read — never a certification it did not make.
 *
 * Run: node --import tsx/esm --test src/test/layoverSafetyEvaluate.test.ts   (LOOPBACK: sandbox off)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import { snapshotIdFor } from "../services/airport/layoverLedger.js";
import { DECISION_PERSISTENCE_FLAG } from "../services/layover/LayoverDecisionStore.js";
import airportRouter from "../routes/airport.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "safety-evaluate-token";
const USER = "user-1";
const HOUR = 3_600_000;
const LEDGER = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"] as const;

let server: http.Server;
let base: string;

const get = (path: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let p: any;
          try { p = JSON.parse(raw); } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });

type Fail = Record<string, { message: string; code?: string }>;

/**
 * A database with (optionally) ONE flag unreadable and/or the Nth read of a
 * table failing — the two failure shapes `makeLayoverDb` cannot stage alone.
 */
function wrap(db: any, opts: { unreadableFlag?: string; failNth?: { table: string; n: number; empty?: boolean } }) {
  const counts: Record<string, number> = {};
  const failing = makeLayoverDb({ [opts.failNth?.table ?? "x"]: [] }, {
    failures: {
      "feature_flags:select": { message: "feature_flags unavailable" },
      ...(opts.failNth && !opts.failNth.empty ? { [`${opts.failNth.table}:select`]: { message: "second read failed" } } : {}),
    },
  }) as any;
  return {
    ...db,
    from(t: string) {
      counts[t] = (counts[t] ?? 0) + 1;
      if (opts.failNth && t === opts.failNth.table && counts[t] === opts.failNth.n) return failing.from(t);
      const b = db.from(t);
      if (t !== "feature_flags" || !opts.unreadableFlag) return b;
      const eq = b.eq.bind(b);
      b.eq = (col: string, val: unknown) =>
        col === "flag" && val === opts.unreadableFlag ? failing.from("feature_flags").select("enabled").eq(col, val) : eq(col, val);
      return b;
    },
  };
}

function stage(opts: {
  flags?: Array<{ flag: string; enabled: boolean }>;
  session?: Record<string, unknown>;
  failures?: Fail;
  unreadableFlag?: string;
  failNth?: { table: string; n: number; empty?: boolean };
} = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      ...(opts.flags ?? []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER, id: "session-1", ...(opts.session ?? {}) })],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
  };
  const db = makeLayoverDb(tables, { users: { [TOKEN]: USER }, failures: opts.failures ?? {} });
  _setTestClient(opts.unreadableFlag || opts.failNth ? wrap(db, opts) : db, true);
  return tables;
}

const rows = (t: Record<string, any[]>) => LEDGER.map((n) => (t[n] ?? []).length);
const ENDED = () => ({
  status: "completed",
  arrival_time: new Date(Date.now() - 10 * HOUR).toISOString(),
  departure_time: new Date(Date.now() - HOUR).toISOString(),
});

before(() => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The /safety handler's source, from its registration to the next route's. */
function safetyHandlerSource(): string {
  const src = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8");
  const start = src.indexOf('router.get("/airport/sessions/:id/safety"');
  const end = src.indexOf("router.", start + 10);
  assert.ok(start > 0 && end > start, "the /safety handler was not found — this test is reading the wrong file");
  return src.slice(start, end);
}

describe("L175 — GET /:id/safety is evaluate()'s route caller", () => {
  it("1. the handler asks evaluate() for the session it serves, and writes nothing inline", () => {
    const body = safetyHandlerSource();
    assert.match(body, /evaluateLayoverFeasibility\(sc, user\.id, session\.id, \{ loaded: \{ session, airport \} \}\)/);
    assert.doesNotMatch(body, /persistDecision\(/, "the §20 write belongs to evaluate(), not to the handler");
  });

  it("2. production (flag ABSENT): the deadline is served, NOT STORED, and the snapshot id names this answer", async () => {
    const t = stage();
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.hardReturnTime, "string");
    assert.deepEqual(r.body.persisted, { state: "not_stored", reason: "persistence_disabled" });
    assert.equal(r.body.snapshotId, snapshotIdFor("session-1", r.body.certification.inputHash));
    assert.deepEqual(rows(t), [0, 0, 0]);
  });

  it("3. ledger ON: evaluate() stores the answer once, under the published snapshot id", async () => {
    const t = stage({ flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }] });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.persisted, { state: "recorded", unwritten: [] });
    assert.deepEqual(rows(t), [1, 1, 1]);
    assert.equal(t.layover_certified_computations[0].snapshot_id, r.body.snapshotId);
    assert.equal(t.layover_return_plans[0].hard_return_by, r.body.hardReturnTime);
  });

  it("4. an UNREADABLE persistence flag is `flag_unreadable` — not 'off' — and nothing is written", async () => {
    const t = stage({ flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }], unreadableFlag: DECISION_PERSISTENCE_FLAG });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, "an unreadable ledger flag must not cost the traveller the answer");
    assert.equal(typeof r.body.hardReturnTime, "string");
    assert.deepEqual(r.body.persisted, { state: "not_stored", reason: "flag_unreadable" });
    assert.deepEqual(rows(t), [0, 0, 0]);
  });
});

describe("L175 — an ENDED session: answered as before, never stored", () => {
  it("5. production (flag ABSENT): the ended session is answered and says `persistence_disabled`, exactly as before", async () => {
    const t = stage({ session: ENDED() });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.hardReturnTime, "string");
    assert.deepEqual(r.body.persisted, { state: "not_stored", reason: "persistence_disabled" });
    assert.equal(r.body.snapshotId, snapshotIdFor("session-1", r.body.certification.inputHash));
    assert.deepEqual(rows(t), [0, 0, 0]);
  });

  it("6. ledger ON: an ended session is answered and NOT stored — `session_ended`", async () => {
    const t = stage({ session: ENDED(), flags: [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }] });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.hardReturnTime, "string");
    assert.deepEqual(r.body.persisted, { state: "not_stored", reason: "session_ended" });
    assert.deepEqual(rows(t), [0, 0, 0], "a ledger row about a layover that is over is a row about nothing");
  });

  it("7. ledger flag UNREADABLE on an ended session: `flag_unreadable`, nothing written", async () => {
    const t = stage({ session: ENDED(), unreadableFlag: DECISION_PERSISTENCE_FLAG });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.persisted, { state: "not_stored", reason: "flag_unreadable" });
    assert.deepEqual(rows(t), [0, 0, 0]);
  });
});

describe("L175 — a refusal evaluate() reaches is answered in the handler's own words, never certified around", () => {
  it("8. its session read fails → 503, the same sentence as the handler's own failed read", async () => {
    stage({ failNth: { table: "layover_sessions", n: 1 } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, "Your layover could not be loaded. Please try again.");
    assert.equal(r.body.hardReturnTime, undefined);
  });

  it("9. the shared session read finds no row → 404 `Session not found`", async () => {
    stage({ failNth: { table: "layover_sessions", n: 1, empty: true } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 404);
    assert.equal(r.body.message, "Session not found");
  });

  it("10. its airport read fails → 503, the airport sentence — never a certification against default buffers", async () => {
    stage({ failNth: { table: "airport_profiles", n: 1 } });
    const r = await get("/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 503);
    assert.equal(r.body.message, "Your airport's timings could not be loaded. Please try again.");
    assert.equal(r.body.hardReturnTime, undefined);
  });
});
