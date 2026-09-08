/**
 * Send-path guards: what happens when the guard's INPUT cannot be read.
 *
 * Two guards on POST /api/threads/:threadId/messages and .../media were
 * correct in themselves and unreachable in practice:
 *
 *   BLOCK GUARD. `isBlockedBetween` is fail-closed — a blocks-table error is
 *   treated as blocked — but it is only CALLED when the thread roster read
 *   produced exactly one other member. supabase-js RESOLVES on a database
 *   error, so an unreadable message_thread_members gave `data: null`, an empty
 *   roster, `others.length === 0`, and the fail-closed check was never reached.
 *   The message went to someone who may have blocked the sender. A guard's
 *   posture is worth nothing if its input can silently make it unreachable.
 *
 *   E2EE FLAG. `messages.is_e2ee` decides whether the server may store
 *   plaintext. An unchecked `.error` made an unreadable message_threads read as
 *   `is_e2ee: false`, and the handler then demanded a plaintext body and wrote
 *   it into a thread whose whole promise is that the server never sees one.
 *
 * Each test asserts the specific status CODE, not merely "not 201" — a request
 * that died at validation would satisfy the weaker assertion while proving
 * nothing. Each also asserts that no row was written, and the fixture installs
 * a `req.log` shim so an error branch cannot crash the route and pass off a
 * 500-from-crash as fail-closed.
 *
 * Run: node --import tsx/esm --test src/test/messagingSendGuardInputs.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";

const TOKEN = "guard-inputs-token";
const ME = "11111111-0000-0000-0000-00000000000a";
const OTHER = "22222222-0000-0000-0000-00000000000b";
const THREAD = "c1d2e3f4-a5b6-7890-cdef-123456789012";
const MSG = "f1e2d3c4-b5a6-7890-fedc-210987654321";

interface State {
  members: any[];
  threads: Record<string, any>;
  blocks: any[];
  messages: any[];
  /** Rows INSERTED during the request, kept apart from the seeded fixture rows. */
  written: any[];
  translations: any[];
  /** table -> forced SELECT error. */
  selectErrors: Record<string, { message: string } | undefined>;
  /**
   * Narrow the forced error to the roster query only (the one carrying .neq),
   * so the membership check ahead of it still succeeds and the block guard is
   * genuinely the thing under test.
   */
  rosterOnlyError?: { message: string };
  queries: number;
}

let state: State;
let logs: Array<{ level: string; msg: string }> = [];
let server: http.Server;
let base: string;

function fresh(): State {
  return {
    members: [
      { thread_id: THREAD, user_id: ME, left_at: null },
      { thread_id: THREAD, user_id: OTHER, left_at: null },
    ],
    threads: { [THREAD]: { id: THREAD, is_e2ee: false } },
    blocks: [],
    messages: [{ id: MSG, thread_id: THREAD, sender_id: OTHER, body: "hola", deleted_at: null, original_language: "es" }],
    written: [],
    translations: [{ id: "tr-1", message_id: MSG, recipient_id: ME, status: "failed" }],
    selectErrors: {},
    queries: 0,
  };
}

function makeClient() {
  function tbl(t: string) {
    return {
      _t: t,
      _f: [] as Array<[string, string, any]>,
      _ins: null as any,
      _upd: null as any,
      _single: false,
      _hasNeq: false,
      select() { return this; },
      insert(d: any) { this._ins = d; return this; },
      update(d: any) { this._upd = d; return this; },
      eq(c: string, v: any) { this._f.push(["eq", c, v]); return this; },
      neq(c: string, v: any) { this._hasNeq = true; this._f.push(["neq", c, v]); return this; },
      in(c: string, v: any[]) { this._f.push(["in", c, v]); return this; },
      is(c: string, v: any) { this._f.push(["eq", c, v]); return this; },
      or() { return this; },
      order() { return this; },
      limit() { return this; },
      range() { return this; },
      maybeSingle() { this._single = true; return this; },
      single() { this._single = true; return this; },
      then(res: (v: any) => void, rej?: (e: unknown) => void) {
        return Promise.resolve(this._resolve()).then(res, rej);
      },
      _resolve(): any {
        state.queries++;
        if (this._ins !== null) {
          const rows = Array.isArray(this._ins) ? this._ins : [this._ins];
          const made = rows.map((r: any) => ({ id: `w-${state.written.length + 1}`, ...r }));
          if (this._t === "messages") made.forEach((r) => { state.messages.push(r); state.written.push(r); });
          return this._single ? { data: made[0] ?? null, error: null } : { data: null, error: null };
        }
        if (this._upd !== null) return { data: null, error: null };

        if (this._t === "message_thread_members" && this._hasNeq && state.rosterOnlyError) {
          return { data: null, error: state.rosterOnlyError };
        }
        const forced = state.selectErrors[this._t];
        if (forced) return { data: null, count: null, error: forced };

        let rows: any[] = [];
        if (this._t === "message_thread_members") rows = state.members.slice();
        else if (this._t === "message_threads") rows = Object.values(state.threads);
        else if (this._t === "blocks") rows = state.blocks.slice();
        else if (this._t === "messages") rows = state.messages.slice();
        else if (this._t === "message_translations") rows = state.translations.slice();
        else if (this._t === "profiles") rows = [{ id: ME, preferred_language: "en" }, { id: OTHER, preferred_language: "en" }];
        else return this._single ? { data: null, error: null } : { data: [], count: 0, error: null };

        for (const [op, c, v] of this._f) {
          if (op === "eq") rows = rows.filter((r) => r[c] === v);
          else if (op === "neq") rows = rows.filter((r) => r[c] !== v);
          else if (op === "in") rows = rows.filter((r) => (v as any[]).includes(r[c]));
        }
        return this._single ? { data: rows[0] ?? null, error: null } : { data: rows, count: rows.length, error: null };
      },
    };
  }
  return {
    from: (t: string) => tbl(t),
    auth: {
      getUser: async (tok: string) =>
        tok === TOKEN
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

function post(path: string, payload: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
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
    r.write(data);
    r.end();
  });
}

const sendText = () => post(`/api/threads/${THREAD}/messages`, { body: "hello there" });
const sendMedia = () => post(`/api/threads/${THREAD}/media`, { mediaUrl: `post-media/${ME}/p.webp`, mediaType: "image" });
const retryTranslate = () => post(`/api/messages/${MSG}/translate/retry`, {});

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = {
      error: (o: any, m?: string) => logs.push({ level: "error", msg: String(m ?? o) }),
      warn: (o: any, m?: string) => logs.push({ level: "warn", msg: String(m ?? o) }),
      info: () => {},
      debug: () => {},
      child: () => (req as any).log,
    };
    next();
  });
  app.use("/api", messagingRouter);
  // Wrapped for the same reason as the sibling suites: the listen callback is
  // typed `() => void` and a promise resolver is not. Still awaited through the
  // listening callback, which is what makes server.address() safe below.
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = fresh();
  logs = [];
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

