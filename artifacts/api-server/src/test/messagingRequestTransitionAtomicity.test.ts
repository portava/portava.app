/**
 * messagingRequestTransitionAtomicity — the `status !== 'pending'` test was a
 * READ, and the write trusted it.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * POST /message-requests/:id/decline and .../cancel both did:
 *
 *     read the request; if (status !== 'pending') refuse;
 *     update({ status: … }).eq('id', requestId);
 *
 * Between those two statements the request can stop being pending — the sender
 * cancels while the recipient declines, or the recipient accepts and then
 * declines on a double tap. The UPDATE has no opinion about status, so it
 * overwrites whatever landed, and BOTH callers are told they made the
 * transition. Decline additionally publishes `request.declined` to the sender,
 * so a request that was accepted a moment earlier is announced as refused.
 *
 * The repair is a compare-and-swap: `.eq('status','pending')` moves the test
 * into the write, and `.select('id')` is what makes the outcome observable —
 * without it PostgREST returns `data: null` and a caller cannot distinguish one
 * affected row from none.
 *
 * ── WHY THIS TEST EXISTS SEPARATELY ──────────────────────────────────────────
 * This fix was measured once before, and WITHDRAWN — not because it was wrong,
 * but because the fake in telegraphStreamEndpoints.test.ts answered
 * `{data: null, error: null}` for EVERY update regardless of `.select()`, so the
 * swap read as "matched nothing" and reddened two unrelated cases. A double that
 * cannot express a client behaviour will veto the repair of a real defect. The
 * fake was taught the client's actual behaviour in the same change that landed
 * this, and that is why the two arrive together.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * A crash. `invalid_payload` is a 400 in lib/http.ts, so every case asserts
 *    the exact status AND the JSON `error` code, which an unhandled throw
 *    cannot produce; the `req.log` shim is installed so the handler's own
 *    logging is not itself the crash.
 *  * A handler that simply stopped working. Every race case is paired with a
 *    POSITIVE CONTROL on the same fixture with no race, which must still answer
 *    200 and must still flip the stored row.
 *  * The race is simulated at the only point where it is real: the fake mutates
 *    the stored row BETWEEN the handler's read and its update. A fixture that
 *    started the row in the losing state would prove only that the pre-read
 *    guard works, which was never in doubt.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/messagingRequestTransitionAtomicity.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { subscribe } from "../lib/telegraphEvents.js";
import messagingRouter from "../routes/messaging.js";

const SENDER_TOKEN    = "atomicity-sender-token";
const RECIPIENT_TOKEN = "atomicity-recipient-token";
const SENDER_ID    = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const RECIPIENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REQUEST_ID   = "cccccccc-3333-4333-8333-cccccccccccc";

let server: http.Server;
let base: string;

interface State {
  requests: any[];
  /** Applied to the stored row the first time a read of message_requests lands,
   *  i.e. AFTER the handler's guard read and BEFORE its update. That is the race
   *  window, and it is the only honest place to open it. */
  raceAfterRead: Record<string, unknown> | null;
  reads: number;
  updatesAttempted: number;
  /** Rows the last UPDATE actually matched — the number the CAS turns on. */
  lastUpdateMatched: number;
}

let state: State;

