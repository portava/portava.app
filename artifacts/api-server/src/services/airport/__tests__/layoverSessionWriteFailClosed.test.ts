/**
 * census L294 — C2: "Never swallow a schema/data error into plausible empty
 * operational state without structured logging and degraded confidence."
 *
 * THE READ HALF WAS CLOSED (getSession / getActiveSession / listSessions bind
 * `error` and answer `{ ok: false }`, and routes/airport.ts:150-157 refuses).
 * THE WRITE HALF WAS NOT. Every writer in LayoverSessionService collapsed
 *
 *     if (error || !data) return null;
 *
 * — a database that could not be written and a session that does not exist are
 * the same `null` — and every route turned that `null` into
 * **404 "Session not found or already closed"**. On DELETE that told a
 * traveller standing at the gate that the layover they are looking at does not
 * exist; on PATCH it told them their edit was rejected as stale. Neither claim
 * was in evidence: the server never learned anything about the row.
 *
 * Six bare `catch { return … }` blocks stood on top of that (`:187, 229, 255,
 * 367, 387, 416`) — the ones §13.5 and §18 both re-counted and left.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverSessionWriteFailClosed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../../lib/http.js";
import airportRouter from "../../../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import {
  updateSession,
  endSessionWrite,
  createSessionWrite,
  setShareStatus,
  setReturnReminder,
} from "../LayoverSessionService.js";

let server: http.Server;
let base: string;
const TOKEN = "fail-closed-token";
const USER_ID = "user-1";

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    if (payload) headers["content-length"] = Buffer.byteLength(payload).toString();
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let p: any; try { p = JSON.parse(raw); } catch { p = raw; } resolve({ status: res.statusCode ?? 0, body: p }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function stage(failures: Record<string, { message: string }> = {}, sessionOver: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: USER_ID, ...sessionOver })],
    layover_events: [],
    layover_plan_stops: [],
    trip_plan_items: [],
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

const DB_DOWN = { message: "layover_sessions is unreadable (57P01 admin shutdown)" };

// ── The service layer: the two answers must stop being the same value ────────

describe("LayoverSessionService writers — an unwritable table is not an absent session", () => {
  const db = (failures: Record<string, { message: string }>, rows: any[] = [sessionRow({ user_id: USER_ID })]) =>
    makeLayoverDb({ layover_sessions: rows, layover_events: [] }, { failures }) as any;

  it("updateSession: a failed UPDATE refuses, and says why", async () => {
    const r = await updateSession(db({ "layover_sessions:update": DB_DOWN }), "session-1", USER_ID, { checkedBags: true });
    assert.equal(r.ok, false, "a write the database refused must not be reported as 'no such session'");
    assert.match(String((r as any).message), /unreadable|57P01/);
  });

  it("updateSession: no matching live row is still an honest 'no session'", async () => {
    const r = await updateSession(db({}, []), "session-1", USER_ID, { checkedBags: true });
    assert.equal(r.ok, true, "an empty table is a successful read of an empty table");
    assert.equal((r as any).session, null);
  });

  it("endSessionWrite: a failed UPDATE refuses rather than reporting 'already closed'", async () => {
    const r = await endSessionWrite(db({ "layover_sessions:update": DB_DOWN }), "session-1", USER_ID, "completed");
    assert.equal(r.ok, false);
  });

  it("createSessionWrite: a failed INSERT refuses rather than returning an empty create", async () => {
    const r = await createSessionWrite(db({ "layover_sessions:insert": DB_DOWN }, []), {
      userId: USER_ID,
      arrivalTime: new Date(Date.now() + 3_600_000).toISOString(),
      departureTime: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    });
    assert.equal(r.ok, false);
  });

  it("setShareStatus: a failed UPDATE refuses", async () => {
    const r = await setShareStatus(db({ "layover_sessions:update": DB_DOWN }), "session-1", USER_ID, true);
    assert.equal(r.ok, false);
  });

  it("setReturnReminder: a failed UPDATE refuses", async () => {
    const r = await setReturnReminder(db({ "layover_sessions:update": DB_DOWN }), "session-1", USER_ID, new Date().toISOString());
    assert.equal(r.ok, false);
  });
});

// ── The routes: the traveller must not be told their layover does not exist ──

describe("routes/airport.ts — a write that could not be performed is 503, not 404", () => {
  it("PATCH /sessions/:id answers degraded_unavailable when the UPDATE fails", async () => {
    stage({ "layover_sessions:update": DB_DOWN });
    const r = await req("PATCH", "/api/airport/sessions/session-1", { checkedBags: true });
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
  });

  it("PATCH /sessions/:id still answers 404 for a session that is genuinely closed", async () => {
    stage({}, { status: "cancelled" });
    const r = await req("PATCH", "/api/airport/sessions/session-1", { checkedBags: true });
    assert.equal(r.status, 404, "the 404 must survive — this is the case the database DID answer");
  });

  it("DELETE /sessions/:id answers degraded_unavailable when the close write fails", async () => {
    stage({ "layover_sessions:update": DB_DOWN });
    const r = await req("DELETE", "/api/airport/sessions/session-1");
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("PATCH /sessions/:id/share answers degraded_unavailable when the write fails", async () => {
    stage({ "layover_sessions:update": DB_DOWN });
    const r = await req("PATCH", "/api/airport/sessions/session-1/share", { enabled: true });
    assert.equal(r.status, 503, `expected 503, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ── The swallow itself ───────────────────────────────────────────────────────

/**
 * Strip comments before scanning source for a forbidden construct.
 *
 * ADDED BY THE §20 MUTATION PASS. Both source guards below used to be
 * LINE-SHAPED regexes, and a line-shaped regex over a syntax rule is a guard
 * with a documented way round it. Two mutations walked straight through:
 *
 *   - `} catch {` written as `}\n  catch {`   — the routes guard required the
 *     closing brace on the SAME line, so a catch on its own line was invisible.
 *   - `try { … } catch { … }` on one line       — the service guard anchored on
 *     `catch {$`, so an inline bare catch was invisible.
 *
 * Both are things a person writes without meaning anything by it, which is
 * exactly the case a guard has to survive. The rule is now shaped like the
 * syntax it polices: `catch` followed by `{` with any whitespace (newlines
 * included) between them, anywhere in the file, with comments removed first so
 * that PROSE about a bare catch — this block included — is not a finding.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("L294/C2 — no bare catch survives in the layover surface", () => {
  it("routes/airport.ts binds every error it catches", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../routes/airport.ts", import.meta.url), "utf8");
    const code = stripComments(src);
    const bare = [...code.matchAll(/\bcatch\s*\{/g)].map(
      (m) => code.slice(Math.max(0, m.index! - 60), m.index! + 8).replace(/\s+/g, " ").trim(),
    );
    assert.deepEqual(
      bare, [],
      `a catch that does not bind its error cannot log it — C2's "without structured logging":\n${bare.join("\n")}`,
    );
  });
});

describe("the route layer uses the honest writers, not the compatibility shims", () => {
  /**
   * `createSession` and `endSession` still exist, collapsing the two answers
   * again, because `src/test/airport.test.ts` binds those names and this lane
   * does not own that file. Nothing in `routes/` may call them — a future edit
   * that routes back through a shim would restore the 404 silently, and only
   * this assertion would notice.
   */
  it("routes/airport.ts imports createSessionWrite and endSessionWrite, and neither shim", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../../routes/airport.ts", import.meta.url), "utf8");
    const importBlock = src.slice(0, src.indexOf("} from \"../services/airport/LayoverSessionService.js\""));
    const named = importBlock.slice(importBlock.lastIndexOf("import {"));
    assert.match(named, /\bcreateSessionWrite\b/);
    assert.match(named, /\bendSessionWrite\b/);
    assert.ok(!/^\s*createSession,\s*$/m.test(named), "routes must not bind the createSession shim");
    assert.ok(!/^\s*endSession,\s*$/m.test(named), "routes must not bind the endSession shim");
  });
});

describe("LayoverSessionService — no bare catch survives", () => {
  it("the file contains no `catch {` block at all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../LayoverSessionService.ts", import.meta.url), "utf8");
    const code = stripComments(src);
    const bare = [...code.matchAll(/\bcatch\s*\{/g)].map(
      (m) => code.slice(Math.max(0, m.index! - 60), m.index! + 8).replace(/\s+/g, " ").trim(),
    );
    assert.deepEqual(bare, [], `bare catch blocks swallow the error C2 forbids: ${bare.join(" | ")}`);
  });
});
