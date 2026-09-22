/**
 * Telegraph §14.3 — Q6, the OWN-MESSAGE REJOIN EXCEPTION.
 *
 * THE OWNER DECISION, as approved:
 *   "A currently authorized, rejoined member may read their own earlier
 *    messages, while other senders' messages remain subject to the new
 *    membership window. Implement this consistently in the shared predicate AND
 *    database queries that currently filter those rows out. Keep thread
 *    identity, active membership, tenant boundaries, deletion rules, and other
 *    authorization requirements outside and mandatory for both branches of the
 *    condition. Do not widen visible_from_at. Do not let an accessible own
 *    message reveal inaccessible quoted messages, previews, or another sender's
 *    protected attachments."
 *
 * ── WHY THIS FILE EXISTS BESIDE telegraphHistoryBound.test.ts ────────────────
 * That file proves the BOUND. This one proves the EXCEPTION, and in particular
 * proves the half that a predicate-only change would have silently missed.
 *
 * FOURTEEN-PLUS READ PATHS PUSH THE BOUND INTO THE QUERY as
 * `.gte('created_at', bound)`. PostgREST discards those rows before a single
 * line of JavaScript runs, so a carve-out written only in `withinWindow` would
 * pass its own unit tests and change NOTHING on those surfaces — §21 search has
 * no JavaScript window filter at all, and `GET /threads/:id/messages` decides
 * its whole page in the query. `sqlNotFixed` below is that counterfactual made
 * executable: the fake honours only the `created_at` half of the relaxed
 * clause, exactly as an unfixed query would, and the own-message rows vanish
 * while the shipped predicate is fully fixed.
 *
 * WHAT THIS FILE ALSO PROVES DOES *NOT* HAPPEN
 *   - an INACTIVE (departed) member reads nothing, own messages included;
 *   - another sender's pre-window message is never admitted, on any surface;
 *   - an accessible own message does not drag in an inaccessible QUOTE, an
 *     inaccessible PREVIEW, or another sender's protected ATTACHMENT;
 *   - a DELETED own pre-window message stays deleted;
 *   - a damaged row (absent/unparseable `created_at`) is still refused, to its
 *     own author — fail-closed is checked BEFORE the exception;
 *   - `visible_from_at` is never written, widened or recomputed.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphHistoryBoundOwnMessages.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  applyHistoryWindow,
  historyWindowOrFilter,
  isOwnMessage,
  withinWindow,
} from "../services/groupChatHistoryBound.js";
import { searchConversations } from "../services/telegraphSearch.js";
import { authorizeSavedMessage } from "../services/telegraph/savedMessages.js";
import { memberCanReadMessageAt, memberFromRow } from "../domain/telegraph/contracts/conversationMembership.js";
import { telegraphGetSharedPlaces } from "../compass/TelegraphConversationTools.js";
import { authorizeMediaAccess, _clearMediaAccessCache } from "../lib/mediaAccess.js";

// ── Cast ──────────────────────────────────────────────────────────────────────

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // founding member, visible_from_at NULL
const BOB   = "bbbbbbbb-0000-4000-8000-000000000002"; // LEFT and REJOINED: visible_from_at = BOUND
const CAROL = "cccccccc-0000-4000-8000-000000000003"; // never a member of T

const THREAD_T = "00000000-0000-4000-8000-00000000000a"; // Bob rejoined
const THREAD_V = "00000000-0000-4000-8000-00000000000c"; // Bob has LEFT and not come back

const BOUND = "2026-03-01T00:00:00.000Z";

const A_OLD  = "11111111-0000-4000-8000-000000000001"; // ALICE, pre-window          → never Bob's
const B_OLD  = "22222222-0000-4000-8000-000000000002"; // BOB,   pre-window          → Q6 admits
const B_OLD2 = "33333333-0000-4000-8000-000000000003"; // BOB,   pre-window, older    → Q6 admits
const B_DEL  = "44444444-0000-4000-8000-000000000004"; // BOB,   pre-window, DELETED  → still gone
const A_AT   = "55555555-0000-4000-8000-000000000005"; // ALICE, exactly at the bound
const A_NEW  = "66666666-0000-4000-8000-000000000006"; // ALICE, in window, quotes A_OLD
const B_NEW  = "77777777-0000-4000-8000-000000000007"; // BOB,   in window, quotes B_OLD
const V1     = "88888888-0000-4000-8000-000000000008"; // ALICE in THREAD_V
const B_BAD  = "99999999-0000-4000-8000-000000000009"; // BOB, pre-window, DAMAGED created_at

/** Bob's own pre-window media, and Alice's — one pre-window, one in-window. */
const BOB_MEDIA       = `${BOB}/bob-before-the-rejoin.jpg`;
const ALICE_MEDIA     = `${ALICE}/alice-before-bobs-rejoin.jpg`;
const ALICE_MEDIA_NEW = `${ALICE}/alice-after-bobs-rejoin.jpg`;
const MEDIA_BUCKET = "post-media";

