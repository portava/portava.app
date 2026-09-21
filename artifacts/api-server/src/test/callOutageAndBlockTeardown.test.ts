/**
 * THE CALL SUBSYSTEM'S TWO SILENT NO-OPS.
 *
 * Both come from the same fact: supabase-js RESOLVES `{ data: null, error }` on
 * a database error. A read that never binds `.error` therefore hands its caller
 * an EMPTY LIST — and in both places below, an empty list is exactly what
 * "there is nothing to do" looks like.
 *
 *   1. THE SWEEPER. `listOpenSessions` is the sweep's only input. Unreadable
 *      `call_sessions` -> [] -> `{ missed: 0, capped: 0, ghosted: 0 }`, which
 *      the scheduler does not even log (it logs only when a counter is
 *      non-zero), and whose `.catch()` never fired because nothing threw. So
 *      overdue rings never became `missed`, no call ever hit the 4-hour cap,
 *      ghost sessions were never healed — and every tick reported a clean pass.
 *      Sustained failures (a renamed column, an RLS change) would have looked
 *      like this forever.
 *
 *   2. THE BLOCK HOOK. `forceEndDirectCallsBetween` is the ONLY thing that ends
 *      a call in progress when one participant blocks the other.
 *      `findOpenDirectSessionsBetween` decides which calls that is. Unreadable
 *      -> [] -> the loop runs zero times -> the function returns success having
 *      ended nothing. A BLOCKS B MID-CALL AND THE CALL KEEPS RUNNING. The
 *      enclosing try/catch could not help: nothing was thrown.
 *
 * ── A VACUOUS TEST THIS FILE REPLACES ───────────────────────────────────────
 * callHardening.test.ts has a test named "the block-hook END primitive
 * terminates rooms for active AND ringing sessions". It never calls
 * `forceEndDirectCallsBetween`. It calls `applyEvent` twice by hand and then
 * asserts `typeof forceEndDirectCallsBetween === 'function'`. MEASURED: the
 * entire body of `forceEndDirectCallsBetween` was replaced with `{}` and
 * callHardening still passed 21/21. Every test below drives the REAL function
 * through the REAL makeCallStore against a fake supabase client, so gutting it
 * turns this file red.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * "there was no call to end" and "the call table could not be read" produce the
 * identical observable — nothing happened. So every outage case here is paired
 * with a control on the SAME fixture where the row IS present and readable, and
 * the control asserts the teardown actually happened.
 *
 * Run: node --import tsx/esm --test src/test/callOutageAndBlockTeardown.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeCallStore } from "../lib/calls/callStoreAdapter.js";
import { forceEndDirectCallsBetween } from "../lib/calls/callSignaling.js";
import { applyEvent, sweepOpenSessions, type CallStore, type RoomAdminPort } from "../lib/calls/callReconciler.js";
import { CALL_CONFIG } from "../lib/calls/callTypes.js";
import {
  runCallSweepTick,
  callSweepFailureState,
  _resetCallSweepFailureState,
} from "../lib/callSweepScheduler.js";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOW = Date.parse("2026-07-18T12:00:00Z");

const DB_ERROR = { code: "42501", message: "permission denied for table call_sessions" };

type Rows = Record<string, any[]>;

/**
 * A fake PostgREST client. Failure is injected per TABLE and RESOLVES rather
 * than throwing — a throwing fake would be caught by try/catch blocks that in
 * production can never fire, which is the whole defect.
 */
function makeSc(rows: Rows, failTables: string[] = []) {
  let selectCount = 0;
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    let isWrite = false;
    let patch: any = null;
    let returning = false;
    const b: any = {
      select() { returning = true; if (!isWrite) selectCount += 1; return b; },
      update(p: any) { isWrite = true; patch = p; return b; },
      insert(p: any) { isWrite = true; patch = p; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(f: any, r: any) { return run(false).then(f, r); },
    };
    function match(): any[] {
      let out: any[] = rows[table] ?? [];
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, v] of ins) out = out.filter((r) => v.includes(r[c]));
      return out;
    }
    async function run(single: boolean): Promise<any> {
      if (failTables.includes(table)) return { data: null, error: DB_ERROR, count: null };
      const hit = match();
      if (isWrite) {
        for (const r of hit) Object.assign(r, patch);
        // A write reports rows only when it was made RETURNING with .select().
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null, count: null };
      }
      if (single) return { data: hit[0] ?? null, error: null, count: hit.length };
      return { data: hit, error: null, count: hit.length };
    }
    return b;
  }
  return { sc: { from } as any, reads: () => selectCount };
}

