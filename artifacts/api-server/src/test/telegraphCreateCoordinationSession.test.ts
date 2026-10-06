/**
 * Telegraph §13.1 `CREATE_COORDINATION_SESSION` — census-telegraph T168.
 *
 * THE ROW, AND WHY IT IS STALE
 * ============================
 * T168 reads: **`CREATE_COORDINATION_SESSION` | N | Nothing (T85).** That was
 * true when it was written and both halves of it have since stopped being true:
 *
 *   - T85 `CoordinationSession` moved **W → C** (census §21.4): a session has
 *     an id (the opening message's own), a `startedBy`, an `endedAt` set only
 *     on COMPLETE or CANCELLED, and a recordable DISRUPTED, projected by
 *     `services/telegraph/coordination.ts` `projectCoordinationSession`.
 *   - The command that opens one is `kind: "COORDINATION_SESSION"` on
 *     `POST /api/threads/:threadId/coordination`
 *     (`routes/telegraphCoordination.ts`), mounted at `routes/index.ts:192`,
 *     with no feature flag and no migration behind it.
 *
 * `domain/telegraph/commands/telegraphCommands.ts` had not caught up. It still
 * listed `CREATE_COORDINATION_SESSION` in `UNIMPLEMENTED_COMMANDS` with the
 * comment "no coordination session ENTITY exists (census T85/T168)", so
 * `POST /api/telegraph/commands` answered **501 not_implemented**: "…is named
 * by Telegraph §13.1 and nothing in this repository implements it."
 *
 * THAT IS THE EXACT FAILURE THE FILE ITSELF NAMES ONE ENTRY EARLIER.
 * `SET_COORDINATION_STATUS` was moved out of `UNIMPLEMENTED_COMMANDS` for this
 * reason, in this file's own words: *"A refusal that tells a caller a thing
 * does not exist when it does is worse than no refusal: it sends them away from
 * the route that would have worked."* The same sentence applies to the command
 * that OPENS the session those statuses move through, and it was left behind.
 *
 * WHAT THESE TESTS PIN
 * ====================
 *   1. The command has a home and the door says so. AT THE MERGE this became a
 *      stronger fact than when these tests were written: a lane landing in the
 *      same window made the command BUS implement the command, so the answer is
 *      no longer a 409 "go here" but the bus performing it (and refusing a call
 *      with no idempotency key). 501 remains the wrong answer either way — it
 *      is the one refusal a caller acts on by giving up. See 1b/1c.
 *   2. The home the refusal names ACCEPTS the thing. A pointer at a route that
 *      would reject `COORDINATION_SESSION` is a different lie with the same
 *      shape, so the test validates the kind through the coordination surface's
 *      own validator rather than trusting the string. This is also what keeps
 *      the entry honest in the OTHER direction: if the coordination surface is
 *      ever removed, test 2 goes red and the entry must move back.
 *   3. `UNIMPLEMENTED_COMMANDS` is now empty and every one of §13.1's eighteen
 *      commands is still accounted for — so emptying it lost nothing.
 *
 * SHOWN RED FIRST: with the entry still in `UNIMPLEMENTED_COMMANDS`, tests 1
 * and 3 fail (501 not_implemented, and the array is non-empty); test 2 passes,
 * which is the point — the capability was already there and only the vocabulary
 * disagreed.
 *
 * Run: node --import tsx/esm --test src/test/telegraphCreateCoordinationSession.test.ts
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
import {
  COORDINATION_KINDS,
  validateCoordinationMessage,
  projectCoordinationSession,
} from "../services/telegraph/coordination.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-00000000000a";

function makeClient(overrides: Record<string, any[]> = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    message_thread_members: [{ thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null }],
    messages: [],
    ...overrides,
  };
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rowsNow = () => (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      /**
       * A real insert, so a test can assert the TABLE afterwards. A handler that
       * returns 200 having written nothing, and one that returns a refusal having
       * written a row anyway, both pass an assertion about the status code.
       */
      insert(rows: any) {
        const arr = Array.isArray(rows) ? rows : [rows];
        const written = arr.map((r, i) => ({ id: `${table}-row-${(db[table] ?? []).length + i + 1}`, ...r }));
        (db[table] ??= []).push(...written);
        const result = { data: written[0] ?? null, error: null };
        const ins: any = {
          select() { return ins; },
          single() { return Promise.resolve(result); },
          maybeSingle() { return Promise.resolve(result); },
          then(resolve: (v: any) => void, reject?: (e: any) => void) {
            return Promise.resolve({ data: written, error: null }).then(resolve, reject);
          },
        };
        return ins;
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
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
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    /** The tables themselves, so a test can assert what the table HOLDS afterwards rather than what a handler returned. */
    _db: db,
  } as any;
}

