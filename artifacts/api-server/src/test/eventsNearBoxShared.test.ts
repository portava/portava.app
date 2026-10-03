/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's V8 and V9, fixtures NS1 and NA0): GET
 * /events' near filter is lib/nearBox's box (`nearBox` + `applyNearBox`), not a private copy of it.
 *
 * Round 19 (B18) wrote the box twice: lib/nearBox.ts for the four other near reads (SW13) and a copy at events.ts' foot
 * for GET /events. The copy was pinned at the north pole and across the line, but not at the south pole (V8:
 * `Math.abs(lat)` dropped) or on the viewer's own side west of -180° (V9: the second range dropped). GET /events now
 * builds its box with lib/nearBox, which NB1/NB2 pin, and these fixtures pin it through the route.
 *
 *   NS0  CONTROL: 89.8°N, an event across the north pole (~44 km, the opposite longitude) → listed
 *   NS1  89.8°S, an event across the SOUTH pole (~44 km) → listed (V8's fixture)
 *   NA0  a viewer just east of the line (lng -179.98), an event ~10 km further east on the viewer's own side → listed
 *        (V9's fixture: the west < -180 box's own-side range)
 *   NA1  the mirror: a viewer just west of the line (lng 179.98), an event ~10 km further west on its own side → listed
 *   NA2  CONTROL: the same viewer as NA0, an event 60 km away across the line → not listed (outside the 50 km radius)
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";

// ── the route ─────────────────────────────────────────────────────────────────
interface Row { [k: string]: unknown }
type Tables = Record<string, { rows: Row[] }>;
const VIEWER = "00000000-0000-0000-0002-0000000000e1"; const HOST = "00000000-0000-0000-0001-0000000000e1";
type Pred = (r: Row) => boolean;
function term(t: string): Pred {
  const nested = /^(and|or)\((.*)\)$/.exec(t);
  if (nested) { const parts = splitTop(nested[2]!).map(term); return nested[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r)); }
  const m = /^([a-z_]+)\.(gte|lte|gt|lt|eq)\.(.*)$/.exec(t);
  if (!m) throw new Error(`unsupported or-term: ${t}`);
  const [, c, op, raw] = m; const v = Number(raw);
  return (r) => { const x = r[c!] as number; if (x == null) return false; return op === "gte" ? x >= v : op === "lte" ? x <= v : op === "gt" ? x > v : op === "lt" ? x < v : x === v; };
}
function splitTop(s: string): string[] { const out: string[] = []; let d = 0; let cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; } if (cur) out.push(cur); return out; }
function makeClient(tables: Tables) {
  function chain(name: string) {
    let rows = [...(tables[name]?.rows ?? [])]; let limit: number | null = null;
    const q: any = {
      select: () => q, eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; }, neq: () => q,
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) >= v); return q; },
      lte: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) <= v); return q; },
      ilike: () => q, is: () => q, not: (c: string) => { rows = rows.filter((r) => r[c] != null); return q; },
      or: (expr: string) => { if (name === "events") rows = rows.filter(term(`or(${expr})`)); return q; },
      order: () => q, limit: (n: number) => { limit = n; return q; }, range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return q; },
      insert: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "No rows" } }),
      then: (res: any, rej: any) => Promise.resolve({ data: limit === null ? rows : rows.slice(0, limit), error: null }).then(res, rej),
    };
    return q;
  }
  return { from: (n: string) => chain(n), rpc: () => Promise.resolve({ data: [], error: null }),
    auth: { getUser: async (t: string) => (t === `tok-${VIEWER}` ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) } };
}
function event(i: number, at: { lat: number; lng: number }): Row {
  return { id: `00000000-0000-0000-00e0-${String(i).padStart(12, "0")}`, host_id: HOST, title: `E${i}`, description: null, location_name: "x",
    location_lat: at.lat, location_lng: at.lng, starts_at: new Date(Date.now() + 3_600_000).toISOString(), ends_at: null, cover_url: null, max_attendees: null,
    age_min: null, age_max: null, trust_score_min: null, verified_only: false, visibility: "public", state: "open", chat_enabled: false, chat_thread_id: null,
    waitlist_enabled: false, price_type: "free", price_url: null, rsvp_options: ["going"], going_count: 0, waitlist_count: 0, category: "music", city: "Pole",
    country: "AQ", show_exact_location: true, rsvp_closed: false, tags: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}
let server: http.Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });
async function list(rows: Row[], q: string) {
  _setTestClient(makeClient({ feature_flags: { rows: [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }] }, events: { rows } }) as never, true);
  const app = express(); app.use((req, _r, n) => { (req as any).log = { error() {}, warn() {}, info() {} }; n(); }); app.use("/api", eventsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const res = await fetch(`http://127.0.0.1:${(server!.address() as any).port}/api/events?${q}`, { headers: { authorization: `Bearer tok-${VIEWER}` } });
  const body: any = await res.json();
  return { n: (body.events ?? []).length, seen: JSON.stringify({ status: res.status, n: (body.events ?? []).length, keys: Object.keys(body) }) };
}
describe("census-discovery §117 (V8, V9): GET /events' near box is lib/nearBox's, at either pole and on either side of the line", () => {
  it("NS0 CONTROL: 89.8°N, an event across the north pole (~44 km) → listed", async () => {
    const r = await list([event(1, { lat: 89.8, lng: -165 })], "nearLat=89.8&nearLng=15&nearRadiusKm=50&limit=50");
    assert.equal(r.n, 1, r.seen);
  });
  it("NS1 89.8°S, an event across the south pole (~44 km) → listed", async () => {
    const r = await list([event(1, { lat: -89.8, lng: -165 })], "nearLat=-89.8&nearLng=15&nearRadiusKm=50&limit=50");
    assert.equal(r.n, 1, r.seen);
  });
  it("NA0 a viewer just east of the line (lng -179.98), an event ~10 km east on the viewer's own side → listed", async () => {
    const r = await list([event(1, { lat: -16.82, lng: -179.886 })], "nearLat=-16.82&nearLng=-179.98&nearRadiusKm=50&limit=50");
    assert.equal(r.n, 1, r.seen);
  });
  it("NA1 the mirror: a viewer just west of the line (lng 179.98), an event ~10 km west on its own side → listed", async () => {
    const r = await list([event(1, { lat: -16.82, lng: 179.886 })], "nearLat=-16.82&nearLng=179.98&nearRadiusKm=50&limit=50");
    assert.equal(r.n, 1, r.seen);
  });
  it("NA2 CONTROL: the NA0 viewer, an event ~60 km away across the line → not listed", async () => {
    const r = await list([event(1, { lat: -16.82, lng: 179.457 })], "nearLat=-16.82&nearLng=-179.98&nearRadiusKm=50&limit=50");
    assert.equal(r.n, 0, r.seen);
  });
});
