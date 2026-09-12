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
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null },
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
