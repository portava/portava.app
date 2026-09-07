/**
 * Telegraph §7.4 — unsend-before-seen, and the two adjacent AGREED invariants
 * this branch upgraded.
 *
 * Both Telegraph specification documents (v1 and v1_1) are byte-identical for
 * their whole shared body; v1_1 only appends an addendum. Everything asserted
 * here is drawn from that shared body, so it is required by BOTH versions
 * regardless of which the owner rules canonical.
 *
 *   1. §7.4 / §13.1 / §27.1 / §28 — a sender may unsend only while no eligible
 *      recipient has seen the message; one recipient seeing it closes the window
 *      for the whole group. The predicate lives in
 *      telegraph_unsend_message_before_seen (migration 2325), so these tests
 *      assert the ROUTE never substitutes its own answer and never converts an
 *      unreadable receipt table into "nobody has seen it".
 *
 *   2. §7.4 / §29 — a deleted or unsent message is removed from normal
 *      retrieval. Its media must go with it: the reader previously nulled the
 *      body but still returned media_url.
 *
 *   3. §26 / §28 / §29 — a blocked sender's DM is denied. The read that decides
 *      whether to consult the block guard must fail closed.
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest).
 * Run:
 *   node --import tsx/esm --test src/test/telegraphUnsendBeforeSeen.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";

const ALICE_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID     = "bbbbbbbb-0000-0000-0000-000000000002";
const CARL_ID    = "cccccccc-0000-0000-0000-000000000003";
const THREAD_ID  = "dddddddd-0000-0000-0000-000000000001";
const MESSAGE_ID = "eeeeeeee-0000-0000-0000-000000000001";

const SENT_AT = "2026-09-06T12:00:00.000Z";
const BEFORE  = "2026-09-06T11:00:00.000Z";
const AFTER   = "2026-09-06T13:00:00.000Z";

interface FakeState {
  messages?: any[];
  message_threads?: any[];
  message_thread_members?: any[];
  profiles?: any[];
  blocks?: any[];
  /**
   * Injects {data: null, error} on the message_thread_members LIST read only
   * (the awaited-array path), NOT on maybeSingle(). The send handler checks the
   * caller's own membership with maybeSingle() first; failing that too would
   * refuse the send for an unrelated reason and the block-guard assertion would
   * pass without the guard ever being reached.
   */
  thread_members_list_error?: { code?: string; message: string };
  /** Injects {data: null, error} on the unsend RPC. */
  rpc_error?: { code?: string; message: string };
  /** Overrides the RPC's returned envelope (e.g. to a shape with no outcome). */
  rpc_data_override?: any;
  /** Records every RPC call the route made. */
  rpcCalls?: Array<{ fn: string; args: any }>;
}

/**
 * A fake that models the migration-2325 function faithfully enough to prove the
 * route's contract with it: same outcome vocabulary, same seen predicate
 * (last_read_at >= created_at over active members excluding the sender).
 *
 * This is NOT a stand-in provider for the real predicate — the real predicate is
 * SQL and is exercised by the migration's own postconditions plus the live-DB
 * lane. It exists so the ROUTE's handling of each outcome is falsifiable here.
 */
