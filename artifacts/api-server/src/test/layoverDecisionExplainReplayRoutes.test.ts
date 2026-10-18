/**
 * census-layover L189 / L191 — the routes for `explainSnapshot` and
 * `replaySessionDecisions`, beside the L190 diff route.
 *
 *   GET /api/airport/sessions/:id/decisions/:snapshotId/explain
 *   GET /api/airport/sessions/:id/decisions/replay?engineVersion=<v>
 *
 * The service halves (LayoverDecisionService.ts, lane 5) are pinned by
 * layoverDecisionExplainReplay.test.ts. This file pins the DOORS: the owner
 * boundary, the wire each outcome is published as, and the three NAMED
 * refusals production answers today, with nothing read and nothing faked.
 *
 * ── THE PRESS STATE THESE RUN IN ─────────────────────────────────────────────
 * Production: `layover_decision_persistence_enabled` ABSENT and 2700/2992/3792
 * unapplied. So the first block is the answer every traveller would get today:
 *
 *   feature_disabled      flag absent or off           — retryable: false
 *   flag_unreadable       flag could not be read        — retryable: true
 *   storage_unavailable   flag on, ledger tables absent — retryable: false
 *
 * as `200 { state: "unavailable", reason }`, the ledger tables never touched.
 * The second block switches the ledger on in the double and explains / replays
 * what GET /:id/safety actually stored — the answer a traveller was told.
 *
 * Run: node --import tsx/esm --test src/test/layoverDecisionExplainReplayRoutes.test.ts   (LOOPBACK: sandbox off)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { _setTestClient } from "../lib/http.js";
import { DECISION_PERSISTENCE_FLAG } from "../services/layover/LayoverDecisionStore.js";
import { LAYOVER_ENGINE_VERSION } from "../services/airport/LayoverSafetyEngine.js";
import airportRouter from "../routes/airport.js";

const TOKEN = "explain-token";
const OTHER_TOKEN = "explain-other-token";
const USER = "user-1";
const OTHER = "user-2";
const LEDGER = ["layover_certified_computations", "layover_time_budgets", "layover_return_plans"];
const MISSING = "snap:" + "0".repeat(32);

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;
let touched: string[] = [];

const get = (path: string, token = TOKEN): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", headers: { authorization: `Bearer ${token}` } },
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

const explain = (snap: string, session = "session-1", token = TOKEN) => get(`/api/airport/sessions/${session}/decisions/${encodeURIComponent(snap)}/explain`, token);
const replay = (engineVersion: string | null, session = "session-1") =>
  get(`/api/airport/sessions/${session}/decisions/replay${engineVersion === null ? "" : `?engineVersion=${encodeURIComponent(engineVersion)}`}`);

function stage(opts: {
  persistence?: boolean | "unreadable";
  failures?: Record<string, { message: string; code?: string }>;
  airportMode?: boolean;
} = {}) {
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: opts.airportMode ?? true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      ...(opts.persistence === true || opts.persistence === "unreadable" ? [{ flag: DECISION_PERSISTENCE_FLAG, enabled: true }]
        : opts.persistence === false ? [{ flag: DECISION_PERSISTENCE_FLAG, enabled: false }] : []),
    ],
    airport_profiles: [airportRow()],
    layover_sessions: [
      sessionRow({ user_id: USER, id: "session-1" }),
      sessionRow({ user_id: USER, id: "session-2" }),
      sessionRow({ user_id: OTHER, id: "session-other" }),
    ],
    layover_events: [], layover_plan_stops: [], trip_plan_items: [],
  };
  const db = makeLayoverDb(tables, { users: { [TOKEN]: USER, [OTHER_TOKEN]: OTHER }, failures: opts.failures ?? {} }) as any;
  const failing = makeLayoverDb({}, { failures: { "feature_flags:select": { message: "feature_flags unavailable" } } }) as any;
  touched = [];
  _setTestClient({
    ...db,
    from(t: string) {
      touched.push(t);
      const b = db.from(t);
      if (t !== "feature_flags" || opts.persistence !== "unreadable") return b;
      const eq = b.eq.bind(b);
      b.eq = (col: string, val: unknown) =>
        col === "flag" && val === DECISION_PERSISTENCE_FLAG ? failing.from("feature_flags").select("enabled").eq(col, val) : eq(col, val);
      return b;
    },
  }, true);
}

/** Hand the ledger back as a database would: through a JSONB round trip. */
function asStored() { for (const n of LEDGER) tables[n] = JSON.parse(JSON.stringify(tables[n] ?? [])); }

