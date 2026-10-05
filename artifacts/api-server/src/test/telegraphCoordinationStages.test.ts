/**
 * Telegraph §9's per-state cells that nothing produced — Active's NEXT STEP
 * (census T106), Returning's SHARED TRANSPORT (T107) and Complete's CLOSEOUT
 * (T108) — as pure projections AND as fields of `GET /threads/:id/coordination`.
 *
 * The route cases read the RESPONSE BODY a client renders from, over the same
 * in-process harness the other coordination suites use; the pure cases pin each
 * rule's refusal side (no step when nothing is happening, a departed member is
 * not riding with anyone, last month's dinner gets no closeout).
 *
 * Run: node --import tsx/esm --test src/test/telegraphCoordinationStages.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import {
  CLOSEOUT_WINDOW_HOURS,
  projectCloseout,
  projectNextStep,
  projectSharedRides,
  type StageCommitment,
  type StageDecision,
} from "../services/telegraph/coordinationStages.js";
import { RETURN_WINDOW_MINUTES } from "../services/telegraph/coordination.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const MEETUP = "20000000-0000-4000-8000-000000000001";

const NOW = Date.now();
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();
const hr = (n: number) => new Date(NOW + n * 3600_000).toISOString();

const PLAN = { objectId: MEETUP, title: "Dinner", startsAt: min(-60), endsAt: min(60), leaveByAt: min(-105) };

function decision(over: Partial<StageDecision> = {}): StageDecision {
  return { decisionId: "d1", question: "Which bar?", deadlineAt: null, resolved: false, ...over };
}
function commitment(over: Partial<StageCommitment> = {}): StageCommitment {
  return { commitmentId: "c1", what: "Book the table", byWhen: null, completedBy: null, overdue: false, ...over };
}

// ── pure: next step ─────────────────────────────────────────────────────────

describe("§9 Active — projectNextStep", () => {
  const base = { state: "ACTIVE" as const, plan: PLAN, decisions: [], commitments: [], rendezvous: [], nowMs: NOW };

  it("a thread that is not coordinating has NO next step (PREPARING, COMPLETE, CANCELLED, no plan)", () => {
    for (const state of ["PREPARING", "COMPLETE", "CANCELLED", null] as const) {
      assert.equal(projectNextStep({ ...base, state, decisions: [decision()] }), null, String(state));
    }
  });

  it("an overdue commitment outranks an open decision — it is what is blocking everyone", () => {
    const step = projectNextStep({
      ...base,
      decisions: [decision()],
      commitments: [commitment({ overdue: true, byWhen: min(-5) })],
    });
    assert.equal(step?.kind, "OVERDUE_COMMITMENT");
    assert.equal(step?.label, "Overdue: Book the table");
    assert.equal(step?.sourceMessageId, "c1");
  });

  it("an open decision, earliest deadline first; a resolved one is not a step", () => {
    const step = projectNextStep({
      ...base,
      decisions: [
        decision({ decisionId: "late", question: "Dessert?", deadlineAt: min(90) }),
        decision({ decisionId: "done", question: "Where?", deadlineAt: min(1), resolved: true }),
        decision({ decisionId: "soon", question: "Which bar?", deadlineAt: min(20) }),
      ],
    });
    assert.equal(step?.kind, "OPEN_DECISION");
    assert.equal(step?.sourceMessageId, "soon");
  });

  it("with nothing to decide, the newest meeting point whose window is still open", () => {
    const step = projectNextStep({
      ...base,
      rendezvous: [
        { messageId: "r-old", at: min(-30), payload: { checkpoint: "Old fountain", windowEndsAt: min(-1) } },
        { messageId: "r-new", at: min(-10), payload: { checkpoint: "Station exit 4", windowStartsAt: min(15) } },
      ],
    });
    assert.equal(step?.kind, "MEET_AT");
    assert.equal(step?.label, "Meet at Station exit 4");
    assert.equal(step?.at, min(15));
  });

  it("a meeting point whose window has closed is not a next step", () => {
    const step = projectNextStep({
      ...base,
      rendezvous: [{ messageId: "r", at: min(-30), payload: { checkpoint: "Old fountain", windowEndsAt: min(-1) } }],
    });
    assert.equal(step?.kind, "PLAN_ENDS");
  });

  it("falls back to the plan's own timeline, per state", () => {
    assert.equal(projectNextStep({ ...base, state: "ASSEMBLING" })?.kind, "LEAVE_BY");
    assert.equal(projectNextStep({ ...base, state: "ASSEMBLING" })?.at, PLAN.leaveByAt);
    assert.equal(projectNextStep({ ...base, state: "ACTIVE" })?.kind, "PLAN_ENDS");
    assert.equal(projectNextStep({ ...base, state: "RETURNING" })?.kind, "HEAD_BACK");
  });

  it("a next step says it was DERIVED — it is never presented as something a person declared", () => {
    assert.equal(projectNextStep(base)?.provenance, "DERIVED_FROM_THREAD");
  });
});

// ── pure: shared rides ──────────────────────────────────────────────────────

describe("§9 Returning — projectSharedRides", () => {
  const proposal = (id: string, by: string, action = "SPLIT_RIDE") => ({
    id,
    sender_id: by,
    created_at: min(-20),
    payload: { action, title: "Taxi back to the hostel" },
  });
  const answer = (by: string, to: string, response: string, at: number) => ({
    id: `${by}-${to}-${at}`,
    sender_id: by,
    created_at: min(at),
    payload: { actionMessageId: to, response },
  });
  const roster = new Set([ALICE, BOB, CAROL]);

  it("the proposer rides; a CONFIRMED answer joins; a DECLINED one does not", () => {
    const rides = projectSharedRides(
      [proposal("p1", ALICE)],
      [answer(BOB, "p1", "CONFIRMED", -10), answer(CAROL, "p1", "DECLINED", -9)],
      roster,
    );
    assert.equal(rides.length, 1);
    assert.deepEqual(rides[0]!.riders, [ALICE, BOB]);
    assert.deepEqual(rides[0]!.declined, [CAROL]);
    assert.equal(rides[0]!.rosterChecked, true);
  });

  it("a person's LATEST answer counts — joining then dropping out is dropping out", () => {
    const rides = projectSharedRides(
      [proposal("p1", ALICE)],
      [answer(BOB, "p1", "CONFIRMED", -10), answer(BOB, "p1", "DECLINED", -2)],
      roster,
    );
    assert.deepEqual(rides[0]!.riders, [ALICE]);
    assert.deepEqual(rides[0]!.declined, [BOB]);
  });

  it("a member who has LEFT the conversation is not riding with anyone (§14.2 re-check on read)", () => {
    const rides = projectSharedRides(
      [proposal("p1", ALICE)],
      [answer(BOB, "p1", "CONFIRMED", -10)],
      new Set([ALICE, CAROL]),
    );
    assert.deepEqual(rides[0]!.riders, [ALICE]);
  });

  it("an unreadable roster drops nobody and SAYS the list was not checked", () => {
    const rides = projectSharedRides([proposal("p1", ALICE)], [answer(BOB, "p1", "CONFIRMED", -10)], null);
    assert.deepEqual(rides[0]!.riders, [ALICE, BOB]);
    assert.equal(rides[0]!.rosterChecked, false);
  });

  it("only SPLIT_RIDE proposals are rides, and an answer to a different proposal is not counted", () => {
    const rides = projectSharedRides(
      [proposal("p1", ALICE, "MEET_HERE"), proposal("p2", ALICE)],
      [answer(BOB, "p1", "CONFIRMED", -10)],
      roster,
    );
    assert.equal(rides.length, 1);
    assert.equal(rides[0]!.proposalId, "p2");
    assert.deepEqual(rides[0]!.riders, [ALICE]);
  });
});

// ── pure: closeout ──────────────────────────────────────────────────────────

describe("§9 Complete — projectCloseout", () => {
  const ended = (minutesAgo: number) => ({
    objectId: MEETUP,
    title: "Dinner",
    startsAt: min(-minutesAgo - 120),
    endsAt: min(-minutesAgo),
  });

  it("a plan that has just completed gets a closeout with explicit options — and nothing created", () => {
    const c = projectCloseout({ state: "COMPLETE", plan: ended(RETURN_WINDOW_MINUTES + 30), arrivedCount: 3, nowMs: NOW });
    assert.ok(c, "no closeout for a plan that just completed");
    assert.equal(c!.title, "Dinner");
    assert.equal(c!.arrivedCount, 3);
    assert.deepEqual([...c!.options], ["CREATE_RECAP", "SAVE_TO_MEMORY", "DONE"]);
  });

  it("the offer ends — last week's dinner does not sit at the top of the thread forever", () => {
    const stale = RETURN_WINDOW_MINUTES + CLOSEOUT_WINDOW_HOURS * 60 + 1;
    assert.equal(projectCloseout({ state: "COMPLETE", plan: ended(stale), arrivedCount: 0, nowMs: NOW }), null);
  });

  it("only COMPLETE closes out: a cancelled plan, a running plan and no plan get nothing", () => {
    const plan = ended(RETURN_WINDOW_MINUTES + 30);
    assert.equal(projectCloseout({ state: "CANCELLED", plan, arrivedCount: 0, nowMs: NOW }), null);
    assert.equal(projectCloseout({ state: "RETURNING", plan, arrivedCount: 0, nowMs: NOW }), null);
    assert.equal(projectCloseout({ state: "COMPLETE", plan: null, arrivedCount: 0, nowMs: NOW }), null);
  });
});

// ── the route ───────────────────────────────────────────────────────────────

interface World {
  meetupStartsAt: string;
  meetupEndsAt: string;
  messages: any[];
  rosterFails?: boolean;
}

function env(kind: string, payload: unknown) {
  return JSON.stringify({ kind, envelopeVersion: "1", payload });
}
function coordMsg(id: string, sender: string, kind: string, payload: unknown, created_at: string) {
  return { id, thread_id: THREAD, sender_id: sender, created_at, deleted_at: null, msg_type: kind.toLowerCase(), subtype: null, body: env(kind, payload) };
}

function makeClient(w: World) {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "telegraph_history_bound_enabled", enabled: false }],
    message_threads: [{ id: THREAD, is_e2ee: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
    ],
    meetups: [
      { id: MEETUP, title: "Dinner", starts_at: w.meetupStartsAt, ends_at: w.meetupEndsAt, status: "confirmed", chat_thread_id: THREAD },
    ],
    messages: w.messages,
  };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let isRosterRead = false;
    const rows = () => {
      let out = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        out = [...out].sort((a, b) => (asc ? 1 : -1) * ((Date.parse(a[col]) || 0) - (Date.parse(b[col]) || 0)));
      }
      return limitN !== null ? out.slice(0, limitN) : out;
    };
    const failRoster = () => w.rosterFails === true && table === "message_thread_members" && isRosterRead;
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) {
        if (table === "message_thread_members" && col === "user_id") isRosterRead = false;
        filters.push((r) => r[col] === val);
        return proxy;
      },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return proxy; },
      is(col: string, val: any) {
        if (table === "message_thread_members" && col === "left_at") isRosterRead = true;
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return proxy;
      },
      gte(col: string, val: any) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      or() { return proxy; },
      order(col: string, opts?: any) { order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { limitN = n; return proxy; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        if (failRoster()) return Promise.resolve({ data: null, error: { message: "roster down" } }).then(resolve, reject);
        return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
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
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

async function getCoordination(w: World, asUser = ALICE) {
  _setTestClient(makeClient(w), true);
  const r = await fetch(`${base}/threads/${THREAD}/coordination`, { headers: { authorization: `Bearer ${asUser}` } });
  return { status: r.status, body: (await r.json()) as any };
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

describe("GET /threads/:id/coordination carries the three stage cells", () => {
  it("ACTIVE with an open decision: nextStep is that decision, derived", async () => {
    const { status, body } = await getCoordination({
      meetupStartsAt: min(-30),
      meetupEndsAt: min(90),
      messages: [
        coordMsg("dec-1", BOB, "DECISION", { question: "Which bar after?", options: [{ id: "a", label: "Ola" }, { id: "b", label: "Lux" }] }, min(-5)),
      ],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.coordination.state, "ACTIVE");
    assert.equal(body.coordination.nextStep.kind, "OPEN_DECISION");
    assert.equal(body.coordination.nextStep.sourceMessageId, "dec-1");
    assert.equal(body.coordination.nextStep.provenance, "DERIVED_FROM_THREAD");
    assert.equal(body.coordination.closeout, null);
  });

  it("RETURNING with a SPLIT_RIDE proposal and a CONFIRMED answer: the ride lists both riders", async () => {
    const { status, body } = await getCoordination({
      meetupStartsAt: min(-180),
      meetupEndsAt: min(-30),
      messages: [
        coordMsg("ride-1", ALICE, "ACTION_PROPOSAL", { action: "SPLIT_RIDE", title: "Taxi back", requiresConfirmation: true }, min(-20)),
        coordMsg("ans-1", BOB, "ACTION_RESPONSE", { actionMessageId: "ride-1", response: "CONFIRMED" }, min(-10)),
      ],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.coordination.state, "RETURNING");
    assert.equal(body.coordination.sharedRides.length, 1);
    assert.deepEqual(body.coordination.sharedRides[0].riders, [ALICE, BOB]);
    assert.equal(body.coordination.sharedRides[0].rosterChecked, true);
    assert.equal(body.coordination.nextStep.kind, "HEAD_BACK");
  });

  it("an unreadable roster: the ride is still listed but says it was NOT checked", async () => {
    const { status, body } = await getCoordination({
      meetupStartsAt: min(-180),
      meetupEndsAt: min(-30),
      rosterFails: true,
      messages: [
        coordMsg("ride-1", ALICE, "ACTION_PROPOSAL", { action: "SPLIT_RIDE", title: "Taxi back", requiresConfirmation: true }, min(-20)),
      ],
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.coordination.sharedRides[0].rosterChecked, false);
  });

  it("COMPLETE a few hours ago: a closeout is offered and nothing is coordinating", async () => {
    const { status, body } = await getCoordination({ meetupStartsAt: hr(-7), meetupEndsAt: hr(-5), messages: [] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.coordination.state, "COMPLETE");
    assert.equal(body.coordination.coordinating, false);
    assert.equal(body.coordination.closeout.title, "Dinner");
    assert.equal(body.coordination.nextStep, null);
  });

  it("COMPLETE three days ago: no closeout", async () => {
    const { status, body } = await getCoordination({ meetupStartsAt: hr(-74), meetupEndsAt: hr(-72), messages: [] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.coordination.state, "COMPLETE");
    assert.equal(body.coordination.closeout, null);
  });
});
