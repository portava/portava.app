/**
 * Wave 5 follow-up B2 — a freed event seat goes to the waitlist queue, never to
 * a walk-in ahead of it, on every path.
 *
 * The design the code already stated: a seat freed on a full / waitlisted event
 * is RESERVED for the queue (an active offer holds it, and syncEventState only
 * reopens the event to walk-ins when no offer does). Four gaps broke it:
 *
 *   1. Only three doors (DELETE /rsvp, POST /leave, DELETE /attendees) offered
 *      a freed seat. A going → maybe RSVP, PATCH attendee status, a ban,
 *      block-user, an offer holder leaving the queue and a host raising the
 *      capacity freed a seat and offered it to nobody: syncEventState reopened
 *      the event and the first walk-in took it. A seat HELD on an unreadable
 *      flag went the same way on the next readable pass.
 *   2. With the flag ON, a promotion whose eligibility read or offer write
 *      failed returned a failure outcome, and the caller then reopened the
 *      event: a failed read or write became "the seat goes to the public".
 *   3. The sweeper (lib/eventWaitlistSweeper.ts), promoting after an offer
 *      lapses, told nobody, and ignored events_waitlist_enabled.
 *   4. DELETE /events/:id/attendees/:userId promoted even when the removed
 *      person was not going — an offer for a seat that did not exist.
 *
 * THE DOUBLE. failClosedSupabase RECORDS writes and does not apply them: a read
 * after a write still sees the seed. So each world is seeded in the state that
 * holds AFTER the route's own write (the seat already free: going 1 of 10 on a
 * `waitlist`-state event, W1 then W2 queued, no offer), exactly as the held-seat
 * suite does. "Offered" means an event_waitlist UPDATE setting a non-null
 * offer_expires_at; "reopened" means an events UPDATE writing state "open".
 *
 * FAIL cases were RED on the pre-fix tree (ab482a1c6, events.ts 7253 lines);
 * CONTROL cases pin answers that must not move.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestFetch } from "../lib/push.js";
import { logger } from "../lib/logger.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import { runSweep, _resetStatus } from "../lib/eventWaitlistSweeper.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./helpers/failClosedSupabase.js";

const HOST   = "22222222-2222-4222-8222-222222222222";
const VIEWER = "11111111-1111-4111-8111-111111111111";
const W1     = "33333333-3333-4333-8333-333333333333";
const W2     = "44444444-4444-4444-8444-444444444444";
const GONE   = "55555555-5555-4555-8555-555555555555";
const EVENT  = "66666666-6666-4666-8666-666666666666";
const OTHER  = "77777777-7777-4777-8777-777777777777";
const INTO   = "88888888-8888-4888-8888-888888888888";
const TOKENS: Record<string, string> = { "t-host": HOST, "t-viewer": VIEWER, "t-w1": W1, "t-into": INTO };
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST   = "2001-01-01T00:00:00.000Z";

type FlagMode = "on" | "off" | "absent" | "unreadable";

interface WorldOpts {
  flag?: FlagMode;
  ev?: Record<string, any>;
  rsvps?: Record<string, any>[];
  waitlist?: Record<string, any>[];
  /** Users holding a `banned` event_roles row (a READABLE refusal by the eligibility gate). */
  banned?: string[];
  /** The offer claim (event_waitlist UPDATE … IS NULL … .select()) matches nobody: another writer got there first. */
  claimLoses?: boolean;
  /** Only the event_waitlist DELETE resolves an error (the ban's queue-row removal), every other write succeeds. */
  wlDeleteFails?: boolean;
  failOn?: (c: FakeReadContext) => any;
  failWritesOn?: (t: string) => any;
}

interface WriteRec { table: string; kind: string; payload: any; filters: Array<[string, string, unknown]> }

