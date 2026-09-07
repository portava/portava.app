/**
 * Telegraph §14.3 group history bounds — the read side of migration 2400.
 *
 * Spec (identical in v1 and v1_1; v1_1 is a byte-exact superset of v1):
 *   §14.3  "New members do not automatically receive pre-membership history."
 *   §26    "New member reads pre-membership history without policy → DENY"
 *   §29    "No group-add operation that leaks prior DM history."
 *   §30A.20 "A newly added group participant cannot read history outside the
 *          authorized sequence window."
 *
 * THE DEFECT: GET /threads/:id/messages filtered on thread_id plus CURRENT
 * membership and nothing else, and GET /me/threads / GET /me/unread-counts read
 * the same rows the same way, so a member added by syncTripChatMembers could
 * page back through everything said before they existed. Migration 2400 adds
 * message_thread_members.visible_from_at (trigger-set) and the flag
 * telegraph_history_bound_enabled, seeded FALSE.
 *
 * WHAT IS PROVED HERE
 *   - OFF: every reader is byte-identical to before — the membership query
 *     does not even name the new column, and no created_at lower bound is
 *     applied. (A build carrying this code is safe against a DB without 2400.)
 *   - ON: a member with visible_from_at sees only messages created at or after
 *     it — in the thread read, its quoted-reply context, the inbox preview and
 *     unread count, the unread badge, and the saved-messages projection. A
 *     member with NULL visible_from_at (pre-2400 row, or a policy grant) stays
 *     unbounded. The boundary is inclusive.
 *   - An unreadable flag leaves history UNBOUNDED (isFlagEnabled is
 *     false-on-error), which is the deliberate polarity: a DB blip must not
 *     hide messages from every member.
 *   - GET /me/saved-messages re-authorizes at read: departed-thread saves and
 *     deleted messages are excluded, and a failed read is a 500, never an empty
 *     list.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphHistoryBound.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import { withinWindow, visibleFromOf, membershipSelect } from "../services/groupChatHistoryBound.js";

const ALICE = "aaaaaaaa-0000-0000-0000-000000000001"; // founding member, visible_from_at NULL
const BOB   = "bbbbbbbb-0000-0000-0000-000000000002"; // added later, visible_from_at = BOUND
const THREAD_T = "00000000-0000-4000-8000-00000000000a"; // trip thread, both members
const THREAD_U = "00000000-0000-4000-8000-00000000000b"; // trip thread, only pre-window traffic
const THREAD_V = "00000000-0000-4000-8000-00000000000c"; // thread Bob has LEFT

const BOUND = "2026-03-01T00:00:00.000Z";

const M1 = "11111111-0000-0000-0000-000000000001"; // Alice, before window
const M2 = "22222222-0000-0000-0000-000000000002"; // Alice, before window, reply target of M4
const M3 = "33333333-0000-0000-0000-000000000003"; // Alice, exactly at the bound (inclusive)
const M4 = "44444444-0000-0000-0000-000000000004"; // Alice, in window, replies to M2
const M5 = "55555555-0000-0000-0000-000000000005"; // Bob, in window
const U1 = "66666666-0000-0000-0000-000000000006"; // Alice in THREAD_U, before window
const D1 = "77777777-0000-0000-0000-000000000007"; // Alice in THREAD_T, in window, DELETED
const V1 = "88888888-0000-0000-0000-000000000008"; // Alice in THREAD_V (Bob left)

interface State {
  flag?: boolean | null;          // null → no row; boolean → row with that value
  feature_flags_error?: { message: string; code?: string };
  saved_messages_error?: { message: string; code?: string };
  bobLastReadAt?: string | null;
}

function fixture(state: State) {
  const flagRows = state.flag === null || state.flag === undefined
    ? []
    : [{ flag: "telegraph_history_bound_enabled", enabled: state.flag }];
  const db: Record<string, any[]> = {
    feature_flags: flagRows,
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
    ],
    message_threads: [
      { id: THREAD_T, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "T", status: "active",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" },
      { id: THREAD_U, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "U", status: "active",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z", last_message_at: "2026-02-01T00:00:00.000Z" },
      { id: THREAD_V, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "V", status: "active",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-05T00:00:00.000Z", last_message_at: "2026-03-05T00:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: THREAD_T, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD_T, user_id: BOB, role: "member", joined_at: BOUND, left_at: null, last_read_at: state.bobLastReadAt ?? null, muted_at: null, archived_at: null, visible_from_at: BOUND },
      { thread_id: THREAD_U, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD_U, user_id: BOB, role: "member", joined_at: BOUND, left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: BOUND },
      { thread_id: THREAD_V, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD_V, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: "2026-03-06T00:00:00.000Z", last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      msg(M1, THREAD_T, ALICE, "one, before Bob", "2026-02-01T00:00:00.000Z"),
      msg(M2, THREAD_T, ALICE, "two, before Bob (quoted later)", "2026-02-15T00:00:00.000Z"),
      msg(M3, THREAD_T, ALICE, "three, at the bound", BOUND),
      { ...msg(M4, THREAD_T, ALICE, "four, replying to two", "2026-03-10T00:00:00.000Z"), reply_to_id: M2 },
      msg(M5, THREAD_T, BOB, "five, from Bob", "2026-03-11T00:00:00.000Z"),
      msg(U1, THREAD_U, ALICE, "only message in U, before Bob", "2026-02-01T00:00:00.000Z"),
      { ...msg(D1, THREAD_T, ALICE, "", "2026-03-09T00:00:00.000Z"), deleted_at: "2026-03-09T01:00:00.000Z" },
      msg(V1, THREAD_V, ALICE, "in the thread Bob left", "2026-03-05T00:00:00.000Z"),
    ],
    saved_messages: [
      { id: "s1", user_id: BOB, message_id: M1, saved_at: "2026-03-12T00:00:00.000Z" },
      { id: "s2", user_id: BOB, message_id: M4, saved_at: "2026-03-13T00:00:00.000Z" },
      { id: "s3", user_id: BOB, message_id: D1, saved_at: "2026-03-14T00:00:00.000Z" },
      { id: "s4", user_id: BOB, message_id: V1, saved_at: "2026-03-15T00:00:00.000Z" },
    ],
    message_translations: [],
  };
  return db;
}

function msg(id: string, thread_id: string, sender_id: string, body: string, created_at: string) {
  return {
    id, thread_id, sender_id, body, created_at,
    deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
    media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null,
    reply_to_id: null,
  };
}

/** What the fake observed: every select() string per table, and every gte() call. */
interface Observed {
  selects: Array<{ table: string; sel: string }>;
  gte: Array<{ table: string; col: string; val: any }>;
}

