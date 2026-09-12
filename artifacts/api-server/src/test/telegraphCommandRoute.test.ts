/**
 * Telegraph §13.1 / §7.4 — `POST /api/telegraph/commands`, against the real
 * route.
 *
 * §13.1 names eighteen commands. This endpoint issues only the ones with NO
 * other writer — `UNSEND_MESSAGE`, `ADD_REACTION`, and the `REMOVE_REACTION`
 * the spec's list omits — and refuses the rest by name, telling a caller where
 * each actually lives.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Adding `SEND_MESSAGE` to the allowlist: the wrong-endpoint test fails.
 *     That command has a block guard, an E2EE gate, a rate limit, an off-app
 *     detector and a translation pipeline on its real route; issuing it through
 *     a generic bus routes around all five, and the test is the only thing
 *     standing between the two.
 *   - Dropping the §7.4 seen check: the "a recipient read it" test fails. An
 *     unsend after somebody has read the message is a claim the product cannot
 *     honour.
 *   - Reading `last_read_at` as "not seen" when the roster read FAILED: the
 *     degraded test fails. "We could not check whether anyone saw it" is not
 *     "nobody saw it".
 *   - Removing the kernel-flag gate: the disabled test fails, and on a database
 *     without migration 2810 the route would answer 42703 rather than a refusal
 *     a client can render.
 *   - Letting a body name an actor: the impersonation test fails.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphCommandRoute.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import {
  TELEGRAPH_COMMANDS,
  ISSUABLE_COMMANDS,
  LEGACY_PATH_COMMANDS,
  UNIMPLEMENTED_COMMANDS,
} from "../domain/telegraph/commands/telegraphCommands.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";
const OTHER_THREAD = "00000000-0000-4000-8000-00000000000b";

const M_MINE = "11111111-0000-4000-8000-000000000001";   // Alice's, unseen
const M_SEEN = "11111111-0000-4000-8000-000000000002";   // Alice's, Bob has read past it
const M_THEIRS = "11111111-0000-4000-8000-000000000003"; // Bob's
const M_GONE = "11111111-0000-4000-8000-000000000004";   // Alice's, already deleted
const M_ELSEWHERE = "11111111-0000-4000-8000-000000000005"; // Alice's, other thread

const SENT_AT = "2026-05-02T00:00:00.000Z";

interface State {
  kernelFlag?: boolean;
  /** Bob's last_read_at in THREAD. */
  bobLastRead?: string | null;
  rosterError?: boolean;
  aliceLeft?: boolean;
}

