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
      { flag: "telegraph_history_bound_enabled", enabled: false },
    ],
    message_threads: [
      { id: THREAD, is_e2ee: false },
      { id: THREAD_B, is_e2ee: false },
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: THREAD_B, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD_B, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null, visible_from_at: null },
    ],
    blocks: [],
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

    const rowsNow = () => {
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
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: `new-${inserted.length + 1}`, ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
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
