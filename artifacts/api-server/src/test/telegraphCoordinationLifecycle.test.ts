/**
 * Telegraph §9 / §13.1 / §13.2 — the coordination session's LIFECYCLE.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §9     PREPARING -> ASSEMBLING -> ACTIVE -> RETURNING -> COMPLETE, with
 *          DISRUPTED / CANCELLED as exits
 *   §12    `coordination_sessions` — "Temporary active real-world coordination
 *          state."
 *   §12.1  a message envelope carries an `idempotencyKey`
 *   §13.1  `CREATE_COORDINATION_SESSION`
 *   §13.2  `coordination.started` · `coordination.completed`
 *   §14.2  "Authorization must be checked both when sending and when reading
 *          because membership … can change after a message was created."
 *   §17.2  "Offline resend must be idempotent."
 *
 * WHAT THIS PINS THAT THE EXISTING SUITE DOES NOT. `telegraphCoordination.test.ts`
 * proves the session is an OBJECT — an id, a starter, an end, a recordable
 * DISRUPTED. Everything here is about what happens to that object when the
 * world misbehaves: a retry, a stale client, somebody leaving mid-evening, a
 * roster that will not read. Those are the four ways a coordination surface
 * goes wrong in the field and none of them was covered.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - `createCoordinationSession` minting a row when the key already exists:
 *     the retry tests fail and a tap-tap on a bad connection becomes two
 *     evenings.
 *   - The read-side collapse removed: the concurrent-retry test fails. The
 *     write check alone cannot see a simultaneous twin.
 *   - `coordination.completed` emitted only on COMPLETE: the CANCELLED test
 *     fails and every other client keeps a cancelled panel open.
 *   - `expectedVersion` ignored: the conflict test fails and the last writer
 *     silently wins.
 *   - `latestQuickStates` not filtered by the active roster: the
 *     membership-change test fails and somebody who walked out still counts as
 *     ARRIVED.
 *   - An unreadable roster treated as "nobody is active": the degraded test
 *     fails, because an empty arrival count and an unverified one are not the
 *     same answer.
 *
 * Run: node --import tsx/esm --test src/test/telegraphCoordinationLifecycle.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  projectConversationSessions,
  projectCoordinationSession,
  latestQuickStates,
} from "../services/telegraph/coordination.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const MEETUP = "20000000-0000-4000-8000-000000000001";

const NOW = Date.now();
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();

function env(kind: string, payload: unknown) {
  return JSON.stringify({ kind, envelopeVersion: "1", payload });
}

interface State {
  extraMessages?: any[];
  members?: any[];
  rosterError?: boolean;
  kernelFlag?: boolean;
  /** No meetup at all, so §9's derived state is null. */
  noPlan?: boolean;
}

/**
 * A PostgREST-shaped fake.
 *
 * `rosterError` injects a failure on the ROSTER read specifically — the one
 * shaped `eq(thread_id) . is(left_at, null)` — and NOT on the membership
 * lookup the gate uses, which is `eq(thread_id) . eq(user_id)`. The two have
 * the same filter COUNT, so the fake matches on the filter SHAPE: a test that
 * broke both would prove nothing about the degraded path, because the gate
 * would 500 before the read under test ever happened. It did exactly that on
 * the first run.
 */
