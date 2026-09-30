/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW10, SW11): a count read that FAILED is never served, or
 * stamped into a cached counter, as a measured 0.
 *
 * The round-18 verifier's B14 (GET /events served a failed RSVP count as `goingCount: 0`) asked for a sweep of every
 * other count read in routes/events.ts of the same shape. supabase-js RESOLVES a failed read as `{ data: null, error }`,
 * and `((data as any[]) ?? []).length` is 0.
 *
 * SW10, GET /events/:id (the event screen, graded by §110 and §111):
 *   DT1  the going/maybe read FAILS → `counts.going` is the cached `going_count`, `counts.maybe` is null (never 0),
 *        and `failedSources` names `event_rsvps`
 *   DT2  the full RSVP read FAILS → `counts.interested` and `counts.cant_go` are null, `event_rsvps` is named
 *   DT3  the waitlist count read FAILS → `waitlistCount` is the cached `waitlist_count`, `event_waitlist` is named
 *   DT0  CONTROL: every read answers → the live counts, and no `failedSources` key
 *
 * SW11, the cached counters every list serves (`waitlistCount` on GET /events, the cards, the event screen): a recount
 * read that FAILED left the column alone for `going_count` (census-trust §30.8) but stamped `waitlist_count: 0`, and
 * the review recount stamped `review_count: 0` and an `avg_rating` of the one new review.
 *   WS1  leaving the waitlist, the recount FAILS → `waitlist_count` is not written
 *   WS2  accepting a waitlist offer, the recount FAILS → the same
 *   WS3  a ban, the recount FAILS → the same
 *   WS4  block-user, the recount FAILS → the same
 *   WS5  a review, the ratings read FAILS → neither `review_count` nor `avg_rating` is written
 *   WS0, WS2c, WS5c  CONTROLS: every read answers → the counts are written as before
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
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

const onlyEventFilter = (c: FakeReadContext) => c.filters.length === 1 && c.eq("event_id") === EVENT;
/** The recount reads: `select("user_id").eq("event_id", id)` on event_waitlist, nothing else filtered. */
const waitlistRecountFails = (c: FakeReadContext) => (c.table === "event_waitlist" && onlyEventFilter(c) ? ERR : null);
const goingMaybeFails = (c: FakeReadContext) => (c.table === "event_rsvps" && c.filters.some((f) => f.op === "in" && f.col === "status") && c.eq("user_id") === undefined ? ERR : null);
const allRsvpsFails = (c: FakeReadContext) => (c.table === "event_rsvps" && onlyEventFilter(c) ? ERR : null);
const ratingsFail = (c: FakeReadContext) => (c.table === "event_reviews" && onlyEventFilter(c) ? ERR : null);
const stamps = (w: WriteRec[], key: string) => eventsUpdates(w).filter((p) => p && key in p && p[key] !== undefined).map((p) => p[key]);