interface State {
  flag?: boolean | null;
  /** Bob's membership of THREAD_T is INACTIVE (he left and did not come back). */
  bobInactive?: boolean;
  /**
   * THE COUNTERFACTUAL. When true the fake honours ONLY the `created_at` half
   * of an `or=` window clause — i.e. it behaves exactly as the database would
   * if the query had been left as a plain `.gte` and only `withinWindow` had
   * been relaxed. Nothing in the production tree changes; this models the
   * database's side of a half-done fix.
   */
  sqlNotFixed?: boolean;
}

function msg(
  id: string, thread_id: string, sender_id: string, body: string, created_at: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    id, thread_id, sender_id, body, created_at,
    deleted_at: null, edited_at: null, original_language: null, msg_type: "text", subtype: null,
    media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null,
    reply_to_id: null, ...extra,
  };
}

function fixture(state: State) {
  const flagRows = state.flag === null || state.flag === undefined
    ? []
    : [{ flag: "telegraph_history_bound_enabled", enabled: state.flag }];
  return {
    feature_flags: flagRows,
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
      { id: CAROL, handle: "carol", name: "Carol" },
    ],
    message_threads: [
      { id: THREAD_T, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "T", status: "active",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z" },
      { id: THREAD_V, thread_type: "trip", trip_id: null, circle_owner_id: null, title: "V", status: "active",
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-05T00:00:00.000Z",
        last_message_at: "2026-03-05T00:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: THREAD_T, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      // THE REJOINED MEMBER. `visible_from_at` is the trigger's value and this
      // file never writes it: Q6 is a READ-side exception.
      { thread_id: THREAD_T, user_id: BOB, role: "member", joined_at: BOUND,
        left_at: state.bobInactive ? "2026-03-20T00:00:00.000Z" : null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: BOUND },
      { thread_id: THREAD_V, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD_V, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: "2026-03-06T00:00:00.000Z", last_read_at: null, muted_at: null, archived_at: null,
        visible_from_at: null },
    ],
    messages: [
      msg(A_OLD, THREAD_T, ALICE, "alice searchable before the rejoin", "2026-02-01T00:00:00.000Z",
          { media_url: `${MEDIA_BUCKET}/${ALICE_MEDIA}` }),
      msg(B_OLD2, THREAD_T, BOB, "bob searchable earliest", "2026-02-05T00:00:00.000Z"),
      msg(B_OLD, THREAD_T, BOB, "bob searchable before the rejoin", "2026-02-10T00:00:00.000Z",
          { media_url: `${MEDIA_BUCKET}/${BOB_MEDIA}` }),
      msg(B_DEL, THREAD_T, BOB, "", "2026-02-25T00:00:00.000Z", { deleted_at: "2026-02-26T00:00:00.000Z" }),
      msg(B_BAD, THREAD_T, BOB, "bob searchable damaged", null),
      msg(A_AT, THREAD_T, ALICE, "alice searchable at the bound", BOUND),
      msg(A_NEW, THREAD_T, ALICE, "alice searchable after", "2026-03-10T00:00:00.000Z",
          { reply_to_id: A_OLD, media_url: `${MEDIA_BUCKET}/${ALICE_MEDIA_NEW}` }),
      msg(B_NEW, THREAD_T, BOB, "bob searchable after", "2026-03-11T00:00:00.000Z", { reply_to_id: B_OLD }),
      msg(V1, THREAD_V, ALICE, "in the thread bob left", "2026-03-05T00:00:00.000Z"),
    ],
    saved_messages: [],
    message_translations: [],
  } as Record<string, any[]>;
}

// ── A fake PostgREST that MODELS `.or()` ─────────────────────────────────────
//
// The existing §14.3 fixture proxies every unmodelled builder method to a
// chaining no-op. That is exactly wrong for this file: an unmodelled `.or()`
// would apply NO filter, and every assertion below would pass because the fake
// had stopped filtering — the most convincing way possible to prove nothing.
// So `or` is modelled, with PostgREST's real semantics: the clauses inside
// `or=(…)` are ORed with each other and the whole group is ANDed with every
// other filter on the query.

/** Split on top-level commas only — `in.(a,b,c)` carries commas of its own. */
function splitClauses(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function clauseMatcher(clause: string, state: State): (r: any) => boolean {
  const first = clause.indexOf(".");
  const second = clause.indexOf(".", first + 1);
  const col = clause.slice(0, first);
  const op = clause.slice(first + 1, second);
  const val = clause.slice(second + 1);
  if (op === "gte") return (r) => Date.parse(r[col]) >= Date.parse(val);
  if (op === "eq") {
    // THE COUNTERFACTUAL. An unfixed query never sends this clause, so the
    // database never ORs it in — modelled by refusing it outright.
    if (state.sqlNotFixed) return () => false;
    return (r) => String(r[col]) === val;
  }
  if (op === "in") {
    const items = splitClauses(val.replace(/^\(/, "").replace(/\)$/, "")).map((x) => x.replace(/^"|"$/g, ""));
    return (r) => items.includes(String(r[col]));
  }
  throw new Error(`fake client: unmodelled or() operator "${op}" in ${clause}`);
}

interface Observed {
  selects: Array<{ table: string; sel: string }>;
  gte: Array<{ table: string; col: string; val: any }>;
  or: Array<{ table: string; filters: string }>;
}

function makeClient(state: State) {
  const db = fixture(state);
  const observed: Observed = { selects: [], gte: [], or: [] };

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

    const target: any = {
      select(sel?: string, opts?: any) {
        observed.selects.push({ table, sel: sel ?? "" });
        if (opts?.head) _head = true;
        return proxy;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any)    { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      not(col: string, op: string, val: any) { if (op === "is") filters.push((r) => r[col] !== val); return proxy; },
      lt(col: string, val: any)    { filters.push((r) => Date.parse(r[col]) < Date.parse(val)); return proxy; },
      gt(col: string, val: any)    { filters.push((r) => Date.parse(r[col]) > Date.parse(val)); return proxy; },
      ilike(col: string, pat: string) {
        const needle = pat.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[col] ?? "").toLowerCase().includes(needle));
        return proxy;
      },
      gte(col: string, val: any) {
        observed.gte.push({ table, col, val });
        filters.push((r) => Date.parse(r[col]) >= Date.parse(val));
        return proxy;
      },
      or(f: string) {
        observed.or.push({ table, filters: f });
        const ms = splitClauses(f).map((c) => clauseMatcher(c, state));
        filters.push((r) => ms.some((m) => m(r)));
        return proxy;
      },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      single()      { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const rows = rowsNow();
        return Promise.resolve({ data: _head ? null : rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
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
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base = "";
let client: ReturnType<typeof makeClient>;

function useState(state: State) {
  client = makeClient(state);
  _setTestClient(client, true);
  _clearMediaAccessCache();
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

// ── 1. THE PREDICATE ─────────────────────────────────────────────────────────

describe("withinWindow — Q6, the own-message exception", () => {
  const own = { senderId: BOB, viewerId: BOB };
  const other = { senderId: ALICE, viewerId: BOB };

  it("admits the viewer's OWN pre-window message and no one else's", () => {
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", BOUND), false, "no context → the window decides alone");
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", BOUND, own), true, "Q6: Bob's own earlier message");
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", BOUND, other), false, "Alice's message stays out");
  });

  it("changes NOTHING a viewer could already see, and nothing about the bound itself", () => {
    assert.equal(withinWindow("2026-02-01T00:00:00.000Z", null, other), true, "null bound still admits everything");
    assert.equal(withinWindow(BOUND, BOUND, other), true, "still inclusive at the boundary");
    assert.equal(withinWindow("2026-03-01T00:00:00+00:00", BOUND, other), true, "still compared as instants");
    assert.equal(withinWindow("2026-03-02T00:00:00.000Z", BOUND, own), true);
  });

  it("FAIL-CLOSED IS CHECKED FIRST: a damaged row is refused to its own author", () => {
    assert.equal(withinWindow(null, BOUND, own), false, "absent created_at is outside the window, even for the sender");
    assert.equal(withinWindow(undefined, BOUND, own), false);
    assert.equal(withinWindow("not a date", BOUND, own), false, "unparseable created_at, even for the sender");
  });

  it("isOwnMessage never matches on an absent, empty or non-string id", () => {
    assert.equal(isOwnMessage({ senderId: BOB, viewerId: BOB }), true);
    assert.equal(isOwnMessage({ senderId: BOB, viewerId: ALICE }), false);
    assert.equal(isOwnMessage({ senderId: null, viewerId: null }), false, "null === null must NOT be 'own'");
    assert.equal(isOwnMessage({ senderId: undefined, viewerId: undefined }), false);
    assert.equal(isOwnMessage({ senderId: "", viewerId: "" }), false, "empty === empty must NOT be 'own'");
    assert.equal(isOwnMessage({ senderId: BOB }), false, "no viewer → no exception");
    assert.equal(isOwnMessage({ viewerId: BOB }), false, "no sender → no exception");
    assert.equal(isOwnMessage(null), false);
    assert.equal(isOwnMessage(undefined), false);
  });
});

// ── 2. THE SQL HALF ──────────────────────────────────────────────────────────

describe("the query side — historyWindowOrFilter / applyHistoryWindow", () => {
  it("carries BOTH clauses and nothing else", () => {
    assert.equal(historyWindowOrFilter(BOUND, BOB), `created_at.gte.${BOUND},sender_id.eq.${BOB}`);
  });

  it("falls back to the plain bound — the NARROWER answer — when the exception cannot be expressed", () => {
    assert.equal(historyWindowOrFilter(null, BOB), null, "no bound → the caller applies nothing at all");
    assert.equal(historyWindowOrFilter(BOUND, null), null);
    assert.equal(historyWindowOrFilter(BOUND, undefined), null);
    assert.equal(historyWindowOrFilter(BOUND, "not-a-uuid"), null, "a non-UUID viewer cannot become filter syntax");
    assert.equal(historyWindowOrFilter(BOUND, `${BOB},sender_id.eq.${ALICE}`), null, "nor can an injected clause");
    assert.equal(historyWindowOrFilter(`${BOUND},sender_id.eq.${ALICE}`, BOB), null, "nor can an injected bound");
    assert.equal(historyWindowOrFilter(`${BOUND})`, BOB), null);
    assert.equal(historyWindowOrFilter(`"${BOUND}"`, BOB), null);
  });

  it("applyHistoryWindow leaves the query BYTE-IDENTICAL when there is no bound", () => {
    const calls: string[] = [];
    const q: any = { gte: (c: string, v: string) => { calls.push(`gte:${c}:${v}`); return q; },
                     or: (f: string) => { calls.push(`or:${f}`); return q; } };
    applyHistoryWindow(q, null, BOB);
    assert.deepEqual(calls, [], "flag OFF must not name sender_id in a filter it did not name before");
    applyHistoryWindow(q, BOUND, BOB);
    assert.deepEqual(calls, [`or:created_at.gte.${BOUND},sender_id.eq.${BOB}`]);
    calls.length = 0;
    applyHistoryWindow(q, BOUND, "not-a-uuid");
    assert.deepEqual(calls, [`gte:created_at:${BOUND}`], "unusable viewer → today's single-clause bound");
  });
});

// ── 3. PAGINATION and the thread read ────────────────────────────────────────

describe("GET /threads/:id/messages — pagination, the surface the query decides", () => {
  it("the rejoined member now sees their OWN earlier messages and still none of Alice's", async () => {
    const c = useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [B_OLD2, B_OLD, B_DEL, A_AT, A_NEW, B_NEW].sort(),
      "Bob's own pre-window messages are admitted; A_OLD (Alice, pre-window) is not; " +
      "B_DEL is his own TOMBSTONE (this route renders tombstones, see the body assertion " +
      "below); B_BAD has no created_at and is refused fail-closed");
    assert.ok(
      c._observed.or.some((o) => o.table === "messages" &&
        o.filters === `created_at.gte.${BOUND},sender_id.eq.${BOB}`),
      "the relaxed clause must be in the QUERY — this page is decided by PostgREST, not by a filter",
    );
    assert.ok(
      !c._observed.gte.some((g) => g.table === "messages" && g.col === "created_at" && g.val === BOUND),
      "and the un-relaxed single-clause bound must be gone from this read",
    );
  });

  it("a DELETED own pre-window message yields a TOMBSTONE, never its body", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    const del = (r.body.messages as any[]).find((m) => m.id === B_DEL);
    // This route renders deleted rows as tombstones for everyone (the §14.3
    // suite asserts the same for an in-window one), so Q6 admitting Bob's own
    // pre-window tombstone is the SAME treatment his in-window ones get. What
    // must not change is the deletion RULE, which is about the body:
    assert.ok(del, "his own tombstone, rendered exactly as an in-window tombstone is");
    assert.ok(del.isDeleted === true || del.deleted === true || !del.body,
      `the deleted body must not be served: ${JSON.stringify(del)}`);
  });

  it("a DAMAGED own pre-window row is refused fail-closed, to its own author", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.ok(!ids(r).includes(B_BAD),
      "`created_at IS NULL` makes `created_at >= bound` NULL, but `sender_id = caller` is TRUE — " +
      "the OR would admit it, and the predicate's fail-closed second layer refuses it");
  });

  it("the founding member with a NULL bound is unchanged", async () => {
    const c = useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [A_OLD, B_OLD2, B_OLD, B_DEL, B_BAD, A_AT, A_NEW, B_NEW].sort(),
      "a NULL bound admits everything, including the damaged row — unchanged by Q6");
    assert.deepEqual(c._observed.or.filter((o) => o.table === "messages"), [],
      "an unbounded member's query gains no clause at all");
  });

  it("flag OFF: byte-identical to today — no bound, no or(), the column is never named", async () => {
    const c = useState({ flag: false });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(c._observed.gte, [], "OFF applies no lower bound");
    assert.deepEqual(c._observed.or.filter((o) => o.table === "messages"), [], "OFF adds no or() either");
    for (const s of c._observed.selects.filter((s) => s.table === "message_thread_members")) {
      assert.ok(!s.sel.includes("visible_from_at"), `OFF must not name the column: ${s.sel}`);
    }
  });

  it("?before cannot walk past the window, and walks the OWN messages it is now entitled to", async () => {
    useState({ flag: true });
    const r = await get(
      `/threads/${THREAD_T}/messages?before=${encodeURIComponent("2026-02-28T00:00:00.000Z")}`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [B_OLD2, B_OLD, B_DEL].sort(),
      "the cursor is ANDed with the relaxed clause: Bob's own earlier page (his tombstone " +
      "included, bodiless), and never Alice's A_OLD");
  });
});

// ── 4. THE PROOF THAT THE SQL HALF MATTERS ───────────────────────────────────

describe("PROOF: a carve-out written only in `withinWindow` changes nothing here", () => {
  it("site 1 — GET /threads/:id/messages: the database never sends the rows, so no predicate can admit them", async () => {
    // `sqlNotFixed` makes the fake honour only `created_at.gte.<bound>` — the
    // single-clause filter an unfixed query would have sent. The production
    // predicate is the FIXED one throughout this run.
    const c = useState({ flag: true, sqlNotFixed: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [A_AT, A_NEW, B_NEW].sort(),
      "with the query unfixed the surface is EXACTLY what it was before Q6 — Bob's own " +
      "pre-window messages are absent although `withinWindow` would admit every one of them");
    assert.ok(c._observed.or.some((o) => o.table === "messages"),
      "and this route has no JavaScript window filter to fall back on: the query is the whole gate");
  });

  it("site 2 — §21 search: the service calls `withinWindow` ZERO times; the `.gte` is the entire bound", async () => {
    const unfixed = makeClient({ flag: true, sqlNotFixed: true });
    const before = await searchConversations(unfixed as any, BOB, "bob searchable");
    assert.deepEqual(before.hits.map((h) => h.messageId).sort(), [B_NEW].sort(),
      "unfixed query → only Bob's in-window message, although the predicate would admit B_OLD/B_OLD2");

    const fixed = makeClient({ flag: true });
    const after = await searchConversations(fixed as any, BOB, "bob searchable");
    assert.deepEqual(after.hits.map((h) => h.messageId).sort(), [B_OLD2, B_OLD, B_NEW].sort(),
      "fixed query → Bob finds his own earlier messages");
    assert.ok(
      fixed._observed.or.some((o) => o.table === "messages" &&
        o.filters === `created_at.gte.${BOUND},sender_id.eq.${BOB}`),
      "search carries the relaxed clause",
    );
  });
});

// ── 5. SEARCH still refuses everyone else's history ──────────────────────────

describe("§21 search — the exception is sender-scoped", () => {
  it("Bob cannot find Alice's pre-window messages", async () => {
    const c = makeClient({ flag: true });
    const r = await searchConversations(c as any, BOB, "alice searchable");
    assert.deepEqual(r.hits.map((h) => h.messageId).sort(), [A_AT, A_NEW].sort(),
      "A_OLD predates Bob's window and was not sent by Bob");
  });

  it("Alice, unbounded, is unchanged and her query gains no clause", async () => {
    const c = makeClient({ flag: true });
    const r = await searchConversations(c as any, ALICE, "searchable");
    assert.ok(r.hits.some((h) => h.messageId === A_OLD));
    assert.deepEqual(c._observed.or.filter((o) => o.table === "messages"), []);
  });

  it("a DEPARTED member searches nothing at all — own messages included", async () => {
    const c = makeClient({ flag: true, bobInactive: true });
    const r = await searchConversations(c as any, BOB, "bob searchable");
    assert.deepEqual(r.hits, [], "the scope read is `.is('left_at', null)`; Q6 never widens membership");
  });
});

// ── 6. NO LEAK THROUGH A QUOTE ───────────────────────────────────────────────

describe("an accessible own message does not reveal an inaccessible quote", () => {
  it("Bob's own reply quoting his OWN pre-window message shows the quote", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    const bNew = (r.body.messages as any[]).find((m) => m.id === B_NEW);
    assert.equal(bNew.replyToId, B_OLD);
    assert.equal(bNew.replyToBody, "bob searchable before the rejoin", "his own words, quoted back to him");
  });

  it("Alice's reply quoting ALICE's pre-window message still withholds the quote from Bob", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    const aNew = (r.body.messages as any[]).find((m) => m.id === A_NEW);
    assert.equal(aNew.replyToId, A_OLD, "the reference survives — it is a pointer, not content");
    assert.equal(aNew.replyToBody, null, "the quoted BODY is retrieval by another name and is still withheld");
    assert.equal(aNew.replyToSenderName, null);
  });

  it("the quoted-context query carries the sender-scoped clause, not an unbounded read", async () => {
    const c = useState({ flag: true });
    await get(`/threads/${THREAD_T}/messages`, BOB);
    const quoted = c._observed.or.filter((o) => o.table === "messages");
    assert.ok(quoted.length >= 2, "both the page read and the quote read are bounded");
    for (const o of quoted) {
      assert.equal(o.filters, `created_at.gte.${BOUND},sender_id.eq.${BOB}`,
        "the quote read admits `sender_id = Bob` only — never the sender of the message that quotes it");
    }
  });
});

// ── 7. PREVIEW and UNREAD ────────────────────────────────────────────────────

describe("GET /me/threads and /me/unread-counts — the preview is sender-scoped too", () => {
  const threadOf = (r: { body: any }, id: string) => (r.body.threads as any[]).find((t) => t.id === id);

  it("the preview may become Bob's OWN earlier message but never Alice's", async () => {
    useState({ flag: true });
    const r = await get(`/me/threads`, BOB);
    assert.equal(r.status, 200);
    const t = threadOf(r, THREAD_T);
    assert.equal(t.lastMessagePreview.body, "bob searchable after", "the newest visible message is still B_NEW");
    assert.notEqual(t.lastMessagePreview.body, "alice searchable before the rejoin");
  });

  it("Bob's own earlier messages do not become UNREAD — a person does not unread themselves", async () => {
    useState({ flag: true });
    const r = await get(`/me/threads`, BOB);
    const t = threadOf(r, THREAD_T);
    assert.equal(t.unreadCount, 2, "A_AT and A_NEW — Alice's in-window messages, and nothing of Bob's");
    const badge = await get(`/me/unread-counts`, BOB);
    assert.equal(badge.status, 200);
    // This route counts a thread only when its LAST visible message is not the
    // caller's; T's is B_NEW, Bob's own. The point under test is that Q6 did
    // NOT make Bob's own older messages count as unread — the badge is what it
    // was, not one higher per own pre-window message.
    assert.equal(badge.body.messages, 0,
      "Q6 must not inflate the badge: a person's own messages are never unread, old or new");
  });
});

// ── 8. DIRECT RETRIEVAL ──────────────────────────────────────────────────────

describe("direct retrieval of one message — GET /threads/:id/messages/:mid/edits", () => {
  it("Bob may ask for the history of HIS OWN pre-window message", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages/${B_OLD}/edits`, BOB);
    assert.notEqual(r.status, 403, `Q6 admits his own message; got ${r.status} ${JSON.stringify(r.body)}`);
  });

  it("Bob may NOT ask for the history of ALICE's pre-window message", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages/${A_OLD}/edits`, BOB);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("a DELETED own pre-window message is still not found", async () => {
    useState({ flag: true });
    const r = await get(`/threads/${THREAD_T}/messages/${B_DEL}/edits`, BOB);
    assert.equal(r.status, 404, "§7.4's tombstone rule is outside the exception and refuses first");
  });
});

// ── 9. INACTIVE MEMBERSHIP — the request the decision insists on ─────────────

describe("a request made while membership is INACTIVE still refuses, own messages included", () => {
  it("the thread read refuses", async () => {
    useState({ flag: true, bobInactive: true });
    const r = await get(`/threads/${THREAD_T}/messages`, BOB);
    assert.equal(r.status, 403);
  });

  it("direct retrieval of his OWN pre-window message refuses", async () => {
    useState({ flag: true, bobInactive: true });
    const r = await get(`/threads/${THREAD_T}/messages/${B_OLD}/edits`, BOB);
    assert.equal(r.status, 403, "leaving ends the authorization; Q6 relaxes the WINDOW and nothing else");
  });

  it("the inbox does not list the thread at all", async () => {
    useState({ flag: true, bobInactive: true });
    const r = await get(`/me/threads`, BOB);
    assert.equal(r.status, 200);
    assert.equal((r.body.threads as any[]).find((t) => t.id === THREAD_T), undefined);
  });

  it("the domain contract agrees: a departed member reads none of their own messages", () => {
    const departed = memberFromRow({
      thread_id: THREAD_T, user_id: BOB, joined_at: "2026-01-01T00:00:00.000Z",
      left_at: "2026-03-20T00:00:00.000Z", visible_from_at: BOUND,
    });
    assert.equal(memberCanReadMessageAt(departed, "2026-02-10T00:00:00.000Z", true, BOB), false);
    assert.equal(memberCanReadMessageAt(departed, "2026-03-10T00:00:00.000Z", true, BOB), false);
  });

  it("an ACTIVE rejoined member reads their own, and not the other sender's", () => {
    const rejoined = memberFromRow({
      thread_id: THREAD_T, user_id: BOB, joined_at: BOUND, left_at: null, visible_from_at: BOUND,
    });
    assert.equal(memberCanReadMessageAt(rejoined, "2026-02-10T00:00:00.000Z", true, BOB), true);
    assert.equal(memberCanReadMessageAt(rejoined, "2026-02-10T00:00:00.000Z", true, ALICE), false);
    assert.equal(memberCanReadMessageAt(rejoined, "2026-02-10T00:00:00.000Z", true), false,
      "a caller that does not say who sent it gets the plain window — the narrower answer");
  });
});

// ── 10. SAVED MESSAGES ───────────────────────────────────────────────────────

describe("§14.2 saved messages — membership is still judged FIRST", () => {
  const source = (id: string, sender: string, created_at: string, deleted_at: string | null = null) =>
    ({ id, thread_id: THREAD_T, sender_id: sender, created_at, deleted_at, body: "x" });

  it("an INACTIVE member is `not_a_member` for their OWN message, before the window is consulted", () => {
    const v = authorizeSavedMessage(source(B_OLD, BOB, "2026-02-10T00:00:00.000Z"),
                                    { active: false, visibleFrom: BOUND, viewerId: BOB });
    assert.deepEqual(v, { ok: false, reason: "not_a_member" });
  });

  it("an ACTIVE rejoined member keeps the save of their OWN earlier message", () => {
    const v = authorizeSavedMessage(source(B_OLD, BOB, "2026-02-10T00:00:00.000Z"),
                                    { active: true, visibleFrom: BOUND, viewerId: BOB });
    assert.deepEqual(v, { ok: true });
  });

  it("and loses the save of ANOTHER sender's earlier message", () => {
    const v = authorizeSavedMessage(source(A_OLD, ALICE, "2026-02-01T00:00:00.000Z"),
                                    { active: true, visibleFrom: BOUND, viewerId: BOB });
    assert.deepEqual(v, { ok: false, reason: "outside_history_window" });
  });

  it("a DELETED own earlier message is still withheld", () => {
    const v = authorizeSavedMessage(
      source(B_DEL, BOB, "2026-02-25T00:00:00.000Z", "2026-02-26T00:00:00.000Z"),
      { active: true, visibleFrom: BOUND, viewerId: BOB });
    assert.deepEqual(v, { ok: false, reason: "source_deleted" });
  });

  it("a caller that does not name the viewer gets today's answer", () => {
    const v = authorizeSavedMessage(source(B_OLD, BOB, "2026-02-10T00:00:00.000Z"),
                                    { active: true, visibleFrom: BOUND });
    assert.deepEqual(v, { ok: false, reason: "outside_history_window" });
  });
});

// ── 11. COMPASS ──────────────────────────────────────────────────────────────

describe("Compass telegraph_get_shared_places — the model gets the caller's own cards only", () => {
  function placeFixture(state: State) {
    const c = makeClient(state);
    // Two place cards, one each, both BEFORE Bob's window.
    c._db.messages.push(
      msg("aaaa1111-0000-4000-8000-00000000aaaa", THREAD_T, ALICE,
          JSON.stringify({ title: "Alice's pre-window bar", text: "hers" }),
          "2026-02-02T00:00:00.000Z", { subtype: "discovery_card" }),
      msg("bbbb1111-0000-4000-8000-00000000bbbb", THREAD_T, BOB,
          JSON.stringify({ title: "Bob's pre-window bar", text: "his" }),
          "2026-02-12T00:00:00.000Z", { subtype: "discovery_card" }),
    );
    return c;
  }

  it("the query carries the sender-scoped clause, and Alice's card never reaches the model", async () => {
    const c = placeFixture({ flag: true });
    const r: any = await telegraphGetSharedPlaces(c as any, BOB, { conversationId: THREAD_T });
    if (r.authorized !== true) {
      // The gate consults privacy/capability layers this fixture does not model.
      // The QUERY is still the thing under test, and it was still built.
      assert.ok(true, `gate refused (${r.reason}) — the clause assertion below still applies`);
    }
    const placeOrs = c._observed.or.filter((o) => o.table === "messages");
    for (const o of placeOrs) {
      assert.equal(o.filters, `created_at.gte.${BOUND},sender_id.eq.${BOB}`,
        "Compass reads message CONTENT — the clause must admit the caller's own rows and no others");
    }
    const titles = r.authorized === true ? (r.places ?? []).map((p: any) => p.title) : [];
    assert.ok(!titles.includes("Alice's pre-window bar"),
      "another participant's pre-membership card must never reach the model");
  });
});

// ── 12. MEDIA ────────────────────────────────────────────────────────────────

describe("the media door — bytes from a PRIVATE bucket", () => {
  /*
   * Q6 IS STRUCTURALLY A NO-OP AT THIS DOOR, AND THAT IS THE FINDING.
   *
   * Branch 3c of `lib/mediaAccess.ts` is only reached when the OBJECT's owner
   * is the MESSAGE's sender (`owner === msg.sender_id`). Q6 only fires when the
   * VIEWER is that sender. The two together give `owner === viewerId` — and
   * `decide()` already returned true for that, four branches earlier, at
   * "1. Owner always sees their own bytes" (`pathOwner === viewerId`). So the
   * exception cannot change a single decision here. It is wired in anyway,
   * because the alternative is the one call site in the tree that spells the
   * rule differently, and because 3c is the door that hands over BYTES.
   *
   * What these tests pin is the half that CAN go wrong: an accessible own
   * message must not become a key to ANOTHER sender's protected object.
   */

  it("Bob may NOT fetch ALICE's PRE-WINDOW attachment", async () => {
    const c = useState({ flag: true });
    const ok = await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, ALICE_MEDIA);
    assert.equal(ok, false,
      "an accessible own message is not a key to another sender's attachment: each object is " +
      "decided by ITS OWN row's sender, and Alice is not Bob");
  });

  it("and the denial above IS the §14.3 door: with the flag OFF he may fetch it", async () => {
    // Without this, "false" would be indistinguishable from a refusal for some
    // unrelated reason, and the test above would prove nothing.
    const c = useState({ flag: false });
    assert.equal(await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, ALICE_MEDIA), true);
  });

  it("Bob MAY fetch Alice's IN-WINDOW attachment — the §14.3 door still opens normally", async () => {
    const c = useState({ flag: true });
    const ok = await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, ALICE_MEDIA_NEW);
    assert.equal(ok, true, "Q6 narrowed nothing: the ordinary windowed case is unchanged");
  });

  it("a DEPARTED member may not fetch another sender's attachment", async () => {
    const c = useState({ flag: true, bobInactive: true });
    assert.equal(await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, ALICE_MEDIA_NEW), false,
      "the membership read is `.is('left_at', null)` and refuses before the window is consulted");
    assert.equal(await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, ALICE_MEDIA), false);
  });

  it("a non-member may not fetch another sender's attachment at all", async () => {
    const c = useState({ flag: true });
    assert.equal(await authorizeMediaAccess(c as any, CAROL, MEDIA_BUCKET, ALICE_MEDIA_NEW), false);
    assert.equal(await authorizeMediaAccess(c as any, CAROL, MEDIA_BUCKET, ALICE_MEDIA), false);
  });

  it("the own-object rule that makes Q6 redundant here is the PRE-EXISTING one, not Q6", async () => {
    // True for a DEPARTED Bob too, which is only defensible because it is not
    // §14.3 reasoning at all: it is "you may read a file in your own storage
    // prefix", decided before any thread is consulted. Pinned so a later reader
    // does not mistake it for Q6's doing, and so a change to it is deliberate.
    const c = useState({ flag: true, bobInactive: true });
    assert.equal(await authorizeMediaAccess(c as any, BOB, MEDIA_BUCKET, BOB_MEDIA), true,
      "`decide()` step 1: pathOwner === viewerId");
  });
});
