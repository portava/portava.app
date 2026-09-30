/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; the round-18 verifier's B14 and B18, and its Z27 / Z28 fixture):
 * GET /api/events never serves a failed RSVP count as a measured value, and its `near*` filter keeps every event
 * within the radius — across the 180th meridian, near a pole and at the radius's own edge.
 *
 * B14. The list (and GET /events/city/:city) recounts `going_count` live from `event_rsvps`. The read's `error` was
 * never read, so a failed read overwrote every row's cached count with 0 and served `goingCount: 0` — a failed read as
 * a measured value, which also fed the ranking. A failed read now keeps the cached count and names the read in
 * `failedSources`; a healthy answer is byte-identical (no new key).
 *
 *   EV2   the rsvps read FAILS → the cached count (12), never 0; `failedSources: ["event_rsvps"]`
 *   EV2b  the same on GET /events/city/:city
 *   EV0c  CONTROL: the rsvps read answers 3 going → goingCount 3, the body keeps its keys
 *   EV0d  CONTROL: the same on GET /events/city/:city
 *
 * B18. The near filter's query box did not wrap at the antimeridian, clamped cos(lat) at 0.2 (narrower than the radius
 * above ~78.5°), and used 111.32 km per degree while the distance filter uses a 6371 km earth (111.19 km per degree),
 * so the box was narrower than the radius everywhere. Events inside the radius were dropped in the query, unsaid.
 *
 *   EA1   an event ~10 km east, across the antimeridian → listed
 *   EA2   the mirror: the viewer east of the line, an event ~10 km west across it → listed
 *   EA3   across the antimeridian, 200 earlier events elsewhere do not crowd the nearby one out of the rank pool
 *         (the wrapped box is in the query: two longitude ranges)
 *   EP1   80°N, an event 45 km east (inside a 50 km radius) → listed
 *   EP2   89.8°N, an event across the pole (~45 km, at the opposite longitude) → listed
 *   EP3   80°N, 200 earlier events elsewhere do not crowd the nearby one out (the box is still in the query)
 *   EB1   an event 49.97 km due north of the viewer, radius 50 → listed (the box is no narrower than the radius)
 *   EA0, EP0, EB0  CONTROLS: an event on the same side, 20 km east at 80°N, 50.05 km north (outside) → as expected
 *
 * Z27 / Z28 (the verifier's NR1, NR2): the radius clamp and the default radius are load-bearing.
 *
 *   NR1   radius 100 km → an event 80 km away is listed (the clamp is not below 100)
 *   NR2   no radius (default 25 km) → an event 20 km away is listed
 *   NR3   radius 900 km → clamped to 500: an event 550 km away is not listed, one 450 km away is
 *   NR4   a radius of 0 (NR4b: below 0) → the default 25 km: an event 20 km away is listed, one 30 km away is not
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
const KM_PER_DEG = (6371 * Math.PI) / 180;

type Pred = (r: Row) => boolean;
/** One PostgREST filter term (`col.op.value`) or a nested `and(...)` / `or(...)`. */
function term(t: string): Pred {
  const nested = /^(and|or)\((.*)\)$/.exec(t);
  if (nested) { const parts = splitTop(nested[2]).map(term); return nested[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r)); }
  const m = /^([a-z_]+)\.(gte|lte|gt|lt|eq)\.(.*)$/.exec(t);
  if (!m) throw new Error(`unsupported or-term: ${t}`);
  const [, c, op, raw] = m; const v = Number(raw);
  return (r) => { const x = r[c] as number; if (x == null) return false; return op === "gte" ? x >= v : op === "lte" ? x <= v : op === "gt" ? x > v : op === "lt" ? x < v : x === v; };
}
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}

