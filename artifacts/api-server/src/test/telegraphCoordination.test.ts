/**
 * Telegraph §8 + §9 — the coordination surface.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §8    ConversationDecision · ConversationCommitment · CoordinationSession ·
 *          Rendezvous
 *   §8.1  the fourteen native actions
 *   §8.2  canonical creation requires user confirmation
 *   §9    PREPARING -> ASSEMBLING -> ACTIVE -> RETURNING -> COMPLETE, with
 *          DISRUPTED / CANCELLED
 *   §9.1  the seven quick states, and "User-declared status must remain
 *          distinguishable from system-derived ETA or location-derived
 *          estimates."
 *
 * WHAT IS EXERCISED: the real `services/telegraph/coordination.ts` projections
 * and the real `routes/telegraphCoordination.ts`, mounted in a real express app
 * over an in-memory PostgREST-shaped fake.
 *
 * THE THREE RULES A NAIVE TALLY GETS WRONG are each asserted: a changed vote,
 * a vote after the deadline, and a tie. A decision projection that only summed
 * votes would pass a weaker test and be wrong in a thread.
 *
 * SHOWN RED before commit, each reverted:
 *   • `projectDecision` counting late votes → pass 41 / fail 1 (the deadline
 *     test).
 *   • it keying votes by message id rather than by voter, so an earlier vote
 *     still counts → pass 41 / fail 1 (the changed-vote test).
 *   • `derivedCoordinationState` returning PREPARING for a plan with no start,
 *     AND `TRANSITIONS.CANCELLED` given an outbound edge → pass 39 / fail 3.
 *   All restored: 42/42.
 *
 * Run: node --import tsx/esm --test src/test/telegraphCoordination.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import {
  COORDINATION_ACTIONS,
  derivedCoordinationState,
  isLegalTransition,
  isTerminalCoordinationState,
  latestQuickStates,
  leaveByFor,
  legalNextStates,
  parseCoordinationEnvelope,
  projectAcknowledgements,
  projectCommitment,
  projectDecision,
  threadIsCoordinating,
  validateCoordinationMessage,
  LEAVE_BY_LEAD_MINUTES,
} from "../services/telegraph/coordination.js";
import { COORDINATION_QUICK_STATES, TELEGRAPH_ACTIONS } from "../services/telegraph/vocabulary.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const THREAD_NONE = "dddddddd-0000-4000-8000-00000000000f";
/** A second thread Alice and Bob are both in — §8's "across threads" case. */
const THREAD_B = "dddddddd-0000-4000-8000-0000000000ab";
const MEETUP = "20000000-0000-4000-8000-000000000001";

const NOW = Date.now();
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();
const hr = (n: number) => new Date(NOW + n * 3600_000).toISOString();

interface State {
  errorTable?: string;
  meetupStartsAt?: string | null;
  meetupEndsAt?: string | null;
  meetupStatus?: string;
  extraMessages?: any[];
  /** Replaces the default roster — the catch-up cases need markers and windows. */
  members?: any[];
  /** §14.3's flag, off by default exactly as it is seeded. */
  historyBound?: boolean;
  /** census-telegraph T107 (lane tg-rides): rows of `blocks`. */
  blocks?: any[];
  /** Fail only the `messages` reads filtered to this `msg_type` (T107's lookups). */
  failMsgType?: string;
  /** Fail only the `messages` reads filtered on this column (T107's identity lookup). */
  failEqCol?: string;
  /**
   * Model 2810's `messages_idempotency_uniq`: an insert repeating (thread_id,
   * sender_id, idempotency_key) is refused 23505 and writes nothing. `onUnique`
   * runs at that moment (T107: the caller leaves between the conflict and the
   * read-back).
   */
  uniqueKeys?: boolean;
  /** A database without 2810: any read filtering on idempotency_key is 42703, an insert naming it is PGRST204. */
  noIdentityColumn?: boolean;
  /** The first N identity lookups (an `.eq("idempotency_key")` read) see nothing — a race lost before the read. */
  missKeyLookups?: number;
  onUnique?: (db: Record<string, any[]>) => void;
}

function env(kind: string, payload: unknown) {
  return JSON.stringify({ kind, envelopeVersion: "1", payload });
}

