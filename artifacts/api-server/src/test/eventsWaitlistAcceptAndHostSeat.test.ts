/**
 * Wave 5 follow-up B3 — the waitlist accept route's three re-offer branches, and
 * host admissions that took a seat the event held for its queue.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventsWaitlistAcceptAndHostSeat.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECTS (B2 handback owner items 4–6; Fable pass 9 §6.5):
 *   1. POST /events/:id/waitlist/accept, "spot filled": the accepter's offer was
 *      nulled and promoteNextWaitlisted called. The accepter KEEPS their queue
 *      position, so the head that call found was usually the accepter: a fresh
 *      offer, a fresh in-app notice and push, and a 403 telling them they had been
 *      "returned to the waitlist queue" — a loop, one lie per turn. A seat that
 *      does not exist was offered.
 *   2. The accept route's expired, visibility-refused and spot-filled branches
 *      called promoteNextWaitlisted directly: events_waitlist_enabled was never
 *      read (OFF still promoted; UNREADABLE still promoted), and an offer was made
 *      whether or not a seat was free.
 *   3. Both join-request approvals admitted on the live going-count only. A seat a
 *      live offer RESERVES, or a seat HELD for the queue, shows as free in that
 *      count, so the host's approval seated the requester in it; the offer holder
 *      was then told "This spot was filled before you accepted". Every other
 *      newcomer door (POST /rsvp, POST /join, invite accept) admits on the
 *      event's state, which stays full / waitlist exactly while a seat is held or
 *      reserved.
 *
 * THE DOUBLE. schemaStrictSupabase (every column checked against the live
 * schema) APPLIES writes to its seed, so a read after a write sees the write —
 * which is what makes the re-offer loop visible: once the accepter's offer is
 * nulled, the queue head is the accepter again. Wrapped (as eventFailedReads
 * does) with `.or()`, `.limit()`, read faults and statement overrides. One
 * correction to the double: `.gt()` compares String(value), and String(null) =
 * "null" sorts above every ISO date, so a queued row with NO offer read as a
 * live offer. PostgreSQL's `NULL > x` is not true; the wrapper adds the
 * `IS NOT NULL` that SQL implies.
 *
 * FAIL cases were RED on the pre-fix tree (events.ts 7322 lines, sha256
 * 9b50543af0e81aef…); CONTROL cases pin answers that must not move.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import { logger } from "../lib/logger.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import { runSweep, _resetStatus } from "../lib/eventWaitlistSweeper.js";
import eventsRouter from "../routes/events.js";
import { makeSchemaStrictClient, type Seed, type Row } from "./helpers/schemaStrictSupabase.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import { projectionKeys, projectRow } from "./helpers/selectProjection.js";

// ── people, event, tokens ─────────────────────────────────────────────────────
const HOST = "d1111111-1111-4111-8111-111111111101";
const A1   = "d1111111-1111-4111-8111-111111111102"; // going
const A2   = "d1111111-1111-4111-8111-111111111103"; // going (fills the event when present)
const W1   = "d1111111-1111-4111-8111-111111111104"; // queue position 1
const W2   = "d1111111-1111-4111-8111-111111111105"; // queue position 2
const W3   = "d1111111-1111-4111-8111-111111111106"; // queue position 3
const REQ  = "d1111111-1111-4111-8111-111111111107"; // asked to join; the host approves them
const EV   = "e2222222-2222-4222-8222-222222222201";
const JR   = "e2222222-2222-4222-8222-222222222202";
const TOKENS: Record<string, string> = { host: HOST, w1: W1, w2: W2 };
const FAIL = { message: "simulated failure", code: "57014" };
const FUTURE = "2099-01-01T00:00:00.000Z"; // a live offer
const PAST   = "2001-01-01T00:00:00.000Z"; // a lapsed offer
const at = (n: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, n)).toISOString();

type Flag = "on" | "off" | "absent" | "unreadable";
interface WorldOpts {
  flag?: Flag;
  max?: number;
  state?: string;
  visibility?: string;
  waitlistEnabled?: boolean;
  going?: string[];
  /** [user, position, offer_expires_at] */
  queue?: Array<[string, number, string | null]>;
  joinRequest?: boolean;
}