/** One open direct call between A and B, ringing long enough to be overdue. */
function fixture(overdue = false): Rows {
  const startedAt = new Date(overdue ? NOW - CALL_CONFIG.RING_TIMEOUT_MS - 5_000 : NOW).toISOString();
  return {
    call_sessions: [{
      id: "call-1", room_name: "pcall_1", status: "ringing", call_type: "voice",
      context_type: "telegraph_dm", context_id: "t1", thread_id: "t1",
      started_by: USER_A, started_at: startedAt, connected_at: null, ended_at: null,
    }],
    call_participants: [
      { call_id: "call-1", user_id: USER_A, status: "joined", joined_at: startedAt },
      { call_id: "call-1", user_id: USER_B, status: "ringing", joined_at: null },
    ],
    message_threads: [],
    messages: [],
  };
}

let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

// ── The block hook ──────────────────────────────────────────────────────────

describe("block hook — a live call between blocker and blocked must actually end", () => {
  it("POSITIVE CONTROL: with a readable call_sessions the open call is ended", async () => {
    const rows = fixture();
    const { sc } = makeSc(rows);
    const ended: string[] = [];
    const admin: RoomAdminPort = { endRoom: async (r) => { ended.push(r); } };

    await forceEndDirectCallsBetween(sc, admin, USER_A, USER_B);

    assert.equal(checked(rows.call_sessions[0].status), "canceled", "END during ring == cancel");
    assert.deepEqual(checked(ended), ["pcall_1"], "the LiveKit room is torn down server-side");
  });

  it("throws out of the store (rather than silently ending nothing) when call_sessions is unreadable", async () => {
    // Same fixture — the call IS there. Only the read fails. The store must
    // report that, instead of handing back an empty list that reads as
    // "these two are not on a call".
    const rows = fixture();
    const { sc } = makeSc(rows, ["call_sessions"]);
    const store = makeCallStore(sc);
    await assert.rejects(
      () => store.findOpenDirectSessionsBetween(USER_A, USER_B),
      /findOpenDirectSessionsBetween sessions read failed/,
      "an unreadable session table must not answer 'no open calls'",
    );
    checked(true);
  });

  it("throws when call_participants is unreadable (the pairing half of the same decision)", async () => {
    const rows = fixture();
    const { sc } = makeSc(rows, ["call_participants"]);
    const store = makeCallStore(sc);
    await assert.rejects(
      () => store.findOpenDirectSessionsBetween(USER_A, USER_B),
      /findOpenDirectSessionsBetween participants read failed/,
    );
    checked(true);
  });

  it("the hook still never throws at its caller — the block itself must not roll back", async () => {
    // The block row is already written by the time this runs; a teardown failure
    // may be loud but must not propagate. It is now logged at ERROR (a live call
    // surviving a block is not "non-critical"), which this asserts by contract:
    // the call resolves, and the session is provably NOT reported as ended.
    const rows = fixture();
    const { sc } = makeSc(rows, ["call_sessions"]);
    const ended: string[] = [];
    const admin: RoomAdminPort = { endRoom: async (r) => { ended.push(r); } };

    await forceEndDirectCallsBetween(sc, admin, USER_A, USER_B); // must not reject

    assert.equal(checked(rows.call_sessions[0].status), "ringing", "nothing was ended — and nothing pretended otherwise");
    assert.deepEqual(checked(ended), [], "no room was torn down");
  });
});

// ── The sweeper ─────────────────────────────────────────────────────────────

