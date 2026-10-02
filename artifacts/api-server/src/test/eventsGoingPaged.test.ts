/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B21, probes GC0–GC2): a count read over
 * rows PostgREST can cut at db-max-rows is read whole, or kept cached and named — never served cut as measured.
 *
 * GET /events and GET /events/city/:city recounted `going_count` live with ONE unbounded read over up to 201 pool events;
 * PostgREST caps a response at db-max-rows (1000 here) silently, so every event whose rows fell past the cap was served
 * and ranked as `goingCount: 0`. The same root sat in GET /events/:id's going/maybe, full-RSVP and waitlist reads, in
 * `getGoingCount` (every capacity sync and going_count stamp) and in the waitlist recounts. Each now reads through
 * `readAllPages` (lib/pagedRead.ts): `.range()` pages with an exact count, so a cut read is an error the existing
 * failed-read arm keeps cached and names.
 *
 * The list cases use the verifier's GET /events double (a response with no explicit range is capped at DB_MAX_ROWS);
 * the rest use world() with `dbMaxRows`, which caps every answer and honours `.range()`.
 *
 *   GC0  CONTROL: 40 events × 20 going = 800 rows → every event's goingCount is 20
 *   GC1  50 events × 25 going = 1250 rows → every event is served 25
 *   GC2  the same on GET /events/city/:city
 *   GC3  the server's max-rows (500) is BELOW the page size → still 25 for every event (the exact count pages on)
 *   GD1  GET /events/:id, one event with 1250 going → counts.going 1250
 *   GD2  GET /events/:id, 1100 interested → counts.interested 1100
 *   GD3  GET /events/:id, 1100 waitlisted → waitlistCount 1100
 *   GG1  DELETE /events/:id/rsvp over 1250 other going RSVPs → going_count stamped 1250 (getGoingCount)
 *   GG2  POST /events/:id/rsvp going, 1250 going at a 1100 cap → the capacity sync moves the event to its waitlist
 *   GW1  a waitlist leave over a 1250-row queue → waitlist_count stamped 1250 (the double keeps the deleted row)
 *   GW0  CONTROL: the same over a 2-row queue → 2
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";
import { world, eventsServer, eventRow, stamps, eventsUpdates, offerRow, EVENT, VIEWER as W_VIEWER, W1 } from "./helpers/eventsWorld.js";

interface Row { [k: string]: unknown }
type Tables = Record<string, { rows: Row[]; error?: { message: string } }>;
const DB_MAX_ROWS = 1000;

const VIEWER = "00000000-0000-0000-0002-0000000000e1";
const HOST = "00000000-0000-0000-0001-0000000000e1";
const LISBON = { lat: 38.72, lng: -9.14 };

function makeClient(tables: Tables) {
  function chain(name: string) {
    const spec = tables[name] ?? { rows: [] };
    let rows = [...spec.rows];
    let limit: number | null = null;
    const capped = () => rows.slice(0, Math.min(limit ?? DB_MAX_ROWS, DB_MAX_ROWS));
    const q: Record<string, unknown> & { then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown> } = {
      select: () => q,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: number | string) => { rows = rows.filter((r) => r[c] != null && (r[c] as number | string) >= v); return q; },
      lte: (c: string, v: number | string) => { rows = rows.filter((r) => r[c] != null && (r[c] as number | string) <= v); return q; },
      ilike: (c: string, p: string) => { const n = p.replace(/%/g, "").toLowerCase(); rows = rows.filter((r) => String(r[c] ?? "").toLowerCase().includes(n)); return q; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      not: (c: string) => { rows = rows.filter((r) => r[c] != null); return q; },
      or: () => q,
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return q; },
      insert: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: rows[0] ?? null, error: rows[0] ? null : { message: "No rows" } }),
      then: (res, rej) => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: capped(), error: null }).then(res, rej),
    };
    return q;
  }
  return {
    from: (name: string) => chain(name),
    rpc: () => Promise.resolve({ data: [], error: null }),
    auth: { getUser: async (t: string) => (t === `tok-${VIEWER}` ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "Invalid token" } }) },
  };
}

