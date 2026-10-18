/**
 * Wave 5 follow-up B — the events waitlist. A failed read must never give away
 * a queued person's seat, and a promoted person must be told.
 *
 * ── 1. AN UNREADABLE WAITLIST FLAG HELD NOTHING ─────────────────────────────
 * Three routes free a seat and then ask `events_waitlist_enabled` whether to
 * promote the next queued person: DELETE /events/:id/rsvp, POST
 * /events/:id/leave, DELETE /events/:id/attendees/:userId. They asked through
 * `isFlagEnabled`, which answers `false` on a database error. So an unreadable
 * flag (a) promoted nobody — correct — and then (b) ran syncEventState, which
 * reopens a full/waitlist event to "open" whenever no active offer holds the
 * seat. No offer had been written, so the event opened and the freed seat went
 * to the first walk-in ahead of everyone in the queue. A failed read became a
 * write.
 *
 * The rule now: the leave still succeeds; nobody is promoted on an unknown
 * flag; the event is NOT moved toward open on that pass (the seat is held), and
 * both decisions are logged at warn. A flag that reads cleanly OFF — and a flag
 * row that is ABSENT, which is "disabled", not "unknown" — behave exactly as
 * before (reopen, nobody promoted). A flag that reads ON behaves as before.
 *
 * ── 2. A PROMOTED PERSON WAS TOLD THROUGH ONE TOKEN READ ─────────────────────
 * promoteNextWaitlisted claims the offer (24 h to accept) and then read
 * profiles.expo_push_token. An unreadable token, no token, or a failed push
 * left the person untold, and the offer lapsed to the next person. The offer is
 * now also written as an in-app notification row (the Activity Center, the
 * unread badge, action → /event/:id), which depends on no read at all. The
 * claim stays the record: a notification that cannot be written neither undoes
 * nor repeats the offer, and nothing is announced for an offer that was not
 * claimed (contended / write failed).
 *
 * FAIL cases were RED on the pre-fix tree (wave4 worktree, events.ts at 7169
 * lines); CONTROL cases pin the answers that must not move.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestFetch } from "../lib/push.js";
import { logger } from "../lib/logger.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./helpers/failClosedSupabase.js";

const HOST   = "22222222-2222-4222-8222-222222222222";
const VIEWER = "11111111-1111-4111-8111-111111111111";
const W1     = "33333333-3333-4333-8333-333333333333";
const W2     = "44444444-4444-4444-8444-444444444444";
const EVENT  = "66666666-6666-4666-8666-666666666666";
const TOKENS: Record<string, string> = { "t-host": HOST, "t-viewer": VIEWER, "t-w1": W1 };
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
const W1_TOKEN = "ExponentPushToken[w1-device]";

type FlagMode = "on" | "off" | "absent" | "unreadable";

interface WorldOpts {
  flag?: FlagMode;
  ev?: Record<string, any>;
  rsvps?: Record<string, any>[];
  waitlist?: Record<string, any>[];
  /** W1's push token on profiles (absent by default). */
  w1Token?: string | null;
  /** The push-token read (profiles.select("expo_push_token")) resolves an error. */
  tokenReadFails?: boolean;
  /** The offer claim (event_waitlist UPDATE … IS NULL … .select()) matches nobody: another writer got there first. */
  claimLoses?: boolean;
  failOn?: (c: FakeReadContext) => any;
  failWritesOn?: (t: string) => any;
}

interface WriteRec { table: string; kind: string; payload: any; filters: Array<[string, string, unknown]> }

