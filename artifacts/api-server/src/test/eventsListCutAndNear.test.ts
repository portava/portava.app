/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B12, server leg): GET /api/events says
 * when its answer is not the whole list, and honours `nearLat` / `nearLng` / `nearRadiusKm`.
 *
 * The NOW map's rollback path reads its events layer through GET /events (`listEvents({ nearLat, nearLng,
 * nearRadiusKm: 50, limit: 60 })`). The route capped the page at 50, ranked a 200-row chronological pool, sent no cut
 * signal and ignored the `near*` parameters entirely, so the map drew page one of events from anywhere as the whole
 * nearby layer. A healthy, whole answer is byte-identical to before: `truncated: true` is added only to an answer that
 * is not whole.
 *
 *   EC1  more ranked events than the page → `truncated: true` (a page of several)
 *   EC2  the 200-row rank pool was filled → `truncated: true` (events past the pool were never ranked)
 *   EC3  the friendships read failed → friends-only events were withheld unchecked → `truncated: true`
 *   EN1  `nearLat`/`nearLng`/`nearRadiusKm` → only located events within the radius (by distance, not the box)
 *   EN2  the near filter is in the query, so events elsewhere cannot fill the rank pool first
 *   EC0  CONTROL: a whole page (every ranked event fits) → no `truncated` key at all; no `near*` → events anywhere
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";

interface Row { [k: string]: unknown }
type Tables = Record<string, { rows: Row[]; error?: { message: string } }>;

const VIEWER = "00000000-0000-0000-0002-0000000000e1";
const HOST = "00000000-0000-0000-0001-0000000000e1";
const LISBON = { lat: 38.72, lng: -9.14 };
const PORTO = { lat: 41.15, lng: -8.61 };

/** A read-only PostgREST-shaped double: the operators GET /events issues, errors resolved, never thrown. */
function makeClient(tables: Tables) {
  function chain(name: string) {
    const spec = tables[name] ?? { rows: [] };
    let rows = [...spec.rows];
    let limit: number | null = null;
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
      order: () => q, range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return q; },  // census-discovery §117 (B21): the paged reads, as PostgREST answers them
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: () => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: rows[0] ?? null, error: rows[0] ? null : { message: "No rows" } }),
      then: (res, rej) => Promise.resolve(spec.error ? { data: null, error: spec.error } : { data: limit === null ? rows : rows.slice(0, limit), error: null }).then(res, rej),
    };
    return q;
  }
  return {
    from: (name: string) => chain(name),
    rpc: () => Promise.resolve({ data: [], error: null }),
    auth: { getUser: async (t: string) => (t === `tok-${VIEWER}` ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "Invalid token" } }) },
  };
}

function event(i: number, at: { lat: number; lng: number } | null, over: Row = {}): Row {
  return {
    id: `00000000-0000-0000-00e0-${String(i).padStart(12, "0")}`, host_id: HOST, title: `Event ${i}`, description: null, location_name: "Somewhere",
    location_lat: at?.lat ?? null, location_lng: at?.lng ?? null, starts_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(), ends_at: null,
    cover_url: null, max_attendees: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, visibility: "public", state: "open",
    chat_enabled: false, chat_thread_id: null, waitlist_enabled: false, price_type: "free", price_url: null, rsvp_options: ["going"], going_count: 0,
    waitlist_count: 0, category: "music", city: "Lisbon", country: "PT", show_exact_location: true, rsvp_closed: false, tags: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  };
}
const FLAGS = { rows: [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }] };

let server: http.Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

async function list(tables: Tables, query: string) {
  _setTestClient(makeClient({ feature_flags: FLAGS, ...tables }) as never, true);
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { log: object }).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", eventsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const port = (server!.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/events?${query}`, { headers: { authorization: `Bearer tok-${VIEWER}` } });
  const body = (await res.json()) as { events?: Array<{ id: string }>; truncated?: boolean; [k: string]: unknown };
  return { status: res.status, body, seen: JSON.stringify({ status: res.status, n: body.events?.length, truncated: body.truncated, keys: Object.keys(body) }) };
}