function eventRow(over: Record<string, any> = {}) {
  return {
    id: EVENT, host_id: HOST, title: "Rooftop quiz", state: "waitlist", rsvp_closed: false, visibility: "public", city: "Lisbon",
    verified_only: false, trust_score_min: null, age_min: null, age_max: null,
    capacity: 10, max_attendees: 10, going_count: 1, waitlist_enabled: true, waitlist_count: 2,
    chat_enabled: false, chat_thread_id: null, price_type: "free", price_url: null, ticket_url: null,
    starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const queueRow = (u: string, position: number, offer: string | null = null) => ({ event_id: EVENT, user_id: u, position, offer_expires_at: offer });
const flagIsWaitlist = (c: FakeReadContext) => c.table === "feature_flags" && c.eq("flag") === "events_waitlist_enabled";
/** checkEventEligibility's ban read for one user — failing it makes that user's eligibility UNREADABLE. */
const banReadFailsFor = (u: string) => (c: FakeReadContext) => (c.table === "event_roles" && c.eq("role") === "banned" && c.eq("user_id") === u ? ERR : null);

function world(o: WorldOpts = {}): { client: any; writes: WriteRec[]; setFlag: (m: FlagMode) => void } {
  let mode: FlagMode = o.flag ?? "on";
  const baseFlags = [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }, { flag: "push_notifications_enabled", enabled: true }];
  const people = [HOST, VIEWER, W1, W2, GONE, OTHER, INTO];
  const rows: Record<string, Record<string, any>[]> = {
    feature_flags: [],
    events: [eventRow(o.ev)],
    event_roles: (o.banned ?? []).map((u) => ({ event_id: EVENT, user_id: u, role: "banned" })), blocks: [], event_reports: [], event_attendee_states: [], identity_verifications: [],
    event_rsvps: o.rsvps ?? [{ event_id: EVENT, user_id: OTHER, status: "going" }],
    event_waitlist: o.waitlist ?? [queueRow(W1, 1), queueRow(W2, 2)],
    profiles: people.map((id) => ({ id, handle: `h${id.slice(0, 4)}`, name: "N", date_of_birth: "1990-06-15", location_country: "US", verified: true, expo_push_token: null })),
  };
  const setFlag = (m: FlagMode) => {
    mode = m;
    rows.feature_flags = [...baseFlags];
    if (m === "on" || m === "unreadable") rows.feature_flags.push({ flag: "events_waitlist_enabled", enabled: true });
    if (m === "off") rows.feature_flags.push({ flag: "events_waitlist_enabled", enabled: false });
  };
  setFlag(mode);
  const spec: FakeClientSpec = {
    users: TOKENS, rows,
    // An unreadable flag is the flag row's read resolving `{ data: null, error }` — the way supabase-js fails.
    failOn: (c) => (mode === "unreadable" && flagIsWaitlist(c) ? ERR : (o.failOn?.(c) ?? null)),
    failWritesOn: o.failWritesOn, inserted: {}, updated: {},
  };
  const client = makeFailClosedClient(spec);
  const writes: WriteRec[] = [];
  const from = client.from.bind(client);
  client.from = (table: string) => {
    const b = from(table);
    if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val);
    if (table === "blocks") b.or = (expr: string) => { const ids = [...new Set([...expr.matchAll(/blocker_id\.eq\.([0-9a-f-]+)/g)].map((m) => m[1]))]; b.in("blocker_id", ids); b.in("blocked_id", ids); return b; };
    let rec: WriteRec | null = null;
    if (table === "event_waitlist" && (o.claimLoses || o.wlDeleteFails)) {
      const then = b.then;
      b.then = (f: any, r: any) => (o.claimLoses && rec && rec.kind === "update" && rec.payload?.offer_expires_at ? Promise.resolve({ data: [], error: null, count: null }).then(f, r)
        : o.wlDeleteFails && rec && rec.kind === "delete" ? Promise.resolve({ data: null, error: ERR, count: null }).then(f, r) : then(f, r));
    }
    for (const kind of ["insert", "upsert", "update", "delete"]) {
      const orig = b[kind];
      b[kind] = (p?: any, opts?: any) => { rec = { table, kind, payload: p ?? null, filters: [] }; writes.push(rec); return orig(p, opts); };
    }
    for (const op of ["eq", "in", "is"]) {
      const orig = b[op];
      b[op] = (col: string, val: unknown) => { if (rec) rec.filters.push([op, col, val]); return orig(col, val); };
    }
    return b;
  };
  _setTestClient(client, true); _setTestServiceClient(client);
  return { client, writes, setFlag };
}