function world(o: WorldOpts = {}): { seed: Seed; flag: Flag } {
  const person = (id: string, handle: string) => ({ id, handle, username: handle, name: handle, display_name: handle, role: "user", account_status: "active", created_at: at(0), expo_push_token: `ExponentPushToken[${handle}]`, verified: true, date_of_birth: "1990-01-01" });
  const flag = o.flag ?? "on";
  const flags = ["events_enabled", "events_chat_enabled", "push_notifications_enabled"].map((f) => ({ flag: f, enabled: true }));
  if (flag === "on" || flag === "unreadable") flags.push({ flag: "events_waitlist_enabled", enabled: true });
  if (flag === "off") flags.push({ flag: "events_waitlist_enabled", enabled: false });
  const seed: Seed = {
    profiles: [person(HOST, "host"), person(A1, "a1"), person(A2, "a2"), person(W1, "w1"), person(W2, "w2"), person(W3, "w3"), person(REQ, "req")],
    user_account_states: [], profile_privacy_settings: [], identity_verifications: [], blocks: [], user_friendships: [], user_follows: [],
    compass_user_preferences: [], trust_profiles: [], trust_events: [], notifications: [], admin_access_log: [], moderation_actions: [],
    feature_flags: flags,
    events: [{
      id: EV, host_id: HOST, title: "Rooftop quiz", description: null, state: o.state ?? "waitlist", visibility: o.visibility ?? "public", city: "Lisbon", country: "PT",
      location_name: "Miradouro", location_lat: 38.7, location_lng: -9.1, starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, chat_enabled: false, chat_thread_id: null,
      waitlist_enabled: o.waitlistEnabled ?? true, max_attendees: o.max ?? 2, going_count: (o.going ?? [A1]).length, waitlist_count: (o.queue ?? []).length, avg_rating: null, review_count: 0,
      rsvp_closed: false, verified_only: false, trust_score_min: null, age_min: null, age_max: null, circle_id: null, trip_id: null, attendee_comments_enabled: true,
      show_exact_location: true, price_type: "free", price_url: null, ticket_url: null, featured: false, created_at: at(1), updated_at: at(1),
    }],
    event_roles: [],
    event_rsvps: (o.going ?? [A1]).map((u, i) => ({ event_id: EV, user_id: u, status: "going", created_at: at(2 + i), updated_at: at(2 + i) })),
    event_waitlist: (o.queue ?? [[W1, 1, FUTURE], [W2, 2, null], [W3, 3, null]]).map(([u, p, offer], i) => ({ event_id: EV, user_id: u, position: p, offer_expires_at: offer, created_at: at(10 + i) })),
    event_join_requests: o.joinRequest ? [{ id: JR, event_id: EV, user_id: REQ, status: "pending", message: null, created_at: at(20) }] : [],
    event_attendees: [], event_activity_log: [], event_invites: [], event_cohosts: [], event_reports: [], event_attendee_states: [],
  };
  return { seed, flag };
}

// ── the double ────────────────────────────────────────────────────────────────
type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };
/** Replace one statement's answer (writes included); null/undefined = run it for real. */
type Override = (calls: Call[]) => Answer | null | undefined;

const isWrite = (calls: Call[]) => calls.some(([m]) => m === "update" || m === "insert" || m === "upsert" || m === "delete");
const has = (calls: Call[], m: string, ...args: unknown[]) => calls.some(([n, a]) => n === m && args.every((x, i) => JSON.stringify(a[i]) === JSON.stringify(x)));
const updateBody = (calls: Call[]) => (calls.find(([m]) => m === "update")?.[1]?.[0] ?? null) as Record<string, unknown> | null;
const isWaitlistFlagRead = (calls: Call[]) => has(calls, "eq", "flag", "events_waitlist_enabled");
const isGoingCount = (calls: Call[]) => has(calls, "select", "user_id") && has(calls, "eq", "status", "going") && !isWrite(calls);