function msg(id: string, sender: string, msg_type: string, payload: unknown, created_at: string, subtype: string | null = null) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at,
    deleted_at: null,
    msg_type,
    subtype,
    body: env(msg_type.toUpperCase(), payload),
  };
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "disable_messaging", enabled: false },
      { flag: "telegraph_history_bound_enabled", enabled: state.historyBound === true },
    ],
    message_threads: [
      { id: THREAD, is_e2ee: false },
      { id: THREAD_B, is_e2ee: false },
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: state.members ?? [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD_B, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD_B, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null, visible_from_at: null, last_read_at: null },
    ],
    blocks: state.blocks ?? [],
    meetups:
      state.meetupStartsAt === null
        ? []
        : [
            {
              id: MEETUP,
              title: "Dinner",
              starts_at: state.meetupStartsAt ?? min(30),
              ends_at: state.meetupEndsAt ?? hr(3),
              status: state.meetupStatus ?? "confirmed",
              chat_thread_id: THREAD,
            },
          ],
    messages: state.extraMessages ?? [],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const inserted: any[] = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const eqs: Record<string, any> = {};

    const rowsNow = () => {
      if (table === "messages" && "idempotency_key" in eqs && !pendingInsert && (state.missKeyLookups ?? 0) > 0) {
        state.missKeyLookups = (state.missKeyLookups ?? 0) - 1;
        return [];
      }
      let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (_order) {
        const { col, asc } = _order;
        rows = [...rows].sort((a, b) => {
          const x = Date.parse(a[col]) || 0;
          const y = Date.parse(b[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () =>
      state.errorTable === table ||
      (state.failMsgType !== undefined && table === "messages" && eqs.msg_type === state.failMsgType && !pendingInsert) ||
      (state.failEqCol !== undefined && table === "messages" && state.failEqCol in eqs && !pendingInsert)
        ? { message: `injected failure on ${table}`, code: "XX000" }
        : state.noIdentityColumn && table === "messages" && ("idempotency_key" in eqs || noColumnInsert)
          ? { message: "column messages.idempotency_key does not exist", code: "42703" }
          : uniqueViolation
          ? { message: "duplicate key value violates unique constraint \"messages_idempotency_uniq\"", code: "23505" }
          : null;
    let uniqueViolation = false;
    let noColumnInsert = false;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        if (state.noIdentityColumn && table === "messages" && "idempotency_key" in row) { noColumnInsert = true; return proxy; }
        if (
          state.uniqueKeys && table === "messages" && row.idempotency_key != null &&
          (db.messages ?? []).some((r) => r.thread_id === row.thread_id && r.sender_id === row.sender_id && r.idempotency_key === row.idempotency_key)
        ) {
          uniqueViolation = true;
          state.onUnique?.(db);
          return proxy;
        }
        pendingInsert = { id: `new-${inserted.length + 1}`, ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { eqs[col] = val; filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      gte(col: string, val: any) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: pendingInsert ? [pendingInsert] : rowsNow(), error: null }).then(resolve, reject);
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
    _inserted: inserted,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function get(path: string, asUser: string) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphCoordinationRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── §9 the state machine ─────────────────────────────────────────────────────

describe("§9 — the coordination state machine", () => {
  it("has exactly §9's arrows, and COMPLETE / CANCELLED are terminal", () => {
    assert.deepEqual([...legalNextStates("PREPARING")], ["ASSEMBLING", "DISRUPTED", "CANCELLED"]);
    assert.deepEqual([...legalNextStates("ASSEMBLING")], ["ACTIVE", "DISRUPTED", "CANCELLED"]);
    assert.deepEqual([...legalNextStates("ACTIVE")], ["RETURNING", "DISRUPTED", "COMPLETE"]);
    assert.deepEqual([...legalNextStates("RETURNING")], ["COMPLETE", "DISRUPTED"]);
    assert.equal(isTerminalCoordinationState("COMPLETE"), true);
    assert.equal(isTerminalCoordinationState("CANCELLED"), true);
    assert.equal(isLegalTransition("PREPARING", "ACTIVE"), false, "§9 has no arrow from PREPARING to ACTIVE");
    assert.equal(isLegalTransition("COMPLETE", "ACTIVE"), false);
  });

  it("DISRUPTED is recoverable — it is an exit, not a grave", () => {
    assert.equal(isLegalTransition("ACTIVE", "DISRUPTED"), true);
    assert.equal(isLegalTransition("DISRUPTED", "ACTIVE"), true);
    assert.equal(isLegalTransition("DISRUPTED", "CANCELLED"), true);
  });

  it("derives the state from the plan's own timeline", () => {
    const plan = { objectId: "m", title: "Dinner", startsAt: min(60), endsAt: min(180) };
    assert.equal(derivedCoordinationState(plan, NOW), "PREPARING");
    assert.equal(derivedCoordinationState(plan, NOW + 30 * 60_000), "ASSEMBLING");
    assert.equal(derivedCoordinationState(plan, NOW + 90 * 60_000), "ACTIVE");
    assert.equal(derivedCoordinationState(plan, NOW + 200 * 60_000), "RETURNING");
    assert.equal(derivedCoordinationState(plan, NOW + 400 * 60_000), "COMPLETE");
  });

  it("a cancelled plan is CANCELLED whatever the clock says", () => {
    const plan = { objectId: "m", title: "x", startsAt: min(60), endsAt: min(180), status: "cancelled" };
    assert.equal(derivedCoordinationState(plan, NOW), "CANCELLED");
  });

  it("a plan with no start has NO state — not PREPARING", () => {
    assert.equal(
      derivedCoordinationState({ objectId: "m", title: "someday", startsAt: null, endsAt: null }, NOW),
      null,
      "an undated wish must not put a conversation into coordination mode",
    );
  });

  it("§9's 'temporarily' excludes PREPARING", () => {
    assert.equal(threadIsCoordinating("PREPARING"), false, "a plan three days out is not a coordination surface");
    assert.equal(threadIsCoordinating("ASSEMBLING"), true);
    assert.equal(threadIsCoordinating("ACTIVE"), true);
    assert.equal(threadIsCoordinating("RETURNING"), true);
    assert.equal(threadIsCoordinating("COMPLETE"), false);
    assert.equal(threadIsCoordinating(null), false);
  });

  it("leave-by is the plan's own, or a lead time before the start", () => {
    assert.equal(leaveByFor({ objectId: "m", title: "x", startsAt: min(60), endsAt: null, leaveByAt: min(10) }), min(10));
    assert.equal(
      leaveByFor({ objectId: "m", title: "x", startsAt: min(60), endsAt: null }),
      new Date(NOW + (60 - LEAVE_BY_LEAD_MINUTES) * 60_000).toISOString(),
    );
    assert.equal(leaveByFor({ objectId: "m", title: "x", startsAt: null, endsAt: null }), null);
  });
});

// ── §9.1 quick states ────────────────────────────────────────────────────────

describe("§9.1 — the seven quick states", () => {
  it("the vocabulary is §9.1's seven, verbatim", () => {
    assert.deepEqual([...COORDINATION_QUICK_STATES], [
      "ON_MY_WAY", "ARRIVED", "RUNNING_LATE", "CANT_MAKE_IT", "START_WITHOUT_ME", "HEADING_BACK", "NEED_HELP",
    ]);
  });

  it("every one validates and lands in the row subtype", () => {
    for (const state of COORDINATION_QUICK_STATES) {
      const r = validateCoordinationMessage("COORDINATION", { state });
      assert.equal(r.ok, true, `${state} must be sendable`);
      assert.equal(r.ok === true && r.subtype, state.toLowerCase());
      assert.equal(r.ok === true && r.msgType, "coordination");
    }
  });

  it("a made-up state is refused", () => {
    assert.equal(validateCoordinationMessage("COORDINATION", { state: "TELEPORTING" }).ok, false);
  });

  it("a quick state carries USER_DECLARED provenance and cannot carry another", () => {
    const r = validateCoordinationMessage("COORDINATION", { state: "ON_MY_WAY" });
    assert.equal(r.ok === true && (r.envelope as any).payload.provenance, "USER_DECLARED");
    const forged = validateCoordinationMessage("COORDINATION", { state: "ON_MY_WAY", provenance: "SYSTEM_DERIVED" });
    assert.equal(forged.ok, false, "§9.1: a derived estimate is not representable as a declared status");
  });

  it("the latest declaration per member wins, and the list is newest first", () => {
    const rows = [
      { sender_id: ALICE, created_at: min(-30), payload: { state: "ON_MY_WAY", provenance: "USER_DECLARED" } },
      { sender_id: ALICE, created_at: min(-5), payload: { state: "ARRIVED", provenance: "USER_DECLARED" } },
      { sender_id: BOB, created_at: min(-10), payload: { state: "RUNNING_LATE", provenance: "USER_DECLARED" } },
    ];
    const latest = latestQuickStates(rows);
    assert.equal(latest.length, 2);
    assert.equal(latest[0]!.userId, ALICE);
    assert.equal(latest[0]!.state, "ARRIVED");
    assert.equal(latest[1]!.state, "RUNNING_LATE");
  });
});

// ── §8 decisions ─────────────────────────────────────────────────────────────

const decisionMsg = {
  id: "d1",
  sender_id: ALICE,
  created_at: min(-60),
  payload: {
    question: "Where do we eat?",
    options: [{ id: "a", label: "Bun cha" }, { id: "b", label: "Banh xeo" }],
    resolutionRule: "PLURALITY",
    deadlineAt: min(-10),
  },
};

function vote(id: string, user: string, optionId: string, at: string) {
  return { id, sender_id: user, created_at: at, payload: { decisionId: "d1", optionId } };
}

describe("§8 — ConversationDecision", () => {
  it("carries question, options, voters, rule, deadline and a final result", () => {
    const d = projectDecision(decisionMsg, [vote("v1", BOB, "a", min(-40)), vote("v2", CAROL, "a", min(-30))], NOW)!;
    assert.equal(d.question, "Where do we eat?");
    assert.equal(d.options.length, 2);
    assert.equal(d.resolutionRule, "PLURALITY");
    assert.equal(d.deadlineAt, min(-10));
    assert.equal(d.votes.length, 2);
    assert.deepEqual(d.tally, { a: 2, b: 0 });
    assert.equal(d.resolved, true);
    assert.equal(d.result, "a");
    assert.equal(d.reason, "deadline_passed");
  });

  it("a voter may change their mind: the LATEST vote counts, the earlier one does not", () => {
    const d = projectDecision(
      decisionMsg,
      [vote("v1", BOB, "a", min(-50)), vote("v2", BOB, "b", min(-20)), vote("v3", CAROL, "b", min(-30))],
      NOW,
    )!;
    assert.deepEqual(d.tally, { a: 0, b: 2 });
    assert.equal(d.votes.length, 2, "one row per voter, not one per vote");
    assert.equal(d.result, "b");
  });

  it("a vote AFTER the deadline is recorded and NOT counted", () => {
    const d = projectDecision(
      decisionMsg,
      [vote("v1", BOB, "a", min(-40)), vote("v2", CAROL, "b", min(-2))],
      NOW,
    )!;
    const late = d.votes.find((v) => v.userId === CAROL)!;
    assert.equal(late.late, true, "the thread still shows the vote happened");
    assert.deepEqual(d.tally, { a: 1, b: 0 }, "but a deadline that changes nothing is not a deadline");
    assert.equal(d.result, "a");
  });

  it("a TIE is unresolved — the spec asks for a final result, and a tie has none", () => {
    const d = projectDecision(
      decisionMsg,
      [vote("v1", BOB, "a", min(-40)), vote("v2", CAROL, "b", min(-30))],
      NOW,
    )!;
    assert.equal(d.resolved, false);
    assert.equal(d.result, null);
    assert.equal(d.reason, "tied");
  });

  it("before the deadline a plurality is still open", () => {
    const open = { ...decisionMsg, payload: { ...decisionMsg.payload, deadlineAt: min(60) } };
    const d = projectDecision(open, [vote("v1", BOB, "a", min(-5))], NOW)!;
    assert.equal(d.resolved, false);
    assert.equal(d.reason, "awaiting_votes");
  });

  it("MAJORITY resolves as soon as one option holds more than half", () => {
    const m = { ...decisionMsg, payload: { ...decisionMsg.payload, resolutionRule: "MAJORITY", deadlineAt: min(60) } };
    const two = projectDecision(m, [vote("v1", BOB, "a", min(-5)), vote("v2", CAROL, "b", min(-4))], NOW)!;
    assert.equal(two.resolved, false);
    const three = projectDecision(
      m,
      [vote("v1", BOB, "a", min(-5)), vote("v2", CAROL, "b", min(-4)), vote("v3", ALICE, "a", min(-3))],
      NOW,
    )!;
    assert.equal(three.resolved, true);
    assert.equal(three.result, "a");
  });

  it("UNANIMOUS needs at least two voters agreeing", () => {
    const u = { ...decisionMsg, payload: { ...decisionMsg.payload, resolutionRule: "UNANIMOUS", deadlineAt: min(60) } };
    const one = projectDecision(u, [vote("v1", BOB, "a", min(-5))], NOW)!;
    assert.equal(one.resolved, false);
    const two = projectDecision(u, [vote("v1", BOB, "a", min(-5)), vote("v2", CAROL, "a", min(-4))], NOW)!;
    assert.equal(two.resolved, true);
  });

  it("ASKER_DECIDES waits for the asker specifically", () => {
    const a = { ...decisionMsg, payload: { ...decisionMsg.payload, resolutionRule: "ASKER_DECIDES", deadlineAt: min(60) } };
    const other = projectDecision(a, [vote("v1", BOB, "b", min(-5))], NOW)!;
    assert.equal(other.resolved, false);
    assert.equal(other.reason, "asker_has_not_decided");
    const asker = projectDecision(a, [vote("v1", BOB, "b", min(-5)), vote("v2", ALICE, "a", min(-4))], NOW)!;
    assert.equal(asker.resolved, true);
    assert.equal(asker.result, "a");
  });

  it("a vote for an option that does not exist is ignored", () => {
    const d = projectDecision(decisionMsg, [vote("v1", BOB, "zzz", min(-40))], NOW)!;
    assert.deepEqual(d.tally, { a: 0, b: 0 });
    assert.equal(d.reason, "no_votes");
  });

  it("a vote for a DIFFERENT decision is ignored", () => {
    const stray = { id: "v9", sender_id: BOB, created_at: min(-40), payload: { decisionId: "other", optionId: "a" } };
    const d = projectDecision(decisionMsg, [stray], NOW)!;
    assert.equal(d.votes.length, 0);
  });
});

// ── §8 commitments ───────────────────────────────────────────────────────────

describe("§8 — ConversationCommitment", () => {
  const ask = {
    id: "c1",
    sender_id: ALICE,
    created_at: min(-120),
    payload: { what: "book the table", byWhen: min(-10), askedOf: [BOB] },
  };
  const resp = (id: string, user: string, response: string, at: string) => ({
    id, sender_id: user, created_at: at, payload: { commitmentId: "c1", response },
  });

  it("records who agreed, by when, and whether it was completed", () => {
    const c = projectCommitment(ask, [resp("r1", BOB, "AGREED", min(-100))], NOW)!;
    assert.equal(c.what, "book the table");
    assert.equal(c.byWhen, min(-10));
    assert.deepEqual(c.agreedBy.map((a) => a.userId), [BOB]);
    assert.equal(c.completedBy, null);
    assert.equal(c.overdue, true, "the deadline passed and nothing was completed");
  });

  it("a completion clears the overdue flag and names who did it", () => {
    const c = projectCommitment(
      ask,
      [resp("r1", BOB, "AGREED", min(-100)), resp("r2", BOB, "COMPLETED", min(-20))],
      NOW,
    )!;
    assert.equal(c.completedBy, BOB);
    assert.equal(c.overdue, false);
  });

  it("a change of mind is the latest answer, not both", () => {
    const c = projectCommitment(
      ask,
      [resp("r1", BOB, "AGREED", min(-100)), resp("r2", BOB, "DECLINED", min(-50))],
      NOW,
    )!;
    assert.deepEqual(c.agreedBy, []);
    assert.deepEqual(c.declinedBy.map((d) => d.userId), [BOB]);
  });
});

// ── §8.1 actions ─────────────────────────────────────────────────────────────

describe("§8.1 — actions carried here, and actions owned elsewhere", () => {
  it("every action this route carries is one of §8.1's fourteen", () => {
    for (const a of COORDINATION_ACTIONS) {
      assert.ok((TELEGRAPH_ACTIONS as readonly string[]).includes(a), `${a} is not a §8.1 action`);
    }
  });

  it("an action owned by a canonical surface is REFUSED here, with where it lives", () => {
    const r = validateCoordinationMessage("ACTION_PROPOSAL", { action: "ADD_TO_TRIP", title: "x" });
    assert.equal(r.ok, false);
    assert.ok(String(r.ok === false && r.error).includes("canonical surface"));
  });

  it("§8.2: a proposal cannot be sent pre-confirmed", () => {
    const ok = validateCoordinationMessage("ACTION_PROPOSAL", { action: "SPLIT_RIDE", title: "Share a Grab" });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok === true && (ok.envelope as any).payload.requiresConfirmation, true);
    const forged = validateCoordinationMessage("ACTION_PROPOSAL", {
      action: "SPLIT_RIDE", title: "x", requiresConfirmation: false,
    });
    assert.equal(forged.ok, false);
  });
});

// ── §8 rendezvous ────────────────────────────────────────────────────────────

describe("§8 — Rendezvous carries all five properties", () => {
  it("checkpoint, landmark, time window, fallback point and proximity state", () => {
    const r = validateCoordinationMessage("RENDEZVOUS", {
      checkpoint: "Dragon bridge, north end",
      landmark: "under the second lamp",
      windowStartsAt: min(20),
      windowEndsAt: min(50),
      fallbackPoint: "the cafe on the corner",
      proximityState: "NEARBY",
    });
    assert.equal(r.ok, true);
    const p = r.ok === true ? (r.envelope as any).payload : null;
    assert.equal(p.checkpoint, "Dragon bridge, north end");
    assert.equal(p.landmark, "under the second lamp");
    assert.equal(p.fallbackPoint, "the cafe on the corner");
    assert.equal(p.proximityState, "NEARBY");
  });

  it("proximity defaults to UNKNOWN and is coarse — there is no coordinate field", () => {
    const r = validateCoordinationMessage("RENDEZVOUS", { checkpoint: "the bridge" });
    assert.equal(r.ok === true && (r.envelope as any).payload.proximityState, "UNKNOWN");
    const withCoords = validateCoordinationMessage("RENDEZVOUS", { checkpoint: "x", lat: 16.05, lng: 108.2 });
    assert.equal(withCoords.ok, true);
    assert.equal(
      (withCoords.ok === true && (withCoords.envelope as any).payload.lat) ?? null,
      null,
      "coordinates are not part of the contract and are dropped",
    );
  });

  it("round-trips through the stored body", () => {
    const r = validateCoordinationMessage("RENDEZVOUS", { checkpoint: "the bridge" });
    const stored = JSON.stringify(r.ok === true && r.envelope);
    const back = parseCoordinationEnvelope("rendezvous", stored);
    assert.equal(back?.kind, "RENDEZVOUS");
    assert.equal(back?.payload.checkpoint, "the bridge");
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

describe("POST /threads/:id/coordination", () => {
  it("writes a quick state with the state as the row subtype", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION",
      payload: { state: "ON_MY_WAY", approximateLabel: "An Thuong" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.msgType, "coordination");
    assert.equal(r.body.subtype, "on_my_way");
    const row = (c as any)._inserted.find((i: any) => i.table === "messages");
    assert.ok(row);
    assert.equal(JSON.parse(row.row.body).payload.provenance, "USER_DECLARED");
  });

  it("a non-member is refused", async () => {
    useState({});
    const r = await post(`/threads/${THREAD_NONE}/coordination`, ALICE, { kind: "COORDINATION", payload: { state: "ARRIVED" } });
    assert.equal(r.status, 403);
  });

  it("an unknown kind is a 400 naming what IS accepted", async () => {
    useState({});
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, { kind: "TELEPATHY", payload: {} });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.message).includes("RENDEZVOUS"));
  });
});

describe("GET /threads/:id/coordination", () => {
  it("derives §9's state from the thread's plan and says the provenance", async () => {
    useState({ meetupStartsAt: min(30), meetupEndsAt: hr(3) });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.state, "ASSEMBLING");
    assert.equal(r.body.coordination.coordinating, true);
    assert.equal(r.body.stateProvenance, "DERIVED_FROM_PLAN_TIMELINE");
    assert.ok(r.body.coordination.plan.leaveByAt);
    assert.deepEqual(r.body.coordination.legalNext, ["ACTIVE", "DISRUPTED", "CANCELLED"]);
  });

  it("a thread with no plan has no state and is not coordinating", async () => {
    useState({ meetupStartsAt: null });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.plan, null);
    assert.equal(r.body.coordination.state, null);
    assert.equal(r.body.coordination.coordinating, false);
  });

  it("reports the latest declared status per member and the arrival counts", async () => {
    useState({
      extraMessages: [
        msg("q1", ALICE, "coordination", { state: "ON_MY_WAY", provenance: "USER_DECLARED" }, min(-30), "on_my_way"),
        msg("q2", ALICE, "coordination", { state: "ARRIVED", provenance: "USER_DECLARED" }, min(-5), "arrived"),
        msg("q3", BOB, "coordination", { state: "ON_MY_WAY", provenance: "USER_DECLARED" }, min(-10), "on_my_way"),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.quickStates.length, 2);
    assert.equal(r.body.coordination.arrivedCount, 1);
    assert.equal(r.body.coordination.onMyWayCount, 1);
    for (const q of r.body.coordination.quickStates) assert.equal(q.provenance, "USER_DECLARED");
  });

  it("projects a decision from the thread's own messages", async () => {
    useState({
      extraMessages: [
        msg("d1", ALICE, "decision", {
          question: "Where do we eat?",
          options: [{ id: "a", label: "Bun cha" }, { id: "b", label: "Banh xeo" }],
          resolutionRule: "MAJORITY",
          deadlineAt: min(60),
        }, min(-60), "majority"),
        msg("v1", BOB, "vote", { decisionId: "d1", optionId: "a" }, min(-30)),
        msg("v2", ALICE, "vote", { decisionId: "d1", optionId: "a" }, min(-20)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.body.coordination.decisions.length, 1);
    const d = r.body.coordination.decisions[0];
    assert.equal(d.question, "Where do we eat?");
    assert.equal(d.resolved, true);
    assert.equal(d.result, "a");
  });

  it("a deleted decision is not projected", async () => {
    const c = useState({
      extraMessages: [
        { ...msg("d1", ALICE, "decision", {
          question: "gone?",
          options: [{ id: "a", label: "x" }, { id: "b", label: "y" }],
          resolutionRule: "PLURALITY",
        }, min(-60)), deleted_at: min(-5) },
      ],
    });
    void c;
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.deepEqual(r.body.coordination.decisions, []);
  });

  it("a non-member cannot read it", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/coordination`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never an empty coordination view", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/coordination`, ALICE)).status, 500);
  });

  it("an unreadable meetups table omits the plan rather than inventing one", async () => {
    useState({ errorTable: "meetups" });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.plan, null);
    assert.equal(r.body.coordination.state, null);
  });
});

// ── §19 acknowledgement, and why it is not Seen ──────────────────────────────

const ANN = "ann-1";
const ANN_NO_ACK = "ann-2";
const ANN_OTHER_THREAD = "ann-3";

function announcement(id: string, requiresAcknowledgement: boolean, at: string, over: Record<string, any> = {}) {
  return {
    id,
    thread_id: THREAD,
    sender_id: ALICE,
    created_at: at,
    deleted_at: null,
    msg_type: "announcement",
    subtype: null,
    body: env("ANNOUNCEMENT", { title: "Leaving at eight", body: "meet downstairs", requiresAcknowledgement }),
    ...over,
  };
}

function ackMsg(id: string, sender: string, target: string, at: string, note: string | null = null) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "acknowledgement",
    subtype: null,
    body: env("ACKNOWLEDGEMENT", { announcementMessageId: target, note }),
  };
}

const annInput = (id: string, requires: boolean, at: string, sender = ALICE) => ({
  id,
  sender_id: sender,
  created_at: at,
  title: "Leaving at eight",
  requiresAcknowledgement: requires,
});

const ackInput = (id: string, sender: string, target: string, at: string, note: string | null = null) => ({
  id,
  sender_id: sender,
  created_at: at,
  payload: { announcementMessageId: target, note },
});

describe("§19 — projectAcknowledgements", () => {
  it("the FIRST acknowledgement by a person wins; pressing twice does not move the time", () => {
    const [p] = projectAcknowledgements(
      [annInput(ANN, true, min(-60))],
      [ackInput("a1", BOB, ANN, min(-30)), ackInput("a2", BOB, ANN, min(-5))],
    );
    assert.equal(p!.acknowledgedBy.length, 1);
    assert.equal(p!.acknowledgedBy[0]!.userId, BOB);
    assert.equal(p!.acknowledgedBy[0]!.at, min(-30));
  });

  it("an acknowledgement naming a message this projection never saw is DROPPED", () => {
    const [p] = projectAcknowledgements(
      [annInput(ANN, true, min(-60))],
      [ackInput("a1", BOB, "some-other-message", min(-30))],
    );
    assert.deepEqual(p!.acknowledgedBy, []);
  });

  it("the announcer is not outstanding on their own announcement", () => {
    const [p] = projectAcknowledgements([annInput(ANN, true, min(-60), ALICE)], [], [ALICE, BOB, CAROL]);
    assert.deepEqual(p!.outstanding, [BOB, CAROL]);
    assert.equal(p!.complete, false);
  });

  it("complete only once every other member has acknowledged", () => {
    const [p] = projectAcknowledgements(
      [annInput(ANN, true, min(-60), ALICE)],
      [ackInput("a1", BOB, ANN, min(-30)), ackInput("a2", CAROL, ANN, min(-20))],
      [ALICE, BOB, CAROL],
    );
    assert.deepEqual(p!.outstanding, []);
    assert.equal(p!.complete, true);
  });

  it("an unknown roster gives outstanding NULL, never an empty list", () => {
    const [p] = projectAcknowledgements([annInput(ANN, true, min(-60))], []);
    assert.equal(p!.outstanding, null);
    assert.equal(p!.complete, null);
  });

  it("an announcement that did not ask is never reported complete", () => {
    const [p] = projectAcknowledgements([annInput(ANN_NO_ACK, false, min(-60))], [], [ALICE, BOB, CAROL]);
    assert.equal(p!.outstanding, null);
    assert.equal(p!.complete, null);
  });

  it("is STRUCTURALLY unable to derive an acknowledgement from a read receipt", async () => {
    // §19 asks that acknowledgement be distinct from passive Seen. The
    // projection takes announcements, acknowledgement MESSAGES and a roster —
    // there is no parameter a read receipt could arrive through, and the
    // module names no receipt column. Asserted rather than described, so a
    // later "helpful" change that filled the gap from last_read_at goes red.
    assert.equal(projectAcknowledgements.length, 3);
    const src = await readFile(
      new URL("../services/telegraph/coordination.ts", import.meta.url),
      "utf8",
    );
    // Comments are stripped first: the module EXPLAINS that it never touches a
    // read receipt, and a scan that counted the explanation as the offence
    // would be unfalsifiable.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.equal(/last_read_at|lastReadAt/.test(code), false);
  });
});

describe("§19 — POST an ACKNOWLEDGEMENT", () => {
  it("acknowledges an announcement that asked for one", async () => {
    const c = useState({ extraMessages: [announcement(ANN, true, min(-60))] });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: ANN },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.msgType, "acknowledgement");
    const row = (c as any)._inserted.find((i: any) => i.table === "messages");
    assert.equal(JSON.parse(row.row.body).payload.announcementMessageId, ANN);
  });

  it("refuses an announcement that did not ask to be acknowledged, and says so", async () => {
    useState({ extraMessages: [announcement(ANN_NO_ACK, false, min(-60))] });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: ANN_NO_ACK },
    });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.message).includes("did not ask to be acknowledged"));
  });

  it("refuses a message that is not an announcement", async () => {
    useState({
      extraMessages: [msg("q1", ALICE, "coordination", { state: "ARRIVED", provenance: "USER_DECLARED" }, min(-30))],
    });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: "q1" },
    });
    assert.equal(r.status, 404);
  });

  it("refuses an announcement in ANOTHER conversation", async () => {
    useState({
      extraMessages: [
        { ...announcement(ANN_OTHER_THREAD, true, min(-60)), thread_id: THREAD_NONE },
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: ANN_OTHER_THREAD },
    });
    assert.equal(r.status, 404);
  });

  it("refuses a deleted announcement", async () => {
    useState({ extraMessages: [announcement(ANN, true, min(-60), { deleted_at: min(-5) })] });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: ANN },
    });
    assert.equal(r.status, 404);
  });

  it("an unreadable messages table refuses rather than acknowledging blindly", async () => {
    useState({ errorTable: "messages", extraMessages: [announcement(ANN, true, min(-60))] });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "ACKNOWLEDGEMENT",
      payload: { announcementMessageId: ANN },
    });
    assert.equal(r.status, 500);
  });
});