/** A read-only PostgREST-shaped double: the operators GET /events issues (`.or()` included), errors resolved, never thrown. */
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
      or: (expr: string) => { if (name === "events") { const p = term(`or(${expr})`); rows = rows.filter(p); } return q; },
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return q; },
      insert: () => Promise.resolve({ data: null, error: null }),
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
const RSVPS_FAIL = { rows: [], error: { message: "canceling statement due to statement timeout" } };

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
  return { status: res.status, body, seen: JSON.stringify({ status: res.status, n: body.events?.length, going: body.events?.map((e) => e.goingCount), truncated: body.truncated, failedSources: body.failedSources, keys: Object.keys(body) }) };
}
const list = (tables: Tables, query: string) => get(tables, `events?${query}`);
const ids = (r: { body: { events?: Array<{ id: string }> } }) => (r.body.events ?? []).map((e) => e.id);

describe("census-discovery §116 (B14): a failed RSVP count is never served as a measured 0", () => {
  // A fresh row per call: the route writes the live count onto the row it read.
  const e0 = () => event(1, LISBON, { going_count: 12 });
  const going3 = { rows: [0, 1, 2].map((i) => ({ event_id: e0().id, status: "going", user_id: `u${i}` })) };
  it("EV0c CONTROL: the rsvps read answers → goingCount is the live count; the body keeps its keys", async () => {
    const r = await list({ events: { rows: [e0()] }, event_rsvps: going3 }, "limit=50");
    assert.equal(r.body.events?.[0]?.goingCount, 3, r.seen);
    assert.deepEqual(Object.keys(r.body).sort(), ["events", "limit", "page", "sessionId"], r.seen);
  });
  it("EV2 the rsvps read FAILS → the cached count, never 0, and the read is named in failedSources", async () => {
    const r = await list({ events: { rows: [e0()] }, event_rsvps: RSVPS_FAIL }, "limit=50");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.body.events?.[0]?.goingCount, 12, `a failed count read served as a measured value: ${r.seen}`);
    assert.deepEqual(r.body.failedSources, ["event_rsvps"], r.seen);
  });
  it("EV0d CONTROL: GET /events/city/:city, the rsvps read answers → the live count; the body keeps its keys", async () => {
    const r = await get({ events: { rows: [e0()] }, event_rsvps: going3 }, "events/city/Lisbon");
    assert.equal(r.body.events?.[0]?.goingCount, 3, r.seen);
    assert.deepEqual(Object.keys(r.body).sort(), ["events", "limit", "page"], r.seen);
  });
  it("EV2b GET /events/city/:city, the rsvps read FAILS → the cached count, never 0, and the read is named", async () => {
    const r = await get({ events: { rows: [e0()] }, event_rsvps: RSVPS_FAIL }, "events/city/Lisbon");
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.body.events?.[0]?.goingCount, 12, `a failed count read served as a measured value: ${r.seen}`);
    assert.deepEqual(r.body.failedSources, ["event_rsvps"], r.seen);
  });
});