let server: any;
let base = "";

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

async function postCommand(type: string) {
  const res = await fetch(`${base}/telegraph/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
    body: JSON.stringify({ type, conversationId: THREAD, params: {} }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

describe("§13.1 CREATE_COORDINATION_SESSION — the refusal names the route that exists", () => {
  it("1a. it is no longer listed as implemented by nothing", () => {
    assert.equal(
      UNIMPLEMENTED_COMMANDS.includes("CREATE_COORDINATION_SESSION"),
      false,
      "the command endpoint would tell a caller the capability does not exist while " +
        "POST /threads/:id/coordination implements it",
    );
  });

  // 1b/1c CHANGED AT THE MERGE, and the change is the point. This lane wrote
  // them against a tree where the command bus did NOT implement
  // CREATE_COORDINATION_SESSION, so the honest answer was a 409 pointing at the
  // coordination route. Another lane, landing in the same window, MADE the bus
  // implement it — `server/telegraph/commandRoute.ts` handles the type before
  // the switch and writes the session. Both lanes were fixing the same stale
  // UNIMPLEMENTED_COMMANDS entry and disagreed only about where the command's
  // home is; in the merged tree the home is here. Keeping the 409 would have
  // made the endpoint say "go there instead" about work it performs itself.
  it("1b. it is ISSUABLE here, and NOT listed as a legacy path", () => {
    assert.ok(
      (ISSUABLE_COMMANDS as readonly string[]).includes("CREATE_COORDINATION_SESSION"),
      "the bus implements this command; if it stops, move the entry back to LEGACY_PATH_COMMANDS " +
        "rather than letting it fall through to 501",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(LEGACY_PATH_COMMANDS, "CREATE_COORDINATION_SESSION"),
      false,
      "listing a command the bus performs as a legacy path makes the endpoint refuse, with a " +
        "'go there instead', a call it would have carried out",
    );
  });

  it("1c. the bus performs it — and still refuses a call with no idempotency key", async () => {
    // 400, not 501 and not 409: the command is neither missing nor at the wrong
    // door. The key is required rather than generated because a generated one
    // would make every retry a new evening.
    _setTestClient(makeClient(), true);
    const { status, body } = await postCommand("CREATE_COORDINATION_SESSION");
    assert.equal(status, 400, `answered ${status}; a 501 or 409 would send the caller away from the door that works`);
    assert.match(String(body.message ?? ""), /idempotencyKey is required/);
  });

  it("2. the home the refusal names actually accepts a COORDINATION_SESSION", () => {
    // Not a string comparison: the coordination surface's OWN validator is
    // asked, so this goes red if that surface is removed or renames the kind,
    // and the vocabulary entry has to move back rather than rot.
    assert.ok(
      (COORDINATION_KINDS as readonly string[]).includes("COORDINATION_SESSION"),
      "the coordination surface no longer declares COORDINATION_SESSION",
    );
    const ok = validateCoordinationMessage("COORDINATION_SESSION", {
      title: "Dinner at 8",
      planObjectId: null,
      note: null,
    });
    assert.equal(ok.ok, true, `the coordination route would refuse it: ${(ok as any).error}`);

    // And the session it opens is a real aggregate, not a bare message: the
    // opening message's id IS the session id (census §21.3).
    const opened = projectCoordinationSession(
      {
        id: "msg-1",
        sender_id: ALICE,
        created_at: "2026-05-02T00:00:00.000Z",
        payload: (ok as any).envelope.payload,
      },
      [],
      null,
    );
    assert.equal(opened.sessionId, "msg-1");
    assert.equal(opened.startedBy, ALICE);
    assert.equal(opened.endedAt, null);
  });

  // ── the same staleness, twice more ────────────────────────────────────────
  //
  // `CREATE_DECISION` and `CAST_VOTE` pointed at the meetup-only surfaces
  // (`/telegraph-chat/create-meetup or /start-poll`, and "the meetup RSVP
  // surface (meetup_time_votes)" — which is a TABLE, not an endpoint a caller
  // can be sent to). §8's general decision shipped on the same coordination
  // route as the session: `kind: "DECISION"` with four resolution rules, a
  // deadline and options, answered by `kind: "VOTE"`. census §13.9 already
  // recorded the consequence for T146 — "the analogue is now §8's
  // DECISION/VOTE projection on the coordination route" — and nobody came back
  // to the command vocabulary, so it still sent callers to the meetup shape.
  for (const [command, kind] of [["CREATE_DECISION", "DECISION"], ["CAST_VOTE", "VOTE"]] as const) {
    it(`4. ${command} names the general ${kind} home, and that home accepts it`, () => {
      const home = String((LEGACY_PATH_COMMANDS as Record<string, string>)[command] ?? "");
      assert.match(home, /coordination/, `${command} does not name the coordination route`);
      assert.match(home, new RegExp(kind), `${command} does not name kind ${kind}`);
      assert.ok((COORDINATION_KINDS as readonly string[]).includes(kind));
    });
  }

  it("4c. the meetup surfaces are still named — the general home ADDS a door, it does not close one", () => {
    // T167 CAST_VOTE is C through `meetup_time_votes` and T83's meetup triple is
    // C. A pointer that dropped them would send an RSVP caller to the wrong
    // place, which is the same defect in the other direction.
    assert.match(String(LEGACY_PATH_COMMANDS.CREATE_DECISION ?? ""), /meetup/);
    assert.match(String(LEGACY_PATH_COMMANDS.CAST_VOTE ?? ""), /meetup/);
  });

  it("3. no §13.1 command is homeless, and the rule that would find one still works", () => {
    // UNIMPLEMENTED_COMMANDS is DERIVED from the other two lists now, so it
    // cannot go stale the way it did. The measurement and the rule are asserted
    // separately, because a derivation that is empty proves nothing on its own.
    assert.deepEqual(
      [...UNIMPLEMENTED_COMMANDS],
      [],
      "a §13.1 command is homeless again; say which and why in the census before landing it",
    );
    assert.deepEqual(
      unimplementedCommandsFrom([...TELEGRAPH_COMMANDS, "TELEPORT_USER"], ISSUABLE_COMMANDS, LEGACY_PATH_COMMANDS),
      ["TELEPORT_USER"],
      "the derivation no longer detects a spec-named command with no home",
    );
    // And CREATE_COORDINATION_SESSION is not homeless by being forgotten. Its
    // home moved at the merge — from the legacy map to the issuable list, once
    // the bus started performing it — so this asserts it has ONE of the two
    // homes the derivation reads from, rather than naming a particular one and
    // going red the next time that answer legitimately changes.
    assert.ok(
      (ISSUABLE_COMMANDS as readonly string[]).includes("CREATE_COORDINATION_SESSION")
        || Object.prototype.hasOwnProperty.call(LEGACY_PATH_COMMANDS, "CREATE_COORDINATION_SESSION"),
      "the command is in neither list, so the derivation would report it unimplemented again",
    );
  });
});

/**
 * THE SECOND DOOR WAS THE WEAKER ONE — census-telegraph, 2026-10-03.
 *
 * `createCoordinationSession` has two callers. `routes/telegraphCoordination.ts`
 * applies `guardTelegraphThreadWrite`, whose own header states the rule: "A
 * second write endpoint that skipped one of them would be a weaker door into
 * the same table." `server/telegraph/commandRoute.ts` applied only the
 * membership half, and `services/telegraph/coordinationSessions.ts:151-157`
 * recorded that asymmetry as a fact without noticing it was a hole.
 *
 * Three gates were therefore reachable past: the `disable_messaging` emergency
 * stop, the 1:1 block guard, and the E2EE plaintext refusal. Each case below
 * asserts the `messages` TABLE afterwards and not only the status code, because
 * a refusal that writes the row anyway passes a status assertion.
 *
 * SHOWN RED FIRST: without the guard at commandRoute.ts, S1, S2 and S3 all
 * answer 200 and leave a new `messages` row behind.
 */
describe("§13.1 CREATE_COORDINATION_SESSION — the four gates on a messages write", () => {
  const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
  const KEY = "evening-1";

  async function open(client: any) {
    _setTestClient(client, true);
    const before = client._db.messages.length;
    const res = await fetch(`${base}/telegraph/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
      body: JSON.stringify({
        type: "CREATE_COORDINATION_SESSION",
        conversationId: THREAD,
        idempotency_key: KEY,
        params: { title: "Dinner at 8" },
      }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as any,
      written: client._db.messages.length - before,
    };
  }

  const members = [
    { thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null },
    { thread_id: THREAD, user_id: BOB, left_at: null, last_read_at: null },
  ];

  it("C. CONTROL: an ordinary 1:1 thread — the command opens the session and the row is written", async () => {
    const client = makeClient({
      message_thread_members: members,
      message_threads: [{ id: THREAD, is_e2ee: false }],
      blocks: [],
    });
    const r = await open(client);
    assert.equal(r.status, 200, `the control must still serve: ${JSON.stringify(r.body)}`);
    assert.equal(r.written, 1, "the control proves the harness really writes, so a 0 below means the gate stopped it");
  });

  it("S1. `disable_messaging` ENGAGED refuses, and writes nothing", async () => {
    const client = makeClient({
      feature_flags: [
        { flag: "telegraph_message_kernel_enabled", enabled: true },
        { flag: "disable_messaging", enabled: true },
      ],
      message_thread_members: members,
      message_threads: [{ id: THREAD, is_e2ee: false }],
      blocks: [],
    });
    const r = await open(client);
    assert.equal(r.body.error, "feature_disabled", `answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.written, 0, "an operator engaged the stop and the write landed anyway");
  });

  it("S2. a 1:1 thread with a block refuses, and writes nothing", async () => {
    // The harness's `.or()` adds no predicate, so this asserts "a blocks row is
    // present ⇒ refused" rather than the exact pair the predicate matches.
    // Which pair `isBlockedBetween` matches is its own file's subject; what is
    // under test here is that this door asks it at all, which it did not.
    const client = makeClient({
      message_thread_members: members,
      message_threads: [{ id: THREAD, is_e2ee: false }],
      blocks: [{ blocker_id: BOB, blocked_id: ALICE }],
    });
    const r = await open(client);
    assert.equal(r.body.error, "forbidden", `answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.written, 0, "blocking leaves the thread open on purpose, so skipping the check is a hole");
  });

  it("S3. an E2EE thread refuses, and stores no plaintext", async () => {
    const client = makeClient({
      message_thread_members: members,
      message_threads: [{ id: THREAD, is_e2ee: true }],
      blocks: [],
    });
    const r = await open(client);
    assert.equal(r.body.error, "e2ee_thread", `answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(
      r.written,
      0,
      "the envelope is JSON.stringify'd plaintext and an E2EE thread's promise is that the server never stores any",
    );
  });

  it("S4. a non-member still gets the membership refusal this endpoint's callers read", async () => {
    // The membership check is kept beside the guard rather than folded into it:
    // the guard reports a non-member and a block with the same `forbidden` code,
    // and these are different sentences to the caller.
    const client = makeClient({
      message_thread_members: [{ thread_id: THREAD, user_id: BOB, left_at: null, last_read_at: null }],
      message_threads: [{ id: THREAD, is_e2ee: false }],
      blocks: [],
    });
    const r = await open(client);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "TELEGRAPH_AUTH_NOT_MEMBER");
    assert.equal(r.written, 0);
  });
});