describe("GET /threads/:id/announcements", () => {
  it("reports who acknowledged, who is outstanding, and what it derived that from", async () => {
    useState({
      extraMessages: [
        announcement(ANN, true, min(-60)),
        announcement(ANN_NO_ACK, false, min(-50)),
        ackMsg("a1", BOB, ANN, min(-30), "on my way"),
      ],
    });
    const r = await get(`/threads/${THREAD}/announcements`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.derivedFrom, "ACKNOWLEDGEMENT_MESSAGES_ONLY");
    assert.equal(r.body.rosterKnown, true);
    assert.equal(r.body.announcements.length, 2);
    const asked = r.body.announcements.find((a: any) => a.messageId === ANN);
    assert.equal(asked.acknowledgedBy.length, 1);
    assert.equal(asked.acknowledgedBy[0].userId, BOB);
    assert.equal(asked.acknowledgedBy[0].note, "on my way");
    assert.deepEqual(asked.outstanding, []);
    assert.equal(asked.complete, true);
    const notAsked = r.body.announcements.find((a: any) => a.messageId === ANN_NO_ACK);
    assert.equal(notAsked.outstanding, null);
    assert.equal(notAsked.complete, null);
  });

  it("a member who has read the thread and not pressed the button is OUTSTANDING", async () => {
    // The fixture's roster is Alice and Bob; only Alice announced. Bob has
    // read everything the ordinary way — nothing here consults that — so he
    // is outstanding. This is §19's whole point.
    useState({ extraMessages: [announcement(ANN, true, min(-60))] });
    const r = await get(`/threads/${THREAD}/announcements`, ALICE);
    assert.deepEqual(r.body.announcements[0].outstanding, [BOB]);
    assert.equal(r.body.announcements[0].complete, false);
  });

  it("a non-member cannot read it", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/announcements`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never an empty announcement list", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/announcements`, ALICE)).status, 500);
  });
});

// ── §2.3 the semantic layers ─────────────────────────────────────────────────
//
// census-telegraph T11: "ACTION and ANNOUNCEMENT give the stream a genuinely
// different class of item … It stays W because there is still no LAYER:
// unresolved actions are interleaved with conversation rather than separated,
// which is what §2.3 asks for."
//
// The property these tests pin is SEPARATION, not decoration: a message that
// is in the PLAN layer is NOT in the TALK stream, and it re-enters the stream
// the moment it resolves. A "layer" that merely tagged messages and left them
// in the stream would pass a weaker test and would be the thing the row calls
// interleaved.

const ACT = "act-1";

function actionProposal(id: string, at: string, action = "SPLIT_RIDE", over: Record<string, any> = {}) {
  return {
    id,
    thread_id: THREAD,
    sender_id: ALICE,
    created_at: at,
    deleted_at: null,
    msg_type: "action_proposal",
    subtype: action.toLowerCase(),
    body: env("ACTION_PROPOSAL", { action, title: "Share the cab", requiresConfirmation: true }),
    ...over,
  };
}

function actionResponse(id: string, sender: string, target: string, response: string, at: string) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "action_response",
    subtype: response.toLowerCase(),
    body: env("ACTION_RESPONSE", { actionMessageId: target, response }),
  };
}

function textMsg(id: string, at: string, body = "hello") {
  return {
    id,
    thread_id: THREAD,
    sender_id: BOB,
    created_at: at,
    deleted_at: null,
    msg_type: "text",
    subtype: null,
    body,
  };
}

