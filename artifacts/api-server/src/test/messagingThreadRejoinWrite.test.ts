/**
 * messagingThreadRejoinWrite — handing back a thread id must mean handing back a
 * USABLE thread.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * Both POST /users/:id/open-thread and POST /message-requests/:id/accept reuse an
 * existing 1:1 thread when one is found, and clear `left_at` so a party who had
 * previously left can talk again:
 *
 *     await sc.from('message_thread_members').update({ left_at: null })
 *       .eq('thread_id', threadId).in('user_id', [a, b]);
 *
 * — no `{ error }`. supabase-js RESOLVES on a database error, so a rejoin that
 * never landed answered exactly like one that did, and the handler replied 200
 * with the thread id. `left_at !== null` is then checked explicitly by the text
 * and media send handlers, which answer 403 "You no longer have access to this
 * thread" — so the client is handed a conversation in which every message it
 * tries to send is refused, and nothing anywhere recorded a failure.
 *
 * The accept path additionally compare-and-swaps the request to 'accepted'
 * BEFORE the rejoin, and the handler refuses anything that is not 'pending'. So
 * refusing without undoing that swap would leave the recipient with an accepted
 * request, no usable thread, and no way to retry — the fix rolls the request
 * back to 'pending', which the last case below pins.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * `db_error` is HTTP 500 and an express crash is also 500, so every failure
 *    case asserts the JSON body carries `error: 'db_error'`; a crash cannot
 *    produce that. A `req.log` shim is installed for the same reason.
 *  * "Not 200" would be satisfied by a handler that stopped working, so each
 *    case is paired with a positive control on the SAME fixture with the rejoin
 *    allowed to succeed: 200, the thread id, and `left_at` actually cleared.
 *  * The injected failure is keyed on the message_thread_members UPDATE, not the
 *    table: findDirectThreadBetween READS that same table twice immediately
 *    before, and failing the table wholesale would make the lookup undecided and
 *    produce a 503 from a completely different branch.
 *
 * Run: node --import tsx/esm --test src/test/messagingThreadRejoinWrite.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";

const ALICE  = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BOB    = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const THREAD = "cccccccc-1111-4111-8111-cccccccccccc";
const REQID  = "dddddddd-1111-4111-8111-dddddddddddd";

interface Db { [table: string]: any[] }

interface Opts {
  /** Fail only the UPDATE against message_thread_members (the rejoin). */
  failRejoin?: { message: string };
  authUserId: string;
}

let db: Db;
let rejoinAttempts = 0;

function makeClient(o: Opts) {
  function parseOr(expr: string): (r: any) => boolean {
    const groups = expr.split(/\),\s*(?:and|or)\(/).map((g) =>
      g.replace(/^(?:and|or)\(/, "").replace(/\)$/, ""));
    return (r: any) => groups.some((g) =>
      g.split(",").every((cond) => {
        const i = cond.indexOf(".eq.");
        if (i === -1) return true;
        return String(r[cond.slice(0, i).trim()]) === String(cond.slice(i + 4).trim());
      }));
  }

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let inserted = false, deleted = false, updated = false;
    let updatedRows: any[] = [];
    let insertResult: any = null;
    let limit: number | null = null;

    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      or(e: string) { filters.push(parseOr(e)); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.map(String).includes(String(r[c]))); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      like() { return b; },
      gt() { return b; },
      limit(n: number) { limit = n; return b; },
      order() { return b; },
      range() { return b; },
      insert(p: any) {
        inserted = true;
        if (Array.isArray(p)) {
          const rows = p.map((r, i) => ({ id: `auto-${table}-${i}`, ...r }));
          (db[table] ??= []).push(...rows);
          insertResult = rows[0];
        } else {
          const row = { id: THREAD, ...p };
          (db[table] ??= []).push(row);
          insertResult = row;
        }
        return b;
      },
      update(patch: any) {
        updated = true;
        if (table === "message_thread_members") rejoinAttempts += 1;
        // Capture the matched rows BEFORE applying the patch. PostgREST's
        // `.update(...).select()` returns the rows the WHERE clause matched;
        // applying first and filtering after would make a compare-and-swap
        // (`.eq('status','pending')`) come back empty for the very row it just
        // flipped, and the handler would take its lost-the-race branch.
        updatedRows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (!(table === "message_thread_members" && o.failRejoin)) {
          updatedRows.forEach((r) => Object.assign(r, patch));
        }
        return b;
      },
      delete() { deleted = true; return b; },
      upsert(p: any) { return b.insert(p); },
      maybeSingle() {
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: (limit !== null ? rows.slice(0, limit) : rows)[0] ?? null, error: null });
      },
      single() {
        if (inserted) return Promise.resolve({ data: insertResult, error: null });
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        // The injected failure is scoped to the UPDATE. The two READS of this
        // same table (findDirectThreadBetween) still answer normally, so a pass
        // here cannot be explained by "message_thread_members was unavailable".
        if (table === "message_thread_members" && updated && o.failRejoin) {
          return Promise.resolve({ data: null, error: o.failRejoin }).then(resolve, reject);
        }
        if (deleted) {
          db[table] = (db[table] ?? []).filter((r) => !filters.every((f) => f(r)));
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        if (updated) return Promise.resolve({ data: updatedRows, error: null }).then(resolve, reject);
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const sliced = limit !== null ? rows.slice(0, limit) : rows;
        if (inserted) return Promise.resolve({ data: sliced, error: null }).then(resolve, reject);
        return Promise.resolve({ data: sliced, count: sliced.length, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: o.authUserId } }, error: null }) },
  };
}