function install(w: { seed: Seed; flag: Flag }, o: { overrides?: Record<string, Override> } = {}) {
  const { seed } = w;
  const strict = makeSchemaStrictClient(seed);
  const statements: Array<{ table: string; calls: Call[] }> = [];
  const from = (table: string) => {
    const b = strict.from(table);
    const st = { table, calls: [] as Call[] };
    statements.push(st);
    const calls = st.calls;
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "ilike", "like", "update", "upsert", "insert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    // SQL: NULL > x is not true. The double compares String(null) = "null", which sorts above every ISO date.
    const gt = b.gt; const not = b.not;
    b.gt = (col: string, v: unknown) => { gt(col, v); not(col, "is", null); return b; };
    let orPred: ((r: Row) => boolean) | null = null;
    let lim: number | null = null;
    const origSelect = b.select;
    b.or = (expr: string) => { calls.push(["or", [expr]]); orPred = orPredicate(expr); origSelect("*"); return b; };
    b.range = () => b;
    b.limit = (n: number) => { calls.push(["limit", [n]]); lim = n; return b; };
    const origThen = b.then;
    const runList = () => new Promise<Answer>((res, rej) => origThen(res, rej));
    const post = (a: Answer): Answer => {
      if (!Array.isArray(a?.data) || isWrite(calls)) return a;
      let rows = a.data as Row[];
      if (orPred) { rows = rows.filter(orPred); const keys = projectionKeys(String(calls.find(([m]) => m === "select")?.[1]?.[0] ?? "")); if (keys) rows = rows.map((r) => projectRow(r, keys) as Row); }
      if (lim !== null) rows = rows.slice(0, lim);
      return { ...a, data: rows };
    };
    const exec = async (kind: "list" | "maybe" | "single"): Promise<Answer> => {
      if (w.flag === "unreadable" && table === "feature_flags" && isWaitlistFlagRead(calls)) return { data: null, error: FAIL, count: null };
      const ov = o.overrides?.[table]?.(calls);
      if (ov) return ov;
      const a = post(await runList());
      if (kind === "list" || a.error || a.data === null) return kind === "list" ? a : { data: a.data, error: a.error };
      const rows = a.data as Row[];
      if (kind === "maybe") return rows.length > 1 ? { data: null, error: { code: "PGRST116", message: "multiple rows" } } : { data: rows[0] ?? null, error: null };
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `${rows.length} rows` } };
    };
    b.then = (onF: any, onR: any) => exec("list").then(onF, onR);
    b.maybeSingle = () => exec("maybe");
    b.single = () => exec("single");
    return b;
  };
  const client = {
    from,
    rpc: () => Promise.resolve({ data: null, error: { message: "no rpc in this double" } }),
    auth: { getUser: async (token: string) => (TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "bad token", status: 401 } }) },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { seed, strict, statements, client };
}
type Rig = ReturnType<typeof install>;