function quickState(id: string, sender: string, state: string, at: string) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination",
    subtype: state.toLowerCase(),
    body: env("COORDINATION", { state, provenance: "USER_DECLARED" }),
  };
}

describe("§2.3 — TALK / PLAN / NOW are layers, not labels", () => {
  it("names §2.3's three layers", async () => {
    useState({ extraMessages: [textMsg("t1", min(-20))] });
    const r = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.layers, ["TALK", "PLAN", "NOW"]);
  });

  it("an unresolved action is in PLAN and is LIFTED OUT of the TALK stream", async () => {
    useState({ extraMessages: [textMsg("t1", min(-20)), actionProposal(ACT, min(-10))] });
    const r = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan.map((i: any) => i.messageId), [ACT]);
    assert.equal(r.body.talk.includes(ACT), false, "an unresolved action was left interleaved in the stream");
    assert.equal(r.body.talk.includes("t1"), true);
  });

  it("…and RE-ENTERS the stream once it is answered", async () => {
    useState({
      extraMessages: [
        textMsg("t1", min(-20)),
        actionProposal(ACT, min(-10)),
        actionResponse("ar1", BOB, ACT, "CONFIRMED", min(-5)),
      ],
    });
    const r = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan, []);
    assert.equal(r.body.talk.includes(ACT), true, "a resolved action never came back to the conversation");
  });

  it("an unresolved decision is in PLAN with the reason it is still open", async () => {
    useState({
      extraMessages: [
        {
          id: "d9", thread_id: THREAD, sender_id: ALICE, created_at: min(-60), deleted_at: null,
          msg_type: "decision", subtype: "plurality",
          body: env("DECISION", {
            question: "Where do we eat?",
            options: [{ id: "a", label: "Bun cha" }, { id: "b", label: "Banh xeo" }],
            resolutionRule: "PLURALITY",
            deadlineAt: min(120),
          }),
        },
      ],
    });
    const r = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(r.status, 200);
    const item = r.body.plan.find((i: any) => i.messageId === "d9");
    assert.ok(item, "an open decision is not in the PLAN layer");
    assert.equal(item.openReason, "decision_open");
    assert.equal(r.body.talk.includes("d9"), false);
  });

  it("an announcement waiting on THIS viewer is in their PLAN layer and not in another's", async () => {
    useState({
      extraMessages: [announcement(ANN, true, min(-60)), ackMsg("a1", BOB, ANN, min(-30))],
    });
    const forBob = await get(`/threads/${THREAD}/layers`, BOB);
    assert.equal(forBob.status, 200);
    assert.equal(forBob.body.plan.some((i: any) => i.messageId === ANN), false, "Bob acknowledged; it is not waiting on him");
    assert.equal(forBob.body.talk.includes(ANN), true);
    // Alice announced it. An announcer is not outstanding on their own notice.
    const forAlice = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(forAlice.body.plan.some((i: any) => i.messageId === ANN), false);
  });

  it("a quick state is NOW, not TALK and not PLAN", async () => {
    useState({ extraMessages: [textMsg("t1", min(-20)), quickState("q1", BOB, "ON_MY_WAY", min(-2))] });
    const r = await get(`/threads/${THREAD}/layers`, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.now.map((i: any) => i.messageId), ["q1"]);
    assert.equal(r.body.talk.includes("q1"), false);
    assert.equal(r.body.plan.some((i: any) => i.messageId === "q1"), false);
  });

  it("the three layers are disjoint — every message is in exactly one", async () => {
    useState({
      extraMessages: [
        textMsg("t1", min(-40)),
        actionProposal(ACT, min(-30)),
        quickState("q1", BOB, "ARRIVED", min(-2)),
        announcement(ANN, true, min(-20)),
      ],
    });
    const r = await get(`/threads/${THREAD}/layers`, BOB);
    assert.equal(r.status, 200);
    const ids = [
      ...r.body.plan.map((i: any) => i.messageId),
      ...r.body.now.map((i: any) => i.messageId),
      ...r.body.talk,
    ];
    assert.equal(new Set(ids).size, ids.length, "a message appeared in more than one layer");
    assert.deepEqual([...new Set(ids)].sort(), ["act-1", "ann-1", "q1", "t1"].sort());
  });

  it("a non-member cannot read the layers", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/layers`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never an empty PLAN layer", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/layers`, ALICE)).status, 500);
  });
});

// ── §8 ConversationCommitment, ACROSS threads ────────────────────────────────
//
// census-telegraph T84: "a projection over one thread's messages is not a
// queryable store, so 'what have I agreed to this week' cannot be answered
// across threads. The spec's Object row implies something a surface can list."
//
// These tests are about the ACROSS. A per-thread answer already existed and is
// asserted above; what is pinned here is that one call answers for every
// conversation the caller is still in, and for no conversation they are not.

function commitmentMsg(id: string, threadId: string, what: string, byWhen: string | null, at: string, askedOf: string[] = []) {
  return {
    id,
    thread_id: threadId,
    sender_id: BOB,
    created_at: at,
    deleted_at: null,
    msg_type: "commitment",
    subtype: null,
    body: env("COMMITMENT", { what, byWhen, askedOf }),
  };
}

function commitmentResponse(id: string, threadId: string, sender: string, target: string, response: string, at: string) {
  return {
    id,
    thread_id: threadId,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "commitment_response",
    subtype: response.toLowerCase(),
    body: env("COMMITMENT_RESPONSE", { commitmentId: target, response }),
  };
}