/** What GET /:id/safety told the traveller and stored (the ledger must be ON). */
async function told(session = "session-1") {
  const r = await get(`/api/airport/sessions/${session}/safety`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.persisted.state, "recorded", JSON.stringify(r.body.persisted));
  return r.body;
}

const ledgerTouched = () => touched.filter((t) => LEDGER.includes(t));

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

// ── unpressed: the answer production gives today ─────────────────────────────

describe("L189 / L191 unpressed — a NAMED refusal, nothing read, nothing faked", () => {
  for (const [label, persistence, reason, retryable] of [
    ["flag ABSENT (production today)", undefined, "feature_disabled", false],
    ["flag OFF", false, "feature_disabled", false],
    ["flag UNREADABLE", "unreadable", "flag_unreadable", true],
  ] as const) {
    it(`explain, ${label}: 200 { state: "unavailable", reason: "${reason}" } and no ledger table touched`, async () => {
      stage({ persistence });
      const r = await explain(MISSING);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { featureEnabled: true, state: "unavailable", reason, retryable });
      assert.deepEqual(ledgerTouched(), []);
    });
    it(`replay, ${label}: 200 { state: "unavailable", reason: "${reason}" } and no ledger table touched`, async () => {
      stage({ persistence });
      const r = await replay(LAYOVER_ENGINE_VERSION);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { featureEnabled: true, state: "unavailable", reason, retryable });
      assert.deepEqual(ledgerTouched(), []);
    });
  }

  const ABSENT_TABLE = { code: "PGRST205", message: "Could not find the table 'public.layover_certified_computations' in the schema cache" };

  it("explain, flag ON over a database without the ledger: `storage_unavailable` — not a 503, not an empty explanation", async () => {
    stage({ persistence: true, failures: { "layover_certified_computations:select": ABSENT_TABLE } });
    const r = await explain(MISSING);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { featureEnabled: true, state: "unavailable", reason: "storage_unavailable", retryable: false });
  });

  it("replay, flag ON over a database without the ledger: `storage_unavailable` — never an empty, all-clear summary", async () => {
    stage({ persistence: true, failures: { "layover_certified_computations:select": ABSENT_TABLE } });
    const r = await replay(LAYOVER_ENGINE_VERSION);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { featureEnabled: true, state: "unavailable", reason: "storage_unavailable", retryable: false });
    assert.equal("summary" in r.body, false, "no summary at all — not an empty one");
  });

  it("airport mode off: `featureEnabled: false`, as the diff route answers", async () => {
    stage({ airportMode: false });
    assert.deepEqual((await explain(MISSING)).body, { featureEnabled: false });
    assert.deepEqual((await replay(LAYOVER_ENGINE_VERSION)).body, { featureEnabled: false });
  });
});

// ── the doors ────────────────────────────────────────────────────────────────

describe("L189 / L191 — the owner's own session, and well-formed ids only", () => {
  it("a malformed snapshot id is 400, before anything is read", async () => {
    stage({ persistence: true });
    const r = await explain("not-a-snapshot");
    assert.equal(r.status, 400);
    assert.deepEqual(ledgerTouched(), []);
  });

  it("a missing or malformed engineVersion is 400, before anything is read", async () => {
    stage({ persistence: true });
    assert.equal((await replay(null)).status, 400);
    assert.equal((await replay("v1;drop")).status, 400);
    assert.equal((await replay("x".repeat(65))).status, 400);
    assert.deepEqual(ledgerTouched(), []);
  });

  it("another traveller's session is 404 on both routes, and its ledger is not read", async () => {
    stage({ persistence: true });
    for (const r of [await explain(MISSING, "session-other"), await replay(LAYOVER_ENGINE_VERSION, "session-other")]) {
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: "not_found", message: "Session not found" }, "the owner check's own answer, not an unrouted path");
    }
    assert.deepEqual(ledgerTouched(), []);
  });
});

// ── pressed (in the double): explain and replay what /safety stored ──────────

