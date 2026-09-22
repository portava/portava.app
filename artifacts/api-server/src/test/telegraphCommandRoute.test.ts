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
  unimplementedCommandsFrom,
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

  it("SET_COORDINATION_STATUS names the route that exists, not a nonexistent vocabulary", () => {
    // §9.1's seven quick states shipped with the coordination surface. This
    // command sat in UNIMPLEMENTED_COMMANDS afterwards, so the endpoint told
    // callers "nothing in this repository implements it" while
    // POST /threads/:id/coordination was implementing it. A refusal that is
    // wrong in that direction sends a caller away from the working route.
    assert.equal(UNIMPLEMENTED_COMMANDS.includes("SET_COORDINATION_STATUS"), false);
    assert.match(String(LEGACY_PATH_COMMANDS.SET_COORDINATION_STATUS), /coordination/);
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

  // This test used to send `CREATE_COORDINATION_SESSION` and assert 501. That
  // command stopped being unimplemented when §9's coordination surface shipped
  // a CoordinationSession (census T85 W -> C), and `UNIMPLEMENTED_COMMANDS` was
  // not updated, so the endpoint told callers the capability did not exist for
  // as long as this test pinned the stale answer in place. It now sends a
  // command that IS still §13.1's and IS still homeless — and today there is
  // none, so the two halves are asserted separately:
  //
  //   - the live list is empty, which is a measurement of the tree, and
  //   - the RULE that produces the 501 still works, checked against a
  //     hypothetical nineteenth command, so the branch keeps its coverage while
  //     being unreachable in fact.
  //
  // See src/test/telegraphCreateCoordinationSession.test.ts for the 409 this
  // command now correctly gets.
  it("no §13.1 command is homeless today — the 501 branch is unreachable, by measurement", () => {
    assert.deepEqual([...UNIMPLEMENTED_COMMANDS], []);
  });

  it("the 501 rule still holds: a §13.1 command with no home is unimplemented", () => {
    const derived = unimplementedCommandsFrom(
      [...TELEGRAPH_COMMANDS, "TELEPORT_USER"],
      ISSUABLE_COMMANDS,
      LEGACY_PATH_COMMANDS,
    );
    assert.deepEqual(derived, ["TELEPORT_USER"],
      "a spec-named command with neither an issuable slot nor a legacy home must be reported " +
      "unimplemented, so the door answers 501 rather than 'you made that up'");
  });

  it("answers 400 — not 501 — for a name §13.1 does not use", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await post({ type: "MAKE_ESPRESSO", conversationId: THREAD, params: {} });
    assert.equal(status, 400);
    assert.match(String(body.message ?? ""), /Unknown command/);
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

// ── §30A.10 the executable-action registry ───────────────────────────────────
//
// census-telegraph T410: "Every executable action registers authorize /
// preview / execute / optional compensate; Telegraph orchestrates, source
// domains retain truth … Three of four hooks exist for ONE action family:
// `ProposedAction.label` (preview), `confirm-action` (execute), and `:390`'s
// re-verification (authorize). **No registry, no compensate.**"
//
// Three things are pinned here, and the third is the one that is easy to fake:
//   1. the registry is EXHAUSTIVE over the action kinds the route can produce —
//      checked against the route's own source, so a fifth kind turns this red;
//   2. every registration declares all four hooks, and where there is no
//      compensate it says WHY rather than being silently absent;
//   3. compensate actually RUNS. §30A.11 asks for the source-domain capability
//      to be rechecked at execution time; when the recheck fails after the
//      orchestration record was written, the record is UNDONE and the caller is
//      told, rather than left with a confirmation nothing backs.

import { readFileSync as readSrc } from "node:fs";
import { dirname as dirOf, join as joinPath } from "node:path";
import { fileURLToPath as urlToPath } from "node:url";
import {
  TELEGRAPH_ACTION_REGISTRY,
  ACTION_HOOKS,
  registrationFor,
  registeredActionIds,
} from "../services/telegraph/actionRegistry.js";
import telegraphCommandsRouter from "../routes/telegraphCommands.js";

const TRIP = "77770000-0000-4000-8000-000000000001";

interface ActionState {
  /** Membership answers true, then false — the §30A.11 recheck race. */
  membershipFlipsAfterWrite?: boolean;
  memberOfTrip?: boolean;
}

function makeActionClient(state: ActionState = {}) {
  // The flip is keyed off the orchestration WRITE, not off a read count: the
  // submit call reads membership too, and counting reads made the race fire
  // before the write it is supposed to follow.
  let wroteRecord = false;
  const rows: Record<string, any[]> = {
    trip_members: [{ trip_id: TRIP, user_id: ALICE, role: "member", status: "accepted" }],
    trips: [{ id: TRIP, owner_id: BOB }],
    user_preference_events: [],
  };
  const writes: Array<{ table: string; op: string; payload: any }> = [];

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let pending: { op: string; payload: any } | null = null;
    const rowsNow = () => (rows[table] ?? []).filter((r) => preds.every((f) => f(r)));
    const target: any = {
      select() { return proxy; },
      insert(row: any) { pending = { op: "insert", payload: row }; return proxy; },
      delete() { pending = { op: "delete", payload: null }; return proxy; },
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      is(col: string, val: any) { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() {
        if (table === "trip_members") {
          if (state.memberOfTrip === false) return Promise.resolve({ data: null, error: null });
          if (state.membershipFlipsAfterWrite && wroteRecord) {
            return Promise.resolve({ data: null, error: null });
          }
        }
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (pending) {
          const p = pending; pending = null;
          writes.push({ table, op: p.op, payload: p.payload });
          if (p.op === "insert") {
            (rows[table] ??= []).push({ ...p.payload });
            if (table === "user_preference_events") wroteRecord = true;
          }
          if (p.op === "delete") rows[table] = (rows[table] ?? []).filter((r) => !preds.every((f) => f(r)));
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: rowsNow(), error: null, count: null }).then(resolve, reject);
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
    _rows: rows,
    _writes: writes,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

describe("§30A.10 — every executable action registers four hooks", () => {
  const here = dirOf(urlToPath(import.meta.url));
  const routeSrc = readSrc(joinPath(here, "../routes/telegraphCommands.ts"), "utf8");

  it("the registry is EXHAUSTIVE over the kinds the route can actually produce", () => {
    const produced = new Set(
      [...routeSrc.matchAll(/kind:\s*"([a-z_]+)"/g)].map((m) => m[1] as string),
    );
    assert.ok(produced.size >= 4, `expected the route to produce action kinds; found ${produced.size}`);
    for (const kind of produced) {
      assert.ok(
        registeredActionIds().includes(kind),
        `${kind} is produced by the route and is not in TELEGRAPH_ACTION_REGISTRY`,
      );
    }
  });

  it("names §30A.10's four hooks, and every registration has all four", () => {
    assert.deepEqual([...ACTION_HOOKS], ["authorize", "preview", "execute", "compensate"]);
    for (const reg of TELEGRAPH_ACTION_REGISTRY) {
      assert.equal(typeof reg.preview, "function", `${reg.actionId} has no preview`);
      assert.equal(typeof reg.authorize, "function", `${reg.actionId} has no authorize`);
      assert.equal(typeof reg.execute, "function", `${reg.actionId} has no execute`);
      assert.ok(reg.compensate, `${reg.actionId} declares no compensate at all`);
      // Optional means "optional to IMPLEMENT", not "optional to answer".
      const c: any = reg.compensate;
      assert.ok(
        typeof c.run === "function" || typeof c.reason === "string",
        `${reg.actionId}'s compensate is neither a function nor a stated reason`,
      );
    }
  });

  it("every registration names the domain that retains canonical truth, and it is never Telegraph", () => {
    for (const reg of TELEGRAPH_ACTION_REGISTRY) {
      assert.ok(reg.canonicalOwner, `${reg.actionId} names no canonical owner`);
      assert.notEqual(reg.canonicalOwner.domain, "telegraph", `${reg.actionId} claims Telegraph owns the truth`);
    }
  });

  it("registrationFor answers null for an action nobody registered", () => {
    assert.equal(registrationFor("delete_the_trip"), null);
  });
});

describe("§30A.11 — the recheck, and the compensate that makes it safe", () => {
  let actionServer: any;
  let actionBase = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use("/api", telegraphCommandsRouter);
    actionServer = createServer(app);
    await new Promise<void>((r) => actionServer.listen(0, "127.0.0.1", r));
    actionBase = `http://127.0.0.1:${actionServer.address().port}/api`;
  });

  after(async () => {
    await new Promise<void>((r) => actionServer.close(() => r()));
  });

  async function submit(client: any) {
    _setTestClient(client, true);
    const r = await fetch(`${actionBase}/telegraph/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "plan my day", tripId: TRIP }),
    });
    const body: any = await r.json();
    return body;
  }

  async function confirm(actionId: string, commandId: string) {
    const r = await fetch(`${actionBase}/telegraph/commands/${commandId}/confirm-action`, {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" },
      body: JSON.stringify({ actionId }),
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  it("a confirmed action reports the four hooks it ran and who owns the write", async () => {
    const c = makeActionClient({});
    const cmd = await submit(c);
    const action = cmd.proposedActions[0];
    const r = await confirm(action.id, cmd.commandId);
    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed, true);
    assert.equal(r.body.orchestration.authorized, true);
    assert.equal(typeof r.body.orchestration.preview, "string");
    assert.ok(r.body.orchestration.preview.length > 0);
    assert.notEqual(r.body.orchestration.canonicalOwner.domain, "telegraph");
    assert.equal(r.body.orchestration.compensated, false);
  });

  it("membership lost between authorize and the recheck UNDOES the orchestration record", async () => {
    const c = makeActionClient({ membershipFlipsAfterWrite: true });
    const cmd = await submit(c);
    const action = cmd.proposedActions[0];
    const r = await confirm(action.id, cmd.commandId);
    assert.equal(r.status, 409);
    assert.equal(r.body.compensated, true);
    // The record must be GONE, not merely reported as undone.
    assert.equal(
      (c._rows.user_preference_events ?? []).length,
      0,
      "the orchestration record survived the compensate",
    );
  });

  it("a non-member is refused by authorize and nothing is written at all", async () => {
    const c = makeActionClient({ memberOfTrip: false });
    _setTestClient(c, true);
    const submitted = await fetch(`${actionBase}/telegraph/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "plan my day", tripId: TRIP }),
    });
    const cmd: any = await submitted.json();
    const r = await confirm(cmd.proposedActions[0].id, cmd.commandId);
    assert.equal(r.status, 403);
    assert.equal((c._rows.user_preference_events ?? []).length, 0);
  });
});