describe("GET /me/commitments — §8's commitment as something a surface can LIST", () => {
  it("answers across every thread the caller is still in, naming the thread each came from", async () => {
    useState({
      extraMessages: [
        commitmentMsg("c1", THREAD, "book the bus", min(600), min(-120)),
        commitmentResponse("r1", THREAD, ALICE, "c1", "AGREED", min(-110)),
        commitmentMsg("c2", THREAD_B, "bring the adapter", min(900), min(-100)),
        commitmentResponse("r2", THREAD_B, ALICE, "c2", "AGREED", min(-90)),
      ],
    });
    const r = await get(`/me/commitments`, ALICE);
    assert.equal(r.status, 200);
    const ids = r.body.commitments.map((c: any) => c.commitmentId).sort();
    assert.deepEqual(ids, ["c1", "c2"], "a commitment in a second thread was not listed");
    const byId = Object.fromEntries(r.body.commitments.map((c: any) => [c.commitmentId, c]));
    assert.equal(byId.c1.threadId, THREAD);
    assert.equal(byId.c2.threadId, THREAD_B);
    assert.equal(byId.c1.what, "book the bus");
    assert.equal(byId.c1.viewerResponse, "AGREED");
  });

  it("does not list a commitment from a thread the caller is not in", async () => {
    useState({
      extraMessages: [commitmentMsg("c9", THREAD_NONE, "carol's errand", null, min(-60))],
    });
    const r = await get(`/me/commitments`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.commitments.some((c: any) => c.commitmentId === "c9"), false);
  });

  it("flags an overdue commitment the caller agreed to", async () => {
    useState({
      extraMessages: [
        commitmentMsg("c3", THREAD, "pay the guesthouse", min(-30), min(-300)),
        commitmentResponse("r3", THREAD, ALICE, "c3", "AGREED", min(-290)),
      ],
    });
    const r = await get(`/me/commitments`, ALICE);
    const c = r.body.commitments.find((x: any) => x.commitmentId === "c3");
    assert.ok(c);
    assert.equal(c.overdue, true);
  });

  it("a completed commitment is out of the open list, and back with includeCompleted", async () => {
    useState({
      extraMessages: [
        commitmentMsg("c4", THREAD, "collect the deposit", min(600), min(-300)),
        commitmentResponse("r4", THREAD, ALICE, "c4", "AGREED", min(-290)),
        commitmentResponse("r5", THREAD, ALICE, "c4", "COMPLETED", min(-10)),
      ],
    });
    const open = await get(`/me/commitments`, ALICE);
    assert.equal(open.body.commitments.some((c: any) => c.commitmentId === "c4"), false);
    const all = await get(`/me/commitments?includeCompleted=true`, ALICE);
    const c = all.body.commitments.find((x: any) => x.commitmentId === "c4");
    assert.ok(c, "includeCompleted did not return the completed commitment");
    assert.equal(c.completedBy, ALICE);
  });

  /**
   * The DEFAULT scope is "mine", and that is a privacy property rather than a
   * convenience: `scope=all` is the thread-wide view and it is opt-in so this
   * route cannot become a way to watch what other people have promised. The
   * mutation that deleted the `scope === "mine"` filter passed the whole suite
   * before this case existed — every commitment in the fixtures happened to be
   * one Alice had agreed to, so "mine" and "all" returned the same list and the
   * branch that separates them was never exercised.
   */
  it("scope=mine excludes a promise somebody else made, and scope=all returns it", async () => {
    useState({
      extraMessages: [
        // Bob's own promise, in a thread Alice is in. Nothing was asked of her
        // and she agreed to nothing.
        commitmentMsg("c10", THREAD, "bob books the ferry", min(600), min(-200)),
        commitmentResponse("r10", THREAD, BOB, "c10", "AGREED", min(-190)),
      ],
    });
    const mine = await get(`/me/commitments`, ALICE);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.scope, "mine");
    assert.equal(
      mine.body.commitments.some((c: any) => c.commitmentId === "c10"),
      false,
      "the default list leaked a commitment the caller neither made nor was asked for",
    );
    const all = await get(`/me/commitments?scope=all`, ALICE);
    assert.equal(all.body.scope, "all");
    const c = all.body.commitments.find((x: any) => x.commitmentId === "c10");
    assert.ok(c, "scope=all did not return the thread-wide commitment");
    assert.equal(c.viewerResponse, null);
    assert.equal(c.askedOfViewer, false);
  });

  /**
   * An unanswered ask IS the caller's, and it is the other half of the same
   * branch: "mine" is what they agreed to PLUS what was explicitly asked of
   * them and is still open. Without this case the filter could be narrowed to
   * `viewerResponse === "AGREED"` and nothing would notice.
   */
  it("scope=mine includes an open ask addressed to the caller", async () => {
    useState({
      extraMessages: [
        commitmentMsg("c11", THREAD, "alice to call the hostel", min(600), min(-200), [ALICE]),
      ],
    });
    const mine = await get(`/me/commitments`, ALICE);
    const c = mine.body.commitments.find((x: any) => x.commitmentId === "c11");
    assert.ok(c, "an unanswered ask addressed to the caller was dropped from their own list");
    assert.equal(c.askedOfViewer, true);
    assert.equal(c.viewerResponse, null);
  });

  it("an unreadable messages table is a 500, never an empty commitment list", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/me/commitments`, ALICE)).status, 500);
  });

  it("an unreadable membership table is a 500, never 'you have agreed to nothing'", async () => {
    useState({ errorTable: "message_thread_members" });
    assert.equal((await get(`/me/commitments`, ALICE)).status, 500);
  });
});

// ── §8 CoordinationSession as an ENTITY ──────────────────────────────────────
//
// census-telegraph T85: "the session's BEHAVIOUR exists … but there is no
// session ENTITY: nothing has an id, nothing records who started it or when it
// ended, and a DISRUPTED transition cannot be recorded because there is
// nowhere to record it. Deriving the state was the right call under Appendix A;
// a session object would need a table…"
//
// It does not. A decision, a commitment and an acknowledgement are all objects
// with ids in this module already, and all three are carried as messages — the
// message id IS the object id. A session is the same shape. What these tests
// pin is the four things the row says are missing: an id, a starter, an end,
// and a recordable DISRUPTED.

const SESSION = "sess-1";

function sessionMsg(id: string, at: string, sender = ALICE, over: Record<string, any> = {}) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination_session",
    subtype: null,
    body: env("COORDINATION_SESSION", { title: "Dinner run", planObjectId: MEETUP }),
    ...over,
  };
}

function transitionMsg(id: string, sessionId: string, to: string, at: string, sender = ALICE) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination_transition",
    subtype: to.toLowerCase(),
    body: env("COORDINATION_TRANSITION", { sessionId, to, reason: "traffic" }),
  };
}

describe("§8 CoordinationSession — an object with an id, a starter and an end", () => {
  it("the session has an id, who started it and when", async () => {
    useState({ extraMessages: [sessionMsg(SESSION, min(-120))] });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    const s = r.body.coordination.session;
    assert.ok(s, "there is no session entity in the coordination view");
    assert.equal(s.sessionId, SESSION);
    assert.equal(s.startedBy, ALICE);
    assert.equal(s.startedAt, min(-120));
    assert.equal(s.endedAt, null);
  });

  it("a DISRUPTED transition is RECORDED and becomes the session's state", async () => {
    useState({
      extraMessages: [
        sessionMsg(SESSION, min(-120)),
        transitionMsg("tr1", SESSION, "DISRUPTED", min(-20)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    const s = r.body.coordination.session;
    assert.equal(s.state, "DISRUPTED");
    assert.equal(s.declaredState, "DISRUPTED");
    assert.equal(s.transitions.length, 1);
    assert.equal(s.transitions[0].to, "DISRUPTED");
    assert.equal(s.transitions[0].declaredBy, ALICE);
    assert.equal(s.transitions[0].applied, true);
  });

  it("declared and derived are SEPARATE fields — §9.1's rule survives the session", async () => {
    useState({
      extraMessages: [
        sessionMsg(SESSION, min(-120)),
        transitionMsg("tr1", SESSION, "DISRUPTED", min(-20)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    const s = r.body.coordination.session;
    // The fixture meetup starts in 30 minutes, so the DERIVED state is ASSEMBLING.
    assert.equal(s.derivedState, "ASSEMBLING");
    assert.equal(s.declaredState, "DISRUPTED");
    assert.notEqual(s.derivedState, s.declaredState);
  });

  it("a terminal transition ENDS the session and leaves no legal next", async () => {
    useState({
      extraMessages: [
        sessionMsg(SESSION, min(-120)),
        transitionMsg("tr1", SESSION, "CANCELLED", min(-10)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    const s = r.body.coordination.session;
    assert.equal(s.state, "CANCELLED");
    assert.equal(s.endedAt, min(-10));
    assert.deepEqual(s.legalNext, []);
  });

  it("an ILLEGAL transition is refused by the route, with the legal set named", async () => {
    useState({
      extraMessages: [
        sessionMsg(SESSION, min(-120)),
        transitionMsg("tr1", SESSION, "CANCELLED", min(-10)),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: SESSION, to: "ACTIVE" },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /CANCELLED/);
  });

  it("a legal transition is accepted; legality is judged against what was DECLARED, not the clock", async () => {
    useState({ extraMessages: [sessionMsg(SESSION, min(-120))] });
    // A fresh session is PREPARING. §9 allows PREPARING -> ASSEMBLING.
    const ok = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: SESSION, to: "ASSEMBLING" },
    });
    assert.equal(ok.status, 201);
    // …and PREPARING -> ACTIVE is not an arrow §9 has, even though the
    // fixture's plan starts in thirty minutes and the DERIVED state is
    // ASSEMBLING. A declared move is checked against declared history, so the
    // same request does not start succeeding because time passed.
    useState({ extraMessages: [sessionMsg(SESSION, min(-120))] });
    const skipped = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: SESSION, to: "ACTIVE" },
    });
    assert.equal(skipped.status, 400);
    assert.match(String(skipped.body.message), /PREPARING/);
  });

  it("a transition naming a session that is not in this thread is refused", async () => {
    useState({ extraMessages: [sessionMsg(SESSION, min(-120))] });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "not-a-session", to: "ACTIVE" },
    });
    assert.equal(r.status, 404);
  });
});

// ── §15.2 conversation-level safety mode ─────────────────────────────────────
//
// census-telegraph T217: "Safety mode NORMAL → SAFETY_ATTENTION → SAFETY_EVENT
// … Two escalation ladders exist and neither is this one: Safe Return sessions
// escalate via `trigger-missed` … and circle presence escalates via
// `needs_help` … **Neither is a conversation-level mode.**" §13.4 classified it
// NEITHER — "A conversation-level safety mode does not exist in either tree."
//
// It does not need one to exist: both carriers are already in the thread. §6.2's
// SAFETY kind has `check_in | heads_up | need_help | all_clear`, and §9.1's
// quick states include NEED_HELP. The mode is a projection over those, and the
// rules these tests pin are the ones a careless projection gets wrong:
//   - a SAFETY_EVENT is cleared only by an explicit ALL CLEAR, never by time;
//   - a routine "checked in safe" does NOT clear a help request;
//   - attention decays, an event does not.

function safetyMsg(id: string, sender: string, kind: string, at: string) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "safety",
    subtype: kind,
    body: env("SAFETY", { kind, label: kind.replace("_", " ") }),
  };
}

describe("§15.2 — NORMAL → SAFETY_ATTENTION → SAFETY_EVENT, as a conversation mode", () => {
  it("a thread with no safety signal is NORMAL and promotes nothing", async () => {
    useState({ extraMessages: [textMsg("t1", min(-20))] });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "NORMAL");
    assert.deepEqual(r.body.affordances.promoted, []);
    assert.deepEqual(r.body.affordances.deprioritized, []);
    assert.deepEqual(r.body.modes, ["NORMAL", "SAFETY_ATTENTION", "SAFETY_EVENT"]);
  });

  it("a heads-up raises SAFETY_ATTENTION and names who raised it", async () => {
    useState({ extraMessages: [safetyMsg("s1", BOB, "heads_up", min(-30))] });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "SAFETY_ATTENTION");
    assert.equal(r.body.raisedBy, BOB);
    assert.equal(r.body.since, min(-30));
  });

  it("a need-help raises SAFETY_EVENT — the top of the ladder, not the middle", async () => {
    useState({
      extraMessages: [
        safetyMsg("s1", BOB, "heads_up", min(-60)),
        safetyMsg("s2", BOB, "need_help", min(-10)),
      ],
    });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "SAFETY_EVENT");
  });

  it("a heads-up posted AFTER a need-help does not de-escalate the thread", async () => {
    // The mode is the HIGHEST unresolved signal, not the latest one. A
    // projection that took the last signal would answer SAFETY_ATTENTION here,
    // which is a conversation quietly stepping down from an emergency because
    // somebody typed something calmer afterwards.
    useState({
      extraMessages: [
        safetyMsg("s1", BOB, "need_help", min(-30)),
        safetyMsg("s2", CAROL, "heads_up", min(-5)),
      ],
    });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "SAFETY_EVENT");
    assert.equal(r.body.raisedBy, BOB, "the later, lesser signal took over the mode");
    assert.equal(r.body.since, min(-30));
  });

  it("§9.1's NEED_HELP quick state raises the mode too — one ladder, two carriers", async () => {
    useState({ extraMessages: [quickState("q1", BOB, "NEED_HELP", min(-5))] });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "SAFETY_EVENT");
    assert.equal(r.body.signals.some((s: any) => s.source === "QUICK_STATE"), true);
  });

  it("a SAFETY_EVENT is cleared by an explicit ALL CLEAR", async () => {
    useState({
      extraMessages: [
        safetyMsg("s1", BOB, "need_help", min(-60)),
        safetyMsg("s2", BOB, "all_clear", min(-5)),
      ],
    });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "NORMAL");
    assert.equal(r.body.clearedAt, min(-5));
  });

  it("a routine CHECK-IN does NOT clear a help request", async () => {
    useState({
      extraMessages: [
        safetyMsg("s1", BOB, "need_help", min(-60)),
        safetyMsg("s2", BOB, "check_in", min(-5)),
      ],
    });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(r.body.mode, "SAFETY_EVENT", "a check-in silently cleared a help request");
  });

  it("a SAFETY_EVENT does not expire with time; attention does", async () => {
    useState({ extraMessages: [safetyMsg("s1", BOB, "need_help", min(-60 * 72))] });
    const stale = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(stale.body.mode, "SAFETY_EVENT", "an uncleared help request aged out of the mode");

    useState({ extraMessages: [safetyMsg("s2", BOB, "heads_up", min(-60 * 72))] });
    const old = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.equal(old.body.mode, "NORMAL");
  });

  it("§15.2's promotion list is served in the spec's order, and entertainment is de-prioritized", async () => {
    useState({ extraMessages: [safetyMsg("s1", BOB, "heads_up", min(-30))] });
    const r = await get(`/threads/${THREAD}/safety-mode`, ALICE);
    assert.deepEqual(r.body.affordances.promoted, [
      "TRUSTED_CONTACT",
      "CURRENT_STATUS",
      "OFFICIAL_HELP",
      "ROUTE_OR_RETURN",
      "CALL",
      "BLOCK_OR_REPORT",
      "LOCATION_SCOPE",
    ]);
    assert.deepEqual(r.body.affordances.deprioritized, ["ENTERTAINMENT"]);
  });

  it("a non-member cannot read a thread's safety mode", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/safety-mode`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never a NORMAL thread", async () => {
    useState({ errorTable: "messages" });
    assert.equal((await get(`/threads/${THREAD}/safety-mode`, ALICE)).status, 500);
  });
});

// ── §20 the conversation CATCH-UP ────────────────────────────────────────────
//
// census-telegraph T267 (§20 Compass): "Authorized thread context,
// meeting/recommendation tools, catch-up." Thread context and the tools exist
// (T245-T251 are C); the catch-up did not.
//
// What is pinned here is not "a summary came back". It is the four rules that
// separate a catch-up from a message count, each of which a careless
// implementation gets wrong in a way no smoke test would notice:
//
//   1. A person did not miss what they SENT.
//   2. §14.3's window is a BOUND, not a preference — a marker older than the
//      viewer's own join must not widen the answer, and the response says
//      which of the two decided.
//   3. What still awaits the viewer is NOT filtered by the marker. A question
//      nobody answered does not stop awaiting them because they were online
//      when it was asked.
//   4. Nothing is read out of prose (§18.3).

const CATCH_UP = `/threads/${THREAD}/catch-up`;

function plainMsg(id: string, sender: string, at: string) {
  return {
    id, thread_id: THREAD, sender_id: sender, created_at: at,
    deleted_at: null, msg_type: "text", subtype: null, body: "just talking",
  };
}

function cardMsg(id: string, sender: string, at: string, subtype: string) {
  return {
    id, thread_id: THREAD, sender_id: sender, created_at: at,
    deleted_at: null, msg_type: "system", subtype, body: JSON.stringify({ title: "Casa do Bacalhau" }),
  };
}