const errorLogged = (re: RegExp) => logs.filter((l) => l.level === "error" && re.test(l.msg));

describe("send path — the block guard's input", () => {
  it("positive control: a clean 1:1 send succeeds and writes one message", async () => {
    const r = await sendText();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(state.written.length, 1);
    assert.ok(state.queries > 3, `fixture check: expected the route to issue queries, saw ${state.queries}`);
  });

  it("positive control: a real block on a clean roster still 403s", async () => {
    state.blocks.push({ blocker_id: OTHER, blocked_id: ME });
    const r = await sendText();
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(state.written.length, 0);
  });

  it("an unreadable thread roster REFUSES the send instead of skipping the block check", async () => {
    // The membership check ahead of it still succeeds, so the roster read is
    // genuinely what fails — otherwise this would only be re-proving the 403
    // that the membership check already produces.
    state.rosterOnlyError = { message: "57014 statement timeout" };
    const r = await sendText();

    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(r.body?.retryable, true, "the check could not be performed, so a retry is the right advice");
    assert.equal(state.written.length, 0, "no message may reach a person whose block status is unknown");
    assert.equal(errorLogged(/roster read failed/i).length, 1);
  });

  it("an unreadable thread roster REFUSES a MEDIA send too", async () => {
    state.rosterOnlyError = { message: "57014 statement timeout" };
    const r = await sendMedia();
    assert.equal(r.status, 503, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(state.written.length, 0);
  });
});

describe("send path — the E2EE flag", () => {
  it("positive control: an E2EE thread refuses a plaintext body", async () => {
    state.threads[THREAD].is_e2ee = true;
    const r = await sendText();
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body?.error, "invalid_payload");
    assert.equal(state.written.length, 0);
  });

  it("positive control: an E2EE thread refuses media with e2ee_thread", async () => {
    state.threads[THREAD].is_e2ee = true;
    const r = await sendMedia();
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body?.error, "e2ee_thread");
  });

  it("an unreadable message_threads REFUSES rather than storing plaintext", async () => {
    state.selectErrors["message_threads"] = { message: "08006 connection failure" };
    const r = await sendText();

    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(state.written.length, 0,
      "'we could not read is_e2ee' must never become 'is_e2ee is false' and write plaintext");
    assert.equal(errorLogged(/E2EE flag read failed/i).length, 1);
  });

  it("an unreadable message_threads REFUSES on the media path", async () => {
    state.selectErrors["message_threads"] = { message: "08006 connection failure" };
    const r = await sendMedia();
    assert.equal(r.status, 503, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(state.written.length, 0);
    assert.equal(errorLogged(/E2EE flag read failed on the media path/i).length, 1);
  });

  it("positive control: retrying translation on an E2EE thread returns e2ee_thread", async () => {
    state.threads[THREAD].is_e2ee = true;
    const r = await retryTranslate();
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body?.error, "e2ee_thread");
  });

  it("an unreadable message_threads REFUSES on the translate-retry path", async () => {
    // Third instance of the same shape: the gate exists so the server never
    // processes an E2EE thread's contents, and an unreadable flag skipped it.
    state.selectErrors["message_threads"] = { message: "08006 connection failure" };
    const r = await retryTranslate();
    assert.equal(r.status, 503, `got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(errorLogged(/E2EE flag read failed on the translate path/i).length, 1);
  });
});
