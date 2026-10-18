/**
 * census-layover L148 (round 2) — "a reload shows the remembered state", from
 * the SERVER.
 *
 * POST /api/airport/sessions/:id/disruption records every §15.2 transition on
 * `layover_events` and reads it back as the prior state of the next report. No
 * read published it: after a reload the layover screen could only show this
 * phone's copy of the last answer it happened to see, and a report made from
 * another device never reached it at all. GET /:id/overview now carries a
 * `disruption` member, read from that same ledger by the same reader.
 *
 * ── WHAT EACH CASE WOULD CATCH ───────────────────────────────────────────────
 *   1  a member invented for a layover nobody reported on (it must say `default`);
 *   2  a report the overview does not see (the whole point: any device, every read);
 *   3  an overview showing an OLDER transition than the ledger's newest;
 *   4  a FAILED ledger read rendered as "nothing reported" — the defect class:
 *      it must be `unknown`, and the overview must still serve the deadline;
 *   5  a ledger row naming a state this build does not know, read as CONNECTION;
 *   6  another traveller's report on this session shown to its owner;
 *   7  `reportedBy: "traveller"` outliving the fact that makes it true (the
 *      route is the ledger's only writer).
 *
 * Every case drives the REAL router; ledger state is read from the fake's own
 * table, never from the response that wrote it.
 *
 * Run: node --import tsx/esm --test src/test/layoverOverviewDisruptionMemory.test.ts   (LOOPBACK: sandbox off)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { DISRUPTION_LEDGER_EVENT_TYPE } from "../services/airport/layoverSafeReturnDisruption.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = "memory-token";
const USER = "mem-user-1";
const OTHER = "mem-user-2";
const SESSION = "session-1";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;

function send(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string | number> = { authorization: `Bearer ${TOKEN}` };
    if (raw !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(raw); }
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let acc = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { acc += c; });
      res.on("end", () => {
        let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (raw !== null) r.write(raw);
    r.end();
  });
}

const overview = () => send("GET", `/api/airport/sessions/${SESSION}/overview`);
const report = (b: unknown) => send("POST", `/api/airport/sessions/${SESSION}/disruption`, b);
/** The fake's created_at has millisecond resolution. */
const tick = () => new Promise((r) => setTimeout(r, 3));

function stage(opts: { failures?: Record<string, { message: string; code?: string }>; events?: any[] } = {}) {
  const now = Date.now();
  tables = {
    // Production's own gate for both routes, and nothing else: the member needs no new flag.
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ id: SESSION, user_id: USER, departure_time: new Date(now + 8 * HOUR).toISOString() }, { nowMs: now })],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: opts.events ?? [],
    trip_plan_items: [],
    trips: [],
    trip_members: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER }, failures: opts.failures }) as any, true);
}