describe("GET /threads/:id/catch-up — §20's catch-up", () => {
  it("counts what arrived after the reader's marker, and NOT what the reader sent", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-100) },
        { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [
        plainMsg("old-1", BOB, min(-200)),      // before the marker
        plainMsg("new-1", BOB, min(-50)),       // after — missed
        plainMsg("new-2", BOB, min(-40)),       // after — missed
        plainMsg("mine-1", ALICE, min(-30)),    // Alice's own: NOT missed
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sinceBasis, "read_marker");
    assert.equal(r.body.since, min(-100));
    assert.equal(r.body.missedCount, 2, "the reader's own message was counted as something they missed");
    assert.deepEqual(r.body.missedFrom, [{ userId: BOB, count: 2 }]);
    assert.equal(r.body.inferredFromProse, false);
  });

  it("a reader who has never opened the thread is told so, not handed a null", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [plainMsg("new-1", BOB, min(-50))],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.body.sinceBasis, "conversation_start");
    assert.equal(r.body.since, null);
    assert.equal(r.body.missedCount, 1);
  });

  it("§14.3's window wins over an older marker, and the response says which", async () => {
    // Alice was added to the crew thread an hour ago and her marker predates
    // that. A catch-up that trusted the marker would hand her a month of a
    // conversation she is not entitled to.
    useState({
      historyBound: true,
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: min(-60), last_read_at: min(-600) },
      ],
      extraMessages: [
        plainMsg("before-join", BOB, min(-300)),
        plainMsg("after-join", BOB, min(-10)),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sinceBasis, "history_window",
      "an older read marker widened the catch-up past the viewer's own join");
    assert.equal(r.body.since, min(-60));
    assert.equal(r.body.missedCount, 1);
    assert.equal(
      r.body.missedFrom.length > 0 && r.body.missedCount === 1,
      true,
    );
  });

  it("names the typed objects that arrived — decisions, commitments, shares — and no prose", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-100) },
        { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [
        msg("d1", BOB, "decision", { question: "Beach or old town?", options: [{ id: "b", label: "Beach" }, { id: "o", label: "Old town" }], resolutionRule: "PLURALITY" }, min(-60)),
        msg("c1", BOB, "commitment", { what: "book the bus", byWhen: min(600), askedOf: [] }, min(-55)),
        cardMsg("card-1", BOB, min(-50), "discovery_card"),
        plainMsg("chatter", BOB, min(-45)),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.decisionsOpened.map((d: any) => d.messageId), ["d1"]);
    assert.equal(r.body.decisionsOpened[0].title, "Beach or old town?");
    assert.deepEqual(r.body.commitmentsMade.map((c: any) => c.messageId), ["c1"]);
    assert.deepEqual(r.body.shared.map((x: any) => x.messageId), ["card-1"],
      "a registered source-object card did not appear as a share");
    assert.equal(
      JSON.stringify(r.body).includes("just talking"),
      false,
      "prose from an ordinary message reached the catch-up",
    );
  });

  it("an ordinary text message is never reported as a shared object", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-100) },
      ],
      extraMessages: [plainMsg("chatter", BOB, min(-45))],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.deepEqual(r.body.shared, []);
  });

  it("what still awaits the reader is NOT filtered by their marker", async () => {
    // Alice opened the decision herself and read past it. It is still open,
    // and it is still hers to resolve.
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-10) },
      ],
      extraMessages: [
        msg("d-old", ALICE, "decision", { question: "Which hostel?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], resolutionRule: "PLURALITY" }, min(-300)),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.body.missedCount, 0, "nothing arrived after the marker");
    assert.deepEqual(
      r.body.needsYou.map((i: any) => i.messageId),
      ["d-old"],
      "an unresolved decision from before the marker dropped out of the catch-up",
    );
    assert.equal(r.body.needsYou[0].openReason, "decision_open");
  });

  it("reports §9 moves with the state they moved FROM, even when the reader missed only the last one", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-40) },
      ],
      extraMessages: [
        msg("s1", BOB, "coordination_session", { title: "Dinner" }, min(-120)),
        msg("t1", BOB, "coordination_transition", { sessionId: "s1", to: "ASSEMBLING" }, min(-100)),
        msg("t2", BOB, "coordination_transition", { sessionId: "s1", to: "ACTIVE" }, min(-20)),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.body.transitions.length, 1, "only the missed move belongs in the catch-up");
    assert.equal(r.body.transitions[0].to, "ACTIVE");
    assert.equal(
      r.body.transitions[0].from,
      "ASSEMBLING",
      "the missed move reported no origin — a reader cannot tell a move from an opening",
    );
    assert.equal(r.body.transitions[0].legal, true);
  });

  it("a safety escalation that happened while they were away is flagged as such", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-100) },
      ],
      extraMessages: [
        msg("sf1", BOB, "safety", { kind: "need_help", label: "I need help", note: "lost my bag" }, min(-30), "need_help"),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.body.safetyMode, "SAFETY_EVENT");
    assert.equal(r.body.safetyChangedWhileAway, true);
  });

  it("a safety event raised BEFORE the marker is still the mode, but not 'while you were away'", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: min(-10) },
      ],
      extraMessages: [
        msg("sf1", BOB, "safety", { kind: "need_help", label: "I need help", note: "lost my bag" }, min(-300), "need_help"),
      ],
    });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.body.safetyMode, "SAFETY_EVENT", "an uncleared event does not expire");
    assert.equal(r.body.safetyChangedWhileAway, false);
  });

  it("a non-member cannot read a catch-up", async () => {
    useState({});
    assert.equal((await get(`/threads/${THREAD_NONE}/catch-up`, ALICE)).status, 403);
  });

  it("an unreadable messages table is a 500, never 'nothing happened while you were away'", async () => {
    useState({ errorTable: "messages" });
    const r = await get(CATCH_UP, ALICE);
    assert.equal(r.status, 500);
  });
});

// ── §9 Returning — shared transport is block-aware and idempotent (T107) ─────
//
// census-telegraph T107 (§45 F6 / §46.3): "a replayed propose creates a second
// identical ride (`ACTION_PROPOSAL` has no idempotency key)" and "a join is not
// checked for a block between joiner and proposer in a group thread". The write
// guard's pairwise block check runs only when the thread has exactly ONE other
// member (`lib/telegraphThreadWrite.ts`), so a group ride needs its own.

