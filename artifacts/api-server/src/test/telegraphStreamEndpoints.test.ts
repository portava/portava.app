/**
 * Realtime stream & typing endpoint tests — HTTP-level.
 *
 * Sections:
 *   A. POST /api/threads/:threadId/typing  (5 tests)
 *   B. Decline message-request emits request.declined — regression  (3 tests)
 *
 * Total: 8
 *
 * Why HTTP-level rather than unit-level:
 *   The in-memory event bus is already unit-tested (telegraphRealtime.test.ts).
 *   These tests exercise the full request path: auth check → membership gate →
 *   fire-and-forget fan-out → event delivered to subscribers.  They would have
 *   caught the decline regression (sender_id missing from select) immediately.
 */

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import telegraphStreamRouter from "../routes/telegraphStream.js";
import messagingRouter from "../routes/messaging.js";

// ---------------------------------------------------------------------------
// HTTP helper (raw node:http — no supertest, firewall-safe)
// ---------------------------------------------------------------------------

function httpReq(
  server: http.Server,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {}),
      },
    };
    const r = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/** One macrotask — enough for fire-and-forget promise chains to flush. */
const tick = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Shared test identifiers
// ---------------------------------------------------------------------------

const THREAD_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";
const REQUEST_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000002";

const ACTOR   = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000001", email: "actor@test.com" };
const OTHER_1 = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000002", email: "other1@test.com" };
const OTHER_2 = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000003", email: "other2@test.com" };
const SENDER  = { id: "bbbbbbbb-bbbb-bbbb-bbbb-000000000004", email: "sender@test.com" };

const TOKEN_ACTOR  = "tok_actor";
const TOKEN_OTHER  = "tok_other";

// ---------------------------------------------------------------------------
// Minimal fake Supabase client
// ---------------------------------------------------------------------------

type FakeRow = Record<string, any>;

/**
 * Project a row to only the columns named in the select() call, exactly as a
 * real DB would.  If the caller passes "*" (or no fields), the full row is
 * returned.  This is what makes the regression test meaningful: if production
 * code omits `sender_id` from `.select(...)`, the projected result won't have
 * the field and `req_.sender_id` will be undefined — matching the original bug.
 */
function projectRow(row: FakeRow, selectArg: string): FakeRow {
  const fields = selectArg.trim();
  if (!fields || fields === "*") return { ...row };
  const cols = fields.split(",").map((f) => f.trim()).filter(Boolean);
  const out: FakeRow = {};
  for (const col of cols) {
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      out[col] = row[col];
    }
  }
  return out;
}

function makeFakeClient(opts: {
  users?: Record<string, { id: string; email: string }>;
  threadMembers?: FakeRow[];
  messageRequests?: FakeRow[];
} = {}) {
  const tableData: Record<string, FakeRow[]> = {
    message_thread_members: opts.threadMembers ?? [],
    message_requests: opts.messageRequests ?? [],
  };

  function makeQuery(table: string) {
    let rows = [...(tableData[table] ?? [])];
    let selectArg = "*";
    let isUpdate = false;
    let isMaybe = false;

    const q: any = {
      select(fields = "*") { selectArg = fields; return q; },
      eq(col: string, val: any) {
        rows = rows.filter((r) => r[col] === val);
        return q;
      },
      is(col: string, val: any) {
        if (val === null) rows = rows.filter((r) => r[col] == null);
        return q;
      },
      order() { return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      maybeSingle() { isMaybe = true; return q; },
      single()      { return q; },
      update(_data: FakeRow) { isUpdate = true; return q; },
      insert(_data: FakeRow | FakeRow[]) { return q; },
      then(resolve: (v: any) => void, _reject?: (e: any) => void) {
        if (isUpdate) return resolve({ data: null, error: null });
        const projected = rows.map((r) => projectRow(r, selectArg));
        if (isMaybe)  return resolve({ data: projected[0] ?? null, error: null });
        return resolve({ data: projected, error: null });
      },
    };
    return q;
  }

  return {
    auth: {
      async getUser(token: string) {
        const u = (opts.users ?? {})[token];
        if (!u) return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: u }, error: null };
      },
    },
    from(table: string) { return makeQuery(table); },
  } as any;
}

// ---------------------------------------------------------------------------
// A. POST /api/threads/:threadId/typing
// ---------------------------------------------------------------------------

let streamServer: http.Server;