describe("census-discovery §116 (SW10, SW11): a failed count read is never served or stamped as 0", () => {
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

  // ── SW10 GET /events/:id ──────────────────────────────────────────────────────
  const openEv = { ev: { state: "open", going_count: 7, waitlist_count: 4 } };
  const rsvps = [
    { event_id: EVENT, user_id: W1, status: "going" }, { event_id: EVENT, user_id: W2, status: "going" },
    { event_id: EVENT, user_id: GONE, status: "maybe" }, { event_id: EVENT, user_id: HOST, status: "interested" },
  ];
  const detail = async (failOn?: (c: FakeReadContext) => any) => {
    world({ ...openEv, rsvps, waitlist: [offerRow(W1, 1, null)], failOn });
    const r = await req("t-viewer", "GET", `/events/${EVENT}`);
    const body = JSON.parse(r.text);
    return { r, body, seen: JSON.stringify({ status: r.status, counts: body.counts, waitlistCount: body.waitlistCount, failedSources: body.failedSources }) };
  };
  it("DT0 CONTROL: every read answers → the live counts, no failedSources key", async () => {
    const d = await detail();
    assert.equal(d.r.status, 200, d.r.text);
    assert.deepEqual(d.body.counts, { going: 2, maybe: 1, interested: 1, cant_go: 0 }, d.seen);
    assert.equal(d.body.waitlistCount, 1, d.seen);
    assert.equal("failedSources" in d.body, false, d.seen);
  });
  it("DT1 the going/maybe read FAILS → counts.going is the cached count, maybe is null, event_rsvps is named", async () => {
    const d = await detail(goingMaybeFails);
    assert.equal(d.r.status, 200, d.r.text);
    assert.equal(d.body.counts.going, 7, `a failed read served as a measured count: ${d.seen}`);
    assert.equal(d.body.counts.maybe, null, d.seen);
    assert.deepEqual(d.body.failedSources, ["event_rsvps"], d.seen);
  });
  it("DT2 the full RSVP read FAILS → interested and cant_go are null, event_rsvps is named", async () => {
    const d = await detail(allRsvpsFails);
    assert.equal(d.body.counts.going, 2, d.seen);
    assert.equal(d.body.counts.interested, null, `a failed read served as a measured count: ${d.seen}`);
    assert.equal(d.body.counts.cant_go, null, d.seen);
    assert.deepEqual(d.body.failedSources, ["event_rsvps"], d.seen);
  });
  it("DT3 the waitlist count read FAILS → waitlistCount is the cached count, event_waitlist is named", async () => {
    const d = await detail(waitlistRecountFails);
    assert.equal(d.body.waitlistCount, 4, `a failed read served as a measured count: ${d.seen}`);
    assert.deepEqual(d.body.failedSources, ["event_waitlist"], d.seen);
  });

  // ── SW11 the cached counters ────────────────────────────────────────────────
  // The double does not apply a DELETE, so a healthy recount reads both queued rows: the controls expect 2.
  const queue = [offerRow(W1, 1, null), offerRow(W2, 2, null)];
  const leave = () => req("t-w1", "DELETE", `/events/${EVENT}/waitlist`);
  it("WS0 CONTROL: leaving the waitlist, the recount answers → waitlist_count is written", async () => {
    const w = world({ waitlist: queue }); const r = await leave();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [2]);
  });
  it("WS1 leaving the waitlist, the recount FAILS → waitlist_count is not stamped 0", async () => {
    const w = world({ waitlist: queue, failOn: waitlistRecountFails }); await leave();
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [], JSON.stringify(eventsUpdates(w.writes)));
  });
  const accept = () => req("t-w1", "POST", `/events/${EVENT}/waitlist/accept`, {});
  const held = [offerRow(W1, 1, FUTURE), offerRow(W2, 2, null)];
  it("WS2c CONTROL: accepting an offer, the recount answers → waitlist_count is written", async () => {
    const w = world({ waitlist: held }); const r = await accept();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [2], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS2 accepting an offer, the recount FAILS → waitlist_count is not stamped 0", async () => {
    const w = world({ waitlist: held, failOn: waitlistRecountFails }); await accept();
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS3 a ban, the recount FAILS → waitlist_count is not stamped 0", async () => {
    const w = world({ waitlist: queue, failOn: waitlistRecountFails }); await req("t-host", "POST", `/events/${EVENT}/roles`, { userId: W1, role: "banned" });
    assert.ok(w.writes.some((x) => x.table === "event_roles" && x.kind === "upsert"), "the ban path ran");
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS3c CONTROL: a ban, the recount answers → waitlist_count is written", async () => {
    const w = world({ waitlist: queue }); await req("t-host", "POST", `/events/${EVENT}/roles`, { userId: W1, role: "banned" });
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [2], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS4 block-user, the recount FAILS → waitlist_count is not stamped 0", async () => {
    const w = world({ waitlist: queue, failOn: waitlistRecountFails }); await req("t-host", "POST", `/events/${EVENT}/block-user/${W1}`, {});
    assert.ok(w.writes.some((x) => x.table === "event_roles" && x.kind === "upsert"), "the block path ran");
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS4c CONTROL: block-user, the recount answers → waitlist_count is written", async () => {
    const w = world({ waitlist: queue }); await req("t-host", "POST", `/events/${EVENT}/block-user/${W1}`, {});
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [2], JSON.stringify(eventsUpdates(w.writes)));
  });
  const done = { ev: { state: "completed" }, extra: { event_attendee_states: [{ event_id: EVENT, user_id: W1, confirmed_at: "2026-09-01T00:00:00.000Z" }], event_reviews: [{ event_id: EVENT, reviewer_id: W2, rating: 2 }] } };
  const review = () => req("t-w1", "POST", `/events/${EVENT}/reviews`, { rating: 5 });
  it("WS5c CONTROL: a review, the ratings read answers → review_count and avg_rating are written", async () => {
    const w = world(done); const r = await review();
    assert.equal(r.status, 201, r.text);
    assert.equal(stamps(w.writes, "review_count").length, 1, JSON.stringify(eventsUpdates(w.writes)));
    assert.equal(stamps(w.writes, "avg_rating").length, 1, JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WS5 a review, the ratings read FAILS → neither review_count nor avg_rating is stamped", async () => {
    const w = world({ ...done, failOn: ratingsFail }); const r = await review();
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(stamps(w.writes, "review_count"), [], JSON.stringify(eventsUpdates(w.writes)));
    assert.deepEqual(stamps(w.writes, "avg_rating"), [], JSON.stringify(eventsUpdates(w.writes)));
  });
});