function eventRow(over: Record<string, any> = {}) {
  return {
    id: EVENT, host_id: HOST, title: "Rooftop quiz", state: "waitlist", rsvp_closed: false, visibility: "public", city: "Lisbon",
    verified_only: false, trust_score_min: null, age_min: null, age_max: null,
    capacity: 10, max_attendees: 10, going_count: 1, waitlist_enabled: true, waitlist_count: 2,
    chat_enabled: false, chat_thread_id: null,
    starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const queueRow = (u: string, position: number, offer: string | null = null) => ({ event_id: EVENT, user_id: u, position, offer_expires_at: offer });
const flagIsWaitlist = (c: FakeReadContext) => c.table === "feature_flags" && c.eq("flag") === "events_waitlist_enabled";

function world(o: WorldOpts = {}): { spec: FakeClientSpec; client: any; writes: WriteRec[] } {
  const mode = o.flag ?? "on";
  const flags: Record<string, any>[] = [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }, { flag: "push_notifications_enabled", enabled: true }];
  if (mode === "on" || mode === "unreadable") flags.push({ flag: "events_waitlist_enabled", enabled: true });
  if (mode === "off") flags.push({ flag: "events_waitlist_enabled", enabled: false });
  const people = [HOST, VIEWER, W1, W2];
  const spec: FakeClientSpec = {
    users: TOKENS,
    rows: {
      feature_flags: flags,
      events: [eventRow(o.ev)],
      event_roles: [], blocks: [], event_reports: [], event_attendee_states: [], identity_verifications: [],
      event_rsvps: o.rsvps ?? [{ event_id: EVENT, user_id: VIEWER, status: "going" }],
      event_waitlist: o.waitlist ?? [queueRow(W1, 1), queueRow(W2, 2)],
      profiles: people.map((id) => ({ id, handle: `h${id.slice(0, 4)}`, name: "N", date_of_birth: "1990-06-15", location_country: "US", verified: true,
        expo_push_token: id === W1 ? (o.w1Token ?? null) : null })),
    },
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
    let cols: string | null = null;
    const sel = b.select;
    b.select = (c?: string, opts?: any) => { if (!rec) cols = c ?? null; return sel(c, opts); };
    if (table === "profiles" && o.tokenReadFails) {
      const ms = b.maybeSingle;
      b.maybeSingle = () => (cols && cols.includes("expo_push_token") ? Promise.resolve({ data: null, error: ERR, count: null }) : ms());
    }
    if (table === "event_waitlist" && o.claimLoses) {
      const then = b.then;
      b.then = (f: any, r: any) => (rec && rec.kind === "update" && rec.payload?.offer_expires_at ? Promise.resolve({ data: [], error: null, count: null }).then(f, r) : then(f, r));
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
  return { spec, client, writes };
}

/** User ids handed a waitlist offer (an UPDATE of offer_expires_at to a non-null value). */
function offeredTo(writes: WriteRec[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    if (w.table !== "event_waitlist" || w.kind !== "update" || !w.payload?.offer_expires_at) continue;
    for (const [op, col, val] of w.filters) if (col === "user_id" && op === "eq") out.push(val as string);
  }
  return out;
}
const offerExpiry = (writes: WriteRec[]) => writes.find((w) => w.table === "event_waitlist" && w.kind === "update" && w.payload?.offer_expires_at)?.payload.offer_expires_at;
const stateWrites = (w: WriteRec[]) => w.filter((x) => x.table === "events" && x.kind === "update" && x.payload?.state !== undefined).map((x) => x.payload.state);
const rsvpDeletes = (w: WriteRec[]) => w.filter((x) => x.table === "event_rsvps" && x.kind === "delete");
const inAppRows = (w: WriteRec[]) => w.filter((x) => x.table === "notifications" && x.kind === "insert").map((x) => x.payload);

// ── Log capture: the route's req.log and the module logger events.ts writes through ──
type LogLine = { level: string; obj: any; msg: string };
const reqLog: LogLine[] = [];
const modLog: LogLine[] = [];
const said = (lines: LogLine[], level: string, needle: RegExp) => lines.some((l) => l.level === level && needle.test(`${l.msg} ${JSON.stringify(l.obj ?? {})}`));

// ── Push capture ──
const pushes: any[][] = [];

describe("wave 5 follow-up B — a held seat and a told offer", () => {
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
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); _setTestFetch(null); (logger as any).warn = origWarn; });
  beforeEach(() => {
    reqLog.length = 0; modLog.length = 0; pushes.length = 0;
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

  // The three doors that free a seat. Each frees VIEWER's going seat on a `waitlist`-state event with room
  // (going 1 of 10 as the double reads it), with W1 then W2 queued and no offer outstanding.
  const SITES: Array<[string, () => Promise<{ status: number; text: string }>, string]> = [
    ["DELETE /rsvp",      () => req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`), '{"ok":true}'],
    ["POST /leave",       () => req("t-viewer", "POST", `/events/${EVENT}/leave`, {}), '{"ok":true}'],
    ["DELETE /attendees", () => req("t-host", "DELETE", `/events/${EVENT}/attendees/${VIEWER}`), '{"ok":true}'],
  ];

  for (const [site, call, okBody] of SITES) {
    // ── 1. FAIL: the flag cannot be read ──────────────────────────────────────
    it(`HS1 ${site}: events_waitlist_enabled UNREADABLE → the leave stands, nobody is promoted, the event is NOT reopened, and both are logged at warn`, async () => {
      const w = world({ flag: "unreadable" }); const r = await call();
      assert.equal(`${r.status} ${r.text}`, `200 ${okBody}`, "the person leaving is not refused because a flag could not be read");
      assert.equal(rsvpDeletes(w.writes).length, 1, "the RSVP is still removed");
      assert.deepEqual(offeredTo(w.writes), [], "nobody is promoted on an unknown flag");
      assert.deepEqual(stateWrites(w.writes), [], `an unreadable flag reopened the event to walk-ins: ${JSON.stringify(stateWrites(w.writes))}`);
      assert.ok(said(reqLog, "warn", /events_waitlist_enabled/), `no warn names the unreadable flag: ${JSON.stringify(reqLog)}`);
      assert.ok(said(modLog, "warn", /HELD/), `no warn records the held seat: ${JSON.stringify(modLog)}`);
    });
    // ── CONTROLS: a flag that reads cleanly behaves exactly as before ─────────
    it(`HS0-off ${site} CONTROL: flag reads OFF → nobody promoted, the event reopens to open (as before), no held-seat warn`, async () => {
      const w = world({ flag: "off" }); const r = await call();
      assert.equal(`${r.status} ${r.text}`, `200 ${okBody}`);
      assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"]);
      assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
    });
    it(`HS0-absent ${site} CONTROL: flag row ABSENT is "disabled", not "unknown" → reopens to open, nobody promoted`, async () => {
      const w = world({ flag: "absent" }); const r = await call();
      assert.equal(`${r.status} ${r.text}`, `200 ${okBody}`);
      assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), ["open"], "a missing flag row must not hold seats");
      assert.ok(!said(reqLog, "warn", /events_waitlist_enabled/), JSON.stringify(reqLog));
    });
    it(`HS0-on ${site} CONTROL: flag reads ON → the head of the queue is offered the seat (as before)`, async () => {
      const w = world({ flag: "on" }); const r = await call();
      assert.equal(`${r.status} ${r.text}`, `200 ${okBody}`);
      assert.deepEqual(offeredTo(w.writes), [W1]);
      assert.ok(!said(modLog, "warn", /HELD/), JSON.stringify(modLog));
    });
  }

  it("HS2 (changed by B2; was a CONTROL pinning the reopen): DELETE /rsvp by someone who was NOT going → the door does not consult the flag; the event's free seats (1 of 10 going, W1/W2 queued) go to the sync's catch-up, which on an UNREADABLE flag holds them (wave 5 follow-up B2: was reopened)", async () => {
    const w = world({ flag: "unreadable", rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "maybe" }] }); const r = await req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), []); assert.deepEqual(stateWrites(w.writes), [], "free seats with a queue are held for it on an unreadable flag, never reopened to walk-ins");
    assert.ok(!said(reqLog, "warn", /events_waitlist_enabled/), "the flag was not read, so it cannot be reported unreadable");
  });
  it("HS3 CONTROL: an UNREADABLE flag on an event that is already OPEN writes nothing and holds nothing", async () => {
    const w = world({ flag: "unreadable", ev: { state: "open" } }); const r = await req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stateWrites(w.writes), []); assert.ok(!said(modLog, "warn", /HELD/), "nothing was held: the event was already open");
  });
  it("HS4 CONTROL: an UNREADABLE flag on an UNLIMITED event (no max_attendees) writes no state", async () => {
    const w = world({ flag: "unreadable", ev: { state: "open", max_attendees: null } }); const r = await req("t-viewer", "POST", `/events/${EVENT}/leave`, {});
    assert.equal(r.status, 200, r.text); assert.deepEqual(stateWrites(w.writes), []);
  });
  it("HS5: UNREADABLE flag, but the event is still AT capacity after the leave (host lowered max) → the state still moves full → waitlist as before; nothing is held", async () => {
    const W3 = "55555555-5555-4555-8555-555555555555";
    const w = world({ flag: "unreadable", ev: { state: "full", max_attendees: 1, waitlist_enabled: true },
      rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }, { event_id: EVENT, user_id: W3, status: "going" }] });
    const r = await req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), [], "nobody is promoted on an unknown flag");
    assert.deepEqual(stateWrites(w.writes), ["waitlist"], "going >= max must still move full -> waitlist; the hold is only for a seat that was actually freed");
    assert.ok(!said(modLog, "warn", /HELD/), `nothing was freed, so nothing is held: ${JSON.stringify(modLog)}`);
  });

  // ── 2. The promoted person is TOLD, through a row that needs no read ────────
  const cancel = () => req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
  it("ON1 promoted, NO push token → an in-app notification row tells W1, pointing at the event, expiring with the offer", async () => {
    const w = world({ w1Token: null }); const r = await cancel();
    assert.equal(r.status, 200, r.text); assert.deepEqual(offeredTo(w.writes), [W1]);
    const rows = inAppRows(w.writes);
    assert.equal(rows.length, 1, `the promoted person was not told: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].user_id, W1); assert.equal(rows[0].event_type, "event.waitlist_offer");
    assert.equal(rows[0].action_url, `/event/${EVENT}`); assert.equal(rows[0].expires_at, offerExpiry(w.writes));
    assert.equal(rows[0].category, "plans"); assert.ok(!String(rows[0].title + rows[0].body).includes("Rooftop quiz"), "no event title in the stored/pushed text");
    assert.equal(pushes.length, 0, "no token, no push");
  });
  it("ON2 promoted, the push-token read FAILS → the offer stands and the in-app row still tells W1", async () => {
    const w = world({ w1Token: W1_TOKEN, tokenReadFails: true }); const r = await cancel();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}');
    assert.deepEqual(offeredTo(w.writes), [W1], "the claim is the record");
    assert.equal(inAppRows(w.writes).filter((x) => x.user_id === W1).length, 1, "an unread token silenced the offer");
    assert.equal(pushes.length, 0);
  });
  it("ON3 the in-app row CANNOT be written → the offer stands, exactly once; the response is unchanged; the failure is logged at warn", async () => {
    const w = world({ w1Token: null, failWritesOn: (t) => (t === "notifications" ? ERR : null) }); const r = await cancel();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}', "a notification failure must not fail the leave");
    assert.deepEqual(offeredTo(w.writes), [W1], "a notification failure must not undo or repeat the offer");
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist" && x.kind === "update").length, 1, "exactly one claim");
    assert.ok(said(reqLog, "warn", /in-app notification/), `the lost notice is not logged: ${JSON.stringify(reqLog)}`);
  });
  it("ON4 promoted WITH a token → one push (which opens the event) AND one in-app row; no double delivery", async () => {
    const w = world({ w1Token: W1_TOKEN }); const r = await cancel();
    assert.equal(r.status, 200, r.text);
    assert.equal(pushes.length, 1, `push count ${pushes.length}`); assert.equal(pushes[0].length, 1);
    assert.equal(pushes[0][0].to, W1_TOKEN); assert.equal(pushes[0][0].title, "A spot opened up!");
    assert.equal(pushes[0][0].data?.actionUrl, `/event/${EVENT}`, `the push does not open the event: ${JSON.stringify(pushes[0][0])}`);
    assert.equal(inAppRows(w.writes).length, 1);
  });
  it("ON5 POST /leave promotes → the in-app row tells W1 there too (every route promoter shares it)", async () => {
    const w = world({ w1Token: null }); const r = await req("t-viewer", "POST", `/events/${EVENT}/leave`, {});
    assert.equal(r.status, 200, r.text); assert.deepEqual(inAppRows(w.writes).map((x) => x.user_id), [W1]);
  });
  it("ON6 CONTROL: the claim LOSES a race (contended) → no offer is announced: no in-app row, no push", async () => {
    const w = world({ w1Token: W1_TOKEN, claimLoses: true }); const r = await cancel();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(inAppRows(w.writes), []); assert.equal(pushes.length, 0);
  });
  it("ON7 CONTROL: the claim WRITE fails → nothing is announced", async () => {
    const w = world({ w1Token: W1_TOKEN, failWritesOn: (t) => (t === "event_waitlist" ? ERR : null) }); const r = await cancel();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(inAppRows(w.writes), []); assert.equal(pushes.length, 0);
  });
  it("ON8 CONTROL: an empty queue (stranded) → nobody is told anything", async () => {
    const w = world({ waitlist: [] }); const r = await cancel();
    assert.equal(r.status, 200, r.text); assert.deepEqual(inAppRows(w.writes), []); assert.equal(pushes.length, 0);
  });
});
