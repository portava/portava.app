/**
 * census-trust §30.6–§30.9 — a waitlisted user is seated through the same
 * gate as everyone else, a ban's waitlist delete is checked, an unreadable
 * going-count admits nobody, and the host safety summary does not show an
 * empty list over a read that failed.
 *
 * supabase-js RESOLVES a failed read as `{ data: null, error }`. The shapes
 * this file drives, each seen on `a5cd72e30` (PR #547's head, which is `main`
 * cd9a11d92 for every path below):
 *
 *   §30.6  POST /events/:id/waitlist/accept and both promoters (the route's
 *          promoteNextWaitlisted and lib/eventWaitlistSweeper) seated or
 *          offered the seat WITHOUT checkEventEligibility: a banned, blocked,
 *          under-age or unverified user on the queue was promoted and accepted.
 *   §30.7  POST /events/:id/roles {role:"banned"} discarded the error of the
 *          DELETE that removes the banned user's waitlist row, and answered
 *          200 {ok:true} over it.
 *   §30.8  getGoingCount answered an unreadable event_rsvps as 0, so every
 *          capacity check it feeds (join, waitlist accept, both approvals,
 *          syncEventState's reopen) admitted over a full event, and every
 *          going_count write stamped 0.
 *   §30.9  GET /events/:id/safety-summary answered an unreadable banned list as
 *          `blockedUsers: []` (and reports / no-shows likewise).
 *
 * FAIL cases were RED on the pre-fix tree; CONTROL cases pin the healthy
 * answers, and the `H*` cases pin healthy response bodies byte-for-byte as
 * captured on the pre-fix tree.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { runSweep, _resetStatus } from "../lib/eventWaitlistSweeper.js";
import { makeFailClosedClient, type FakeClientSpec, type FakeReadContext } from "./helpers/failClosedSupabase.js";

const HOST   = "22222222-2222-4222-8222-222222222222";
const VIEWER = "11111111-1111-4111-8111-111111111111";
const W1     = "33333333-3333-4333-8333-333333333333";
const W2     = "44444444-4444-4444-8444-444444444444";
const GONE   = "55555555-5555-4555-8555-555555555555";
const EVENT  = "66666666-6666-4666-8666-666666666666";
const JREQ   = "99999999-9999-4999-8999-999999999999";
const TOKENS: Record<string, string> = { "t-host": HOST, "t-viewer": VIEWER, "t-w1": W1 };
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST   = "2001-01-01T00:00:00.000Z";

interface WorldOpts {
  ev?: Record<string, any>;
  /** Who is ineligible, and how. */
  banned?: string[];
  blockedWithHost?: string[];
  minors?: string[];
  unverified?: string[];
  waitlist?: Record<string, any>[];
  rsvps?: Record<string, any>[];
  failOn?: (c: FakeReadContext) => any;
  failWritesOn?: (t: string) => any;
  extra?: Record<string, Record<string, any>[]>;
}

interface WriteRec { table: string; kind: string; payload: any; filters: Array<[string, string, unknown]> }