describe("A. Typing endpoint — auth, membership gate, event fan-out", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", telegraphStreamRouter);
    streamServer = createServer(app);
    streamServer.listen(0, "127.0.0.1");
    await new Promise<void>((r) => streamServer.once("listening", r));
  });

  after(() => { streamServer?.close(); });
  afterEach(() => { _clearTestClient(); });

  it("A1: 401 without auth token", async () => {
    _setTestClient(makeFakeClient({ users: {} }), true);
    const r = await httpReq(streamServer, "POST", `/api/threads/${THREAD_ID}/typing`, undefined, { typing: true });
    assert.equal(r.status, 401);
  });

  it("A2: 400 for malformed thread UUID", async () => {
    _setTestClient(makeFakeClient({ users: { [TOKEN_ACTOR]: ACTOR } }), true);
    const r = await httpReq(streamServer, "POST", "/api/threads/not-a-uuid/typing", TOKEN_ACTOR, { typing: true });
    assert.equal(r.status, 400);
  });

  it("A3: 403 for non-member of the thread", async () => {
    _setTestClient(makeFakeClient({
      users: { [TOKEN_OTHER]: OTHER_1 },
      threadMembers: [],
    }), true);
    const r = await httpReq(streamServer, "POST", `/api/threads/${THREAD_ID}/typing`, TOKEN_OTHER, { typing: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("A4: 200 and relays typing.started to other members only — actor excluded", async () => {
    _setTestClient(makeFakeClient({
      users: { [TOKEN_ACTOR]: ACTOR },
      threadMembers: [
        { thread_id: THREAD_ID, user_id: ACTOR.id,   left_at: null },
        { thread_id: THREAD_ID, user_id: OTHER_1.id, left_at: null },
        { thread_id: THREAD_ID, user_id: OTHER_2.id, left_at: null },
      ],
    }), true);

    const actorEvents:  TelegraphEvent[] = [];
    const other1Events: TelegraphEvent[] = [];
    const other2Events: TelegraphEvent[] = [];

    const ua = subscribe(ACTOR.id,   (e) => actorEvents.push(e));
    const u1 = subscribe(OTHER_1.id, (e) => other1Events.push(e));
    const u2 = subscribe(OTHER_2.id, (e) => other2Events.push(e));

    try {
      const r = await httpReq(streamServer, "POST", `/api/threads/${THREAD_ID}/typing`, TOKEN_ACTOR, { typing: true });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.typing, true);

      await tick();

      assert.equal(actorEvents.length, 0,  "actor must NOT receive their own typing indicator");
      assert.equal(other1Events.length, 1, "other1 must receive typing.started");
      assert.equal(other2Events.length, 1, "other2 must receive typing.started");
      assert.equal(other1Events[0].type, "typing.started");
      assert.equal((other1Events[0] as any).payload?.userId, ACTOR.id, "payload carries the actor's userId");
      assert.equal(other1Events[0].threadId, THREAD_ID, "event is scoped to the correct thread");
    } finally {
      ua(); u1(); u2();
    }
  });

  it("A5: relays typing.stopped when typing=false", async () => {
    _setTestClient(makeFakeClient({
      users: { [TOKEN_ACTOR]: ACTOR },
      threadMembers: [
        { thread_id: THREAD_ID, user_id: ACTOR.id,   left_at: null },
        { thread_id: THREAD_ID, user_id: OTHER_1.id, left_at: null },
      ],
    }), true);

    const events: TelegraphEvent[] = [];
    const u1 = subscribe(OTHER_1.id, (e) => events.push(e));

    try {
      const r = await httpReq(streamServer, "POST", `/api/threads/${THREAD_ID}/typing`, TOKEN_ACTOR, { typing: false });
      assert.equal(r.status, 200);
      assert.equal(r.body.typing, false);

      await tick();

      assert.equal(events.length, 1);
      assert.equal(events[0].type, "typing.stopped");
    } finally {
      u1();
    }
  });
});

// ---------------------------------------------------------------------------
// B. Decline message-request — request.declined emission regression
//
//   Background: The decline handler originally omitted sender_id from its DB
//   select(), so req_.sender_id was undefined and publishToUsers was never
//   called.  The fix was to include sender_id in the select.  These tests
//   confirm that regression can never silently re-appear.
// ---------------------------------------------------------------------------

let msgServer: http.Server;

describe("B. Decline message-request — request.declined realtime regression", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", messagingRouter);
    msgServer = createServer(app);
    msgServer.listen(0, "127.0.0.1");
    await new Promise<void>((r) => msgServer.once("listening", r));
  });

  after(() => {
    msgServer?.close();
    _clearTestClient();
    _setTestServiceClient(null);
  });

  afterEach(() => {
    _clearTestClient();
    _setTestServiceClient(null);
  });

  it("B1: 200 and body { status: 'declined', requestId } for valid decline", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_ACTOR]: ACTOR },
      messageRequests: [
        { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: ACTOR.id, status: "pending" },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await httpReq(msgServer, "POST", `/api/message-requests/${REQUEST_ID}/decline`, TOKEN_ACTOR);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "declined");
    assert.equal(r.body.requestId, REQUEST_ID);
  });

  it("B2: 403 when caller is not the recipient", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_ACTOR]: ACTOR },
      messageRequests: [
        { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: OTHER_1.id, status: "pending" },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const r = await httpReq(msgServer, "POST", `/api/message-requests/${REQUEST_ID}/decline`, TOKEN_ACTOR);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("B3: emits request.declined to the sender — and only the sender", async () => {
    const client = makeFakeClient({
      users: { [TOKEN_ACTOR]: ACTOR },
      messageRequests: [
        { id: REQUEST_ID, sender_id: SENDER.id, recipient_id: ACTOR.id, status: "pending" },
      ],
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const senderEvents: TelegraphEvent[] = [];
    const actorEvents:  TelegraphEvent[] = [];

    const us = subscribe(SENDER.id, (e) => senderEvents.push(e));
    const ua = subscribe(ACTOR.id,  (e) => actorEvents.push(e));

    try {
      const r = await httpReq(msgServer, "POST", `/api/message-requests/${REQUEST_ID}/decline`, TOKEN_ACTOR);
      assert.equal(r.status, 200);

      // publishToUsers is fire-and-forget after the response is sent;
      // wait one macrotask for the synchronous fake-client chain to flush.
      await tick();

      assert.equal(senderEvents.length, 1, "sender must receive request.declined");
      assert.equal(senderEvents[0].type, "request.declined");
      assert.equal(
        (senderEvents[0] as any).payload?.requestId,
        REQUEST_ID,
        "payload must include the requestId",
      );
      assert.equal(actorEvents.length, 0, "the decliner must not receive their own action");
    } finally {
      us(); ua();
    }
  });
});