function makeClient(state: State) {
  const db = fixture(state);
  const observed: Observed = { selects: [], gte: [] };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    let _head = false;

    const rowsNow = () => {
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (_order) {
        const { col, asc } = _order;
        rows = [...rows].sort((a, b) => {
          const x = Date.parse(a[col]) || 0, y = Date.parse(b[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };

    const injected = (): { message: string; code?: string } | null => {
      if (table === "feature_flags" && state.feature_flags_error) return state.feature_flags_error;
      if (table === "saved_messages" && state.saved_messages_error) return state.saved_messages_error;
      return null;
    };

    const target: any = {
      select(sel?: string, opts?: any) {
        observed.selects.push({ table, sel: sel ?? "" });
        if (opts?.head) _head = true;
        return proxy;
      },
      eq(col: string, val: any)   { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any)   { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      not(col: string, op: string, val: any) { if (op === "is") filters.push((r) => r[col] !== val); return proxy; },
      lt(col: string, val: any)   { filters.push((r) => Date.parse(r[col]) < Date.parse(val)); return proxy; },
      gt(col: string, val: any)   { filters.push((r) => Date.parse(r[col]) > Date.parse(val)); return proxy; },
      gte(col: string, val: any)  {
        observed.gte.push({ table, col, val });
        filters.push((r) => Date.parse(r[col]) >= Date.parse(val));
        return proxy;
      },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number)            { _limit = n; return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      single() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        const rows = rowsNow();
        return Promise.resolve({ data: _head ? null : rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    // Any builder method this fixture does not model (helpers reached through
    // the route — enrichSpans, nameVisibilitySet, count queries) is a no-op
    // that keeps chaining. Unknown tables resolve to [] via db[table] ?? [].
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _observed: observed,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: {
      // The bearer token IS the user id, so one app serves both callers.
      getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }),
    },
  };
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base = "";
let client: ReturnType<typeof makeClient>;

function useState(state: State) {
  client = makeClient(state);
  _setTestClient(client, true);
  return client;
}

async function get(path: string, asUser: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ids = (r: { body: any }) => (r.body.messages as any[]).map((m) => m.id).sort();

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("groupChatHistoryBound helpers", () => {
  it("withinWindow compares instants, inclusive at the bound, null bound admits all", () => {
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", null), true);
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", BOUND), false);
    assert.equal(withinWindow(BOUND, BOUND), true);
    assert.equal(withinWindow("2026-03-01T00:00:00+00:00", BOUND), true, "Postgres spelling of the same instant");
    assert.equal(withinWindow("2026-03-01T01:00:00.000Z", BOUND), true);
    assert.equal(withinWindow(null, BOUND), false, "no created_at is outside the window, never inside it");
    assert.equal(withinWindow("not a date", BOUND), false);
  });

  it("visibleFromOf is null when disabled, when the row is absent, or when the row is unbounded", () => {
    assert.equal(visibleFromOf({ visible_from_at: BOUND }, false), null);
    assert.equal(visibleFromOf(null, true), null);
    assert.equal(visibleFromOf({ visible_from_at: null }, true), null);
    assert.equal(visibleFromOf({ visible_from_at: BOUND }, true), BOUND);
  });

  it("membershipSelect names the column only when enabled", () => {
    assert.equal(membershipSelect("user_id, left_at", false), "user_id, left_at");
    assert.equal(membershipSelect("user_id, left_at", true), "user_id, left_at, visible_from_at");
  });
});

// ── GET /threads/:id/messages ─────────────────────────────────────────────────

describe("GET /threads/:id/messages — §14.3 bound", () => {
  it("flag OFF (the seed): the new member reads the whole history, the query is byte-identical, the column is never named", async () => {
    const c = useState({ flag: false });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [M1, M2, M3, M4, M5, D1].sort());
    const memberSelects = c._observed.selects.filter((s) => s.table === "message_thread_members");
    assert.ok(memberSelects.length > 0);
    for (const s of memberSelects) assert.ok(!s.sel.includes("visible_from_at"), `OFF must not name the column: ${s.sel}`);
    assert.deepEqual(c._observed.gte, [], "OFF must apply no lower bound");
    // And the quoted reply context still quotes the pre-window message.
    const m4 = (r.body.messages as any[]).find((m) => m.id === M4);
    assert.equal(m4.replyToId, M2);
    assert.equal(m4.replyToBody, "two, before Bob (quoted later)");
  });

  it("flag absent (no row): identical to OFF", async () => {
    const c = useState({ flag: null });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.equal((r.body.messages as any[]).length, 6);
    assert.deepEqual(c._observed.gte, []);
  });

  it("flag ON: the new member sees only messages at or after visible_from_at; the bound is in the query", async () => {
    const c = useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [M3, M4, M5, D1].sort(), "M1 and M2 predate Bob; M3 is AT the bound and is visible");
    assert.ok(
      c._observed.gte.some((g) => g.table === "messages" && g.col === "created_at" && g.val === BOUND),
      "the bound must be applied in the messages query, so pagination cannot walk past it",
    );
  });

  it("flag ON: a reply to a pre-window message does not quote it back in", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    const m4 = (r.body.messages as any[]).find((m) => m.id === M4);
    assert.equal(m4.replyToId, M2, "the reference survives (it is a pointer, not content)");
    assert.equal(m4.replyToBody, null, "the quoted body is retrieval by another name and must be withheld");
    assert.equal(m4.replyToSenderName, null);
  });

  it("flag ON: a member with NULL visible_from_at (pre-2400 row / policy grant) stays unbounded", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, ALICE);
    assert.equal(r.status, 200);
    assert.equal((r.body.messages as any[]).length, 6);
    const m4 = (r.body.messages as any[]).find((m) => m.id === M4);
    assert.equal(m4.replyToBody, "two, before Bob (quoted later)");
  });

  it("flag ON: pagination with ?before cannot walk past the bound", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages?before=${encodeURIComponent("2026-03-05T00:00:00.000Z")}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [M3], "only the at-bound message is both before the cursor and inside the window");
  });

  it("flag read ERROR: history stays unbounded (an unreadable flag must not hide messages from everyone)", async () => {
    const c = useState({ flag: true, feature_flags_error: { message: "boom", code: "XX000" } });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.equal((r.body.messages as any[]).length, 6);
    assert.deepEqual(c._observed.gte, []);
  });

  it("non-member is still refused regardless of the flag", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_V}/messages`, BOB);
    assert.equal(r.status, 403);
  });
});

// ── GET /me/threads ───────────────────────────────────────────────────────────

describe("GET /me/threads — preview and unread honour the bound", () => {
  const threadOf = (r: { body: any }, id: string) => (r.body.threads as any[]).find((t) => t.id === id);

  it("flag OFF: preview and unread count include pre-window messages", async () => {
    useState({ flag: false, bobLastReadAt: null });
    const r = await get(`/me/threads`, BOB);
    assert.equal(r.status, 200);
    const t = threadOf(r, THREAD_T);
    assert.equal(t.unreadCount, 4, "M1, M2, M3, M4 — everything not from Bob");
    const u = threadOf(r, THREAD_U);
    assert.ok(u.lastMessagePreview, "U's only message is previewed");
    assert.equal(u.lastMessagePreview.body, "only message in U, before Bob");
    assert.equal(u.unreadCount, 1);
  });

  it("flag ON: pre-window messages are neither previewed nor counted", async () => {
    useState({ flag: true, bobLastReadAt: null });
    const r = await get(`/me/threads`, BOB);
    assert.equal(r.status, 200);
    const t = threadOf(r, THREAD_T);
    assert.equal(t.unreadCount, 2, "M3 (at bound) and M4 only");
    assert.equal(t.lastMessagePreview.body, "five, from Bob");
    const u = threadOf(r, THREAD_U);
    assert.equal(u.lastMessagePreview, null, "U's only message predates Bob — no preview");
    assert.equal(u.unreadCount, 0);
  });

  it("flag ON: the founding member (NULL bound) is unchanged", async () => {
    useState({ flag: true });
    const r = await get(`/me/threads`, ALICE);
    const u = threadOf(r, THREAD_U);
    assert.equal(u.lastMessagePreview.body, "only message in U, before Bob");
  });
});

// ── GET /me/unread-counts ─────────────────────────────────────────────────────

describe("GET /me/unread-counts — the badge honours the bound", () => {
  it("flag OFF: a thread whose only unread message predates the member still counts", async () => {
    useState({ flag: false, bobLastReadAt: null });
    const r = await get(`/me/unread-counts`, BOB);
    assert.equal(r.status, 200);
    // T's last message is Bob's own (not counted); U's last message is Alice's, unread → 1.
    assert.equal(r.body.messages, 1);
  });

  it("flag ON: that thread no longer counts", async () => {
    useState({ flag: true, bobLastReadAt: null });
    const r = await get(`/me/unread-counts`, BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.messages, 0);
  });
});

// ── GET /me/saved-messages ────────────────────────────────────────────────────

describe("GET /me/saved-messages — the read half of saved_messages, re-authorized at read", () => {
  it("flag OFF: returns active-thread, non-deleted saves, newest save first", async () => {
    useState({ flag: false });
    const r = await get(`/me/saved-messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.saved as any[]).map((s) => s.messageId), [M4, M1],
      "D1 is deleted and V1 is in a thread Bob left — neither is returned");
    assert.equal(r.body.saved[0].savedAt, "2026-03-13T00:00:00.000Z");
  });

  it("flag ON: a saved pre-window message is outside the window and is not returned", async () => {
    useState({ flag: true });
    const r = await get(`/me/saved-messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual((r.body.saved as any[]).map((s) => s.messageId), [M4]);
  });

  it("a failed saved_messages read is a 500, never an empty collection", async () => {
    useState({ flag: false, saved_messages_error: { message: "relation unavailable", code: "42P01" } });
    const r = await get(`/me/saved-messages`, BOB);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });

  it("a user with no saves gets an empty list, 200", async () => {
    useState({ flag: false });
    const r = await get(`/me/saved-messages`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.saved, []);
  });
});
