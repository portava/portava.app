/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-132): `loadNearbyEvents` (routes/mapSearch.ts) never
 * states a cut scan as complete.
 *
 * It read the box's events with `.limit(60)`, no order and — for GET /map/search, the NOW gateway and the temporal
 * forecast — no time window, so past and completed events filled the scan and the event that mattered was never
 * read; every caller then named `events` as a complete source (the round-15 verifier's B4).
 *
 *   V15-NE0  CONTROL (the verifier's): one upcoming event → forecast.events 1, `events` named
 *   V15-NE1  (the verifier's) 60 past events ahead of the upcoming one → never `events: 0` stated as read
 *   V15-NE2c CONTROL (the verifier's): /map/search q=jazz, the jazz event alone → found
 *   V15-NE2  (the verifier's) /map/search q=jazz over the same scan → never "nothing matched" with no refusal
 *   NE3      the window: the forecast reads the target's window, so 70 past events do not hide the upcoming one
 *   NE4      the order: 61 later events ahead of a live one → the live one is read (starts_at first), and the cut said
 *   NE5      the NOW gateway over a cut scan (61 events in the window) → `events` is not named as read
 *   NE6      the forecast over a cut scan → no events count is stated, and `events` is not named
 *   NE7      /map/search over a cut scan → the event source is `events_capped`
 *   NE8      the boundary: exactly 60 events in the window → a whole read, refusal null, `events` named
 *   NE9      the NOW gateway and search read a forward window: an event that ended last week is not served
 *   NE10     the forecast's window has an upper bound: 60 events that start after the target do not cut its read
 *   NE11     (mapInferredCause) the §10 cause over a cut scan reports eventsReadFailed
 *   NE12     the forward window keeps a live event with no end that started within the assumed duration
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import temporalRouter from "../routes/mapProjectionTemporal.js";
import mapSearchRouter from "../routes/mapSearch.js";
import mapProjectionRouter, { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-000000000017";
const TOKEN = "tok-r16-nearby";
const HOST = "ab000000-0000-4000-a000-0000000000f5";
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 3_600_000; const D = 24 * H;
let n = 0;
const ev = (startMs: number, endMs: number | null, over: Record<string, unknown> = {}) => {
  n += 1;
  return { id: `e1000000-0000-4000-a000-${String(n).padStart(12, "0")}`, host_id: HOST, title: `Event ${n}`, location_name: "Club", location_lat: 38.72, location_lng: -9.14, show_exact_location: true, starts_at: iso(startMs), ends_at: endMs === null ? null : iso(endMs), cover_url: null, visibility: "public", state: "open", age_min: null, age_max: null, trust_score_min: null, verified_only: false, ...over };
};
const past = (count: number) => Array.from({ length: count }, (_, i) => ev(-7 * D - i * H, -7 * D - i * H + 2 * H, { state: i % 2 ? "completed" : "open" }));

/** A fake that honours what PostgREST does: filters, `.or` over simple `col.op.value` terms, `.order` and `.limit`. */
function buildQuery(rowsIn: any[]) {
  let rows = [...rowsIn];
  let cap: number | null = null;
  const cmp = (a: any, op: string, v: any) => a != null && (op === "gte" ? a >= v : op === "lte" ? a <= v : op === "gt" ? a > v : op === "lt" ? a < v : op === "eq" ? String(a) === v : false);
  const out = () => (cap == null ? rows : rows.slice(0, cap));
  const q: any = {
    select() { return q; }, range() { return q; }, ilike() { return q; }, contains() { return q; }, is() { return q; },
    not(c: string, op: string, v: string) { if (op === "in") { const vs = v.replace(/[()"]/g, "").split(","); rows = rows.filter((r) => !vs.includes(r[c])); } return q; },
    or(expr: string) {
      if (expr.includes("and(")) return q;
      const terms = expr.split(",").map((t) => { const [c, op, ...v] = t.split("."); return { c, op, v: v.join(".") }; });
      rows = rows.filter((r) => terms.some((t) => cmp(r[t.c], t.op, t.v)));
      return q;
    },
    order(c: string, o?: { ascending?: boolean }) { const asc = o?.ascending !== false; rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] < b[c]) === asc ? -1 : 1)); return q; },
    limit(k: number) { cap = k; return q; },
    gte(c: string, v: any) { rows = rows.filter((r) => r[c] >= v); return q; },
    lte(c: string, v: any) { rows = rows.filter((r) => r[c] <= v); return q; },
    gt(c: string, v: any) { rows = rows.filter((r) => r[c] > v); return q; },
    lt(c: string, v: any) { rows = rows.filter((r) => r[c] < v); return q; },
    eq(c: string, v: any) { rows = rows.filter((r) => !(c in r) || r[c] === v); return q; },
    neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return q; },
    in(c: string, vs: any[]) { rows = rows.filter((r) => !(c in r) || vs.includes(r[c])); return q; },
    maybeSingle() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    single() { return Promise.resolve({ data: out()[0] ?? null, error: null }); },
    then(res: any, rej?: any) { return Promise.resolve({ data: out(), error: null }).then(res, rej); },
  };
  return q;
}
function client(events: any[]) {
  const state: Record<string, any[]> = {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }, { flag: "map_search_enabled", enabled: true }],
    events,
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: (t: string) => buildQuery(state[t] ?? []), rpc: () => Promise.resolve({ data: [], error: null }) };
}
let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", temporalRouter); app.use("/api", mapSearchRouter); app.use("/api", mapProjectionRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _clearProtectedZoneCache());
async function call(events: any[], path: string) {
  const c = client(events); _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}
const FORECAST = `/map/projection/temporal?bbox=-9.2,38.7,-9.1,38.75&zoom=14&offsetMinutes=90`;
const NOW = `/map/projection?bbox=-9.2,38.7,-9.1,38.75&zoom=14&kinds=event`;
const search = (q = "") => `/map/search?lat=38.72&lng=-9.14&radiusKm=5&types=event${q ? `&q=${q}` : ""}`;
const upcoming = (over: Record<string, unknown> = {}) => ev(1 * H, 3 * H, over);
/** `count` events that all cover the forecast target (+90 min) and are all in the NOW window. */
const inWindow = (count: number) => Array.from({ length: count }, (_, i) => ev(1 * H - i * 30_000, 3 * H));

describe("§113 (D-W11X2-132): loadNearbyEvents over a cut scan", () => {
  it("V15-NE0 CONTROL: one upcoming event → forecast.events 1, events named", async () => {
    const { status, body } = await call([upcoming()], FORECAST);
    assert.equal(status, 200); assert.equal(body.forecast.events, 1); assert.ok(body.sources.includes("events"));
  });
  it("V15-NE1 60 past events fill the scan ahead of the upcoming one → never `events: 0` stated as read", async () => {
    const { status, body } = await call([...past(60), upcoming()], FORECAST);
    assert.equal(status, 200);
    assert.ok(!(body.forecast?.events === 0 && body.sources.includes("events")), `a scan cut at 60 rows stated as "no events forecast": ${JSON.stringify({ events: body.forecast?.events, sources: body.sources })}`);
  });
  it("V15-NE2c CONTROL: /map/search q=jazz, the jazz event alone → found", async () => {
    const { status, body } = await call([upcoming({ title: "Jazz night" })], search("jazz"));
    assert.equal(status, 200); assert.equal(body.results.length, 1);
  });
  it("V15-NE2 /map/search q=jazz: 60 past events ahead of the jazz event → never an empty answer with sources.event.refusal null", async () => {
    const { status, body } = await call([...past(60), upcoming({ title: "Jazz night" })], search("jazz"));
    assert.ok(!(status === 200 && body.results.length === 0 && body.sources?.event?.refusal === null), `"nothing matched" over an event scan cut at 60: ${JSON.stringify({ results: body.results?.length, sources: body.sources })}`);
  });

  it("NE3 the window: 70 past events do not hide the upcoming one from the forecast", async () => {
    const { body } = await call([...past(70), upcoming()], FORECAST);
    assert.equal(body.forecast.events, 1, JSON.stringify(body.forecast));
    assert.ok(body.sources.includes("events"), JSON.stringify(body.sources));
  });
  it("NE4 the order: 61 later events ahead of a live one → the live one is read first, and the cut is said", async () => {
    const later = Array.from({ length: 61 }, (_, i) => ev(2 * D + i * H, 2 * D + i * H + 2 * H));
    const { status, body } = await call([...later, ev(-1 * H, 2 * H, { title: "Live jazz" })], search("live"));
    assert.equal(status, 200);
    assert.equal(body.results.length, 1, JSON.stringify(body.sources));
    assert.equal(body.sources.event.refusal, "events_capped");
  });
  it("NE5 the NOW gateway over a cut scan (61 events in the window) → `events` is not named as read", async () => {
    const { status, body } = await call(inWindow(61), NOW);
    assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
    assert.equal(body.sources.includes("events"), false, JSON.stringify(body.sources));
  });
  it("NE6 the forecast over a cut scan → no events count is stated, and `events` is not named", async () => {
    const { body } = await call(inWindow(61), FORECAST);
    assert.equal(body.forecast.events, null, JSON.stringify(body.forecast));
    assert.equal(body.sources.includes("events"), false, JSON.stringify(body.sources));
  });
  it("NE7 /map/search over a cut scan → the event source is events_capped", async () => {
    const { body } = await call(inWindow(61), search());
    assert.equal(body.sources.event.refusal, "events_capped", JSON.stringify(body.sources));
    assert.equal(body.sources.event.collected, 60);
  });
  it("NE8 the boundary: exactly 60 events in the window → a whole read", async () => {
    const sixty = () => inWindow(60);
    const s = await call(sixty(), search());
    assert.equal(s.body.sources.event.refusal, null, JSON.stringify(s.body.sources));
    const g = await call(sixty(), NOW);
    assert.ok(g.body.sources.includes("events"), JSON.stringify(g.body.sources));
    const f = await call(sixty(), FORECAST);
    assert.equal(f.body.forecast.events, 60);
  });
  it("NE9 the NOW gateway and search read a forward window: an event that ended last week is not served", async () => {
    const old = ev(-7 * D, -7 * D + 2 * H, { title: "Old jazz" });
    const s = await call([old], search("jazz"));
    assert.equal(s.body.results.length, 0, JSON.stringify(s.body.results));
    assert.equal(s.body.sources.event.refusal, null);
    const g = await call([old], NOW);
    assert.equal((g.body.objects ?? []).length, 0, JSON.stringify(g.body.objects));
  });
  it("NE10 the forecast window's upper bound: 60 events starting after the target do not cut the forecast's read", async () => {
    const later = Array.from({ length: 60 }, (_, i) => ev(6 * H + i * 60_000, 8 * H));
    const { body } = await call([upcoming(), ...later], FORECAST);
    assert.equal(body.forecast.events, 1, JSON.stringify(body.forecast));
    assert.ok(body.sources.includes("events"), JSON.stringify(body.sources));
  });
  it("NE12 the forward window keeps a live event with no end that started within the assumed duration", async () => {
    const live = ev(-1 * H, null, { title: "Open mic" });
    const s = await call([live], search("open"));
    assert.equal(s.body.results.length, 1, JSON.stringify(s.body.sources));
    const g = await call([live], NOW);
    assert.equal((g.body.objects ?? []).length, 1);
  });
});