function makeClient() {
  function table(t: string) {
    const self: any = {
      _filters: [] as Array<[string, string, any]>,
      _update: null as any,
      _single: false,
      _selected: false,
      select() { self._selected = true; return self; },
      insert() { return self; },
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
          const hit = self._match(state.requests);
          state.lastUpdateMatched = hit.length;
          for (const r of hit) Object.assign(r, self._update);
          // PostgREST: with a trailing .select() an UPDATE returns the affected
          // rows; without one it returns data: null. The whole compare-and-swap
          // turns on that distinction, so the fake honours it.
          if (!self._selected) return { data: null, error: null };
          if (self._single) return { data: hit[0] ? { id: hit[0].id } : null, error: null };
          return { data: hit.map((r: any) => ({ id: r.id })), error: null };
        }
        // DETACHED COPIES, not live references. A real client returns parsed
        // JSON; handing back the stored objects lets a later mutation reach
        // backwards into a read the handler already made. That is not a
        // fidelity nicety here, it is the whole test: with live references the
        // handler's `status !== 'pending'` guard SAW the racing write and
        // refused before reaching its UPDATE, so the compare-and-swap was never
        // exercised and the fixture check caught it.
        const rows = self._match(state.requests).map((r: any) => ({ ...r }));
        state.reads += 1;
        // THE RACE: the handler has now read `pending`. Something else lands
        // before its write does.
        if (state.raceAfterRead && state.reads === 1) {
          Object.assign(state.requests[0], state.raceAfterRead);
        }
        if (self._single) return { data: rows[0] ?? null, error: null };
        return { data: rows, count: rows.length, error: null };
      },
    };
    return self;
  }
  return {
    from: (t: string) => table(t),
    auth: {
      // eslint-disable-next-line @typescript-eslint/require-await
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
    raceAfterRead: null,
    reads: 0,
    updatesAttempted: 0,
    lastUpdateMatched: -1,
  };
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
});

describe("decline — the transition is a compare-and-swap, not a read then a write", () => {
  it("POSITIVE CONTROL: with no race it still declines, flips the row, and tells the sender", async () => {
    const seen: any[] = [];
    const unsub = subscribe(SENDER_ID, (e) => seen.push(e));
    try {
      const r = await decline();
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
      assert.equal(state.requests[0].status, "declined");
      assert.equal(state.lastUpdateMatched, 1, "the swap must match exactly the one pending row");
      assert.equal(seen.filter((e) => e.type === "request.declined").length, 1);
    } finally { unsub(); }
  });

  it("an ACCEPT landing between the read and the write is not overwritten", async () => {
    const seen: any[] = [];
    const unsub = subscribe(SENDER_ID, (e) => seen.push(e));
    try {
      state.raceAfterRead = { status: "accepted" };
      const r = await decline();

      assert.equal(state.updatesAttempted, 1, "fixture check: the handler must have reached its UPDATE");
      assert.equal(state.lastUpdateMatched, 0, "the swap must match nothing once the row left 'pending'");
      assert.equal(r.status, 400, `expected invalid_payload's 400, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(
        r.body?.error, "invalid_payload",
        "an express crash also fails, but with no 'error' field — the code is what distinguishes them",
      );
      assert.equal(
        state.requests[0].status, "accepted",
        "THE POINT: the accept survives. On the pre-fix build the decline overwrote it.",
      );
      assert.equal(
        seen.filter((e) => e.type === "request.declined").length, 0,
        "the sender must not be told they were declined for a request that was accepted",
      );
    } finally { unsub(); }
  });

  it("a CANCEL landing between the read and the write is not overwritten either", async () => {
    state.raceAfterRead = { status: "cancelled" };
    const r = await decline();
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    assert.equal(state.requests[0].status, "cancelled");
  });
});

describe("cancel — same swap, same guarantee", () => {
  it("POSITIVE CONTROL: with no race it still cancels and flips the row", async () => {
    const r = await cancel();
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "cancelled");
    assert.equal(state.requests[0].status, "cancelled");
    assert.equal(state.lastUpdateMatched, 1);
  });

  it("a DECLINE landing between the read and the write is not overwritten", async () => {
    state.raceAfterRead = { status: "declined" };
    const r = await cancel();
    assert.equal(state.updatesAttempted, 1, "fixture check: the handler must have reached its UPDATE");
    assert.equal(state.lastUpdateMatched, 0);
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
    assert.equal(
      state.requests[0].status, "declined",
      "THE POINT: the recipient's decline survives the sender's cancel",
    );
  });

  it("an ACCEPT landing between the read and the write is not overwritten", async () => {
    state.raceAfterRead = { status: "accepted" };
    const r = await cancel();
    assert.equal(r.status, 400);
    assert.equal(state.requests[0].status, "accepted");
  });
});