function makeClient(state: FakeState = {}, authUserId = ALICE_ID) {
  const db: Record<string, any[]> = {
    messages: state.messages ?? [],
    message_threads: state.message_threads ?? [],
    message_thread_members: state.message_thread_members ?? [],
    blocks: state.blocks ?? [],
    profiles: state.profiles ?? [
      { id: ALICE_ID, handle: "alice", name: "Alice" },
      { id: BOB_ID, handle: "bob", name: "Bob" },
      { id: CARL_ID, handle: "carl", name: "Carl" },
    ],
    feature_flags: [],
    message_translations: [],
  };

  const rpcCalls = state.rpcCalls ?? [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _deleted = false;
    let _limit: number | null = null;

    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      or() { return b; },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.map(String).includes(String(r[col])));
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      not() { return b; },
      like() { return b; },
      limit(n: number) { _limit = n; return b; },
      order() { return b; },
      insert(payload: any) {
        const row = Array.isArray(payload) ? payload[0] : payload;
        (db[table] ??= []).push({ id: MESSAGE_ID, ...row });
        return b;
      },
      update(patch: any) {
        (db[table] ?? [])
          .filter((r) => filters.every((f) => f(r)))
          .forEach((r) => Object.assign(r, patch));
        return b;
      },
      delete() { _deleted = true; return b; },
      upsert() { return b; },
      maybeSingle(): Promise<{ data: any; error: any }> {
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single(): Promise<{ data: any; error: any }> {
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        // The real shape of a supabase-js failure: it RESOLVES {data:null,error}.
        if (table === "message_thread_members" && state.thread_members_list_error) {
          return Promise.resolve({ data: null, error: state.thread_members_list_error })
            .then(resolve, reject);
        }
        if (_deleted) {
          db[table] = (db[table] ?? []).filter((r) => !filters.every((f) => f(r)));
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const sliced = _limit !== null ? rows.slice(0, _limit) : rows;
        return Promise.resolve({ data: sliced, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  async function rpc(fn: string, args: any) {
    rpcCalls.push({ fn, args });
    if (state.rpc_error) {
      // An error may arrive WITH a payload. The route must key off `error`, not
      // off whether `data` happens to look plausible.
      return {
        data: state.rpc_data_override !== undefined ? state.rpc_data_override : null,
        error: state.rpc_error,
      };
    }
    if (state.rpc_data_override !== undefined) {
      return { data: state.rpc_data_override, error: null };
    }
    if (fn !== "telegraph_unsend_message_before_seen") {
      return { data: null, error: null };
    }

    const msg = (db.messages ?? []).find(
      (m) => m.id === args.p_message_id && m.thread_id === args.p_thread_id,
    );
    if (!msg) return { data: { outcome: "not_found" }, error: null };
    if (msg.sender_id !== args.p_actor_id) {
      return { data: { outcome: "not_sender" }, error: null };
    }
    if (msg.deleted_at || msg.unsent_at) {
      return { data: { outcome: "already_gone" }, error: null };
    }
    const active = (db.message_thread_members ?? []).some(
      (m) =>
        m.thread_id === args.p_thread_id &&
        m.user_id === args.p_actor_id &&
        m.left_at == null,
    );
    if (!active) return { data: { outcome: "not_member" }, error: null };

    const seenBy = (db.message_thread_members ?? []).filter(
      (m) =>
        m.thread_id === args.p_thread_id &&
        m.user_id !== args.p_actor_id &&
        m.left_at == null &&
        m.last_read_at != null &&
        new Date(m.last_read_at) >= new Date(msg.created_at),
    ).length;

    if (seenBy > 0) {
      return { data: { outcome: "seen", seenBy }, error: null };
    }

    const now = "2026-09-06T14:00:00.000Z";
    msg.unsent_at = now;
    msg.deleted_at = now;
    msg.body = "";
    return { data: { outcome: "unsent", unsentAt: now }, error: null };
  }

  return {
    _db: db,
    _rpcCalls: rpcCalls,
    from,
    rpc,
    auth: {
      getUser: async (_token: string) => ({
        data: { user: { id: authUserId } },
        error: null,
      }),
    },
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

let baseUrl = "";
let httpServer: ReturnType<typeof createServer>;

function callApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

before(async () => {
  const app = express();
  app.use(express.json());
  // Production wires req.log via pino-http at the app root; this minimal test
  // app doesn't, so any route path that calls req.log.* would throw a TypeError
  // and fall through to express's default 500 instead of running its OWN error
  // branch. Without this stub the read-failure tests below would pass for the
  // wrong reason — a crash rather than the route's deliberate refusal.
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", messagingRouter);
  httpServer = createServer(app);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = httpServer.address() as any;
  baseUrl = `http://127.0.0.1:${addr.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function install(state: FakeState, authUserId = ALICE_ID) {
  const c = makeClient(state, authUserId);
  // _setTestClient also injects the service client, which is what the unsend
  // route and the block guard both reach for.
  _setTestClient(c as any, true);
  return c;
}

/** Alice sent MESSAGE_ID into a thread she shares with Bob. */
function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    messages: [
      {
        id: MESSAGE_ID,
        thread_id: THREAD_ID,
        sender_id: ALICE_ID,
        body: "meet me at 8",
        created_at: SENT_AT,
        deleted_at: null,
        unsent_at: null,
        msg_type: "text",
      },
    ],
    message_threads: [{ id: THREAD_ID, thread_type: "direct", is_e2ee: false }],
    message_thread_members: [
      { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
      { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
    ],
    ...overrides,
  };
}

const UNSEND_PATH = `/threads/${THREAD_ID}/messages/${MESSAGE_ID}/unsend`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. §7.4 unsend-before-seen
// ─────────────────────────────────────────────────────────────────────────────

describe("Telegraph §7.4 — unsend before seen", () => {
  it("unsends when no recipient has seen the message", async () => {
    const c = install(baseState());
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.unsent, true);
    assert.equal(res.body.id, MESSAGE_ID);

    const msg = c._db.messages[0];
    assert.ok(msg.unsent_at, "unsent_at must be set — it distinguishes unsend from delete (§13.1)");
    assert.ok(msg.deleted_at, "deleted_at must be set so existing readers suppress the row (§7.4)");
    assert.equal(msg.body, "", "body must be redacted, and '' not null (messages.body is NOT NULL)");
  });

  it("REFUSES with 409 once an eligible recipient has seen it", async () => {
    // Bob read the thread AFTER the message was sent.
    const c = install(
      baseState({
        message_thread_members: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: AFTER },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "already_seen");

    const msg = c._db.messages[0];
    assert.equal(msg.unsent_at, null, "a seen message must NOT be unsent (§27.1, §28)");
    assert.equal(msg.deleted_at, null, "a refused unsend must not degrade into a delete");
    assert.equal(msg.body, "meet me at 8", "the body must survive a refused unsend");
  });

  it("a read that predates the message does NOT close the window", async () => {
    install(
      baseState({
        message_thread_members: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: BEFORE },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);
    assert.equal(res.status, 200, "last_read_at before created_at is not 'seen'");
    assert.equal(res.body.unsent, true);
  });

  it("§7.4 group rule: ONE recipient seeing it closes the window for everyone", async () => {
    const c = install(
      baseState({
        message_thread_members: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
          { thread_id: THREAD_ID, user_id: CARL_ID, left_at: null, last_read_at: AFTER },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 409, "one seen recipient out of two must refuse the unsend");
    assert.equal(c._db.messages[0].unsent_at, null);
  });

  it("a DEPARTED member who saw it does not hold the window open", async () => {
    install(
      baseState({
        message_thread_members: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
          {
            thread_id: THREAD_ID,
            user_id: CARL_ID,
            left_at: "2026-09-06T12:30:00.000Z",
            last_read_at: AFTER,
          },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);
    assert.equal(res.status, 200, "an eligible recipient is an ACTIVE member");
  });

  it("the sender's own read does not close their own window", async () => {
    install(
      baseState({
        message_thread_members: [
          { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: AFTER },
          { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);
    assert.equal(res.status, 200, "the sender is not one of their own eligible recipients");
  });

  it("only the sender may unsend", async () => {
    install(baseState(), BOB_ID);
    const res = await callApi("POST", UNSEND_PATH);
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it("an already-deleted message cannot be unsent", async () => {
    install(
      baseState({
        messages: [
          {
            id: MESSAGE_ID,
            thread_id: THREAD_ID,
            sender_id: ALICE_ID,
            body: "",
            created_at: SENT_AT,
            deleted_at: AFTER,
            unsent_at: null,
            msg_type: "text",
          },
        ],
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  it("the route delegates the predicate — it never decides seen-ness itself", async () => {
    const c = install(baseState());
    await callApi("POST", UNSEND_PATH);
    const call = c._rpcCalls.find((r) => r.fn === "telegraph_unsend_message_before_seen");
    assert.ok(call, "the route MUST go through the atomic function (§7.4 race safety)");
    assert.equal(call!.args.p_message_id, MESSAGE_ID);
    assert.equal(call!.args.p_actor_id, ALICE_ID);
    assert.equal(call!.args.p_thread_id, THREAD_ID);
  });

  // ── The read-failure path, with the real {data: null, error} shape ──────────

  it("a FAILED unsend read is not 'nobody has seen it'", async () => {
    const c = install(
      baseState({ rpc_error: { code: "57014", message: "canceling statement due to statement timeout" } }),
    );
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error", "the route's OWN refusal branch must run");
    assert.equal(
      c._db.messages[0].unsent_at,
      null,
      "an unreadable receipt table must never be treated as an unseen message",
    );
    assert.equal(c._db.messages[0].body, "meet me at 8");
  });

  it("an error WINS over a success-looking payload", async () => {
    // Without an explicit `error` check the route would read the payload, see
    // outcome 'unsent', and report success on a call that actually failed.
    const c = install(
      baseState({
        rpc_error: { code: "57014", message: "statement timeout" },
        rpc_data_override: { outcome: "unsent", unsentAt: "2026-09-06T14:00:00.000Z" },
      }),
    );
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error", "the error branch must win");
    assert.notEqual(res.body?.unsent, true, "a failed call must never report success");
    assert.equal(
      c._db.messages[0].unsent_at,
      null,
      "nothing may be marked unsent off a failed call",
    );
  });

  it("an outcome-less response is a failure, not a success", async () => {
    const c = install(baseState({ rpc_data_override: null }));
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error", "the route's OWN refusal branch must run");
    assert.notEqual(res.body?.unsent, true, "a null envelope must never report success");
    assert.equal(c._db.messages[0].unsent_at, null);
  });

  it("an unrecognised outcome is a failure, not a success", async () => {
    const c = install(baseState({ rpc_data_override: { outcome: "something_new" } }));
    const res = await callApi("POST", UNSEND_PATH);

    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "db_error", "the route's OWN refusal branch must run");
    assert.notEqual(res.body?.unsent, true);
    assert.equal(c._db.messages[0].unsent_at, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. §7.4 / §29 — media goes with the message
// ─────────────────────────────────────────────────────────────────────────────

describe("Telegraph §7.4/§29 — a removed message takes its media with it", () => {
  function mediaState(deletedAt: string | null): FakeState {
    return {
      messages: [
        {
          id: MESSAGE_ID,
          thread_id: THREAD_ID,
          sender_id: BOB_ID,
          body: deletedAt ? "" : "look at this",
          created_at: SENT_AT,
          deleted_at: deletedAt,
          unsent_at: deletedAt,
          msg_type: "text",
          subtype: null,
          edited_at: null,
          original_language: "en",
          media_url: "https://media.example/private-asset.jpg",
          media_type: "image",
          media_thumbnail_url: "https://media.example/private-thumb.jpg",
          media_duration_seconds: 12,
          profile: { id: BOB_ID, handle: "bob", name: "Bob" },
        },
      ],
      message_threads: [{ id: THREAD_ID, thread_type: "direct", is_e2ee: false }],
      message_thread_members: [
        { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
        { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
      ],
    };
  }

  it("an unsent media message exposes NO media url to the reader", async () => {
    install(mediaState(AFTER));
    const res = await callApi("GET", `/threads/${THREAD_ID}/messages`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const m = res.body.messages.find((x: any) => x.id === MESSAGE_ID);
    assert.ok(m, "the tombstone row is still listed");
    assert.equal(m.deleted, true);
    assert.equal(m.body, null, "body was already suppressed");
    assert.equal(m.mediaUrl, null, "§29: no revocation bypass via a cached media url");
    assert.equal(m.mediaThumbnailUrl, null, "the thumbnail is the same disclosure");
    assert.equal(m.mediaType, null);
    assert.equal(m.mediaDurationSeconds, null);
  });

  it("a live media message still exposes its media (the fix is not a blanket null)", async () => {
    install(mediaState(null));
    const res = await callApi("GET", `/threads/${THREAD_ID}/messages`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const m = res.body.messages.find((x: any) => x.id === MESSAGE_ID);
    assert.equal(m.deleted, false);
    assert.equal(m.mediaUrl, "https://media.example/private-asset.jpg");
    assert.equal(m.mediaThumbnailUrl, "https://media.example/private-thumb.jpg");
    assert.equal(m.mediaType, "image");
    assert.equal(m.mediaDurationSeconds, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. §26 / §28 / §29 — the block guard fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe("Telegraph §26/§28 — a failed membership read must not skip the block guard", () => {
  it("a send whose member lookup FAILS is refused, not delivered", async () => {
    const c = install({
      messages: [],
      message_threads: [{ id: THREAD_ID, thread_type: "direct", is_e2ee: false }],
      message_thread_members: [
        { thread_id: THREAD_ID, user_id: ALICE_ID, left_at: null, last_read_at: null },
        { thread_id: THREAD_ID, user_id: BOB_ID, left_at: null, last_read_at: null },
      ],
      // Alice blocked Bob. If the member lookup silently yields [], the guard
      // never runs and this message is delivered to someone who blocked her.
      blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }],
      thread_members_list_error: { code: "57014", message: "statement timeout" },
    });

    const res = await callApi("POST", `/threads/${THREAD_ID}/messages`, {
      body: "hello anyway",
    });

    assert.equal(
      res.status,
      500,
      `an unreadable membership table must refuse the send, got ${res.status}`,
    );
    assert.equal(res.body.error, "db_error", "the guard's own fail-closed branch must run");
    assert.equal(
      (c._db.messages ?? []).length,
      0,
      "§28 blocked direct deliveries: 0 — nothing may be written on a failed guard read",
    );
  });
});