/** User ids handed a waitlist offer (an UPDATE of offer_expires_at to a non-null value), in order. */
function offeredTo(writes: WriteRec[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.table !== "event_waitlist" || w.kind !== "update" || !w.payload?.offer_expires_at) continue;
    for (const [op, col, val] of w.filters) {
      if (col !== "user_id") continue;
      if (op === "eq") out.push(val as string);
      if (op === "in") out.push(...(val as string[]));
    }
  }
  return out;
}
const offerExpiry = (writes: WriteRec[]) => writes.find((w) => w.table === "event_waitlist" && w.kind === "update" && w.payload?.offer_expires_at)?.payload.offer_expires_at;
const stateWrites = (w: WriteRec[]) => w.filter((x) => x.table === "events" && x.kind === "update" && x.payload?.state !== undefined).map((x) => x.payload.state);
const inAppRows = (w: WriteRec[]) => w.filter((x) => x.table === "notifications" && x.kind === "insert").map((x) => x.payload);
const waitlistDeletes = (w: WriteRec[]) => w.filter((x) => x.table === "event_waitlist" && x.kind === "delete");

type LogLine = { level: string; obj: any; msg: string };
const reqLog: LogLine[] = [];
const modLog: LogLine[] = [];
const said = (lines: LogLine[], level: string, needle: RegExp) => lines.some((l) => l.level === level && needle.test(`${l.msg} ${JSON.stringify(l.obj ?? {})}`));
const pushes: any[][] = [];

