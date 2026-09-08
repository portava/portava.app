/**
 * messagingRequestResolutionWrites — "declined" and "cancelled" must be facts,
 * not hopes.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * POST /message-requests/:id/decline and POST /message-requests/:id/cancel each
 * resolved the request with a bare
 *
 *     await sc.from('message_requests').update({ status: … }).eq('id', requestId);
 *
 * — no `.select()`, no `{ error }`. supabase-js RESOLVES on a database error, so
 * an UPDATE that never landed was indistinguishable from one that did, and the
 * handler answered HTTP 200 `{ status: 'declined' }`. Decline went further and
 * published a `request.declined` realtime event to the SENDER. Three parties
 * then disagreed about one fact: the recipient's client dropped the card, the
 * sender was told they had been turned down, and the row was still `pending`, so
 * the next GET /message-requests handed the recipient the same request back.
 * Nothing retried, because nothing observed a failure.
 *
 * Its sibling, POST /message-requests/:id/accept, had already been given a
 * checked compare-and-swap; these two had not.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * `db_error` maps to HTTP 500 in lib/http.ts, so `status !== 200` — and even
 *    `status >= 500` — is satisfied by an express CRASH. Every failure case
 *    therefore asserts the JSON body carries `error: 'db_error'`, which an
 *    unhandled throw cannot produce, and a `req.log` shim is installed so the
 *    handler's own error logging is not itself the crash.
 *  * "No 200" alone would also pass against a handler that simply stopped
 *    working. Each case is paired with a positive control on the SAME fixture
 *    with the write allowed to succeed: 200, and the stored row really flips.
 *  * The decline case additionally asserts what the SENDER saw. On the broken
 *    build the sender's live connection receives `request.declined`; the fixed
 *    build must not announce a transition it did not watch land. That assertion
 *    cannot be satisfied by a crash either — a crash sends nothing, but then the
 *    positive control (which requires the event) fails.
 *  * The failing write is keyed on the UPDATE, not on the table: the same
 *    handler reads `message_requests` twice, and failing the table wholesale
 *    would prove something weaker (it would fail the lookup instead).
 *
 * Run: node --import tsx/esm --test src/test/messagingRequestResolutionWrites.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { subscribe } from "../lib/telegraphEvents.js";
import messagingRouter from "../routes/messaging.js";

const SENDER_TOKEN    = "msg-res-sender-token";
const RECIPIENT_TOKEN = "msg-res-recipient-token";
const SENDER_ID    = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID   = "33333333-3333-4333-8333-333333333333";

let server: http.Server;
let base: string;

interface State {
  requests: any[];
  /** When set, every UPDATE against message_requests resolves with this error. */
  failRequestUpdate: { message: string } | null;
  /** Every UPDATE the fake was asked to perform, error or not. */
  updatesAttempted: number;
}

let state: State;