function makeClient(state: State = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: state.kernelFlag !== false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: state.aliceLeft ? "2026-06-01T00:00:00.000Z" : null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, last_read_at: state.bobLastRead ?? null },
      { thread_id: OTHER_THREAD, user_id: BOB, left_at: null, last_read_at: null },
    ],
    messages: [
      { id: M_MINE, thread_id: THREAD, sender_id: ALICE, body: "mine", created_at: SENT_AT, deleted_at: null, unsent_at: null },
      { id: M_SEEN, thread_id: THREAD, sender_id: ALICE, body: "seen", created_at: SENT_AT, deleted_at: null, unsent_at: null },
      { id: M_THEIRS, thread_id: THREAD, sender_id: BOB, body: "theirs", created_at: SENT_AT, deleted_at: null, unsent_at: null },
      { id: M_GONE, thread_id: THREAD, sender_id: ALICE, body: "", created_at: SENT_AT, deleted_at: "2026-05-03T00:00:00.000Z", unsent_at: null },
      { id: M_ELSEWHERE, thread_id: OTHER_THREAD, sender_id: ALICE, body: "elsewhere", created_at: SENT_AT, deleted_at: null, unsent_at: null },
    ],
    message_reactions: [],
  };

  const writes: Array<{ table: string; op: string; payload: any }> = [];

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let nFilters = 0;
    let pending: { op: string; payload: any } | null = null;

    const rowsNow = () => (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
    const injected = () => {
      // The roster read is select(user_id,last_read_at).eq(thread).is(left_at).neq(user)
      // — three filters. The caller's own membership lookup is two eq's.
      if (table === "message_thread_members" && state.rosterError && nFilters === 3) {
        return { message: "roster read blew up" };
      }
      return null;
    };

    const target: any = {
      select() { return proxy; },
      insert(row: any) { pending = { op: "insert", payload: row }; return proxy; },
      upsert(row: any) {
        pending = { op: "upsert", payload: row };
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) {
          const hit = (db[table] ??= []).find(
            (x) => x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji,
          );
          if (!hit) db[table]!.push({ ...r });
        }
        return proxy;
      },
      update(patch: any) { pending = { op: "update", payload: patch }; return proxy; },
      delete() { pending = { op: "delete", payload: null }; return proxy; },
      eq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { nFilters++; preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in() { nFilters++; return proxy; },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        if (pending) {
          const p = pending; pending = null;
          writes.push({ table, op: p.op, payload: p.payload });
          if (p.op === "update") for (const r of rowsNow()) Object.assign(r, p.payload);
          if (p.op === "delete") {
            const keep = (db[table] ?? []).filter((r) => !preds.every((f) => f(r)));
            db[table] = keep;
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
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
    _writes: writes,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

let server: any;
let base = "";

async function post(body: unknown, asUser: string | null = ALICE) {
  const res = await fetch(`${base}/telegraph/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(asUser ? { authorization: `Bearer ${asUser}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", commandRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  _setTestClient(null, false);
  await new Promise<void>((r) => server.close(() => r()));
});

/* ─────────────────────── the vocabulary and the door ──────────────────────── */

describe("Telegraph §13.1 — the command vocabulary", () => {
  it("declares all eighteen of §13.1's commands", () => {
    assert.equal(TELEGRAPH_COMMANDS.length, 18);
    for (const c of ["SEND_MESSAGE", "UNSEND_MESSAGE", "ADD_REACTION", "REPORT_MESSAGE"]) {
      assert.ok((TELEGRAPH_COMMANDS as readonly string[]).includes(c));
    }
  });

  it("the issuable set contains ONLY commands with no other writer", () => {
    for (const c of ISSUABLE_COMMANDS) {
      assert.equal(LEGACY_PATH_COMMANDS[c], undefined,
        `${c} has a legacy route and must not be issuable here — the bus would route around its guards`);
    }
  });

  it("every §13.1 command is accounted for: issuable, legacy, or unimplemented", () => {
    const unaccounted = (TELEGRAPH_COMMANDS as readonly string[]).filter(
      (c) => !(ISSUABLE_COMMANDS as readonly string[]).includes(c)
        && !(c in LEGACY_PATH_COMMANDS)
        && !UNIMPLEMENTED_COMMANDS.includes(c),
    );
    assert.deepEqual(unaccounted, [],
      `these §13.1 commands are in no category, so nothing says whether they exist: ${unaccounted.join(", ")}`);
  });
});

describe("POST /telegraph/commands — the door", () => {
  it("requires a verified user", async () => {
    _setTestClient(makeClient(), true);
    const { status } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: {} }, null);
    assert.equal(status, 401);
  });

  it("REFUSES a body that names an actor rather than ignoring it", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({
      type: "UNSEND_MESSAGE", conversationId: THREAD, actorUserId: BOB, params: { messageId: M_MINE },
    });
    assert.equal(status, 400);
    assert.match(String(body.message), /taken from the verified token/i);
  });

  it("sends a legacy command to its real route with a 409, not a 400", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "SEND_MESSAGE", conversationId: THREAD, params: {} });
    assert.equal(status, 409);
    assert.equal(body.error, "wrong_endpoint");
    assert.match(String(body.message), /POST \/api\/threads\/:threadId\/messages/);
  });

  it("answers 501 for a §13.1 command nothing implements", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "CREATE_COORDINATION_SESSION", conversationId: THREAD, params: {} });
    assert.equal(status, 501);
    assert.equal(body.error, "not_implemented");
  });

  it("answers 400 for a command nobody has heard of", async () => {
    _setTestClient(makeClient(), true);
    const { status } = await post({ type: "MAKE_COFFEE", conversationId: THREAD, params: {} });
    assert.equal(status, 400);
  });

  it("answers feature_disabled when the kernel flag is off — never a schema error", async () => {
    _setTestClient(makeClient({ kernelFlag: false }), true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_MINE } });
    // 404, which is what this codebase maps feature_disabled to: a capability
    // that is off is indistinguishable from one that was never built, and that
    // is the right answer to give a client probing for it.
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("refuses a non-member before any handler runs", async () => {
    _setTestClient(makeClient({ aliceLeft: true }), true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_MINE } });
    assert.equal(status, 403);
    assert.equal(body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
  });
});

/* ───────────────────────────── UNSEND_MESSAGE ─────────────────────────────── */

