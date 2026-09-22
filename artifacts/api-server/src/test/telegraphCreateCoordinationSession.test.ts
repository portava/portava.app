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
 *   1. The refusal names the real home, and it is a 409 (wrong door) rather
 *      than a 501 (does not exist). Those lead a caller to different actions:
 *      one is "go here", the other is "give up".
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

function makeClient() {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    message_thread_members: [{ thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null }],
    messages: [],
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

  it("1b. LEGACY_PATH_COMMANDS points at the coordination route and names the kind", () => {
    const home = String(LEGACY_PATH_COMMANDS.CREATE_COORDINATION_SESSION ?? "");
    assert.match(home, /coordination/, "the entry does not name the coordination route");
    assert.match(home, /COORDINATION_SESSION/, "the entry does not name the kind the route needs");
  });

  it("1c. the route answers 409 wrong_endpoint, not 501 not_implemented", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await postCommand("CREATE_COORDINATION_SESSION");
    assert.equal(status, 409, `answered ${status}; a 501 sends the caller away from a working route`);
    assert.equal(body.error, "wrong_endpoint");
    assert.match(String(body.message ?? ""), /coordination/);
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
    // And CREATE_COORDINATION_SESSION is not homeless by being forgotten: it is
    // in the legacy map, which is where the derivation reads from.
    assert.ok(Object.prototype.hasOwnProperty.call(LEGACY_PATH_COMMANDS, "CREATE_COORDINATION_SESSION"));
  });
});