// ── what happened ─────────────────────────────────────────────────────────────
const queueRows = (s: Seed) => (s.event_waitlist ?? []).filter((r) => r.event_id === EV).sort((a, b) => Number(a.position) - Number(b.position));
const queueRow = (s: Seed, u: string) => queueRows(s).find((r) => r.user_id === u) ?? null;
/** Users holding an offer that has not lapsed. */
const liveOffers = (s: Seed) => queueRows(s).filter((r) => r.offer_expires_at != null && String(r.offer_expires_at) > new Date().toISOString()).map((r) => r.user_id);
/** Users handed a NEW offer by this request (an offer UPDATE with a non-null expiry that matched their row). */
function offeredTo(d: Rig): string[] {
  const out: string[] = [];
  for (const st of d.statements) {
    if (st.table !== "event_waitlist") continue;
    const body = updateBody(st.calls);
    if (!body || body.offer_expires_at == null) continue;
    const u = st.calls.find(([m, a]) => m === "eq" && a[0] === "user_id")?.[1]?.[1];
    if (typeof u === "string" && queueRow(d.seed, u)?.offer_expires_at === body.offer_expires_at) out.push(u);
  }
  return out;
}
const noticesTo = (d: Rig) => d.strict.writes.filter((x) => x.table === "notifications" && x.op === "insert").map((x) => x.rows[0]?.user_id);
const stateWrites = (d: Rig) => d.strict.writes.filter((x) => x.table === "events" && x.op === "update" && x.rows[0]?.state !== undefined).map((x) => x.rows[0].state);
const goingIds = (s: Seed) => (s.event_rsvps ?? []).filter((r) => r.event_id === EV && r.status === "going").map((r) => r.user_id);
const flagReads = (d: Rig) => d.statements.filter((st) => st.table === "feature_flags" && isWaitlistFlagRead(st.calls)).length;

// ── the server, the logs, the pushes ──────────────────────────────────────────
let server: http.Server;
let base = "";
const logs: Array<{ level: string; msg: string; obj: unknown }> = [];
const pushes: unknown[] = [];
const origLogger = { warn: logger.warn, error: logger.error, info: logger.info };
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const cap = (level: string) => (o: unknown, m?: string) => { logs.push({ level, msg: String(m ?? o), obj: o }); };
    req.log = { error: cap("error"), warn: cap("warn"), info: cap("info"), debug() {}, child() { return req.log; } };
    next();
  });
  app.use(eventsRouter);
  app.use(globalErrorHandler);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => {
  _resetRateLimit(); _resetStatus();
  logs.length = 0; pushes.length = 0;
  (logger as any).warn = (o: unknown, m?: string) => { logs.push({ level: "warn", msg: String(m ?? o), obj: o }); };
  (logger as any).error = (o: unknown, m?: string) => { logs.push({ level: "error", msg: String(m ?? o), obj: o }); };
  (logger as any).info = (o: unknown, m?: string) => { logs.push({ level: "info", msg: String(m ?? o), obj: o }); };
  _setTestFetch((async (_u: any, init: any) => { const msgs = JSON.parse(String(init?.body ?? "[]")); pushes.push(msgs); return new Response(JSON.stringify({ data: (msgs as any[]).map(() => ({ status: "ok", id: "t" })) }), { status: 200, headers: { "content-type": "application/json" } }); }) as any);
});
afterEach(() => { _setTestFetch(null); (logger as any).warn = origLogger.warn; (logger as any).error = origLogger.error; (logger as any).info = origLogger.info; });

async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
/** Fire-and-forget work the route started after answering. */
const settle = () => new Promise((r) => setTimeout(r, 40));
const said = (level: string, re: RegExp) => logs.some((l) => l.level === level && re.test(`${l.msg} ${JSON.stringify(l.obj ?? {})}`));
const accept = (token = "w1") => call("POST", `/events/${EV}/waitlist/accept`, token);
const SPOT_FILLED = "This spot was filled before you accepted. You have been returned to the waitlist queue.";
const FLAGS: Flag[] = ["on", "off", "absent", "unreadable"];