describe("wave 5 follow-up B2 — a freed seat goes to the queue, never to a walk-in ahead of it", () => {
  let url = ""; let server: http.Server;
  const origWarn = logger.warn;
  before(async () => {
    const mod = await import("../routes/events.js");
    const app = express(); app.use(express.json());
    app.use((req: any, _r: unknown, n: () => void) => {
      const rec = (level: string) => (obj: any, msg?: string) => { reqLog.push({ level, obj, msg: msg ?? (typeof obj === "string" ? obj : "") }); };
      req.log = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug() {}, child() { return req.log; } }; n();
    });
    app.use(mod.default);
    app.use(globalErrorHandler);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); _setTestFetch(null); (logger as any).warn = origWarn; });
  beforeEach(() => {
    reqLog.length = 0; modLog.length = 0; pushes.length = 0; _resetStatus();
    (logger as any).warn = (obj: any, msg?: string) => { modLog.push({ level: "warn", obj, msg: msg ?? (typeof obj === "string" ? obj : "") }); };
    _setTestFetch((async (_u: any, init: any) => {
      const msgs = JSON.parse(String(init?.body ?? "[]")); pushes.push(msgs);
      return new Response(JSON.stringify({ data: msgs.map(() => ({ status: "ok", id: "t" })) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any);
  });
  afterEach(() => { (logger as any).warn = origWarn; });

  const req = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  };

  // ── 1. Every path that frees a seat offers it to the queue ───────────────────
  // Each frees VIEWER's seat (the seed already shows it free: OTHER going, 1 of 10) on a `waitlist` event.
  // The last two did not run the state sync at all before this change.
  const PATHS: Array<[string, () => Promise<{ status: number; text: string }>, boolean]> = [
    ["POST /rsvp going → maybe",           () => req("t-viewer", "POST", `/events/${EVENT}/rsvp`, { status: "maybe" }), true],
    ["PATCH /attendees/:userId/status",    () => req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" }), true],
    ["POST /roles ban",                    () => req("t-host", "POST", `/events/${EVENT}/roles`, { userId: VIEWER, role: "banned" }), true],
    ["POST /block-user",                   () => req("t-host", "POST", `/events/${EVENT}/block-user/${VIEWER}`, {}), true],
    ["DELETE /waitlist (offer holder)",    () => req("t-viewer", "DELETE", `/events/${EVENT}/waitlist`), false],
    ["PATCH /events/:id capacity raised",  () => req("t-host", "PATCH", `/events/${EVENT}`, { maxAttendees: 10 }), false],
  ];
  for (const [path, call, syncedBefore] of PATHS) {
    it(`FQ1 ${path}: flag ON → the freed seat is OFFERED to the head of the queue (and told), and the event is NOT reopened to walk-ins`, async () => {
      const w = world({ flag: "on" }); const r = await call();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(offeredTo(w.writes), [W1], `the freed seat was not offered to the queue: ${JSON.stringify(offeredTo(w.writes))}`);
      assert.ok(!stateWrites(w.writes).includes("open"), `the seat went to walk-ins: ${JSON.stringify(stateWrites(w.writes))}`);
      assert.deepEqual(inAppRows(w.writes).map((x) => x.user_id), [W1], "the promoted person is told");
    });
    it(`FQ2 ${path}: flag UNREADABLE → nobody offered, the seat is HELD (no state write), logged at warn`, async () => {
      const w = world({ flag: "unreadable" }); const r = await call();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(offeredTo(w.writes), []);
      assert.deepEqual(stateWrites(w.writes), [], `an unreadable flag reopened the event: ${JSON.stringify(stateWrites(w.writes))}`);
      assert.ok(said(modLog, "warn", /HELD/) && said(modLog, "warn", /events_waitlist_enabled/), `the held seat is not logged: ${JSON.stringify(modLog)}`);
    });
    it(`FQ0-off ${path} ${syncedBefore ? "CONTROL" : "(the route now syncs)"}: flag OFF → nobody offered, reopened to open exactly as the other routes do`, async () => {
      const w = world({ flag: "off" }); const r = await call();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"]);
      assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
    });
  }
  it("FQ0-absent CONTROL: the flag row ABSENT is disabled, not unknown → reopened, nobody offered, nothing held", async () => {
    const w = world({ flag: "absent" }); const r = await PATHS[1][1]();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"]);
    assert.ok(!said(modLog, "warn", /HELD|events_waitlist_enabled/), JSON.stringify(modLog));
  });
  it("FQ0-empty CONTROL: flag ON and the queue EMPTY → reopened to open as today; nobody is told anything", async () => {
    const w = world({ flag: "on", waitlist: [] }); const r = await PATHS[0][1]();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"]);
    assert.deepEqual(inAppRows(w.writes), []); assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
  });
  it("FQ0-ineligible CONTROL: flag ON and the only queued user is BANNED (a readable refusal) → stranded, reopened as today, not held", async () => {
    const w = world({ flag: "on", waitlist: [queueRow(W1, 1)], banned: [W1] });
    const r = await req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"]);
    assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
  });

  // ── 1b. A held seat is released to the QUEUE, never to walk-ins ──────────────
  it("FQ3 held, then released: an unreadable flag holds the seat; the next readable pass offers it to W1 — it is never reopened", async () => {
    const w = world({ flag: "unreadable" });
    const r1 = await req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" });
    assert.equal(r1.status, 200, r1.text);
    assert.deepEqual(stateWrites(w.writes), [], "first pass: held");
    w.setFlag("on");
    const r2 = await req("t-into", "POST", `/events/${EVENT}/rsvp`, { status: "interested" });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(offeredTo(w.writes), [W1], "the held seat went to the head of the queue");
    assert.ok(!stateWrites(w.writes).includes("open"), `the held seat went to walk-ins: ${JSON.stringify(stateWrites(w.writes))}`);
  });
  it("FQ4 CONTROL one offer at a time: W1 already HOLDS a live offer → a sync offers nobody else and writes no state", async () => {
    const w = world({ flag: "on", waitlist: [queueRow(W1, 1, FUTURE), queueRow(W2, 2)] });
    const r = await req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(offeredTo(w.writes), [], "never two offers for one seat");
    assert.deepEqual(stateWrites(w.writes), []);
  });
  it("FQ5 CONTROL a door's own offer is not repeated by its state sync: DELETE /rsvp offers W1 exactly once, one notice", async () => {
    const w = world({ flag: "on", rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }] });
    const r = await req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), [W1]);
    assert.equal(inAppRows(w.writes).length, 1);
  });
  it("FB1 (guards the new catch-up) a ban whose queue-row DELETE fails → 503, and the sync offers the seat to NOBODY — not the banned user still at the head of the queue, whose ban is written only after the sync", async () => {
    const w = world({ flag: "on", waitlist: [queueRow(VIEWER, 1), queueRow(W1, 2)], wlDeleteFails: true });
    const r = await req("t-host", "POST", `/events/${EVENT}/roles`, { userId: VIEWER, role: "banned" });
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.deepEqual(offeredTo(w.writes), [], `the seat was offered on a pass whose ban had not removed the banned user's queue row: ${JSON.stringify(offeredTo(w.writes))}`);
    assert.deepEqual(stateWrites(w.writes), [], "held, not reopened");
  });
  it("FQ6 CONTROL a CONTENDED claim on the sync's offer is not a failure: nothing held, nothing announced", async () => {
    const w = world({ flag: "on", claimLoses: true });
    const r = await req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" });
    assert.equal(r.status, 200, r.text);
    assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
    assert.deepEqual(inAppRows(w.writes), []); assert.equal(pushes.length, 0);
  });

  // ── 2. Flag ON, a FAILED promotion holds the seat ───────────────────────────
  const DOORS: Array<[string, () => Promise<{ status: number; text: string }>]> = [
    ["DELETE /rsvp",      () => req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`)],
    ["POST /leave",       () => req("t-viewer", "POST", `/events/${EVENT}/leave`, {})],
    ["DELETE /attendees", () => req("t-host", "DELETE", `/events/${EVENT}/attendees/${VIEWER}`)],
    ["PATCH /attendees/:userId/status (the sync's own offer)", () => req("t-host", "PATCH", `/events/${EVENT}/attendees/${VIEWER}/status`, { status: "cant_go" })],
  ];
  const goingViewer = [{ event_id: EVENT, user_id: VIEWER, status: "going" }];
  for (const [door, call] of DOORS) {
    it(`FP1 ${door}: flag ON, the head's ELIGIBILITY cannot be read → nobody offered, the seat is HELD (not reopened), logged at warn`, async () => {
      const w = world({ flag: "on", rsvps: goingViewer, failOn: banReadFailsFor(W1) }); const r = await call();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(offeredTo(w.writes), []);
      assert.deepEqual(stateWrites(w.writes), [], `a failed eligibility read gave the seat to walk-ins: ${JSON.stringify(stateWrites(w.writes))}`);
      assert.ok(said(modLog, "warn", /HELD/) || said(reqLog, "warn", /HELD/), `the hold is not logged: ${JSON.stringify([...modLog, ...reqLog])}`);
    });
    it(`FP2 ${door}: flag ON, the offer WRITE fails → the seat is HELD, not reopened, logged at warn`, async () => {
      const w = world({ flag: "on", rsvps: goingViewer, failWritesOn: (t) => (t === "event_waitlist" ? ERR : null) }); const r = await call();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(stateWrites(w.writes), [], `a failed offer write gave the seat to walk-ins: ${JSON.stringify(stateWrites(w.writes))}`);
      assert.deepEqual(inAppRows(w.writes), []);
      assert.ok(said(modLog, "warn", /HELD/) || said(reqLog, "warn", /HELD/), `the hold is not logged: ${JSON.stringify([...modLog, ...reqLog])}`);
    });
  }

  // ── 4. DELETE /attendees promotes and holds only for a GOING seat ────────────
  const remove = () => req("t-host", "DELETE", `/events/${EVENT}/attendees/${VIEWER}`);
  const fullWithMaybe = { ev: { max_attendees: 1 }, rsvps: [{ event_id: EVENT, user_id: OTHER, status: "going" }, { event_id: EVENT, user_id: VIEWER, status: "maybe" }] };
  it("FR1 removing a MAYBE from a FULL event frees no seat → nobody is offered (was: W1 offered a seat that does not exist)", async () => {
    const w = world({ flag: "on", ...fullWithMaybe }); const r = await remove();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), [], `an offer for a seat that does not exist: ${JSON.stringify(offeredTo(w.writes))}`);
    assert.deepEqual(inAppRows(w.writes), []);
  });
  it("FR2 removing a MAYBE with the flag UNREADABLE → the flag is not consulted, nothing is held or logged as held", async () => {
    const w = world({ flag: "unreadable", ...fullWithMaybe }); const r = await remove();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), []);
    assert.ok(!said(reqLog, "warn", /events_waitlist_enabled/) && !said(modLog, "warn", /HELD/), `a non-going removal consulted the flag: ${JSON.stringify([...reqLog, ...modLog])}`);
  });
  it("FR3 the removed person's prior RSVP cannot be read → 503 degraded_unavailable, nothing removed, nobody offered (never a default)", async () => {
    const w = world({ flag: "on", rsvps: goingViewer, failOn: (c) => (c.table === "event_rsvps" && c.eq("user_id") === VIEWER ? ERR : null) }); const r = await remove();
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.equal(w.writes.filter((x) => x.table === "event_rsvps" && x.kind === "delete").length, 0, "nothing may be removed on an unread status");
    assert.deepEqual(offeredTo(w.writes), []);
  });
  it("FR0 CONTROL: removing a GOING attendee → the head of the queue is offered (as before)", async () => {
    const w = world({ flag: "on", rsvps: goingViewer }); const r = await remove();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), [W1]);
  });

  // ── 3. The sweeper: a lapsed offer's seat, the flag, and the notice ─────────
  const lapsed = { waitlist: [queueRow(GONE, 1, PAST), queueRow(W1, 2), queueRow(W2, 3)] };
  const sweep = async (o: WorldOpts) => { const w = world(o); const out = await runSweep({ client: w.client }); return { w, out }; };
  it("FS1 flag ON → the lapsed offer is cleared, W1 is offered AND told (an in-app row that expires with the offer, opening the event)", async () => {
    const { w, out } = await sweep({ flag: "on", ...lapsed });
    assert.deepEqual(offeredTo(w.writes), [W1]); assert.equal(out.promoted, 1);
    const rows = inAppRows(w.writes);
    assert.equal(rows.length, 1, `the sweeper's promotion told nobody: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].user_id, W1); assert.equal(rows[0].event_type, "event.waitlist_offer");
    assert.equal(rows[0].action_url, `/event/${EVENT}`); assert.equal(rows[0].expires_at, offerExpiry(w.writes));
  });
  it("FS2 flag ON, the notice cannot be written → the offer STANDS (promoted, one claim), the failure is logged at warn", async () => {
    const { w, out } = await sweep({ flag: "on", ...lapsed, failWritesOn: (t) => (t === "notifications" ? ERR : null) });
    assert.equal(out.promoted, 1); assert.deepEqual(offeredTo(w.writes), [W1]);
    assert.ok(said(modLog, "warn", /in-app notification/), `the lost notice is not logged: ${JSON.stringify(modLog)}`);
  });
  for (const mode of ["off", "absent"] as const) {
    it(`FS3-${mode} flag ${mode.toUpperCase()} → the lapsed offer is still cleared (time decided that), and NOBODY is promoted or told`, async () => {
      const { w, out } = await sweep({ flag: mode, ...lapsed });
      assert.equal(waitlistDeletes(w.writes).length, 1, "the lapsed offer is expired"); assert.equal(out.cleared, 1);
      assert.deepEqual(offeredTo(w.writes), [], `the sweeper promoted with the waitlist ${mode}: ${JSON.stringify(offeredTo(w.writes))}`);
      assert.equal(out.promoted, 0); assert.equal((out as any).held, 1); assert.deepEqual(inAppRows(w.writes), []);
      assert.equal(out.unreadable, 0, "a disabled flag is not a failure");
    });
  }
  it("FS4 flag UNREADABLE → the lapsed offer is cleared, nobody is promoted, the seat is held and the pass is not clean", async () => {
    const { w, out } = await sweep({ flag: "unreadable", ...lapsed });
    assert.equal(waitlistDeletes(w.writes).length, 1); assert.equal(out.cleared, 1);
    assert.deepEqual(offeredTo(w.writes), [], `the sweeper promoted over an unread flag: ${JSON.stringify(offeredTo(w.writes))}`);
    assert.equal((out as any).held, 1); assert.equal(out.unreadable, 1);
  });
  it("FS0 CONTROL: flag ON, nobody else queued → stranded, nobody told", async () => {
    const { w, out } = await sweep({ flag: "on", waitlist: [queueRow(GONE, 1, PAST)] });
    assert.equal(out.stranded, 1); assert.deepEqual(inAppRows(w.writes), []);
  });
});