function event(i: number, over: Row = {}): Row {
  return {
    id: `00000000-0000-0000-00e0-${String(i).padStart(12, "0")}`, host_id: HOST, title: `Event ${i}`, description: null, location_name: "Somewhere",
    location_lat: LISBON.lat, location_lng: LISBON.lng, starts_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(), ends_at: null,
    cover_url: null, max_attendees: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, visibility: "public", state: "open",
    chat_enabled: false, chat_thread_id: null, waitlist_enabled: false, price_type: "free", price_url: null, rsvp_options: ["going"], going_count: 0,
    waitlist_count: 0, category: "music", city: "Lisbon", country: "PT", show_exact_location: true, rsvp_closed: false, tags: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  };
}
const FLAGS = { rows: [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }] };

let server: http.Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

async function get(tables: Tables, path: string) {
  _setTestClient(makeClient({ feature_flags: FLAGS, ...tables }) as never, true);
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { log: object }).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", eventsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const port = (server!.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, { headers: { authorization: `Bearer tok-${VIEWER}` } });
  const body = (await res.json()) as { events?: Array<{ id: string; goingCount?: number }>; truncated?: boolean; failedSources?: string[]; [k: string]: unknown };
  const going = body.events?.map((e) => e.goingCount) ?? [];
  return { status: res.status, body, going, seen: JSON.stringify({ status: res.status, n: body.events?.length, zeros: going.filter((g) => g === 0).length, distinct: [...new Set(going)], truncated: body.truncated, failedSources: body.failedSources, keys: Object.keys(body) }) };
}

function listWorld(nEvents: number, perEvent: number) {
  const evs = Array.from({ length: nEvents }, (_, i) => event(i + 1, { going_count: perEvent }));
  const rsvps = evs.flatMap((e) => Array.from({ length: perEvent }, (_, k) => ({ event_id: e.id, status: "going", user_id: `u-${e.id}-${k}` })));
  return { events: { rows: evs }, event_rsvps: { rows: rsvps } };
}
const said = (b: { truncated?: boolean; failedSources?: string[] }) => b.truncated === true || (b.failedSources ?? []).length > 0;

describe("census-discovery §117 (B21): GET /events' live going recount is read whole", () => {
  it("GC0 CONTROL: 40 events × 20 going (800 rows) → every event's goingCount is 20", async () => {
    const r = await get(listWorld(40, 20), "events?limit=50");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.going.length, 40, r.seen);
    assert.ok(r.going.every((g) => g === 20), r.seen);
  });
  it("GC1 50 events × 25 going (1250 rows; the whole list on one page) → every event is served 25", async () => {
    const r = await get(listWorld(50, 25), "events?limit=50");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.going.length, 50, r.seen);
    assert.ok(r.going.every((g) => g === 25), `a read cut at db-max-rows served as measured counts: ${r.seen}`);
    assert.equal(said(r.body), false, r.seen);
  });
  it("GC2 GET /events/city/:city, 50 events × 25 going (1250 rows) → every event is served 25", async () => {
    const r = await get(listWorld(50, 25), "events/city/Lisbon?limit=50");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.going.length, 50, r.seen);
    assert.ok(r.going.every((g) => g === 25), `a read cut at db-max-rows served as measured counts: ${r.seen}`);
  });
});