function eventRow(over: Record<string, any> = {}) {
  return {
    id: EVENT, host_id: HOST, title: "Rooftop quiz", state: "waitlist", rsvp_closed: false, visibility: "public", city: "Lisbon",
    verified_only: false, trust_score_min: null, age_min: null, age_max: null,
    capacity: 10, max_attendees: 10, going_count: 0, waitlist_enabled: true, waitlist_count: 0,
    chat_enabled: false, chat_thread_id: null,
    starts_at: "2030-01-01T00:00:00.000Z", ends_at: null, created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function world(o: WorldOpts = {}): { spec: FakeClientSpec; client: any; writes: WriteRec[] } {
  const people = [HOST, VIEWER, W1, W2, GONE];
  const spec: FakeClientSpec = {
    users: TOKENS,
    rows: {
      feature_flags: [
        { flag: "events_enabled", enabled: true },
        { flag: "events_waitlist_enabled", enabled: true },
        { flag: "events_trust_gates_enabled", enabled: true },
      ],
      events: [eventRow(o.ev)],
      event_roles: (o.banned ?? []).map((u) => ({ event_id: EVENT, user_id: u, role: "banned" })),
      blocks: (o.blockedWithHost ?? []).map((u) => ({ blocker_id: HOST, blocked_id: u })),
      event_rsvps: o.rsvps ?? [],
      event_waitlist: o.waitlist ?? [],
      event_reports: [], event_attendee_states: [],
      profiles: people.map((id) => ({ id, handle: `h${id.slice(0, 4)}`, name: "N", date_of_birth: "1990-06-15", location_country: "US", verified: !(o.unverified ?? []).includes(id) })),
      identity_verifications: (o.minors ?? []).map((u) => ({ user_id: u, is_over_18: false, created_at: "2026-08-01T00:00:00.000Z" })),
      ...(o.extra ?? {}),
    },
    failOn: o.failOn, failWritesOn: o.failWritesOn, inserted: {}, updated: {},
  };
  const client = makeFailClosedClient(spec);
  const writes: WriteRec[] = [];
  const from = client.from.bind(client);
  client.from = (table: string) => {
    const b = from(table);
    if (typeof b.ilike !== "function") b.ilike = (col: string, val: unknown) => b.filter(col, "ilike", val);
    // The double ignores `.or()`. isBlockedBetween asks "(A blocks B) or (B blocks A)"; for a pair A≠B that is
    // exactly "blocker ∈ {A,B} and blocked ∈ {A,B}", which the double can filter.
    if (table === "blocks") b.or = (expr: string) => { const ids = [...new Set([...expr.matchAll(/blocker_id\.eq\.([0-9a-f-]+)/g)].map((m) => m[1]))]; b.in("blocker_id", ids); b.in("blocked_id", ids); return b; };
    // The double ignores the column list and returns the whole row. For `events` reads with a plain column list,
    // project to those columns, as PostgREST does — the waitlist accept's gate is only as good as the columns it read.
    if (table === "events") {
      let cols: string | null = null; const sel = b.select, ms = b.maybeSingle;
      b.select = (c?: string, o?: any) => { cols = c ?? null; return sel(c, o); };
      b.maybeSingle = () => ms().then((r: any) => {
        if (rec || !r?.data || !cols || !/^[a-z_, ]+$/.test(cols)) return r;
        const keep = cols.split(",").map((x) => x.trim());
        return { ...r, data: Object.fromEntries(keep.filter((k) => k in r.data).map((k) => [k, r.data[k]])) };
      });
    }
    let rec: WriteRec | null = null;
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

// Filters for the reads that decide each case.
const isGoingCount = (c: FakeReadContext) =>
  c.table === "event_rsvps" && c.eq("status") === "going" && c.eq("user_id") === undefined;
const goingCountFails = (c: FakeReadContext) => (isGoingCount(c) ? ERR : null);
// The trust seam's read for one user (WA5: the acting user's own profile row is read by auth, so it stays healthy).
const trustUnreadableFor = (u: string) => (c: FakeReadContext) => (c.table === "trust_profiles" && c.eq("user_id") === u ? ERR : null);
// The age seam's profile read for one user (promotion paths: that user is not the caller).
const ageUnreadableFor = (u: string) => (c: FakeReadContext) => (c.table === "profiles" && c.eq("id") === u ? ERR : null);
const eventReadFails = (c: FakeReadContext) => (c.table === "events" && c.eq("id") === EVENT ? ERR : null);

/** User ids handed a waitlist offer (an UPDATE of offer_expires_at to a non-null value). */
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
const rsvpWrites = (w: WriteRec[]) => w.filter((x) => x.table === "event_rsvps" && (x.kind === "upsert" || x.kind === "insert"));
const eventsUpdates = (w: WriteRec[]) => w.filter((x) => x.table === "events" && x.kind === "update").map((x) => x.payload);

const offerRow = (u: string, position: number, offer: string | null) => ({ event_id: EVENT, user_id: u, position, offer_expires_at: offer });

describe("census-trust §30.6–§30.9: waitlist seating, ban delete, capacity and safety summary fail closed", () => {
  let url = ""; let server: http.Server;
  before(async () => {
    const mod = await import("../routes/events.js");
    const app = express(); app.use(express.json());
    app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
    app.use(mod.default);
    server = http.createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); });
  const req = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  };
  const accept = () => req("t-w1", "POST", `/events/${EVENT}/waitlist/accept`, {});
  const heldOffer = { waitlist: [offerRow(W1, 1, FUTURE)] };

  // ── §30.6 POST /events/:id/waitlist/accept re-runs the eligibility gate ──────
  it("WA0 CONTROL/H: healthy accept, eligible adult → 200 body byte-identical to the pre-fix tree, RSVP written", async () => {
    const w = world(heldOffer); const r = await accept();
    assert.equal(r.status, 200, r.text); assert.equal(r.text, `{"status":"going","eventId":"${EVENT}"}`);
    assert.equal(rsvpWrites(w.writes).length, 1);
  });
  for (const [name, opts, why] of [
    ["WA1", { banned: [W1] }, "banned from the event"],
    ["WA2", { blockedWithHost: [W1] }, "blocked by the host"],
    ["WA3", { minors: [W1], ev: { age_min: 18 } }, "a verified minor, 18+ event"],
    ["WA4", { unverified: [W1], ev: { verified_only: true } }, "unverified, verified-only event"],
  ] as const) {
    it(`${name} accept, the user is ${why} → refused 403, no RSVP written`, async () => {
      const w = world({ ...heldOffer, ...(opts as WorldOpts) }); const r = await accept();
      assert.equal(rsvpWrites(w.writes).length, 0, `an ineligible waitlister was seated at accept: ${r.status} ${r.text}`);
      assert.equal(r.status, 403, r.text);
    });
  }
  it("WA5 accept, the user's eligibility cannot be read (trust seam unreadable) → 503 degraded_unavailable, no RSVP, the row is left", async () => {
    const w = world({ ...heldOffer, ev: { trust_score_min: 30 }, failOn: trustUnreadableFor(W1) }); const r = await accept();
    assert.equal(rsvpWrites(w.writes).length, 0, `an unread eligibility seated the waitlister: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist").length, 0, "the waitlist row must be left alone");
  });
  it("WA6 accept, the event read FAILS → 503 degraded_unavailable (was 404 'Event not found'), no RSVP", async () => {
    const w = world({ ...heldOffer, failOn: eventReadFails }); const r = await accept();
    assert.equal(rsvpWrites(w.writes).length, 0);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });

  // ── §30.6 the route's promoter (DELETE /events/:id/rsvp frees a seat) ───────
  const cancel = () => req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
  const queue = { rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }], waitlist: [offerRow(W1, 1, null), offerRow(W2, 2, null)] };
  it("PR0 CONTROL/H: head of the queue eligible → the offer goes to the head; body {\"ok\":true} as before", async () => {
    const w = world(queue); const r = await cancel();
    assert.equal(r.status, 200); assert.equal(r.text, '{"ok":true}'); assert.deepEqual(offeredTo(w.writes), [W1]);
  });
  for (const [name, opts, why] of [
    ["PR1", { banned: [W1] }, "banned"],
    ["PR2", { minors: [W1], ev: { age_min: 18 } }, "a verified minor on an 18+ event"],
    ["PR3", { blockedWithHost: [W1] }, "blocked by the host"],
  ] as const) {
    it(`${name} head of the queue is ${why} → not offered; the next eligible user is`, async () => {
      const w = world({ ...queue, ...(opts as WorldOpts) }); const r = await cancel();
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(offeredTo(w.writes), [W2], `offered to ${JSON.stringify(offeredTo(w.writes))}`);
    });
  }
  it("PR4 head's eligibility cannot be read → nobody is offered the seat (not skipped past, not promoted)", async () => {
    const w = world({ ...queue, ev: { age_min: 18 }, failOn: ageUnreadableFor(W1) }); const r = await cancel();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(offeredTo(w.writes), [], `promoted over an unread eligibility: ${JSON.stringify(offeredTo(w.writes))}`);
  });
  it("PR6 head's VERIFIED read fails on a verified-only event → nobody is offered (a failed read is not \"unverified\")", async () => {
    const w = world({ ...queue, ev: { verified_only: true }, failOn: ageUnreadableFor(W1) }); await cancel();
    assert.deepEqual(offeredTo(w.writes), [], `promoted over an unread verified flag: ${JSON.stringify(offeredTo(w.writes))}`);
  });
  it("PR7 head's BAN read fails → nobody is offered (a failed read is not a verdict on the user)", async () => {
    const w = world({ ...queue, failOn: (c) => (c.table === "event_roles" && c.eq("role") === "banned" && c.eq("user_id") === W1 ? ERR : null) }); await cancel();
    assert.deepEqual(offeredTo(w.writes), [], `promoted over an unread ban: ${JSON.stringify(offeredTo(w.writes))}`);
  });
  it("PR5 the event read FAILS → nobody is offered the seat", async () => {
    const w = world({ ...queue, failOn: eventReadFails }); await cancel();
    assert.deepEqual(offeredTo(w.writes), [], `promoted without an event to check against: ${JSON.stringify(offeredTo(w.writes))}`);
  });

  // ── §30.6 the sweeper's promoter ─────────────────────────────────────────────
  const sweepQueue = { waitlist: [offerRow(GONE, 1, PAST), offerRow(W1, 2, null), offerRow(W2, 3, null)] };
  const sweep = async (o: WorldOpts) => { const w = world(o); _resetStatus(); const out = await runSweep({ client: w.client }); return { w, out }; };
  it("SW0 CONTROL: head eligible → the sweep offers the freed seat to the head (counts as before)", async () => {
    const { w, out } = await sweep(sweepQueue);
    assert.deepEqual(offeredTo(w.writes), [W1]);
    assert.deepEqual({ cleared: out.cleared, promoted: out.promoted, stranded: out.stranded, unreadable: out.unreadable, failed: out.failed },
      { cleared: 1, promoted: 1, stranded: 0, unreadable: 0, failed: 0 });
  });
  it("SW1 head is banned → the sweep skips them and offers the seat to the next eligible user", async () => {
    const { w, out } = await sweep({ ...sweepQueue, banned: [W1] });
    assert.deepEqual(offeredTo(w.writes), [W2], `sweep offered to ${JSON.stringify(offeredTo(w.writes))}`);
    assert.equal(out.promoted, 1);
  });
  it("SW2 head is under age for an 18+ event → skipped, the next eligible user is offered", async () => {
    const { w } = await sweep({ ...sweepQueue, minors: [W1], ev: { age_min: 18 } });
    assert.deepEqual(offeredTo(w.writes), [W2]);
  });
  it("SW3 head's eligibility cannot be read → nobody is offered; the pass reports it unreadable", async () => {
    const { w, out } = await sweep({ ...sweepQueue, ev: { age_min: 18 }, failOn: ageUnreadableFor(W1) });
    assert.deepEqual(offeredTo(w.writes), [], `sweep promoted over an unread eligibility: ${JSON.stringify(offeredTo(w.writes))}`);
    assert.equal(out.promoted, 0); assert.equal(out.unreadable, 1);
  });
  it("SW4 the event read FAILS → nobody is offered; unreadable", async () => {
    const { w, out } = await sweep({ ...sweepQueue, failOn: eventReadFails });
    assert.deepEqual(offeredTo(w.writes), []); assert.equal(out.unreadable, 1);
  });

  // ── §30.7 the ban's waitlist delete ──────────────────────────────────────────
  const ban = () => req("t-host", "POST", `/events/${EVENT}/roles`, { userId: W1, role: "banned" });
  it("BD0 CONTROL/H: healthy ban → 200 body byte-identical to the pre-fix tree; the waitlist row deleted, the ban written", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null)] }); const r = await ban();
    assert.equal(r.status, 200); assert.equal(r.text, `{"ok":true,"userId":"${W1}","role":"banned"}`);
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist" && x.kind === "delete").length, 1);
    assert.ok(w.writes.some((x) => x.table === "event_roles" && x.kind === "upsert" && x.payload?.role === "banned"));
  });
  it("BD1 the waitlist DELETE fails → not reported as success: 503 degraded_unavailable; the ban itself is still written", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null)], failWritesOn: (t) => (t === "event_waitlist" ? ERR : null) }); const r = await ban();
    assert.notEqual(r.status, 200, `a failed waitlist delete was reported as success: ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.ok(w.writes.some((x) => x.table === "event_roles" && x.kind === "upsert" && x.payload?.role === "banned"), "the ban must still be recorded");
  });

  // The second ban path: the host's "block from event" writes the ban and removes the waitlist row.
  const blockUser = () => req("t-host", "POST", `/events/${EVENT}/block-user/${W1}`, {});
  it("BU0 CONTROL/H: healthy block-user → 200 {\"ok\":true} as before; ban written, waitlist row deleted", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null)] }); const r = await blockUser();
    assert.equal(r.status, 200); assert.equal(r.text, '{"ok":true}');
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist" && x.kind === "delete").length, 1);
  });
  it("BU1 block-user, the waitlist DELETE fails → 503 degraded_unavailable, not {ok:true}; the ban is still written", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null)], failWritesOn: (t) => (t === "event_waitlist" ? ERR : null) }); const r = await blockUser();
    assert.notEqual(r.status, 200, `a failed waitlist delete was reported as success: ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.ok(w.writes.some((x) => x.table === "event_roles" && x.kind === "upsert" && x.payload?.role === "banned"));
  });
  it("BU2 block-user, the BAN write itself fails → not {ok:true}; nothing else is removed", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null)], failWritesOn: (t) => (t === "event_roles" ? ERR : null) }); const r = await blockUser();
    assert.notEqual(r.status, 200, `a ban that was not written was reported as success: ${r.text}`);
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist" && x.kind === "delete").length, 0);
  });

  // ── §30.8 an unreadable going-count admits nobody ────────────────────────────
  const open = { ev: { state: "open" } };
  it("JN0 CONTROL/H: healthy join with room → 200 body byte-identical to the pre-fix tree, RSVP written", async () => {
    const w = world(open); const r = await req("t-w1", "POST", `/events/${EVENT}/join`, {});
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true}'); assert.equal(rsvpWrites(w.writes).length, 1);
  });
  it("JN0b CONTROL: join, count readable and full → waitlisted 202, no RSVP", async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ event_id: EVENT, user_id: `a${i}`, status: "going" }));
    const w = world({ ...open, rsvps: full }); const r = await req("t-w1", "POST", `/events/${EVENT}/join`, {});
    assert.equal(r.status, 202, r.text); assert.equal(rsvpWrites(w.writes).length, 0);
  });
  it("JN1 join, the going-count read FAILS → 503 degraded_unavailable, no RSVP (was: counted 0 and seated)", async () => {
    const w = world({ ...open, failOn: goingCountFails }); const r = await req("t-w1", "POST", `/events/${EVENT}/join`, {});
    assert.equal(rsvpWrites(w.writes).length, 0, `an unread count admitted a joiner: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });
  it("WA7 accept, the going-count read FAILS → 503 degraded_unavailable, no RSVP, the row is left", async () => {
    const w = world({ ...heldOffer, failOn: goingCountFails }); const r = await accept();
    assert.equal(rsvpWrites(w.writes).length, 0, `an unread count seated the waitlister: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
    assert.equal(w.writes.filter((x) => x.table === "event_waitlist").length, 0);
  });
  it("WA7b CONTROL: accept, count readable and full → 403 (spot filled), no RSVP", async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({ event_id: EVENT, user_id: `a${i}`, status: "going" }));
    const w = world({ ...heldOffer, rsvps: full }); const r = await accept();
    assert.equal(r.status, 403, r.text); assert.equal(rsvpWrites(w.writes).length, 0);
  });
  const legacyApprove = () => req("t-host", "PATCH", `/events/${EVENT}/requests/${W1}`, { action: "approve" });
  const jr = { event_join_requests: [{ id: JREQ, event_id: EVENT, user_id: W1, status: "pending" }] };
  it("AP0 CONTROL/H: legacy approve with room → body byte-identical to the pre-fix tree, RSVP written", async () => {
    const w = world({ ...open, extra: jr }); const r = await legacyApprove();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true,"action":"approve"}'); assert.equal(rsvpWrites(w.writes).length, 1);
  });
  it("AP1 legacy approve, the going-count read FAILS → 503 degraded_unavailable, no RSVP", async () => {
    const w = world({ ...open, extra: jr, failOn: goingCountFails }); const r = await legacyApprove();
    assert.equal(rsvpWrites(w.writes).length, 0, `an unread count seated an approved user: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });
  const approve = () => req("t-host", "POST", `/events/${EVENT}/join-requests/${JREQ}/approve`, {});
  it("AQ0 CONTROL/H: join-request approve with room → body byte-identical to the pre-fix tree, RSVP written", async () => {
    const w = world({ ...open, extra: jr }); const r = await approve();
    assert.equal(`${r.status} ${r.text}`, '200 {"ok":true,"status":"approved"}'); assert.equal(rsvpWrites(w.writes).length, 1);
  });
  it("AQ1 join-request approve, the going-count read FAILS → 503 degraded_unavailable, no RSVP", async () => {
    const w = world({ ...open, extra: jr, failOn: goingCountFails }); const r = await approve();
    assert.equal(rsvpWrites(w.writes).length, 0, `an unread count seated an approved user: ${r.status} ${r.text}`);
    assert.equal(r.status, 503, r.text); assert.equal(JSON.parse(r.text).error, "degraded_unavailable");
  });
  it("SY1 a seat frees on a FULL event and the count read FAILS → the event is not reopened and going_count is not stamped 0", async () => {
    const w = world({ ev: { state: "full" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }], failOn: goingCountFails,
      extra: { feature_flags: [{ flag: "events_enabled", enabled: true }, { flag: "events_waitlist_enabled", enabled: false }] } });
    const r = await cancel(); assert.equal(r.status, 200, r.text);
    const ups = eventsUpdates(w.writes);
    assert.ok(!ups.some((p) => p?.state === "open"), `an unread count reopened a full event: ${JSON.stringify(ups)}`);
    assert.ok(!ups.some((p) => p?.going_count !== undefined), `an unread count was persisted as going_count: ${JSON.stringify(ups)}`);
  });
  it("SY0 CONTROL: a seat frees on a FULL event, count readable → reopened and going_count stamped (as before)", async () => {
    const w = world({ ev: { state: "full" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }],
      extra: { feature_flags: [{ flag: "events_enabled", enabled: true }, { flag: "events_waitlist_enabled", enabled: false }] } });
    const r = await cancel(); assert.equal(r.status, 200, r.text);
    const ups = eventsUpdates(w.writes);
    assert.ok(ups.some((p) => p?.state === "open"), JSON.stringify(ups)); assert.ok(ups.some((p) => p?.going_count === 1), JSON.stringify(ups));
  });

  // Every going_count write site: reached with a readable count (CONTROL: a number is written), and with an
  // unreadable one nothing is stamped (the pre-fix tree wrote 0 over the real count).
  const INVITE = "88888888-8888-4888-8888-888888888888";
  const unlimited = { state: "open", max_attendees: null };
  const sites: Array<[string, WorldOpts, () => Promise<{ status: number; text: string }>]> = [
    ["rsvp",        { ev: { state: "open" } },                                      () => req("t-w1", "POST", `/events/${EVENT}/rsvp`, { status: "going" })],
    ["join",        { ev: unlimited },                                               () => req("t-w1", "POST", `/events/${EVENT}/join`, {})],
    ["leave",       { ev: { state: "open" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }] }, () => req("t-viewer", "POST", `/events/${EVENT}/leave`, {})],
    ["wl-accept",   { ev: unlimited, ...heldOffer },                                 () => accept()],
    ["req-approve", { ev: unlimited, extra: jr },                                    () => legacyApprove()],
    ["jr-approve",  { ev: unlimited, extra: jr },                                    () => approve()],
    ["ban",         { rsvps: [{ event_id: EVENT, user_id: W1, status: "going" }] }, () => ban()],
    ["status",      { ev: { state: "open" } },                                       () => req("t-host", "PATCH", `/events/${EVENT}/attendees/${W1}/status`, { status: "going" })],
    ["remove",      { ev: { state: "open" }, rsvps: [{ event_id: EVENT, user_id: W1, status: "going" }] }, () => req("t-host", "DELETE", `/events/${EVENT}/attendees/${W1}`)],
    ["invite",      { ev: { state: "open" }, extra: { event_invites: [{ id: INVITE, event_id: EVENT, invitee_id: W1, inviter_id: HOST, status: "pending" }] } },
                    () => req("t-w1", "POST", `/events/${EVENT}/invites/${INVITE}/accept`, {})],
    ["block-user",  { rsvps: [{ event_id: EVENT, user_id: W1, status: "going" }] }, () => blockUser()],
  ];
  for (const [name, opts, call] of sites) {
    it(`GC0-${name} CONTROL: count readable → going_count written as a number`, async () => {
      const w = world(opts); const r = await call();
      assert.ok(eventsUpdates(w.writes).some((p) => typeof p?.going_count === "number"), `${r.status} ${r.text} ${JSON.stringify(eventsUpdates(w.writes))}`);
    });
    it(`GC1-${name} the going-count read FAILS → no going_count is stamped`, async () => {
      const w = world({ ...opts, failOn: goingCountFails }); const r = await call();
      const ups = eventsUpdates(w.writes);
      assert.ok(!ups.some((p) => p?.going_count !== undefined), `an unread count was persisted as going_count (${r.status}): ${JSON.stringify(ups)}`);
    });
  }

  // ── §30.9 the host safety summary ────────────────────────────────────────────
  const summary = () => req("t-host", "GET", `/events/${EVENT}/safety-summary`);
  const norm = (s: string) => s.replace(/"generatedAt":"[^"]+"/, '"generatedAt":"T"');
  it("SS0 CONTROL/H: healthy summary → body byte-identical to the pre-fix tree (no failedSources key)", async () => {
    world({ banned: [W1] }); const r = await summary();
    assert.equal(r.status, 200); assert.equal(norm(r.text), `{"eventId":"${EVENT}","reports":[],"noShows":[],"blockedUsers":["${W1}"],"generatedAt":"T"}`);
  });
  it("SS1 the banned-list read FAILS → blockedUsers is null and failedSources names it (never [])", async () => {
    world({ banned: [W1], failOn: (c) => (c.table === "event_roles" && c.eq("role") === "banned" ? ERR : null) }); const r = await summary();
    assert.equal(r.status, 200, r.text); const b = JSON.parse(r.text);
    assert.notDeepEqual(b.blockedUsers, [], `an unread banned list was shown as empty: ${r.text}`);
    assert.equal(b.blockedUsers, null); assert.deepEqual(b.failedSources, ["blockedUsers"]);
  });
  it("SS2 the reports and no-show reads FAIL → each is null and named in failedSources; the banned list still shown", async () => {
    world({ banned: [W1], failOn: (c) => (c.table === "event_reports" || c.table === "event_attendee_states" ? ERR : null) }); const r = await summary();
    const b = JSON.parse(r.text);
    assert.equal(b.reports, null, r.text); assert.equal(b.noShows, null, r.text);
    assert.deepEqual(b.failedSources, ["reports", "noShows"]); assert.deepEqual(b.blockedUsers, [W1]);
  });
});