describe("L189 — GET /decisions/:snapshotId/explain over what GET /:id/safety stored", () => {
  it("explains EXACTLY the answer the traveller was told: same snapshot, reasons, unknowns, disclaimer, deadline", async () => {
    stage({ persistence: true });
    const safety = await told();
    asStored();
    const r = await explain(safety.snapshotId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "explained");
    const e = r.body.explanation;
    assert.equal(e.snapshotId, safety.snapshotId);
    assert.equal(e.sessionId, "session-1");
    assert.deepEqual(e.reasons, safety.advice.reasons);
    assert.deepEqual(e.unknowns, safety.advice.unknowns);
    assert.equal(e.disclaimer, safety.advice.disclaimer);
    assert.deepEqual(e.breakdown, safety.breakdown, "the per-term buffer breakdown the traveller was shown");
    assert.equal(e.decision.inputHash, safety.certification.inputHash);
    assert.equal(e.decision.result.hardReturnTime, safety.hardReturnTime);
    assert.equal(e.decision.engineVersion, safety.advice.engineVersion);
    assert.equal(e.verifiedBy, "replay_match");
  });

  it("the DASHBOARD's path: the snapshot GET /:id/overview published (and stored) is the one explained", async () => {
    stage({ persistence: true });
    const ov = await get("/api/airport/sessions/session-1/overview");
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    assert.equal(ov.body.persisted.state, "recorded", "the overview stored the answer it told");
    asStored();
    const r = await explain(ov.body.snapshotId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "explained");
    assert.equal(r.body.explanation.snapshotId, ov.body.snapshotId);
    assert.deepEqual(r.body.explanation.reasons, ov.body.advice.reasons);
    assert.equal(r.body.explanation.decision.result.hardReturnTime, ov.body.window.hardReturnTime);
    const rp = await replay(ov.body.certification.engineVersion);
    assert.equal(rp.body.state, "replayed");
    assert.equal(rp.body.summary.matched, rp.body.summary.read);
    assert.ok(rp.body.summary.read >= 1);
  });

  it("a snapshot of ANOTHER of the traveller's sessions is 404 — exactly like a missing one", async () => {
    stage({ persistence: true });
    const other = await told("session-2");
    asStored();
    const cross = await explain(other.snapshotId, "session-1");
    const missing = await explain(MISSING, "session-1");
    assert.equal(cross.status, 404);
    assert.deepEqual(cross.body, missing.body);
  });

  it("a stored row that does not reproduce from its inputs is NOT explained: `not_explained` / `replay_mismatch`, fields named", async () => {
    stage({ persistence: true });
    const safety = await told();
    asStored();
    const row = tables.layover_certified_computations[0];
    row.hard_return_time = new Date(Date.parse(row.hard_return_time) + 30 * 60_000).toISOString();
    const r = await explain(safety.snapshotId);
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "not_explained");
    assert.equal(r.body.reason, "replay_mismatch");
    assert.deepEqual(r.body.detail, ["hard_return_time"], "the one field that was changed is the one named");
    assert.equal(r.body.explanation, undefined);
  });

  it("a ledger read that FAILS is 503 — never an empty explanation", async () => {
    stage({ persistence: true, failures: { "layover_certified_computations:select": { message: "timeout" } } });
    const r = await explain(MISSING);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
  });
});

describe("L191 — GET /decisions/replay over what GET /:id/safety stored", () => {
  it("replays every stored answer of the session under the running engine: all reproduce", async () => {
    stage({ persistence: true });
    await told();
    await new Promise((r) => setTimeout(r, 5));
    await told();
    asStored();
    const r = await replay(LAYOVER_ENGINE_VERSION);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "replayed");
    assert.equal(r.body.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.equal(r.body.truncated, false);
    const stored = tables.layover_certified_computations.length;
    assert.ok(stored >= 1);
    assert.equal(r.body.summary.read, stored);
    assert.equal(r.body.summary.matched, stored);
    assert.equal(r.body.summary.mismatched, 0);
  });

  it("a tampered stored answer is a MISMATCH with its fields named — never counted as reproduced", async () => {
    stage({ persistence: true });
    const safety = await told();
    asStored();
    tables.layover_certified_computations[0].usable_minutes += 45;
    const r = await replay(LAYOVER_ENGINE_VERSION);
    assert.equal(r.body.state, "replayed");
    assert.equal(r.body.summary.mismatched, 1);
    const bad = r.body.summary.results.find((x: any) => x.snapshotId === safety.snapshotId);
    assert.equal(bad.status, "mismatch");
    assert.ok(bad.mismatchedFields.length > 0);
  });

  it("an engine version that is not running is `not_replayed`, naming the running one — this tree runs one engine", async () => {
    stage({ persistence: true });
    const r = await replay("1999.01.01-1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { featureEnabled: true, state: "not_replayed", reason: "engine_version_not_running", runningEngineVersion: LAYOVER_ENGINE_VERSION });
    assert.deepEqual(ledgerTouched(), []);
  });

  it("a ledger read that FAILS is 503 — never an empty, all-clear summary", async () => {
    stage({ persistence: true, failures: { "layover_certified_computations:select": { message: "timeout" } } });
    const r = await replay(LAYOVER_ENGINE_VERSION);
    assert.equal(r.status, 503);
    assert.equal(r.body.summary, undefined);
  });
});