describe("census-discovery §115 (B12): GET /events says a cut answer and honours near*", () => {
  it("EC0 CONTROL: a whole page → no `truncated` key; the body keeps its keys", async () => {
    const r = await list({ events: { rows: [event(1, LISBON), event(2, PORTO)] } }, "limit=50");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.body.events?.length, 2, r.seen);
    assert.deepEqual(Object.keys(r.body).sort(), ["events", "limit", "page", "sessionId"], r.seen);
  });
  it("EC1 more ranked events than the page → truncated", async () => {
    const r = await list({ events: { rows: Array.from({ length: 7 }, (_v, i) => event(i, LISBON)) } }, "limit=5");
    assert.equal(r.body.events?.length, 5, r.seen);
    assert.equal(r.body.truncated, true, `a page of several served as the whole list: ${r.seen}`);
  });
  it("EC1c CONTROL: exactly a page (nothing past it) → no truncated", async () => {
    const r = await list({ events: { rows: Array.from({ length: 5 }, (_v, i) => event(i, LISBON)) } }, "limit=5");
    assert.equal(r.body.events?.length, 5, r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EC2 the 200-row rank pool was filled → truncated (events past it were never ranked)", async () => {
    const r = await list({ events: { rows: Array.from({ length: 201 }, (_v, i) => event(i, LISBON)) } }, "limit=50&page=5");
    assert.equal(r.body.events?.length, 0, r.seen);
    assert.equal(r.body.truncated, true, `a cut rank pool served as the whole list: ${r.seen}`);
  });
  it("EC2c CONTROL: exactly 200 rows, the last page → whole", async () => {
    const r = await list({ events: { rows: Array.from({ length: 200 }, (_v, i) => event(i, LISBON)) } }, "limit=50&page=4");
    assert.equal(r.body.events?.length, 50, r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EC3 the friendships read failed → friends-only events withheld unchecked → truncated", async () => {
    const r = await list({ events: { rows: [event(1, LISBON), event(2, LISBON, { visibility: "friends_only" })] }, user_friendships: { rows: [], error: { message: "statement timeout" } } }, "limit=50");
    assert.equal(r.body.events?.length, 1, r.seen);
    assert.equal(r.body.truncated, true, `friends-only events withheld over a failed read, unsaid: ${r.seen}`);
  });
  it("EC3c CONTROL: the friendships read answered (not friends) → the friends-only event is withheld, whole", async () => {
    const r = await list({ events: { rows: [event(1, LISBON), event(2, LISBON, { visibility: "friends_only" })] } }, "limit=50");
    assert.equal(r.body.events?.length, 1, r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EN1 near* → only located events within the radius", async () => {
    // event 5 sits inside the radius's bounding box but ~62 km away (a corner): the distance, not the box, decides.
    const r = await list({ events: { rows: [event(1, LISBON), event(2, PORTO), event(3, null), event(4, { lat: 38.9, lng: -9.14 }), event(5, { lat: 38.72 + 0.4, lng: -9.14 + 0.5 })] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=50&limit=50`);
    assert.deepEqual(r.body.events?.map((e) => e.id).sort(), [event(1, LISBON).id, event(4, null).id].sort(), r.seen);
  });
  it("EN2 near* is applied in the query: 200 earlier events elsewhere do not crowd a nearby one out of the rank pool", async () => {
    const far = Array.from({ length: 200 }, (_v, i) => event(i, PORTO));
    const nearby = event(500, LISBON);
    const r = await list({ events: { rows: [...far, nearby] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=50&limit=50`);
    assert.deepEqual(r.body.events?.map((e) => e.id), [nearby.id], r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EN0 CONTROL: no near* → events anywhere, located or not", async () => {
    const r = await list({ events: { rows: [event(1, LISBON), event(2, PORTO), event(3, null)] } }, "limit=50");
    assert.equal(r.body.events?.length, 3, r.seen);
  });
});