describe("sweeper — 'nothing stale' and 'could not read' must not be the same answer", () => {
  it("POSITIVE CONTROL: an overdue ring is swept to missed through the real store", async () => {
    const rows = fixture(true);
    const { sc } = makeSc(rows);
    const store = makeCallStore(sc);
    const res = await sweepOpenSessions(store, { endRoom: async () => {} }, NOW);
    assert.equal(checked(res.missed), 1);
    assert.equal(checked(rows.call_sessions[0].status), "missed");
  });

  it("throws (rather than reporting a clean pass) when call_sessions is unreadable", async () => {
    const rows = fixture(true); // the overdue ring IS there
    const { sc } = makeSc(rows, ["call_sessions"]);
    const store = makeCallStore(sc);
    await assert.rejects(
      () => sweepOpenSessions(store, { endRoom: async () => {} }, NOW),
      /listOpenSessions failed/,
      "an unreadable session table must not present as 'no stale calls'",
    );
    assert.equal(checked(rows.call_sessions[0].status), "ringing", "and the overdue ring is still overdue");
  });

  it("POSITIVE CONTROL: a genuinely empty sweep is a SUCCESS and clears the failure counter", async () => {
    _resetCallSweepFailureState();
    const { sc } = makeSc({ call_sessions: [], call_participants: [] });
    const t = await runCallSweepTick({ client: sc, admin: { endRoom: async () => {} }, nowMs: NOW });
    assert.equal(checked(t.ok), true, "no open sessions is a completed sweep, not a failure");
    assert.equal(checked(callSweepFailureState().consecutiveFailures), 0);
  });

  it("counts consecutive failed ticks and does NOT reset on a tick where everything failed", async () => {
    _resetCallSweepFailureState();
    const { sc } = makeSc(fixture(true), ["call_sessions"]);
    const admin: RoomAdminPort = { endRoom: async () => {} };
    for (let i = 1; i <= 3; i++) {
      const t = await runCallSweepTick({ client: sc, admin, nowMs: NOW });
      assert.equal(checked(t.ok), false, `tick ${i} did not sweep and must not claim it did`);
      assert.equal(
        checked(callSweepFailureState().consecutiveFailures), i,
        "a pass in which everything failed is not a pass — the counter must climb",
      );
    }
    assert.match(checked(callSweepFailureState().lastError ?? ""), /listOpenSessions failed/);
  });

  it("a completed sweep after failures clears the counter (and only then)", async () => {
    _resetCallSweepFailureState();
    const rows = fixture(true);
    const failing = makeSc(rows, ["call_sessions"]);
    const admin: RoomAdminPort = { endRoom: async () => {} };
    await runCallSweepTick({ client: failing.sc, admin, nowMs: NOW });
    assert.equal(checked(callSweepFailureState().consecutiveFailures), 1);
    const healthy = makeSc(rows);
    const ok = await runCallSweepTick({ client: healthy.sc, admin, nowMs: NOW });
    assert.equal(checked(ok.ok), true);
    assert.equal(checked(callSweepFailureState().consecutiveFailures), 0, "reset only on a real pass");
    assert.equal(checked(rows.call_sessions[0].status), "missed", "and it did the work it had been skipping");
  });

  it("a missing supabase client is a failed tick, not a clean pass", async () => {
    // runCallSweep returns null when there is no client — the sweep did not
    // run. Reporting that as a clean tick is the same lie the unreadable-table
    // case used to tell, so it counts. Driven through the injectable seam
    // because getServiceClient() answers from the environment and a null client
    // cannot be forced through `opts` (a `client: null` is simply replaced by
    // `?? getServiceClient()`, which is how an earlier draft of this test
    // passed for the wrong reason — a transport error, not a missing client).
    _resetCallSweepFailureState();
    const t = await runCallSweepTick({}, async () => null);
    assert.equal(checked(t.ok), false, "the sweep did not run; saying nothing is the old defect");
    assert.equal(checked(callSweepFailureState().consecutiveFailures), 1);
    assert.match(checked(callSweepFailureState().lastError ?? ""), /no supabase client/);
  });

  it("a tick that cannot reach the database at all also counts as failed", async () => {
    _resetCallSweepFailureState();
    const boom = new Error("TypeError: fetch failed");
    const t = await runCallSweepTick({}, async () => { throw boom; });
    assert.equal(checked(t.ok), false);
    assert.equal(checked(callSweepFailureState().consecutiveFailures), 1);
  });
});

// ── applyEvent's return value: don't announce what you didn't do ────────────

describe("applyEvent reports whether it actually moved the session", () => {
  /** A store whose compare-and-set outcome the test dictates. */
  function storeWithCas(applies: boolean, session: any) {
    const store: CallStore = {
      getSessionByRoom: async () => session,
      getSession: async () => session,
      applyTransition: async () => applies,
      markParticipantJoined: async () => {},
      markParticipantLeft: async () => {},
      listOpenSessions: async () => [session],
      writeCallHistoryMessage: async () => {},
    };
    return store;
  }
  const session = {
    id: "c1", roomName: "pcall_c1", status: "active", callType: "voice",
    contextType: "telegraph_dm", contextId: "t1", threadId: "t1", startedBy: USER_A,
    startedAt: new Date(NOW).toISOString(), connectedAt: new Date(NOW).toISOString(), endedAt: null,
  } as any;

  it("true when the transition applied", async () => {
    const applied = await applyEvent(
      storeWithCas(true, session), { endRoom: async () => {} }, { ...session },
      { type: "END" }, new Date(NOW).toISOString(),
    );
    assert.equal(checked(applied), true);
  });

  it("false when it LOST the compare-and-set — the caller must not announce an end it did not cause", async () => {
    // This is what made the block hook broadcast `call.ended, reason:"blocked"`
    // to both parties, and write a second `ended` row into analytics, for a call
    // that had already ended by other means moments earlier.
    const applied = await applyEvent(
      storeWithCas(false, session), { endRoom: async () => {} }, { ...session },
      { type: "END" }, new Date(NOW).toISOString(),
    );
    assert.equal(checked(applied), false);
  });

  it("false when the transition is illegal for the current state", async () => {
    const terminal = { ...session, status: "ended", endedAt: new Date(NOW).toISOString() };
    const applied = await applyEvent(
      storeWithCas(true, terminal), { endRoom: async () => {} }, terminal,
      { type: "END" }, new Date(NOW).toISOString(),
    );
    assert.equal(checked(applied), false, "a terminal session cannot be ended again");
  });
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 28, `expected >=28 checked assertions, got ${inspected}`);
  });
});