describe("T107 — a ride join in a group refuses across a block; a replayed proposal is one ride", () => {
  const RIDE = "ride-1";
  const COORD = `/threads/${THREAD}/coordination`;
  const group = [
    { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
    { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
    { thread_id: THREAD, user_id: CAROL, left_at: null, visible_from_at: null, last_read_at: null },
  ];
  const join = (response = "CONFIRMED") => ({ kind: "ACTION_RESPONSE", payload: { actionMessageId: RIDE, response } });
  const inserts = (c: any) => c._inserted.filter((i: any) => i.table === "messages");
  const block = (blocker: string, blocked: string) => ({ blocker_id: blocker, blocked_id: blocked });

  it("an unblocked member joins a group ride exactly as before (201, one response written)", async () => {
    const c = useState({ members: group, extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, BOB, join());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 1);
  });

  it("the joiner BLOCKED the proposer: refused, nothing written", async () => {
    const c = useState({ members: group, blocks: [block(CAROL, ALICE)], extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0, "a refused join still wrote a response");
  });

  it("the proposer blocked the JOINER (the other direction): refused, nothing written", async () => {
    const c = useState({ members: group, blocks: [block(ALICE, CAROL)], extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0);
  });

  it("a block between the joiner and a RIDER who is not the proposer also refuses", async () => {
    const c = useState({
      members: group,
      blocks: [block(BOB, CAROL)],
      extraMessages: [actionProposal(RIDE, min(-10)), actionResponse("ar-b", BOB, RIDE, "CONFIRMED", min(-5))],
    });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0);
  });

  it("a rider who has since DROPPED OUT no longer blocks the join", async () => {
    const c = useState({
      members: group,
      blocks: [block(BOB, CAROL)],
      extraMessages: [
        actionProposal(RIDE, min(-10)),
        actionResponse("ar-b1", BOB, RIDE, "CONFIRMED", min(-6)),
        actionResponse("ar-b2", BOB, RIDE, "DECLINED", min(-3)),
      ],
    });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 1);
  });

  it("an UNREADABLE blocks table refuses the join (503, retryable) — never 'nobody is blocked'", async () => {
    const c = useState({ members: group, errorTable: "blocks", extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(inserts(c).length, 0);
  });

  it("an UNREADABLE rider list refuses the join (503) — the riders could not be checked", async () => {
    const c = useState({ members: group, failMsgType: "action_response", extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0);
  });

  it("DROPPING OUT of a ride is never refused for a block — leaving must always work", async () => {
    const c = useState({ members: group, blocks: [block(ALICE, CAROL)], extraMessages: [actionProposal(RIDE, min(-10))] });
    const r = await post(COORD, CAROL, join("DECLINED"));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 1);
  });

  it("a confirmation of a NON-ride action is not ride-checked (unchanged)", async () => {
    const c = useState({
      members: group,
      blocks: [block(ALICE, CAROL)],
      extraMessages: [actionProposal(RIDE, min(-10), "MEET_HERE")],
    });
    const r = await post(COORD, CAROL, join());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 1);
  });

  const propose = (key?: string) => ({
    kind: "ACTION_PROPOSAL",
    payload: { action: "SPLIT_RIDE", title: "Share a ride back", requiresConfirmation: true, ...(key ? { idempotencyKey: key } : {}) },
  });

  it("a REPLAYED ride proposal returns the SAME ride (200, duplicate) and writes nothing", async () => {
    const c = useState({ members: group });
    const first = await post(COORD, ALICE, propose("ride-key-1"));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await post(COORD, ALICE, propose("ride-key-1"));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.id, first.body.id, "a replay minted a second ride");
    assert.equal(again.body.duplicate, true);
    assert.equal(inserts(c).length, 1);
    const view = await get(COORD, BOB);
    assert.equal(view.status, 200);
    assert.equal(view.body.coordination.sharedRides.length, 1, "two rides are listed for one proposal");
  });

  it("a NEW key is a new ride; another member's identical key is theirs, not a replay", async () => {
    const c = useState({ members: group });
    const a1 = await post(COORD, ALICE, propose("k-a"));
    const a2 = await post(COORD, ALICE, propose("k-b"));
    const b1 = await post(COORD, BOB, propose("k-a"));
    assert.deepEqual([a1.status, a2.status, b1.status], [201, 201, 201]);
    assert.equal(new Set([a1.body.id, a2.body.id, b1.body.id]).size, 3);
    assert.equal(inserts(c).length, 3);
  });

  it("a ride proposal WITHOUT an idempotency key is refused (400) — a retry could not be recognised", async () => {
    const c = useState({ members: group });
    const r = await post(COORD, ALICE, propose());
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0);
  });

  it("the request identity is stored in messages.idempotency_key, NOT in the body", async () => {
    const c = useState({ members: group });
    const r = await post(COORD, ALICE, propose("k-col"));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = inserts(c)[0].row;
    assert.equal(row.idempotency_key, "k-col");
    assert.equal(JSON.parse(row.body).payload.idempotencyKey, undefined, "the key leaked into the body");
    assert.equal(JSON.parse(row.body).payload.action, "SPLIT_RIDE");
  });

  it("N SIMULTANEOUS requests with one identity: exactly one ride, every caller gets its id (unique index modelled)", async () => {
    const c = useState({ members: group, uniqueKeys: true });
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(COORD, ALICE, propose("k-race"))));
    const ids = new Set(rs.map((r) => r.body.id));
    assert.equal(inserts(c).length, 1, "more than one ride was written");
    assert.equal(ids.size, 1, `callers got different ids: ${[...ids].join(",")}`);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
  });

  it("a caller who LEFT between the conflict and the read-back is refused and is not handed the ride", async () => {
    const c = useState({
      members: group.map((m) => ({ ...m })),
      uniqueKeys: true,
      extraMessages: [{ ...actionProposal("ride-held", min(-1)), idempotency_key: "k-gone" }],
      onUnique: (db) => { for (const m of db.message_thread_members) if (m.user_id === ALICE) m.left_at = min(0); },
      // The pre-insert read must MISS, so the conflict branch is the one tested.
      missKeyLookups: 1,
    });
    const r = await post(COORD, ALICE, propose("k-gone"));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.notEqual(r.body.id, "ride-held");
    assert.equal(JSON.stringify(r.body).includes("ride-held"), false, "the refusal revealed the ride");
    assert.equal(inserts(c).length, 0);
  });

  it("an identity already held by a DIFFERENT kind of message is refused (409) without revealing it", async () => {
    const c = useState({
      members: group,
      extraMessages: [{ ...textMsg("t-held", min(-3)), sender_id: ALICE, idempotency_key: "k-text" }],
    });
    const r = await post(COORD, ALICE, propose("k-text"));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(JSON.stringify(r.body).includes("t-held"), false);
    assert.equal(inserts(c).length, 0);
  });

  it("a database WITHOUT 2810's column: the proposal is written as before #685 (201, no key column) — never a 500", async () => {
    const c = useState({ members: group, noIdentityColumn: true });
    const r = await post(COORD, ALICE, propose("k-no-col"));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 1);
    const row = inserts(c)[0].row;
    assert.equal("idempotency_key" in row, false, "the fallback named the absent column");
    assert.equal(JSON.parse(row.body).payload.action, "SPLIT_RIDE");
    // …and a join on that ride still works and is still block-checked.
    const j = await post(COORD, BOB, { kind: "ACTION_RESPONSE", payload: { actionMessageId: r.body.id, response: "CONFIRMED" } });
    assert.equal(j.status, 201, JSON.stringify(j.body));
  });

  it("…the column-absent fallback is pre-#685 behaviour: a replay is a second ride there (stated, not hidden)", async () => {
    const c = useState({ members: group, noIdentityColumn: true });
    // CAROL, not ALICE: the in-process send-burst limiter counts every ALICE send in this file.
    const a = await post(COORD, CAROL, propose("k-no-col-2"));
    const b = await post(COORD, CAROL, propose("k-no-col-2"));
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(inserts(c).length, 2);
  });

  it("an UNREADABLE replay lookup is an error, never a second ride", async () => {
    const c = useState({ members: group, failEqCol: "idempotency_key" });
    const r = await post(COORD, CAROL, propose("k-x"));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(inserts(c).length, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// census-telegraph T155 — §12 `conversation_snapshots`, "rebuild/replay
// checkpoints where useful" (migration 3998, services/telegraph/
// conversationSnapshots.ts). WHERE USEFUL is the session read's cap: a thread
// with more session-kind rows than SESSION_SCAN_LIMIT folds a prefix of the
// evening. With the checkpoint the fold reads the checkpointed rows plus the
// rows replayed after its cursor.
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync as t155Read } from "node:fs";
import { pathToFileURL as t155Url } from "node:url";
import {
  SNAPSHOT_ROW_CAP as T155_CAP,
  checkpointFrom as t155CheckpointFrom,
  instantKey as t155InstantKey,
  isAfterCursor as t155After,
  readSessionRowsThroughCheckpoint as t155Read2,
} from "../services/telegraph/conversationSnapshots.js";
import { SESSION_SCAN_LIMIT as T155_SCAN } from "../routes/telegraphCoordination.js";

const T155_SQL = t155Read(new URL("../migrations/3998_telegraph_conversation_snapshots.sql", import.meta.url), "utf8");

/** Message ids are uuids in the database, and a checkpoint's cursor id must be one. */
const t155Id = (i: number) => `15500000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** A long evening: one session opened 1000 minutes ago and `n` transitions after it, oldest first. */
function t155Evening(n: number): any[] {
  const rows: Array<ReturnType<typeof sessionMsg> | ReturnType<typeof transitionMsg>> = [sessionMsg(SESSION, min(-1000))];
  for (let i = 0; i < n; i++) {
    const to = i % 2 === 0 ? "DISRUPTED" : "ACTIVE";
    rows.push(transitionMsg(t155Id(i), SESSION, to, min(-999 + i)));
  }
  return rows;
}

/** The coordination fake, plus 3998: the table, the flag, and the writer modelled by MEANING. */
function t155State(state: State, opts: { flag?: boolean; checkpoint?: any; snapshotError?: boolean; writer?: string } = {}) {
  const c: any = useState(state);
  c._db.feature_flags.push({ flag: "telegraph_conversation_snapshots_enabled", enabled: opts.flag === true });
  c._db.conversation_snapshots = opts.checkpoint ? [opts.checkpoint] : [];
  c._rpcCalls = [] as any[];
  const baseFrom = c.from;
  c._snapshotReads = 0;
  c.from = (table: string) => {
    if (table === "conversation_snapshots") {
      c._snapshotReads += 1;
      if (opts.snapshotError) {
        const p: any = new Proxy({}, { get(_t, k) { if (k === "maybeSingle") return () => Promise.resolve({ data: null, error: { message: "relation does not exist", code: "42P01" } }); if (k === "then" || k === "catch" || k === "finally") return undefined; return () => p; } });
        return p;
      }
    }
    return baseFrom(table);
  };
  c.rpc = async (fn: string, args: any) => {
    c._rpcCalls.push({ fn, args });
    if (fn !== "telegraph_write_conversation_snapshot") return { data: null, error: { message: "rpc not modelled" } };
    if (opts.writer) return opts.writer === "error" ? { data: null, error: { message: "boom" } } : { data: { outcome: opts.writer }, error: null };
    if (!c._db.feature_flags.some((f: any) => f.flag === "telegraph_conversation_snapshots_enabled" && f.enabled === true)) return { data: { outcome: "disabled" }, error: null };
    const live = (c._db.messages as any[])
      .filter((m) => m.thread_id === args.p_thread_id && ["coordination_session", "coordination_transition"].includes(m.msg_type) && m.deleted_at == null)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : 1));
    if (live.length > 2000) return { data: { outcome: "too_large", row_count: live.length }, error: null };
    const last = live[live.length - 1];
    c._db.conversation_snapshots = [{
      thread_id: args.p_thread_id, projection: args.p_projection, projection_version: 1,
      through_created_at: last.created_at, through_message_id: last.id, row_count: live.length,
      rows: live.map((m) => ({ id: m.id, sender_id: m.sender_id, created_at: m.created_at, msg_type: m.msg_type, body: m.body })),
    }];
    return { data: { outcome: "written", row_count: live.length }, error: null };
  };
  return c;
}

describe("T155 — the coordination fold reads a §12 checkpoint where the session read is truncated", () => {
  it("OFF (the seed): the read is the one before 3998 — capped, truncation stated, no checkpoint read or written", async () => {
    const c = t155State({ extraMessages: t155Evening(T155_SCAN + 50) }, { flag: false });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionScanTruncated, true);
    assert.equal(r.body.coordination.session, null, "the session row is older than the newest 200 session-kind rows");
    assert.deepEqual(r.body.sessionSnapshot, { used: false, reason: "off", throughCreatedAt: null, checkpointRows: 0, writer: null });
    assert.equal(c._snapshotReads, 0);
    assert.deepEqual(c._rpcCalls, []);
  });

  it("ON: a truncated read checkpoints the thread once and folds the WHOLE evening", async () => {
    const n = T155_SCAN + 50;
    const c = t155State({ extraMessages: t155Evening(n) }, { flag: true });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionScanTruncated, false);
    assert.equal(r.body.sessionSnapshot.used, true);
    assert.equal(r.body.sessionSnapshot.writer, "written");
    assert.equal(r.body.sessionSnapshot.checkpointRows, n + 1);
    const s = r.body.coordination.session;
    assert.ok(s, "the session opened before the newest 200 rows is back in the fold");
    assert.equal(s.sessionId, SESSION);
    assert.equal(s.transitions.length, n, "every transition, the earliest included");
    assert.equal(s.transitions[0].messageId, t155Id(0));
    assert.deepEqual(c._rpcCalls.map((x: any) => x.args), [{ p_thread_id: THREAD, p_projection: "coordination_sessions" }]);
  });

  it("ON, with a checkpoint: the rows after its cursor are REPLAYED onto it, and nothing is rewritten", async () => {
    const all = t155Evening(30);
    const checkpointed = all.slice(0, 21);
    const last = checkpointed[checkpointed.length - 1];
    const checkpoint = {
      thread_id: THREAD, projection: "coordination_sessions", projection_version: 1,
      through_created_at: last.created_at, through_message_id: last.id, row_count: checkpointed.length,
      rows: checkpointed.map((m) => ({ id: m.id, sender_id: m.sender_id, created_at: m.created_at, msg_type: m.msg_type, body: m.body })),
    };
    // The tail lives only in `messages`; the checkpoint's own rows are removed from it, so a fold that did not
    // read the checkpoint could not see them.
    // A tombstoned transition after the cursor is not replayed, any more than the live read would read it.
    const tombstone = { ...transitionMsg("15500000-0000-4000-8000-0000000009ff", SESSION, "CANCELLED", min(-100)), deleted_at: min(-99) };
    const c = t155State({ extraMessages: [...all.slice(21), tombstone] }, { flag: true, checkpoint });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionSnapshot.used, true);
    assert.equal(r.body.sessionSnapshot.writer, null);
    assert.equal(r.body.sessionSnapshot.throughCreatedAt, last.created_at);
    assert.equal(r.body.coordination.session.transitions.length, 30, "21 checkpointed (the session among them) + 9 replayed, once each");
    assert.notEqual(r.body.coordination.session.state, "CANCELLED");
    assert.deepEqual(c._rpcCalls, [], "an untruncated tail does not rewrite the checkpoint");
  });

  it("ON, with a checkpoint whose TAIL overflows the cap: the checkpoint is advanced once and the fold is whole again", async () => {
    const all = t155Evening(20 + T155_SCAN + 30);
    const checkpointed = all.slice(0, 21);
    const last = checkpointed[checkpointed.length - 1];
    const checkpoint = {
      thread_id: THREAD, projection: "coordination_sessions", projection_version: 1,
      through_created_at: last.created_at, through_message_id: last.id, row_count: checkpointed.length,
      rows: checkpointed.map((m) => ({ id: m.id, sender_id: m.sender_id, created_at: m.created_at, msg_type: m.msg_type, body: m.body })),
    };
    const c = t155State({ extraMessages: all }, { flag: true, checkpoint });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.body.sessionSnapshot.used, true);
    assert.equal(r.body.sessionSnapshot.writer, "written");
    assert.equal(r.body.sessionSnapshot.checkpointRows, all.length);
    assert.equal(r.body.sessionScanTruncated, false);
    assert.equal(r.body.coordination.session.transitions.length, all.length - 1);
    assert.equal(c._rpcCalls.length, 1);
  });

  it("ON, but nothing to checkpoint: an untruncated read is answered as before and writes nothing", async () => {
    const c = t155State({ extraMessages: t155Evening(10) }, { flag: true });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.body.sessionSnapshot.reason, "not_needed");
    assert.equal(r.body.coordination.session.transitions.length, 10);
    assert.deepEqual(c._rpcCalls, []);
  });

  it("an UNREADABLE checkpoint falls back to the live read, truncation stated — never less than that read", async () => {
    const c = t155State({ extraMessages: t155Evening(T155_SCAN + 50) }, { flag: true, snapshotError: true });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionSnapshot.used, false);
    assert.equal(r.body.sessionSnapshot.reason, "unreadable");
    assert.equal(r.body.sessionScanTruncated, true);
    assert.deepEqual(c._rpcCalls, [], "a checkpoint that cannot be read is not overwritten blind");
  });

  it("a MALFORMED checkpoint is not used", async () => {
    const bad = { thread_id: THREAD, projection: "coordination_sessions", through_created_at: min(-5), through_message_id: "00000000-0000-4000-8000-000000000001", row_count: 3, rows: [] };
    t155State({ extraMessages: t155Evening(5) }, { flag: true, checkpoint: bad });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.body.sessionSnapshot.reason, "malformed");
    assert.equal(r.body.coordination.session.transitions.length, 5);
  });

  it("a checkpoint whose tail overflows, and a writer that REFUSES to advance it: never a fold with a hole in the middle", async () => {
    const all = t155Evening(20 + T155_SCAN + 30);
    const checkpointed = all.slice(0, 21);
    const last = checkpointed[checkpointed.length - 1];
    const checkpoint = {
      thread_id: THREAD, projection: "coordination_sessions", projection_version: 1,
      through_created_at: last.created_at, through_message_id: last.id, row_count: checkpointed.length,
      rows: checkpointed.map((m) => ({ id: m.id, sender_id: m.sender_id, created_at: m.created_at, msg_type: m.msg_type, body: m.body })),
    };
    t155State({ extraMessages: all }, { flag: true, checkpoint, writer: "too_large" });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.body.sessionSnapshot.used, false, "the old checkpoint plus the newest 200 would skip every row between them");
    assert.equal(r.body.sessionSnapshot.reason, "not_written");
    assert.equal(r.body.sessionScanTruncated, true);
  });

  for (const writer of ["too_large", "disabled", "error"]) {
    it(`a writer that answers ${writer} leaves the live read's answer, truncation stated`, async () => {
      t155State({ extraMessages: t155Evening(T155_SCAN + 50) }, { flag: true, writer });
      const r = await get(`/threads/${THREAD}/coordination`, ALICE);
      assert.equal(r.status, 200);
      assert.equal(r.body.sessionSnapshot.used, false);
      assert.equal(r.body.sessionSnapshot.reason, "not_written");
      assert.equal(r.body.sessionSnapshot.writer, writer);
      assert.equal(r.body.sessionScanTruncated, true);
    });
  }

  it("the §14.3 window applies to checkpointed rows as it does to live ones (Q6 keeps a member's own)", async () => {
    const members = [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      // Bob's window opens between the session (-1000 min) and its first transition (-999 min).
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: min(-999.5), last_read_at: null },
    ];
    t155State({ extraMessages: t155Evening(T155_SCAN + 50), members, historyBound: true }, { flag: true });
    const alice = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(alice.body.coordination.session?.sessionId, SESSION, "Alice opened it");
    const bob = await get(`/threads/${THREAD}/coordination`, BOB);
    assert.equal(bob.body.sessionSnapshot.used, true, "Bob reads the checkpoint Alice's read wrote");
    assert.equal(bob.body.coordination.session, null, "Bob joined after the session was opened by somebody else");
  });

  it("the cursor is compared to the MICROSECOND, by (created_at, id)", () => {
    const cp = { throughCreatedAt: "2026-10-17T12:00:00.123456+00:00", throughMessageId: "00000000-0000-4000-8000-000000000005" };
    assert.ok(t155InstantKey("2026-10-17T12:00:00.123457+00:00") > t155InstantKey(cp.throughCreatedAt));
    assert.equal(t155After({ created_at: "2026-10-17T12:00:00.123457+00:00", id: "00000000-0000-4000-8000-000000000001" }, cp), true);
    assert.equal(t155After({ created_at: "2026-10-17T12:00:00.123455+00:00", id: "ffffffff-0000-4000-8000-000000000009" }, cp), false);
    assert.equal(t155After({ created_at: cp.throughCreatedAt, id: "00000000-0000-4000-8000-000000000006" }, cp), true);
    assert.equal(t155After({ created_at: cp.throughCreatedAt, id: cp.throughMessageId }, cp), false, "the cursor row itself is checkpointed, never replayed twice");
    assert.equal(t155After({ created_at: "not a time", id: "x" }, cp), false);
  });

  it("a checkpoint must be well-formed to be used: a cursor that could become filter syntax, a count mismatch, a foreign kind", () => {
    const row = (over: any = {}) => ({ through_created_at: min(-5), through_message_id: "00000000-0000-4000-8000-000000000001", row_count: 1,
      rows: [{ id: "a", sender_id: ALICE, created_at: min(-6), msg_type: "coordination_session", body: "{}" }], ...over });
    assert.notEqual(t155CheckpointFrom(row()), "malformed");
    assert.equal(t155CheckpointFrom(row({ through_created_at: "2026-10-17T12:00:00Z,id.gt.0" })), "malformed");
    assert.equal(t155CheckpointFrom(row({ through_message_id: "not-a-uuid" })), "malformed");
    assert.equal(t155CheckpointFrom(row({ row_count: 2 })), "malformed");
    assert.equal(t155CheckpointFrom(row({ rows: [{ id: "a", sender_id: ALICE, created_at: min(-6), msg_type: "text", body: "hi" }] })), "malformed");
  });

  it("an unreadable flag is NOT on: the live read runs and says why", async () => {
    let lived = 0;
    const client: any = { from: () => new Proxy({}, { get(_t, k) { if (k === "maybeSingle") return () => Promise.resolve({ data: null, error: { message: "flags down" } }); if (k === "then" || k === "catch" || k === "finally") return undefined; return () => client.from(); } }) };
    const r = await t155Read2(client, { threadId: THREAD, visibleFrom: null, viewerId: ALICE, columns: "id", tailLimit: 10 },
      async () => { lived += 1; return { ok: true, sessions: [], transitions: [], truncated: false }; });
    assert.equal(lived, 1);
    assert.ok(r.ok && r.snapshot.reason === "flag_unreadable");
  });

  it("the TS row cap and the migration's are one number", () => {
    assert.equal(T155_CAP, 2000);
    assert.match(T155_SQL, /CHECK \(row_count BETWEEN 1 AND 2000\)/);
    assert.match(T155_SQL, /LIMIT 2001\) s;/);
    assert.match(T155_SQL, /IF v_count > 2000 THEN/);
  });
});