describe("census-discovery §117 (B21): every event count read over a cuttable set is read whole", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());
  const users = (n: number, tag: string) => Array.from({ length: n }, (_, k) => `${tag}-${String(k).padStart(5, "0")}`);
  const rsvpRows = (eventId: string, n: number, status: string) => users(n, `u-${status}-${eventId.slice(-4)}`).map((u) => ({ event_id: eventId, user_id: u, status }));

  it("GC3 db-max-rows 500, below the page size: 50 events × 25 going → every event is served 25", async () => {
    const evs = Array.from({ length: 50 }, (_, i) => eventRow({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, state: "open", going_count: 25, starts_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString() }));
    world({ ev: { state: "cancelled" }, moreEvents: evs, rsvps: evs.flatMap((e) => rsvpRows(e.id, 25, "going")), dbMaxRows: 500 });
    const r = await srv.req("t-viewer", "GET", "/events?limit=50");
    const going = (r.body?.events ?? []).map((e: any) => e.goingCount);
    const seen = JSON.stringify({ status: r.status, n: going.length, distinct: [...new Set(going)], failedSources: r.body?.failedSources });
    assert.equal(r.status, 200, r.text);
    assert.equal(going.length, 50, seen);
    assert.ok(going.every((g: number) => g === 25), seen);
  });
  it("GD1 GET /events/:id, 1250 going → counts.going 1250", async () => {
    world({ ev: { state: "open", going_count: 3 }, rsvps: rsvpRows(EVENT, 1250, "going"), dbMaxRows: 1000 });
    const r = await srv.req("t-host", "GET", `/events/${EVENT}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.counts.going, 1250, JSON.stringify(r.body.counts));
    assert.equal("failedSources" in r.body, false, JSON.stringify(r.body.failedSources));
  });
  it("GD2 GET /events/:id, 1100 interested → counts.interested 1100", async () => {
    world({ ev: { state: "open" }, rsvps: rsvpRows(EVENT, 1100, "interested"), dbMaxRows: 1000 });
    const r = await srv.req("t-host", "GET", `/events/${EVENT}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.counts.interested, 1100, JSON.stringify(r.body.counts));
  });
  it("GD3 GET /events/:id, 1100 waitlisted → waitlistCount 1100", async () => {
    world({ ev: { state: "waitlist", waitlist_count: 7 }, waitlist: users(1100, "wl").map((u, k) => ({ event_id: EVENT, user_id: u, position: k + 1, offer_expires_at: null })), dbMaxRows: 1000 });
    const r = await srv.req("t-host", "GET", `/events/${EVENT}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.waitlistCount, 1100, JSON.stringify({ waitlistCount: r.body.waitlistCount, failedSources: r.body.failedSources }));
  });
  it("GG1 DELETE /events/:id/rsvp over 1250 other going RSVPs → going_count stamped 1250", async () => {
    const w = world({ ev: { state: "open", max_attendees: null, capacity: null }, rsvps: [...rsvpRows(EVENT, 1250, "going"), { event_id: EVENT, user_id: W_VIEWER, status: "maybe" }], dbMaxRows: 1000 });
    const r = await srv.req("t-viewer", "DELETE", `/events/${EVENT}/rsvp`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stamps(w.writes, "going_count"), [1250], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("GG2 POST /events/:id/rsvp going, 1250 going at a 1100 cap → the capacity sync moves the event to its waitlist", async () => {
    const w = world({ ev: { state: "open", max_attendees: 1100, capacity: 1100, waitlist_enabled: true }, rsvps: rsvpRows(EVENT, 1250, "going"), dbMaxRows: 1000 });
    const r = await srv.req("t-viewer", "POST", `/events/${EVENT}/rsvp`, { status: "going" });
    const states = eventsUpdates(w.writes).filter((p) => p && "state" in p).map((p) => p.state);
    assert.equal(r.status, 200, r.text);
    assert.ok(states.includes("waitlist"), JSON.stringify({ states, updates: eventsUpdates(w.writes) }));
  });
  const leave = () => srv.req("t-w1", "DELETE", `/events/${EVENT}/waitlist`);
  it("GW0 CONTROL: a waitlist leave over a 2-row queue → waitlist_count stamped 2", async () => {
    const w = world({ waitlist: [offerRow(W1, 1, null), offerRow("w2", 2, null)], ev: { waitlist_count: 2 }, dbMaxRows: 1000 });
    const r = await leave();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [2], JSON.stringify(eventsUpdates(w.writes)));
  });
  it("GW1 a waitlist leave over a 1250-row queue → waitlist_count stamped 1250, never a cut 1000", async () => {
    const queue = [offerRow(W1, 1, null), ...users(1249, "wl").map((u, k) => offerRow(u, k + 2, null))];
    const w = world({ waitlist: queue, ev: { waitlist_count: 1250 }, dbMaxRows: 1000 });
    const r = await leave();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [1250], JSON.stringify(eventsUpdates(w.writes)));
  });
});