let baseUrl = "";
let httpServer: ReturnType<typeof createServer>;

function callApi(method: string, path: string): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

/** Alice and Bob share a direct thread that BOTH have left. */
function seed() {
  db = {
    profiles: [{ id: ALICE, handle: "alice" }, { id: BOB, handle: "bob" }],
    message_threads: [{ id: THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null, is_e2ee: false, status: "active" }],
    message_thread_members: [
      { user_id: ALICE, thread_id: THREAD, left_at: "2026-01-01T00:00:00.000Z" },
      { user_id: BOB,   thread_id: THREAD, left_at: "2026-01-01T00:00:00.000Z" },
    ],
    message_requests: [{ id: REQID, sender_id: BOB, recipient_id: ALICE, status: "pending", preview_text: null, responded_at: null }],
    blocks: [], user_message_settings: [], user_account_states: [], user_restrictions: [],
    trust_restrictions: [], user_follows: [], user_friendships: [], trip_members: [],
    circle_memberships: [], rent_buddy_bookings: [], messages: [], message_translations: [],
    feature_flags: [], user_privacy_settings: [], profile_privacy_settings: [],
  };
  rejoinAttempts = 0;
}

const leftAtOf = (u: string) =>
  (db.message_thread_members.find((m: any) => m.user_id === u) as any).left_at;

before(async () => {
  const app = express();
  app.use(express.json());
  // Without this, a handler calling req.log.error throws and express answers
  // 500 — the same status the fix produces. The shim keeps them distinguishable.
  app.use((req: any, _res, next) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", messagingRouter);
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  await new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(seed);

describe("POST /users/:id/open-thread — a failed rejoin is not an open thread", () => {
  it("refuses with db_error when the left_at reset fails, instead of returning a 403-on-every-send thread", async () => {
    _setTestClient(makeClient({ authUserId: ALICE, failRejoin: { message: "deadlock detected" } }) as any, true);
    const r = await callApi("POST", `/api/users/${BOB}/open-thread`);

    assert.equal(rejoinAttempts, 1, "fixture check: the handler must have attempted the left_at reset");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body?.error, "db_error",
      `the body must carry the handler's own error code — an express crash also answers 500 ` +
      `but with no 'error' field. Got ${JSON.stringify(r.body)}`,
    );
    assert.equal(r.body?.threadId, undefined, "no thread id may be handed back for a thread that still refuses sends");
    assert.notEqual(
      leftAtOf(ALICE), null,
      "left_at is still set — exactly the state the send handlers answer 403 on",
    );
  });

  it("positive control: a healthy rejoin answers 200 and really clears left_at for both parties", async () => {
    _setTestClient(makeClient({ authUserId: ALICE }) as any, true);
    const r = await callApi("POST", `/api/users/${BOB}/open-thread`);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.threadId, THREAD);
    assert.equal(r.body?.created, false);
    assert.equal(leftAtOf(ALICE), null, "the caller must be rejoined");
    assert.equal(leftAtOf(BOB), null, "the other party must be rejoined too");
  });
});

describe("POST /message-requests/:id/accept — a failed rejoin is not an accepted request", () => {
  it("refuses with db_error AND rolls the request back to pending so the accept can be retried", async () => {
    _setTestClient(makeClient({ authUserId: ALICE, failRejoin: { message: "deadlock detected" } }) as any, true);
    const r = await callApi("POST", `/api/message-requests/${REQID}/accept`);

    assert.equal(rejoinAttempts, 1, "fixture check: the handler must have attempted the left_at reset");
    assert.equal(r.status, 500, `expected the db_error status, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    assert.notEqual(r.body?.status, "accepted", "the response must not claim an accept whose thread is unusable");
    assert.equal(
      (db.message_requests[0] as any).status, "pending",
      "the compare-and-swap must be undone — otherwise the request is stuck 'accepted' with no usable thread " +
      "and the handler's own status check refuses every retry",
    );
    assert.equal(
      (db.message_requests[0] as any).responded_at, null,
      "the rollback must restore responded_at as well",
    );
  });

  it("positive control: a healthy accept answers 200, clears left_at, and leaves the request accepted", async () => {
    _setTestClient(makeClient({ authUserId: ALICE }) as any, true);
    const r = await callApi("POST", `/api/message-requests/${REQID}/accept`);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.status, "accepted");
    assert.equal(r.body?.threadId, THREAD);
    assert.equal((db.message_requests[0] as any).status, "accepted");
    assert.equal(leftAtOf(ALICE), null, "the recipient must be rejoined");
    assert.equal(leftAtOf(BOB), null, "the sender must be rejoined");
  });
});