// ── 3998 executed (PGlite, as the repository's other SQL suites run it) ──────

const T155_PGLITE = process.env.DISCOVERY_PGLITE_MODULE ?? new URL(import.meta.resolve("@electric-sql/pglite")).pathname; // a devDependency: the suite always executes

describe("T155 — migration 3998 executed: the checkpoint, its writer and the triggers that keep it honest", { skip: !T155_PGLITE }, () => {
  let db: any;
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  let thread = "";

  before(async () => {
    const { PGlite } = await import(t155Url(T155_PGLITE!).href);
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
      CREATE TABLE public.message_threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE public.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        thread_id uuid NOT NULL REFERENCES public.message_threads(id) ON DELETE CASCADE,
        sender_id uuid NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz, msg_type text NOT NULL DEFAULT 'text', translated_body_json jsonb);
    `);
    await db.exec(T155_SQL);
  });

  const count = async () => Number((await db.query("SELECT count(*)::int AS c FROM public.conversation_snapshots")).rows[0].c);
  const write = async () => (await db.query("SELECT public.telegraph_write_conversation_snapshot($1, 'coordination_sessions') AS r", [thread])).rows[0].r;
  const seed = async (n: number) => {
    thread = (await db.query("INSERT INTO public.message_threads DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query("INSERT INTO public.messages (thread_id, sender_id, body, created_at, msg_type) VALUES ($1, $2, '{}', now() - interval '10 hours', 'coordination_session')", [thread, A]);
    for (let i = 0; i < n; i++) {
      await db.query("INSERT INTO public.messages (thread_id, sender_id, body, created_at, msg_type) VALUES ($1, $2, $3, now() - ($4 || ' minutes')::interval, 'coordination_transition')", [thread, A, `{"i":${i}}`, String(500 - i)]);
    }
    await db.query("INSERT INTO public.messages (thread_id, sender_id, body, msg_type) VALUES ($1, $2, 'just chat', 'text')", [thread, A]);
  };
  const flag = (on: boolean) => db.query("UPDATE public.feature_flags SET enabled = $1 WHERE flag = 'telegraph_conversation_snapshots_enabled'", [on]);

  it("the seed is OFF and the writer refuses while it is", async () => {
    assert.equal((await db.query("SELECT enabled FROM public.feature_flags WHERE flag = 'telegraph_conversation_snapshots_enabled'")).rows[0].enabled, false);
    await seed(3);
    assert.deepEqual(await write(), { outcome: "disabled" });
    assert.equal(await count(), 0);
  });

  it("ON: the checkpoint holds every live session-kind row, oldest first, and its cursor is the newest", async () => {
    await flag(true);
    await seed(5);
    await db.query("UPDATE public.messages SET deleted_at = now() WHERE thread_id = $1 AND body = '{\"i\":0}'", [thread]);
    const r = await write();
    assert.equal(r.outcome, "written");
    assert.equal(r.row_count, 5, "1 session + 4 live transitions; the tombstone and the chat are not the fold's input");
    const row = (await db.query("SELECT * FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0];
    assert.equal(row.rows.length, 5);
    assert.equal(row.rows[0].msg_type, "coordination_session");
    assert.deepEqual(row.rows.slice(1).map((x: any) => x.body), ['{"i":1}', '{"i":2}', '{"i":3}', '{"i":4}']);
    assert.equal(row.through_message_id, row.rows[4].id);
  });

  it("a translation write keeps the checkpoint; a NEW row after the cursor keeps it (it is the replayed tail)", async () => {
    await seed(3); await write();
    const mine = async () => Number((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0].c);
    await db.query("UPDATE public.messages SET translated_body_json = '{}'::jsonb WHERE thread_id = $1", [thread]);
    assert.equal(await mine(), 1);
    await db.query("INSERT INTO public.messages (thread_id, sender_id, body, msg_type) VALUES ($1, $2, '{}', 'coordination_transition')", [thread, A]);
    assert.equal(await mine(), 1);
  });

  for (const [label, change] of [
    ["an edit of a checkpointed row's body", "UPDATE public.messages SET body = '{\"i\":99}' WHERE thread_id = $1 AND body = '{\"i\":1}'"],
    ["a tombstone (unsend / delete-for-everyone)", "UPDATE public.messages SET deleted_at = now() WHERE thread_id = $1 AND body = '{\"i\":1}'"],
    ["a hard delete (an account deletion's cascade over the sender's messages)", "DELETE FROM public.messages WHERE thread_id = $1 AND sender_id = '" + "aaaaaaaa-0000-4000-8000-000000000001" + "'"],
    ["a row committed BEHIND the cursor", "INSERT INTO public.messages (thread_id, sender_id, body, created_at, msg_type) VALUES ($1, 'bbbbbbbb-0000-4000-8000-000000000002', '{}', now() - interval '20 hours', 'coordination_transition')"],
  ] as const) {
    it(`${label} deletes the checkpoint in the same transaction`, async () => {
      await seed(3); await write();
      const others = (await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id <> $1", [thread])).rows[0].c;
      await db.query(change, [thread]);
      assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0].c, 0, label);
      assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id <> $1", [thread])).rows[0].c, others, "another thread's checkpoint is untouched");
    });
  }

  it("a session row MOVED into another thread clears that thread's checkpoint too", async () => {
    await seed(3); await write();
    const from = thread;
    await seed(3); await write();
    const to = thread;
    await db.query("UPDATE public.messages SET thread_id = $2 WHERE id = (SELECT id FROM public.messages WHERE thread_id = $1 AND msg_type = 'coordination_session')", [from, to]);
    for (const t of [from, to]) {
      assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [t])).rows[0].c, 0, t === to ? "the destination" : "the source");
    }
  });

  it("the triggers run whatever the flag says", async () => {
    await seed(3); await write();
    await flag(false);
    await db.query("UPDATE public.messages SET body = 'x' WHERE thread_id = $1 AND msg_type = 'coordination_session'", [thread]);
    assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0].c, 0);
    await flag(true);
  });

  it("the thread's deletion takes its checkpoint; a thread with no session row has none", async () => {
    await seed(2); await write();
    await db.query("DELETE FROM public.message_threads WHERE id = $1", [thread]);
    assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0].c, 0);
    thread = (await db.query("INSERT INTO public.message_threads DEFAULT VALUES RETURNING id")).rows[0].id;
    assert.deepEqual(await write(), { outcome: "empty", row_count: 0 });
  });

  it("more than the cap is refused, and nothing is written", async () => {
    thread = (await db.query("INSERT INTO public.message_threads DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO public.messages (thread_id, sender_id, body, created_at, msg_type)
      SELECT $1, $2, '{}', now() - (g || ' seconds')::interval, 'coordination_transition' FROM generate_series(1, 2001) g`, [thread, A]);
    const r = await write();
    assert.equal(r.outcome, "too_large");
    assert.equal((await db.query("SELECT count(*)::int c FROM public.conversation_snapshots WHERE thread_id = $1", [thread])).rows[0].c, 0);
  });

  it("TRUNCATE of messages removes every checkpoint", async () => {
    await seed(2); await write();
    assert.ok(await count() > 0);
    await db.exec("TRUNCATE public.messages CASCADE");
    assert.equal(await count(), 0);
  });

  it("service role reads only; no client role reads or writes; only service role runs the writer", async () => {
    const priv = async (role: string, p: string) => (await db.query(`SELECT has_table_privilege($1, 'public.conversation_snapshots', $2) AS ok`, [role, p])).rows[0].ok;
    assert.equal(await priv("service_role", "SELECT"), true);
    for (const p of ["INSERT", "UPDATE", "DELETE"]) assert.equal(await priv("service_role", p), false, p);
    for (const role of ["anon", "authenticated"]) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal(await priv(role, p), false, `${role} ${p}`);
    const exec = async (role: string) => (await db.query(`SELECT has_function_privilege($1, 'public.telegraph_write_conversation_snapshot(uuid, text)', 'EXECUTE') AS ok`, [role])).rows[0].ok;
    assert.equal(await exec("service_role"), true);
    assert.equal(await exec("anon"), false);
    assert.equal(await exec("authenticated"), false);
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversation_snapshots'::regclass")).rows[0].relrowsecurity, true);
  });

  it("the postconditions hold, and catch drift", async () => {
    const post = T155_SQL.slice(T155_SQL.indexOf("DO $post$"), T155_SQL.indexOf("COMMIT;"));
    await db.exec(post);
    for (const drift of [
      "ALTER TABLE public.conversation_snapshots ADD COLUMN extra text",
      "ALTER TABLE public.conversation_snapshots DISABLE ROW LEVEL SECURITY",
      "GRANT INSERT ON public.conversation_snapshots TO service_role",
      "GRANT SELECT ON public.conversation_snapshots TO authenticated",
      "DROP TRIGGER telegraph_conversation_snapshot_on_delete ON public.messages",
      "ALTER TABLE public.messages DISABLE TRIGGER telegraph_conversation_snapshot_on_update",
      "GRANT EXECUTE ON FUNCTION public.telegraph_write_conversation_snapshot(uuid, text) TO anon",
    ]) {
      await db.exec("BEGIN");
      try {
        await db.exec(drift);
        await assert.rejects(db.exec(post), /3998:/, drift);
      } finally {
        await db.exec("ROLLBACK");
      }
    }
  });
});