function makeClient() {
  function table(t: string) {
    const self: any = {
      _t: t,
      _filters: [] as Array<[string, string, any]>,
      _update: null as any,
      _insert: null as any,
      _single: false,
      select() { return self; },
      insert(d: any) { self._insert = d; return self; },
      update(d: any) { self._update = d; return self; },
      delete() { return self; },
      eq(c: string, v: any) { self._filters.push(["eq", c, v]); return self; },
      neq(c: string, v: any) { self._filters.push(["neq", c, v]); return self; },
      in(c: string, v: any[]) { self._filters.push(["in", c, v]); return self; },
      is(c: string, v: any) { self._filters.push(["eq", c, v]); return self; },
      or() { return self; },
      order() { return self; },
      limit() { return self; },
      range() { return self; },
      maybeSingle() { self._single = true; return self; },
      single() { self._single = true; return self; },
      then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
        return Promise.resolve(self._resolve()).then(resolve, reject);
      },
      _match(rows: any[]) {
        let out = rows;
        for (const [op, c, v] of self._filters) {
          if (op === "eq") out = out.filter((r: any) => r[c] === v);
          else if (op === "neq") out = out.filter((r: any) => r[c] !== v);
          else if (op === "in") out = out.filter((r: any) => (v as any[]).includes(r[c]));
        }
        return out;
      },
      _resolve(): any {
        if (t !== "message_requests") {
          return self._single ? { data: null, error: null } : { data: [], count: 0, error: null };
        }
        if (self._update !== null) {
          state.updatesAttempted += 1;
          // The failure is scoped to the WRITE. The reads of this same table in
          // the same handler still answer normally, so a passing test cannot be
          // explained by "the table was unavailable".
          if (state.failRequestUpdate) {
            return { data: null, error: state.failRequestUpdate };
          }
          const hit = self._match(state.requests);
          for (const r of hit) Object.assign(r, self._update);
          if (self._single) return { data: hit[0] ?? null, error: null };
          return { data: hit.map((r: any) => ({ id: r.id })), error: null };
        }
        const rows = self._match(state.requests);
        if (self._single) return { data: rows[0] ?? null, error: null };
        return { data: rows, count: rows.length, error: null };
      },
    };
    return self;
  }
  return {
    from: (t: string) => table(t),
    auth: {
      getUser: async (token: string) => {
        if (token === SENDER_TOKEN)    return { data: { user: { id: SENDER_ID } }, error: null };
        if (token === RECIPIENT_TOKEN) return { data: { user: { id: RECIPIENT_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

function post(path: string, token: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = { _raw: raw }; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

const decline = () => post(`/api/message-requests/${REQUEST_ID}/decline`, RECIPIENT_TOKEN);
const cancel  = () => post(`/api/message-requests/${REQUEST_ID}/cancel`,  SENDER_TOKEN);

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this the handler's own `req.log.error` throws and the express
  // default handler answers 500 — which looks exactly like the refusal the fix
  // is supposed to produce. The shim is what keeps a crash distinguishable.
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", messagingRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  state = {
    requests: [{
      id: REQUEST_ID,
      sender_id: SENDER_ID,
      recipient_id: RECIPIENT_ID,
      status: "pending",
      preview_text: null,
      responded_at: null,
    }],
    failRequestUpdate: null,
    updatesAttempted: 0,
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("POST /message-requests/:id/decline — a failed write is not a decline", () => {
  it("refuses with db_error when the status UPDATE fails, instead of answering 200 'declined'", async () => {
    const seen: any[] = [];
    const unsub = subscribe(SENDER_ID, (e) => seen.push(e));
    try {
      state.failRequestUpdate = { message: "canceling statement due to statement timeout" };
      const r = await decline();

      assert.equal(state.updatesAttempted, 1, "fixture check: the handler must have attempted the UPDATE");
      assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(
        r.body?.error, "db_error",
        `the body must carry the handler's own error code — an express crash also answers 500 ` +
        `but with no 'error' field. Got ${JSON.stringify(r.body)}`,
      );
      assert.notEqual(r.body?.status, "declined", "the response must not claim a decline that did not happen");
      assert.equal(
        state.requests[0].status, "pending",
        "the stored request is still pending — that is the state the response must reflect",
      );
      assert.equal(
        seen.filter((e) => e.type === "request.declined").length, 0,
        "the SENDER must not be told they were declined when the decline never landed",
      );
    } finally { unsub(); }
  });

  it("positive control: a healthy decline answers 200, flips the row, and tells the sender", async () => {
    const seen: any[] = [];
    const unsub = subscribe(SENDER_ID, (e) => seen.push(e));
    try {
      const r = await decline();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body?.status, "declined");
      assert.equal(state.requests[0].status, "declined", "the row must actually be updated");
      // The realtime publish happens after res.end(); give the tick a moment.
      await new Promise((res) => setTimeout(res, 30));
      assert.equal(
        seen.filter((e) => e.type === "request.declined").length, 1,
        "the sender must still receive request.declined on the healthy path",
      );
    } finally { unsub(); }
  });
});

describe("POST /message-requests/:id/cancel — a failed write is not a cancellation", () => {
  it("refuses with db_error when the status UPDATE fails, instead of answering 200 'cancelled'", async () => {
    state.failRequestUpdate = { message: "canceling statement due to statement timeout" };
    const r = await cancel();

    assert.equal(state.updatesAttempted, 1, "fixture check: the handler must have attempted the UPDATE");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body?.error, "db_error",
      `the body must carry the handler's own error code — an express crash also answers 500 ` +
      `but with no 'error' field. Got ${JSON.stringify(r.body)}`,
    );
    assert.notEqual(r.body?.status, "cancelled", "the response must not claim a cancellation that did not happen");
    assert.equal(
      state.requests[0].status, "pending",
      "the request is still pending and still sitting in the recipient's inbox",
    );
  });

  it("positive control: a healthy cancel answers 200 and flips the row", async () => {
    const r = await cancel();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.status, "cancelled");
    assert.equal(state.requests[0].status, "cancelled", "the row must actually be updated");
  });
});