describe("Telegraph §7.4 UNSEND_MESSAGE", () => {
  it("unsends an unseen message of the caller's own, retaining the row", async () => {
    const client = makeClient({ bobLastRead: null });
    _setTestClient(client, true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_MINE } });
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const row = client._db.messages.find((m: any) => m.id === M_MINE);
    assert.ok(row, "§17.2: the tombstone keeps the row so the sequence stays continuous");
    assert.ok(row.unsent_at);
    assert.equal(row.lifecycle_state, "unsent");
    assert.equal(row.body, "", "the body is redacted in place — messages.body is NOT NULL");
  });

  it("REFUSES once an eligible recipient has read past it", async () => {
    const client = makeClient({ bobLastRead: "2026-05-05T00:00:00.000Z" });
    _setTestClient(client, true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_SEEN } });
    assert.equal(status, 409);
    assert.equal(body.reason, "TELEGRAPH_LIFECYCLE_SEEN_BY_RECIPIENT");
    assert.equal(client._db.messages.find((m: any) => m.id === M_SEEN).unsent_at, null);
  });

  it("an UNREADABLE roster refuses — 'we could not check' is not 'nobody saw it'", async () => {
    const client = makeClient({ rosterError: true });
    _setTestClient(client, true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_MINE } });
    assert.equal(status, 409);
    assert.equal(body.reason, "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");
    assert.equal(client._db.messages.find((m: any) => m.id === M_MINE).unsent_at, null);
  });

  it("refuses someone else's message", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_THEIRS } });
    assert.equal(status, 403);
    assert.equal(body.reason, "TELEGRAPH_AUTH_NOT_SENDER");
  });

  it("a message in ANOTHER conversation answers exactly as a missing one", async () => {
    _setTestClient(makeClient(), true);
    const elsewhere = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_ELSEWHERE } });
    const missing = await post({
      type: "UNSEND_MESSAGE", conversationId: THREAD,
      params: { messageId: "99999999-0000-4000-8000-000000000009" },
    });
    assert.equal(elsewhere.status, missing.status);
    assert.equal(elsewhere.body.reason, missing.body.reason,
      "distinguishing them makes the endpoint a message-existence oracle");
  });

  it("refuses a message that is already deleted", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "UNSEND_MESSAGE", conversationId: THREAD, params: { messageId: M_GONE } });
    assert.equal(status, 409);
    assert.equal(body.reason, "TELEGRAPH_LIFECYCLE_ALREADY_DELETED");
  });
});

/* ──────────────────────────── reactions ───────────────────────────────────── */

describe("Telegraph §12/§13.1 ADD_REACTION / REMOVE_REACTION", () => {
  it("adds a reaction and is idempotent on a repeat", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    const first = await post({ type: "ADD_REACTION", conversationId: THREAD, params: { messageId: M_MINE, emoji: "🎉" } });
    assert.equal(first.status, 200);
    const second = await post({ type: "ADD_REACTION", conversationId: THREAD, params: { messageId: M_MINE, emoji: "🎉" } });
    assert.equal(second.status, 200);
    assert.equal(client._db.message_reactions.length, 1, "a double-tap is one reaction, not an error and not two rows");
  });

  it("REFUSES a long 'emoji' — the column must not become a second message body", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({
      type: "ADD_REACTION", conversationId: THREAD,
      params: { messageId: M_MINE, emoji: "this is a whole sentence pretending to be a reaction" },
    });
    assert.equal(status, 409);
    assert.equal(body.reason, "TELEGRAPH_MEDIA_KIND_NOT_ALLOWED");
  });

  it("refuses a reaction to a deleted message", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "ADD_REACTION", conversationId: THREAD, params: { messageId: M_GONE, emoji: "👍" } });
    assert.equal(status, 409);
    assert.equal(body.reason, "TELEGRAPH_LIFECYCLE_ALREADY_DELETED");
  });

  it("removes only the caller's OWN reaction", async () => {
    const client = makeClient();
    _setTestClient(client, true);
    await post({ type: "ADD_REACTION", conversationId: THREAD, params: { messageId: M_MINE, emoji: "👍" } });
    client._db.message_reactions.push({ message_id: M_MINE, user_id: BOB, emoji: "👍" });

    const { status } = await post({ type: "REMOVE_REACTION", conversationId: THREAD, params: { messageId: M_MINE, emoji: "👍" } });
    assert.equal(status, 200);
    const left = client._db.message_reactions;
    assert.equal(left.length, 1);
    assert.equal(left[0].user_id, BOB, "someone else's reaction must survive");
  });
});