describe("census-discovery §116 (B18): GET /events' near filter keeps every event within the radius", () => {
  const TAVEUNI = { lat: -16.82, lng: 179.98 };
  const near = (p: { lat: number; lng: number }, km?: number) => `nearLat=${p.lat}&nearLng=${p.lng}${km == null ? "" : `&nearRadiusKm=${km}`}&limit=50`;
  it("EA0 CONTROL: an event ~10 km west, same side of the 180th meridian → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: -16.82, lng: 179.886 })] } }, near(TAVEUNI, 50));
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("EA1 an event ~10 km east, across the antimeridian → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: -16.82, lng: -179.926 })] } }, near(TAVEUNI, 50));
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.body.events?.length, 1, `an event 10 km away dropped by the box: ${r.seen}`);
  });
  it("EA2 the mirror: the viewer just east of the line, an event ~10 km west across it → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: -16.82, lng: 179.95 })] } }, near({ lat: -16.82, lng: -179.95 }, 50));
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("EA3 across the antimeridian, 200 earlier events elsewhere do not crowd the nearby one out of the rank pool", async () => {
    const far = Array.from({ length: 200 }, (_v, i) => event(i, { lat: -16.82, lng: 0 }));
    const nearby = event(500, { lat: -16.82, lng: -179.926 });
    const r = await list({ events: { rows: [...far, nearby] } }, near(TAVEUNI, 50));
    assert.deepEqual(ids(r), [nearby.id], r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EP0 CONTROL: 80°N, an event 20 km east → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: 80, lng: 15 + 20 / (111.32 * Math.cos((80 * Math.PI) / 180)) })] } }, near({ lat: 80, lng: 15 }, 50));
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("EP1 80°N, an event 45 km east (inside a 50 km radius) → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: 80, lng: 15 + 45 / (111.32 * Math.cos((80 * Math.PI) / 180)) })] } }, near({ lat: 80, lng: 15 }, 50));
    assert.equal(r.body.events?.length, 1, `an event 45 km away dropped by the box: ${r.seen}`);
  });
  it("EP2 89.8°N, an event across the pole (~45 km, at the opposite longitude) → listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: 89.8, lng: -165 })] } }, near({ lat: 89.8, lng: 15 }, 50));
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("EP3 80°N, 200 earlier events elsewhere do not crowd the nearby one out (the box is still in the query)", async () => {
    const far = Array.from({ length: 200 }, (_v, i) => event(i, PORTO));
    const nearby = event(500, { lat: 80, lng: 15 + 45 / (111.32 * Math.cos((80 * Math.PI) / 180)) });
    const r = await list({ events: { rows: [...far, nearby] } }, near({ lat: 80, lng: 15 }, 50));
    assert.deepEqual(ids(r), [nearby.id], r.seen);
    assert.equal("truncated" in r.body, false, r.seen);
  });
  it("EB1 an event 49.97 km due north, radius 50 → listed (the box is no narrower than the radius)", async () => {
    const r = await list({ events: { rows: [event(1, { lat: LISBON.lat + 49.97 / KM_PER_DEG, lng: LISBON.lng })] } }, near(LISBON, 50));
    assert.equal(r.body.events?.length, 1, `an event inside the radius dropped by the box: ${r.seen}`);
  });
  it("EB0 CONTROL: an event 50.05 km due north, radius 50 → not listed", async () => {
    const r = await list({ events: { rows: [event(1, { lat: LISBON.lat + 50.05 / KM_PER_DEG, lng: LISBON.lng })] } }, near(LISBON, 50));
    assert.equal(r.body.events?.length, 0, r.seen);
  });
});

describe("census-discovery §116 (Z27, Z28): GET /events' near radius clamp and default are load-bearing", () => {
  const north = (km: number) => ({ lat: LISBON.lat + km / KM_PER_DEG, lng: LISBON.lng });
  it("NR1 radius 100 km → an event 80 km away is listed", async () => {
    const r = await list({ events: { rows: [event(1, north(80))] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=100&limit=15`);
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("NR2 no radius (default 25 km) → an event 20 km away is listed", async () => {
    const r = await list({ events: { rows: [event(1, north(20))] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&limit=15`);
    assert.equal(r.body.events?.length, 1, r.seen);
  });
  it("NR3 radius 900 km → clamped to 500: an event 450 km away is listed, one 550 km away is not", async () => {
    const r = await list({ events: { rows: [event(1, north(450)), event(2, north(550))] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=900&limit=15`);
    assert.deepEqual(ids(r), [event(1, null).id], r.seen);
  });
  it("NR4 a radius of 0 → the default 25 km: 20 km listed, 30 km not", async () => {
    const r = await list({ events: { rows: [event(1, north(20)), event(2, north(30))] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=0&limit=15`);
    assert.deepEqual(ids(r), [event(1, null).id], r.seen);
  });
  it("NR4b a radius of -5 → the default 25 km: 20 km listed, 30 km not", async () => {
    const r = await list({ events: { rows: [event(1, north(20)), event(2, north(30))] } }, `nearLat=${LISBON.lat}&nearLng=${LISBON.lng}&nearRadiusKm=-5&limit=15`);
    assert.deepEqual(ids(r), [event(1, null).id], r.seen);
  });
});