const NO_HELP = {
  rebooking: { available: false, reason: "no_airline_integration" },
  airlineContact: { available: false, reason: "no_airline_directory" },
  airportHelp: { available: false, reason: "no_airport_help_directory" },
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/api", airportRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("L148 — GET /:id/overview publishes the server's disruption memory", () => {
  it("1. nothing ever reported: CONNECTION from `default`, reported by nobody, at no time", async () => {
    stage();
    const r = await overview();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.disruption, {
      status: "known", state: "CONNECTION", source: "default", reportedBy: null, recordedAt: null,
      baselineDepartureTime: null, recovery: { recoveryNeeded: false, ...NO_HELP },
    });
  });

  it("2. a report made through the route — from any device — is what the next overview read shows", async () => {
    stage();
    const posted = await report({ kind: "cancellation" });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const row = tables.layover_events.find((e) => e.metadata?.disruption);
    assert.ok(row, "the route recorded the transition");

    const r = await overview();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.disruption, {
      status: "known", state: "CANCELLED", source: "ledger", reportedBy: "traveller",
      recordedAt: row.created_at,
      baselineDepartureTime: row.metadata.disruption.baselineDepartureTime,
      recovery: { recoveryNeeded: true, ...NO_HELP },
    });
  });

  it("3. the NEWEST recorded transition wins: CANCELLED → REBOOKING reads REBOOKING", async () => {
    stage();
    assert.equal((await report({ kind: "cancellation" })).status, 200);
    await tick();
    assert.equal((await report({ kind: "rebooking_offered" })).status, 200);
    const newest = tables.layover_events.filter((e) => e.metadata?.disruption).at(-1);
    const r = await overview();
    assert.equal(r.body.disruption.state, "REBOOKING");
    assert.equal(r.body.disruption.recordedAt, newest.created_at);
  });

  it("4. an UNREADABLE ledger is `unknown` — never `default`/CONNECTION — and the overview still serves the deadline", async () => {
    stage({ failures: { "layover_events:select": { message: "layover_events unavailable" } } });
    const r = await overview();
    assert.equal(r.status, 200, "the disruption memory is not worth the traveller's deadline");
    assert.equal(typeof r.body.window.hardReturnTime, "string");
    assert.equal(r.body.disruption.status, "unknown");
    assert.equal(r.body.disruption.reason, "ledger_unreadable");
    assert.equal(typeof r.body.disruption.message, "string");
    assert.equal(r.body.disruption.state, undefined, "an unknown memory carries no state at all");
  });

  it("5. a ledger row naming a state this build does not know is `unknown`, never read past as CONNECTION", async () => {
    stage({
      events: [{
        id: "e-1", session_id: SESSION, user_id: USER, event_type: DISRUPTION_LEDGER_EVENT_TYPE,
        created_at: new Date().toISOString(), metadata: { disruption: { state: "HOLDING_PATTERN", previousState: "CONNECTION" } },
      }],
    });
    const r = await overview();
    assert.equal(r.status, 200);
    assert.equal(r.body.disruption.status, "unknown");
  });

  it("6. another traveller's report on this session is not this traveller's memory", async () => {
    stage({
      events: [{
        id: "e-2", session_id: SESSION, user_id: OTHER, event_type: DISRUPTION_LEDGER_EVENT_TYPE,
        created_at: new Date().toISOString(), metadata: { disruption: { state: "CANCELLED", previousState: "CONNECTION", baselineDepartureTime: new Date().toISOString() } },
      }],
    });
    const r = await overview();
    assert.equal(r.body.disruption.source, "default");
    assert.equal(r.body.disruption.state, "CONNECTION");
  });
});

describe("L148 — `reportedBy: \"traveller\"` is true because the route is the ledger's only writer", () => {
  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "test" || name === "__tests__" || name === "node_modules") continue;
        out.push(...tsFiles(p));
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("7. `recordDisruptionState(` is called once in production code, inside POST /:id/disruption", () => {
    const root = join(HERE, "..");
    const calls: string[] = [];
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\brecordDisruptionState\s*\(/g)) {
        const lineStart = src.lastIndexOf("\n", m.index!) + 1;
        const before = src.slice(lineStart, m.index);
        if (/^\s*(\*|\/\/)/.test(before) || /function\s+$/.test(before)) continue;
        calls.push(`${relative(root, file)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    assert.equal(calls.length, 1, `a second writer of the disruption ledger must state its source: ${calls.join(", ")}`);
    const [file, line] = calls[0].split(":");
    assert.equal(file.split("\\").join("/"), "routes/airport.ts");
    const src = readFileSync(join(root, "routes", "airport.ts"), "utf8");
    const route = src.indexOf('router.post("/airport/sessions/:id/disruption"');
    const next = src.indexOf("router.", route + 10);
    const at = src.split("\n").slice(0, Number(line) - 1).join("\n").length;
    assert.ok(route > 0 && at > route && at < next, "the one writer is the traveller's report route");
    assert.match(src.slice(route, next), /source: "traveller" as const/);
  });
});