function makeClient(state: State = {}) {
  const db: Record<string, any[]> = {
    feature_flags: [
      { flag: "disable_messaging", enabled: false },
      { flag: "telegraph_history_bound_enabled", enabled: false },
      { flag: "telegraph_message_kernel_enabled", enabled: state.kernelFlag !== false },
    ],
    message_threads: [{ id: THREAD, is_e2ee: false }],
    message_thread_members: state.members ?? [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null, last_read_at: null },
    ],
    blocks: [],
    meetups: state.noPlan
      ? []
      : [
          {
            id: MEETUP,
            title: "Dinner",
            starts_at: min(30),
            ends_at: min(180),
            status: "confirmed",
            chat_thread_id: THREAD,
          },
        ],
    messages: [...(state.extraMessages ?? [])],
    message_reactions: [],
  };
  let seq = 0;

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const shape: string[] = [];
    let pending: any = null;
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;

    const rowsNow = () => {
      let rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
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
    const injected = () =>
      table === "message_thread_members"
      && state.rosterError
      && shape.join(",") === "eq:thread_id,is:left_at"
        ? { message: "roster read blew up", code: "XX000" }
        : null;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        seq += 1;
        pending = { id: `ins-${seq}`, ...row };
        (db[table] ??= []).push(pending);
        return proxy;
      },
      update(patch: any) { pending = { __update: patch }; return proxy; },
      eq(col: string, val: any) { shape.push(`eq:${col}`); preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { shape.push(`neq:${col}`); preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { shape.push(`is:${col}`); preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { shape.push(`in:${col}`); preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      gte(col: string, val: any) { shape.push(`gte:${col}`); preds.push((r) => Date.parse(r[col]) >= Date.parse(val)); return proxy; },
      order(col: string, opts?: any) { _order = { col, asc: opts?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = injected();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pending && !pending.__update ? pending : rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = injected();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pending && !pending.__update ? pending : rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = injected();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (pending && pending.__update) {
          const patch = pending.__update; pending = null;
          for (const r of rowsNow()) Object.assign(r, patch);
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        const rows = pending ? [pending] : rowsNow();
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
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

let server: any;
let base = "";
/**
 * Every DELIVERY the bus made, with the user it reached.
 *
 * Deliveries and not events: one publish to a two-person thread arrives twice,
 * and collapsing that into one list made the first run assert `2 !== 1` on an
 * event that was perfectly correct. Keeping the recipient is also what lets
 * these tests assert the AUDIENCE, which for a presence-adjacent event is the
 * load-bearing half.
 */
let deliveries: Array<{ userId: string; event: TelegraphEvent }> = [];
let unsubs: Array<() => void> = [];

function useState(state: State = {}) {
  const c = makeClient(state);
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
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

async function get(path: string, asUser: string) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${asUser}` } });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

/** Wait for the fire-and-forget publishes the routes make after responding. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

/** Distinct events of a type, keyed by their own `eventKey`. */
function eventsOfType(type: string): TelegraphEvent[] {
  const byKey = new Map<string, TelegraphEvent>();
  for (const d of deliveries) {
    if (d.event.type !== type) continue;
    const key = String((d.event.payload as any)?.eventKey ?? `${d.event.type}:${byKey.size}`);
    if (!byKey.has(key)) byKey.set(key, d.event);
  }
  return [...byKey.values()];
}

/** Who a type of event reached. */
function recipientsOf(type: string): string[] {
  return [...new Set(deliveries.filter((d) => d.event.type === type).map((d) => d.userId))].sort();
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphCoordinationRouter);
  app.use("/api", commandRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  for (const u of unsubs) u();
  _setTestClient(null, false);
  _setTestServiceClient(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  for (const u of unsubs) u();
  deliveries = [];
  unsubs = [ALICE, BOB, CAROL].map((u) => subscribe(u, (e) => { deliveries.push({ userId: u, event: e }); }));
});

function sessionMsg(id: string, at: string, key: string | null, sender = ALICE) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination_session",
    subtype: null,
    body: env("COORDINATION_SESSION", {
      title: "Dinner run",
      planObjectId: MEETUP,
      ...(key === null ? {} : { idempotencyKey: key }),
    }),
  };
}

function transitionMsg(id: string, sessionId: string, to: string, at: string, key: string | null = null, sender = ALICE) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination_transition",
    subtype: to.toLowerCase(),
    body: env("COORDINATION_TRANSITION", { sessionId, to, ...(key === null ? {} : { idempotencyKey: key }) }),
  };
}

function quickMsg(id: string, sender: string, state: string, at: string) {
  return {
    id,
    thread_id: THREAD,
    sender_id: sender,
    created_at: at,
    deleted_at: null,
    msg_type: "coordination",
    subtype: state.toLowerCase(),
    body: env("COORDINATION", { state }),
  };
}

/* ───────────────── §13.1 CREATE_COORDINATION_SESSION ─────────────────────── */

describe("§13.1 CREATE_COORDINATION_SESSION — one command, two doors, one writer", () => {
  it("opens a session through the coordination route and returns 201", async () => {
    useState();
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", planObjectId: MEETUP, idempotencyKey: "k-1" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.duplicate, false);
    assert.equal(r.body.session.startedBy, ALICE);
    assert.equal(r.body.session.idempotencyKey, "k-1");
    assert.equal(r.body.session.version, 0);
  });

  it("REFUSES a session with no idempotency key — a generated one defeats §17.2", async () => {
    useState();
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run" },
    });
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /idempotencyKey is required/);
  });

  it("a RETRY returns the SAME session with 200 and duplicate:true, and writes nothing", async () => {
    const c = useState();
    const first = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "k-retry" },
    });
    assert.equal(first.status, 201);
    const countAfterFirst = c._db.messages.length;

    const second = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "k-retry" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.session.sessionId, first.body.session.sessionId);
    assert.equal(c._db.messages.length, countAfterFirst, "the retry inserted a second session row");
  });

  it("a DIFFERENT key from the same person opens a second session — retries are not deduped by title", async () => {
    useState();
    const a = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "k-a" },
    });
    const b = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "k-b" },
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.session.sessionId, b.body.session.sessionId);
  });

  it("the SAME key from a DIFFERENT person is a different session — a key is not a global lock", async () => {
    useState();
    const a = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Alice's", idempotencyKey: "same" },
    });
    const b = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Bob's", idempotencyKey: "same" },
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.session.sessionId, b.body.session.sessionId);
  });

  it("the command BUS issues it, and a retry there is also a duplicate", async () => {
    useState();
    const first = await post(`/telegraph/commands`, ALICE, {
      type: "CREATE_COORDINATION_SESSION",
      conversationId: THREAD,
      idempotency_key: "bus-1",
      params: { title: "Dinner run" },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.duplicate, false);

    const second = await post(`/telegraph/commands`, ALICE, {
      type: "CREATE_COORDINATION_SESSION",
      conversationId: THREAD,
      idempotency_key: "bus-1",
      params: { title: "Dinner run" },
    });
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.data.sessionId, first.body.data.sessionId);
  });

  it("the bus issues it with the message-kernel flag OFF, while the schema-gated commands are refused", async () => {
    // The gate exists because UNSEND_MESSAGE and the reaction commands need
    // columns and tables migration 2810/2811 add. A session needs none of them,
    // and gating it would make a live capability unreachable on every
    // deployment of this tree, where the flag is seeded FALSE.
    useState({ kernelFlag: false });
    const created = await post(`/telegraph/commands`, ALICE, {
      type: "CREATE_COORDINATION_SESSION",
      conversationId: THREAD,
      idempotency_key: "flag-off",
      params: { title: "Dinner run" },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);

    const unsend = await post(`/telegraph/commands`, ALICE, {
      type: "UNSEND_MESSAGE",
      conversationId: THREAD,
      params: { messageId: "11111111-0000-4000-8000-000000000001" },
    });
    assert.equal(unsend.status, 404, "feature_disabled must still refuse the schema-gated commands");
  });

  it("a non-member cannot open a session on somebody else's conversation", async () => {
    useState();
    const r = await post(`/threads/${THREAD}/coordination`, CAROL, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Crashing", idempotencyKey: "nope" },
    });
    assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
  });
});

/* ───────────── the read-side collapse: two rows, one session ─────────────── */

describe("§17.2 — two rows carrying one key are ONE session on the read", () => {
  it("collapses a concurrent twin, keeps the earlier row, and names the loser", () => {
    const rows = [
      { id: "s-late", sender_id: ALICE, created_at: min(-10), payload: { title: "Dinner", idempotencyKey: "k" } },
      { id: "s-early", sender_id: ALICE, created_at: min(-20), payload: { title: "Dinner", idempotencyKey: "k" } },
    ];
    const out = projectConversationSessions(rows as any, [], null);
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0]!.sessionId, "s-early", "the EARLIER row is the session");
    assert.deepEqual(out.duplicateSessionIds, ["s-late"]);
  });

  it("a session with NO key is never collapsed — pre-key rows keep their identity", () => {
    const rows = [
      { id: "s-1", sender_id: ALICE, created_at: min(-20), payload: { title: "One" } },
      { id: "s-2", sender_id: ALICE, created_at: min(-10), payload: { title: "Two" } },
    ];
    const out = projectConversationSessions(rows as any, [], null);
    assert.equal(out.sessions.length, 2);
    assert.deepEqual(out.duplicateSessionIds, []);
  });

  it("the coordination view reports the collapse rather than hiding it", async () => {
    useState({
      extraMessages: [sessionMsg("s-early", min(-20), "k"), sessionMsg("s-late", min(-10), "k")],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.session.sessionId, "s-early");
    assert.deepEqual(r.body.duplicateSessionIds, ["s-late"]);
  });
});

/* ─────────────────── §13.2 coordination.started / completed ───────────────── */

describe("§13.2 coordination.started and coordination.completed", () => {
  it("coordination.started is published to the conversation when a session opens", async () => {
    useState();
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", planObjectId: MEETUP, idempotencyKey: "ev-1" },
    });
    await settle();
    const started = eventsOfType("coordination.started");
    assert.equal(started.length, 1);
    assert.equal((started[0]!.payload as any).sessionId, r.body.session.sessionId);
    assert.equal((started[0]!.payload as any).startedBy, ALICE);
    assert.equal((started[0]!.payload as any).planObjectId, MEETUP);
    assert.equal(
      (started[0]!.payload as any).eventKey,
      `coordination.started:${r.body.session.sessionId}`,
      "§13.3 asks consumers to be idempotent; they need a key to be idempotent ON",
    );
    // The AUDIENCE is the conversation, opener included. A session event that
    // excluded the actor would leave the one device that is certainly showing
    // the panel without the fact that opened it.
    assert.deepEqual(recipientsOf("coordination.started"), [ALICE, BOB].sort());
    assert.equal(
      Object.prototype.hasOwnProperty.call(started[0]!.payload as any, "note"),
      false,
      "the opener's free-text note is not fanned out",
    );
  });

  it("a RETRY publishes NOTHING — a duplicate command is not a second evening", async () => {
    useState();
    await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "ev-2" },
    });
    await settle();
    deliveries = [];
    await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_SESSION",
      payload: { title: "Dinner run", idempotencyKey: "ev-2" },
    });
    await settle();
    assert.equal(eventsOfType("coordination.started").length, 0);
    assert.equal(eventsOfType("message.created").length, 0, "a retry must not re-announce the message either");
  });

  it("coordination.completed fires on COMPLETE, naming the terminal state", async () => {
    useState({
      extraMessages: [
        sessionMsg("s-1", min(-120), "k"),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-60)),
        transitionMsg("t-2", "s-1", "ACTIVE", min(-30)),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "COMPLETE", idempotencyKey: "done" },
    });
    assert.equal(r.status, 201);
    await settle();
    const done = eventsOfType("coordination.completed");
    assert.equal(done.length, 1);
    assert.equal((done[0]!.payload as any).terminalState, "COMPLETE");
    assert.equal((done[0]!.payload as any).sessionId, "s-1");
  });

  it("coordination.completed ALSO fires on CANCELLED — §9 has two terminal states and §13.2 names one event", async () => {
    useState({ extraMessages: [sessionMsg("s-1", min(-120), "k")] });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "CANCELLED", reason: "rained off", idempotencyKey: "cx" },
    });
    assert.equal(r.status, 201);
    await settle();
    const done = eventsOfType("coordination.completed");
    assert.equal(done.length, 1, "a cancelled session must not leave every other client's panel open");
    assert.equal((done[0]!.payload as any).terminalState, "CANCELLED");
    assert.equal((done[0]!.payload as any).reason, "rained off");
  });

  it("a NON-terminal transition publishes no completion", async () => {
    useState({ extraMessages: [sessionMsg("s-1", min(-120), "k")] });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ASSEMBLING", idempotencyKey: "go" },
    });
    assert.equal(r.status, 201);
    await settle();
    assert.equal(eventsOfType("coordination.completed").length, 0);
  });

  it("a REFUSED transition publishes no completion", async () => {
    // PREPARING -> COMPLETE is not an arrow §9 has. An event emitted from the
    // request rather than from the accepted arrow would fire here.
    useState({ extraMessages: [sessionMsg("s-1", min(-120), "k")] });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "COMPLETE", idempotencyKey: "nope" },
    });
    assert.equal(r.status, 400);
    await settle();
    assert.equal(eventsOfType("coordination.completed").length, 0);
  });
});

/* ──────────────────── version conflict and transition retries ─────────────── */

describe("§9 — a stale client does not silently win", () => {
  it("a stale expectedVersion is a 409 that names both numbers", async () => {
    useState({
      extraMessages: [
        sessionMsg("s-1", min(-120), "k"),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-60)),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ACTIVE", expectedVersion: 0, idempotencyKey: "stale" },
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "TELEGRAPH_COORDINATION_VERSION_CONFLICT");
    assert.equal(r.body.currentVersion, 1);
    assert.equal(r.body.expectedVersion, 0);
    assert.equal(r.body.state, "ASSEMBLING");
  });

  it("a matching expectedVersion is accepted", async () => {
    useState({
      extraMessages: [
        sessionMsg("s-1", min(-120), "k"),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-60)),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ACTIVE", expectedVersion: 1, idempotencyKey: "fresh" },
    });
    assert.equal(r.status, 201);
  });

  it("NO expectedVersion still works — the check is opt-in, not a new requirement", async () => {
    useState({ extraMessages: [sessionMsg("s-1", min(-120), "k")] });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ASSEMBLING" },
    });
    assert.equal(r.status, 201);
  });

  it("version counts APPLIED arrows, not rows — a refused one does not make a client stale", () => {
    const session = { id: "s-1", sender_id: ALICE, created_at: min(-120), payload: { title: "D" } };
    const transitions = [
      { id: "t-1", sender_id: ALICE, created_at: min(-60), payload: { sessionId: "s-1", to: "ASSEMBLING" } },
      // PREPARING is gone; ASSEMBLING -> RETURNING is not an arrow §9 has.
      { id: "t-2", sender_id: BOB, created_at: min(-50), payload: { sessionId: "s-1", to: "RETURNING" } },
    ];
    const s = projectCoordinationSession(session as any, transitions as any, null);
    assert.equal(s.version, 1);
    assert.equal(s.transitions.length, 2, "the refused arrow is still RECORDED");
    assert.equal(s.transitions[1]!.applied, false);
  });

  it("a RETRIED transition is answered 200 duplicate, and the version does not move", async () => {
    useState({
      extraMessages: [
        sessionMsg("s-1", min(-120), "k"),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-60), "same-tap"),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ASSEMBLING", idempotencyKey: "same-tap" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
    assert.equal(r.body.version, 1);
    assert.equal(r.body.state, "ASSEMBLING");
  });

  it("a retried TERMINAL transition is a duplicate and not 'this session is COMPLETE'", async () => {
    // The order of the two gates is the whole test. Checked after the legality
    // gate, this would be refused as an illegal arrow from a terminal state —
    // telling a client its own successful command had failed.
    useState({
      extraMessages: [
        sessionMsg("s-1", min(-200), "k"),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-120)),
        transitionMsg("t-2", "s-1", "ACTIVE", min(-90)),
        transitionMsg("t-3", "s-1", "COMPLETE", min(-30), "finish"),
      ],
    });
    const r = await post(`/threads/${THREAD}/coordination`, ALICE, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "COMPLETE", idempotencyKey: "finish" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
  });

  it("two rows with one transition key apply ONCE, and the second is marked a duplicate not an illegal arrow", () => {
    const session = { id: "s-1", sender_id: ALICE, created_at: min(-120), payload: { title: "D" } };
    const transitions = [
      { id: "t-1", sender_id: ALICE, created_at: min(-60), payload: { sessionId: "s-1", to: "ASSEMBLING", idempotencyKey: "tap" } },
      { id: "t-2", sender_id: ALICE, created_at: min(-59), payload: { sessionId: "s-1", to: "ASSEMBLING", idempotencyKey: "tap" } },
    ];
    const s = projectCoordinationSession(session as any, transitions as any, null);
    assert.equal(s.version, 1, "one tap, one move");
    assert.equal(s.transitions[1]!.applied, false);
    assert.equal(s.transitions[1]!.duplicateOfKey, "tap");
  });
});

/* ─────────────────────── membership changes mid-session ───────────────────── */

describe("§14.2 — membership can change after a message was created", () => {
  it("a member who LEFT stops counting as ARRIVED", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
        { thread_id: THREAD, user_id: BOB, left_at: min(-5), visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [
        quickMsg("q-1", ALICE, "ARRIVED", min(-30)),
        quickMsg("q-2", BOB, "ARRIVED", min(-25)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.rosterKnown, true);
    assert.equal(r.body.coordination.arrivedCount, 1, "somebody who walked out is not at the table");
    assert.deepEqual(r.body.coordination.quickStates.map((q: any) => q.userId), [ALICE]);
  });

  it("the session a departed member STARTED survives — §9 has no arrow for somebody leaving", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
        { thread_id: THREAD, user_id: BOB, left_at: min(-5), visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [
        sessionMsg("s-1", min(-120), "k", BOB),
        transitionMsg("t-1", "s-1", "ASSEMBLING", min(-60), null, BOB),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    const s = r.body.coordination.session;
    assert.ok(s, "one person leaving must not cancel the evening for everybody else");
    assert.equal(s.startedBy, BOB);
    assert.equal(s.state, "ASSEMBLING");
    assert.equal(s.endedAt, null);
    assert.equal(s.transitions.length, 1, "their declaration about the SESSION stays in the record");
  });

  it("a member who left may not post a transition", async () => {
    useState({
      members: [
        { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null, last_read_at: null },
        { thread_id: THREAD, user_id: BOB, left_at: min(-5), visible_from_at: null, last_read_at: null },
      ],
      extraMessages: [sessionMsg("s-1", min(-120), "k")],
    });
    const r = await post(`/threads/${THREAD}/coordination`, BOB, {
      kind: "COORDINATION_TRANSITION",
      payload: { sessionId: "s-1", to: "ASSEMBLING", idempotencyKey: "x" },
    });
    assert.ok(r.status === 403 || r.status === 404, `expected a refusal, got ${r.status}`);
  });

  it("an UNREADABLE roster reports rosterKnown:false and filters NOTHING", async () => {
    // Both wrong answers are available here and both are worse. Treating the
    // failure as "nobody is active" empties the arrival counts on a database
    // blip; presenting the unfiltered list as verified is a claim nothing
    // checked. It returns the unfiltered list and says it is unverified.
    useState({
      rosterError: true,
      extraMessages: [
        quickMsg("q-1", ALICE, "ARRIVED", min(-30)),
        quickMsg("q-2", BOB, "ARRIVED", min(-25)),
      ],
    });
    const r = await get(`/threads/${THREAD}/coordination`, ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.coordination.rosterKnown, false);
    assert.equal(r.body.coordination.arrivedCount, 2);
  });

  it("latestQuickStates with a null roster is the unfiltered list, by contract", () => {
    const rows = [
      { sender_id: ALICE, created_at: min(-30), payload: { state: "ARRIVED" } },
      { sender_id: BOB, created_at: min(-25), payload: { state: "ARRIVED" } },
    ];
    assert.equal(latestQuickStates(rows as any, null).length, 2);
    assert.equal(latestQuickStates(rows as any, new Set([ALICE])).length, 1);
    assert.equal(latestQuickStates(rows as any, new Set<string>()).length, 0);
  });
});