// ═════════════════════════════════════════════════════════════════════════════
describe("B3.1 — POST /waitlist/accept, spot filled: the accepter is returned to the queue and told so; no seat that does not exist is offered", () => {
  // The event is full (A1, A2 of 2). W1 holds a live offer for a seat a host admission took.
  const full = { going: [A1, A2] };

  for (const flag of FLAGS) {
    it(`SF1 [${flag}] FAIL: 403 spot filled; W1's offer is withdrawn and their place kept; NOBODY is offered (W1 not re-offered, W2 not offered); no notice, no push`, async () => {
      const d = install(world({ ...full, flag })); const r = await accept(); await settle();
      assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, SPOT_FILLED);
      assert.deepEqual(offeredTo(d), [], `an offer was made for a seat that does not exist: ${JSON.stringify(queueRows(d.seed))}`);
      assert.deepEqual(liveOffers(d.seed), [], "nobody may hold an offer: no seat is free");
      assert.equal(queueRow(d.seed, W1)?.offer_expires_at ?? null, null, "W1's offer is withdrawn");
      assert.equal(queueRow(d.seed, W1)?.position, 1, "W1 keeps their place in the queue");
      assert.deepEqual(noticesTo(d), []); assert.equal(pushes.length, 0);
      assert.deepEqual(goingIds(d.seed).sort(), [A1, A2].sort(), "nobody seated past capacity");
      assert.deepEqual(stateWrites(d), [], "the event is already waitlisted: no transition");
    });
  }

  it("SF2 FAIL: the loop — W1 taps Accept three times: once 'spot filled', then 'no offer pending'; never a fresh offer or notice (the old code re-offered W1 each time)", async () => {
    const d = install(world(full));
    const r1 = await accept(); const r2 = await accept(); const r3 = await accept(); await settle();
    assert.equal(r1.status, 403, r1.raw); assert.equal(r1.body.message, SPOT_FILLED);
    for (const r of [r2, r3]) { assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, "No spot offer is pending for you"); }
    assert.deepEqual(noticesTo(d), [], `W1 was re-offered and re-told: ${JSON.stringify(noticesTo(d))}`);
    assert.equal(pushes.length, 0);
    assert.deepEqual(liveOffers(d.seed), []);
  });

  it("SF3 FAIL: the withdraw write fails → 503 degraded_unavailable that says the spot was filled and does NOT claim they were returned to the queue; their offer stands; nobody else is offered", async () => {
    const d = install(world(full), { overrides: { event_waitlist: (c) => (updateBody(c)?.offer_expires_at === null ? { data: null, error: FAIL } : null) } });
    const r = await accept(); await settle();
    assert.equal(r.status, 503, r.raw); assert.equal(r.body.error, "degraded_unavailable");
    assert.match(r.body.message, /spot was filled/i); assert.doesNotMatch(r.body.message, /returned to the waitlist/i);
    assert.equal(queueRow(d.seed, W1)?.offer_expires_at, FUTURE, "the offer was not withdrawn, and the answer says so");
    assert.deepEqual(offeredTo(d), [], "nobody else is offered a seat that does not exist");
    assert.deepEqual(noticesTo(d), []);
    assert.ok(said("warn", /could not be withdrawn/), JSON.stringify(logs));
  });

  it("SF4 CONTROL: a seat frees between the accept's count and its sync → the sync offers it to the head of the queue (W1, whose place was kept), with a notice", async () => {
    let first = true;
    const d = install(world({ going: [A1] }), { overrides: { event_rsvps: (c) => { if (!isGoingCount(c) || !first) return null; first = false; return { data: [{ user_id: A1 }, { user_id: A2 }], error: null, count: null }; } } });
    const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, SPOT_FILLED);
    assert.deepEqual(offeredTo(d), [W1]); assert.deepEqual(noticesTo(d), [W1]); assert.deepEqual(liveOffers(d.seed), [W1]);
  });

  it("SF5 FAIL: the two-passes race, bounded — W1 and W2 both hold offers for ONE seat; W2 accepts and is seated; W1 is told the spot was filled; nobody else is offered, nobody re-offered, no notice", async () => {
    const d = install(world({ going: [A1], queue: [[W1, 1, FUTURE], [W2, 2, FUTURE], [W3, 3, null]] }));
    const r2 = await accept("w2"); assert.equal(r2.status, 200, r2.raw); assert.deepEqual(r2.body, { status: "going", eventId: EV });
    const r1 = await accept("w1"); await settle();
    assert.equal(r1.status, 403, r1.raw); assert.equal(r1.body.message, SPOT_FILLED);
    assert.deepEqual(goingIds(d.seed).sort(), [A1, W2].sort());
    assert.deepEqual(liveOffers(d.seed), [], `a seat that does not exist is on offer: ${JSON.stringify(queueRows(d.seed))}`);
    assert.deepEqual(offeredTo(d), []); assert.deepEqual(noticesTo(d), []);
    assert.equal(queueRow(d.seed, W1)?.position, 1, "W1 keeps their place");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("B3.2 — the accept route's expired and visibility-refused branches read events_waitlist_enabled, as the doors and the catch-up do", () => {
  // One seat free (A1 of 2), reserved by W1's offer; W2, W3 queued.
  const lapsed = { going: [A1], queue: [[W1, 1, PAST], [W2, 2, null], [W3, 3, null]] as Array<[string, number, string | null]> };

  it("EX-on CONTROL: W1's offer lapsed → 403 expired, W1 removed, W2 offered and told, no reopen", async () => {
    const d = install(world({ ...lapsed, flag: "on" })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, "Your spot offer has expired");
    assert.equal(queueRow(d.seed, W1), null); assert.deepEqual(offeredTo(d), [W2]); assert.deepEqual(noticesTo(d), [W2]);
    assert.ok(!stateWrites(d).includes("open"));
  });
  for (const flag of ["off", "absent"] as Flag[]) {
    it(`EX-${flag} FAIL: the waitlist is off → W1 removed, NOBODY promoted; the event reopens as the doors reopen it with the flag off`, async () => {
      const d = install(world({ ...lapsed, flag })); const r = await accept(); await settle();
      assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, "Your spot offer has expired");
      assert.equal(queueRow(d.seed, W1), null);
      assert.deepEqual(offeredTo(d), [], `promoted with the waitlist ${flag}`); assert.deepEqual(noticesTo(d), []);
      assert.deepEqual(stateWrites(d), ["open"]);
    });
  }
  it("EX-unreadable FAIL: the flag cannot be read → W1 removed, nobody promoted, the seat HELD (no state write), warned naming the flag", async () => {
    const d = install(world({ ...lapsed, flag: "unreadable" })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw);
    assert.equal(queueRow(d.seed, W1), null);
    assert.deepEqual(offeredTo(d), []); assert.deepEqual(stateWrites(d), []);
    assert.ok(said("warn", /events_waitlist_enabled[\s\S]*HELD|HELD[\s\S]*events_waitlist_enabled/), JSON.stringify(logs));
  });
  it("EX-full FAIL: the lapsed offer's seat was taken meanwhile (A1, A2 of 2) → nobody is offered a seat that does not exist", async () => {
    const d = install(world({ ...lapsed, going: [A1, A2] })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(queueRow(d.seed, W1), null);
    assert.deepEqual(offeredTo(d), []); assert.deepEqual(noticesTo(d), []);
  });
  it("EX-delfail FAIL: the lapsed row cannot be removed → nobody is offered here (the sweeper removes it and offers the seat ONCE); the old code offered W2 and the sweeper then offered W3 for the same seat", async () => {
    let failed = false;
    const d = install(world(lapsed), { overrides: { event_waitlist: (c) => { if (failed || !has(c, "delete")) return null; failed = true; return { data: null, error: FAIL }; } } });
    const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, "Your spot offer has expired");
    assert.equal(queueRow(d.seed, W1)?.offer_expires_at, PAST, "the lapsed row is still there");
    assert.deepEqual(offeredTo(d), [], "offered while the lapsed row (which the sweeper will free) still holds its seat");
    assert.ok(said("warn", /lapsed offer could not be removed/), JSON.stringify(logs));
    const pass = await runSweep({ client: d.client }); await settle();
    assert.equal(pass.promoted, 1, JSON.stringify(pass));
    assert.deepEqual(liveOffers(d.seed), [W2], `one seat, one offer: ${JSON.stringify(queueRows(d.seed))}`);
  });

  // The offer reached a user the private-event gate refuses (no approved request): they are removed and the seat released.
  const refused = { visibility: "invite_only", going: [A1] };
  it("VR-on CONTROL: refused at accept → 403 with the gate's message, W1 removed, W2 offered and told", async () => {
    const d = install(world({ ...refused, flag: "on" })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(r.body.message, "This event requires host approval to join");
    assert.equal(queueRow(d.seed, W1), null); assert.deepEqual(offeredTo(d), [W2]); assert.deepEqual(noticesTo(d), [W2]);
  });
  for (const flag of ["off", "absent"] as Flag[]) {
    it(`VR-${flag} FAIL: the waitlist is off → W1 removed, NOBODY promoted, the event reopens`, async () => {
      const d = install(world({ ...refused, flag })); const r = await accept(); await settle();
      assert.equal(r.status, 403, r.raw); assert.equal(queueRow(d.seed, W1), null);
      assert.deepEqual(offeredTo(d), [], `promoted with the waitlist ${flag}`); assert.deepEqual(stateWrites(d), ["open"]);
    });
  }
  it("VR-unreadable FAIL: the flag cannot be read → nobody promoted, the seat HELD, warned", async () => {
    const d = install(world({ ...refused, flag: "unreadable" })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(queueRow(d.seed, W1), null);
    assert.deepEqual(offeredTo(d), []); assert.deepEqual(stateWrites(d), []);
    assert.ok(said("warn", /HELD/), JSON.stringify(logs));
  });
  it("AC0 CONTROL: a healthy accept with a free seat → 200 {status:going}; the flag is not read on the way in", async () => {
    const d = install(world({ going: [A1] })); const r = await accept(); await settle();
    assert.equal(r.status, 200, r.raw); assert.deepEqual(r.body, { status: "going", eventId: EV });
    assert.deepEqual(goingIds(d.seed).sort(), [A1, W1].sort()); assert.equal(queueRow(d.seed, W1), null);
    assert.equal(flagReads(d), 0, "the event is now full: the sync's catch-up does not run, so no flag read");
  });
  it("EX-open FAIL (a CHANGE, stated for the owner — Fable pass 9 §6.4): an OPEN event, W1's offer lapsed → W1 removed, nobody offered (the catch-up runs only on full / waitlist; walk-ins may RSVP to an open event); the old code offered W2", async () => {
    const d = install(world({ ...lapsed, state: "open" })); const r = await accept(); await settle();
    assert.equal(r.status, 403, r.raw); assert.equal(queueRow(d.seed, W1), null);
    assert.deepEqual(offeredTo(d), []); assert.deepEqual(stateWrites(d), []);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe("B3.3 — a host's approval does not take a seat the event holds for its queue (it admits on the state, as /rsvp, /join and invite accept do)", () => {
  const legacy = () => call("PATCH", `/events/${EV}/requests/${REQ}`, "host", { action: "approve" });
  const modern = () => call("POST", `/events/${EV}/join-requests/${JR}/approve`, "host", {});
  const ROUTES: Array<[string, () => Promise<{ status: number; body: any; raw: string }>, string, string]> = [
    ["PATCH /requests/:userId", legacy, '{"ok":true,"action":"approve","status":"waitlisted"}', '{"ok":true,"action":"approve","status":"approved_pending_capacity"}'],
    ["POST /join-requests/:id/approve", modern, '{"ok":true,"status":"waitlisted"}', '{"ok":true,"status":"approved_pending_capacity"}'],
  ];
  for (const [name, approve, waitlisted, pending] of ROUTES) {
    it(`HA1 ${name} FAIL: W1 holds a live offer for the one free seat → the requester is WAITLISTED behind the queue, not seated; W1 then accepts and is seated`, async () => {
      const d = install(world({ going: [A1], joinRequest: true })); const r = await approve(); await settle();
      assert.equal(`${r.status} ${r.raw}`, `200 ${waitlisted}`);
      assert.deepEqual(goingIds(d.seed), [A1], "the host's approval took the seat W1's offer reserves");
      assert.equal(queueRow(d.seed, REQ)?.position, 4, "the requester joins the BACK of the queue");
      assert.equal(queueRow(d.seed, W1)?.offer_expires_at, FUTURE, "W1's offer is untouched");
      const a = await accept(); await settle();
      assert.equal(a.status, 200, `W1 was told the spot was filled: ${a.raw}`); assert.deepEqual(goingIds(d.seed).sort(), [A1, W1].sort());
    });
    it(`HA2 ${name} FAIL: the free seat is HELD for the queue (no offer: the flag was unreadable, or the offer failed) → the requester is waitlisted, not seated`, async () => {
      const d = install(world({ going: [A1], joinRequest: true, queue: [[W1, 1, null], [W2, 2, null]] })); const r = await approve(); await settle();
      assert.equal(`${r.status} ${r.raw}`, `200 ${waitlisted}`);
      assert.deepEqual(goingIds(d.seed), [A1]); assert.equal(queueRow(d.seed, REQ)?.position, 3);
    });
    it(`HA3 ${name} FAIL: the event's waitlist is disabled and its one free seat is reserved by an offer (state full) → approved_pending_capacity, nobody seated`, async () => {
      const d = install(world({ going: [A1], joinRequest: true, state: "full", waitlistEnabled: false })); const r = await approve(); await settle();
      assert.equal(`${r.status} ${r.raw}`, `200 ${pending}`);
      assert.deepEqual(goingIds(d.seed), [A1]); assert.equal(queueRow(d.seed, REQ), null);
    });
    it(`HA0 ${name} CONTROL: an OPEN event with room → the requester is seated, the body byte-identical to the pre-fix tree`, async () => {
      const d = install(world({ going: [A1], joinRequest: true, state: "open", queue: [] })); const r = await approve(); await settle();
      assert.equal(`${r.status} ${r.raw}`, name.startsWith("PATCH") ? '200 {"ok":true,"action":"approve"}' : '200 {"ok":true,"status":"approved"}');
      assert.deepEqual(goingIds(d.seed).sort(), [A1, REQ].sort());
    });
    it(`HA4 ${name} CONTROL: full by count (A1, A2 of 2) → waitlisted, as before`, async () => {
      const d = install(world({ going: [A1, A2], joinRequest: true, queue: [] })); const r = await approve(); await settle();
      assert.equal(`${r.status} ${r.raw}`, `200 ${waitlisted}`);
      assert.deepEqual(goingIds(d.seed).sort(), [A1, A2].sort()); assert.equal(queueRow(d.seed, REQ)?.position, 1);
    });
  }

  it("PS-TODAY (owner question, NOT changed): PATCH /attendees/:userId/status {going} seats a host's pick in the seat W1's offer reserves; W1's accept is then 'spot filled' — and, since B3.1, W1 is returned to the queue without a re-offer", async () => {
    const d = install(world({ going: [A1] }));
    const r = await call("PATCH", `/events/${EV}/attendees/${REQ}/status`, "host", { status: "going" });
    assert.equal(`${r.status} ${r.raw}`, `200 {"ok":true,"userId":"${REQ}","status":"going"}`);
    assert.deepEqual(goingIds(d.seed).sort(), [A1, REQ].sort(), "today: the host's status change seats past the reservation");
    const a = await accept(); await settle();
    assert.equal(a.status, 403, a.raw); assert.equal(a.body.message, SPOT_FILLED);
    assert.deepEqual(liveOffers(d.seed), []); assert.deepEqual(noticesTo(d), []);
  });
});
