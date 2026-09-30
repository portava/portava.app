/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-137): the round's sweep over the Discovery ranking's trail
 * keys and the hashtag routes.
 *
 *   DV1  loadTrailKeys: a trail-membership read cut at MAX_TRAIL_KEY_ROWS is degraded (reported), never whole
 *   DV1c CONTROL: exactly MAX_TRAIL_KEY_ROWS rows → not degraded
 *   HT1  GET /hashtags/:slug: the viewer's follow read fails → isFollowing null and failedSources names it, never false
 *   HT2  GET /hashtags/:slug: the 30-day usage tally is cut at its cap → topCity is not stated (null)
 *   HT3  GET /hashtags/:slug: the usage read fails → topCity null, failedSources names it
 *   HT4  GET /hashtags/suggestions: the follow read fails → isFollowing null on every suggestion, failedSources named
 *   HT5  POST and DELETE /hashtags/:slug/follow: the hashtag read fails → 503 degraded_unavailable, never 404 "not found"
 *   HTc  CONTROL: healthy reads → the bodies keep their keys (no failedSources), isFollowing true/false, topCity stated
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hashtagsRouter from "../routes/hashtags.js";
import { loadTrailKeys, MAX_TRAIL_KEY_ROWS } from "../lib/discoveryRankDiversity.js";

const TOKEN = "r16-sweep-token";
const USER = "ab000000-0000-4000-a000-0000000000c1";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const HT = { id: "11111111-2222-4333-8444-555555555555", slug: "jazz", name: "jazz", usage_count: 7, is_blocked: false, created_at: "2026-01-01T00:00:00.000Z" };

function buildQuery(rowsIn: any[], error: any = null) {
  let rows = [...rowsIn];
  let cap: number | null = null;
  const out = () => (cap == null ? rows : rows.slice(0, cap));
  const res = () => (error ? { data: null, error } : { data: out(), error: null });
  const q: any = {
    select() { return q; }, range() { return q; }, or() { return q; }, ilike() { return q; }, not() { return q; }, is() { return q; },
    order(c: string, o?: { ascending?: boolean }) { const asc = o?.ascending !== false; rows = [...rows].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] < b[c]) === asc ? -1 : 1)); return q; },
    limit(n: number) { cap = n; return q; },
    gte() { return q; }, lte() { return q; }, gt() { return q; }, lt() { return q; },
    eq(c: string, v: any) { rows = rows.filter((r) => !(c in r) || r[c] === v); return q; },
    neq(c: string, v: any) { rows = rows.filter((r) => r[c] !== v); return q; },
    in(c: string, vs: any[]) { rows = rows.filter((r) => !(c in r) || vs.includes(r[c])); return q; },
    upsert() { return q; }, delete() { return q; },
    maybeSingle() { return Promise.resolve(error ? { data: null, error } : { data: out()[0] ?? null, error: null }); },
    single() { return Promise.resolve(error ? { data: null, error } : { data: out()[0] ?? null, error: null }); },
    then(r: any, j?: any) { return Promise.resolve(res()).then(r, j); },
  };
  return q;
}
function client(state: Record<string, any[]>, fail: string[] = []) {
  const f = new Set(fail);
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "no" } }) },
    from: (t: string) => buildQuery(state[t] ?? [], f.has(t) ? ERR : null),
    rpc: async () => ({ data: [], error: null }),
  };
}
let server: http.Server; let base: string;
function call(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const r = http.request({ hostname: u.hostname, port: Number(u.port), path: u.pathname + u.search, method, headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); r.end();
  });
}
function use(state: Record<string, any[]>, fail: string[] = []) { const c = client(state, fail); _setTestClient(c as any, true); _setTestServiceClient(c as any); }
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req: any, _r, n) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; n(); });
  app.use("/api", hashtagsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))); });

const usage = (n: number, city: string) => Array.from({ length: n }, (_v, i) => ({ hashtag_id: HT.id, city, created_at: new Date(Date.now() - (i + 1) * 60_000).toISOString() }));
const world = (over: Record<string, any[]> = {}) => ({ hashtags: [HT], user_hashtag_follows: [{ user_id: USER, hashtag_id: HT.id }], hashtag_usage: usage(3, "Lisbon"), ...over });

describe("§113 (D-W11X2-137): the ranking's trail keys over a cut read", () => {
  const uuid = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const members = (n: number) => Array.from({ length: n }, (_v, i) => ({ trail_id: `t-${i}`, source_id: uuid(i % 3), source_type: "place", relationship: "primary" }));
  const db = (rows: any[]) => ({ from: (t: string) => buildQuery(t === "content_trails" ? rows : t === "trails" ? rows.map((r) => ({ id: r.trail_id })) : []) });
  it("DV1 a membership read cut at its cap → degraded, never a whole grouping", async () => {
    const r = await loadTrailKeys(db(members(MAX_TRAIL_KEY_ROWS + 1)), [uuid(0), uuid(1), uuid(2)]);
    assert.equal(r.degraded, true);
  });
  it("DV1c CONTROL: exactly the cap → not degraded", async () => {
    const r = await loadTrailKeys(db(members(MAX_TRAIL_KEY_ROWS)), [uuid(0), uuid(1), uuid(2)]);
    assert.equal(r.degraded, false);
  });
});

describe("§113 (D-W11X2-137): the hashtag routes over a failed or cut read", () => {
  it("HT1 GET /hashtags/:slug, the follow read fails → isFollowing null, failedSources names it", async () => {
    use(world(), ["user_hashtag_follows"]);
    const r = await call("GET", "/api/hashtags/jazz");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.isFollowing, null);
    assert.deepEqual(r.body.failedSources, ["user_hashtag_follows"]);
  });
  it("HT2 GET /hashtags/:slug, the usage tally is cut at its cap → topCity is not stated", async () => {
    use(world({ hashtag_usage: [...usage(150, "Porto"), ...usage(51, "Lisbon")] }));
    const r = await call("GET", "/api/hashtags/jazz");
    assert.equal(r.status, 200);
    assert.equal(r.body.topCity, null, JSON.stringify(r.body));
  });
  it("HT3 GET /hashtags/:slug, the usage read fails → topCity null, failedSources names it", async () => {
    use(world(), ["hashtag_usage"]);
    const r = await call("GET", "/api/hashtags/jazz");
    assert.equal(r.body.topCity, null);
    assert.deepEqual(r.body.failedSources, ["hashtag_usage"]);
  });
  it("HT4 GET /hashtags/suggestions, the follow read fails → isFollowing null, failedSources named", async () => {
    use(world(), ["user_hashtag_follows"]);
    const r = await call("GET", "/api/hashtags/suggestions?q=ja");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.suggestions.length, 1);
    assert.equal(r.body.suggestions[0].isFollowing, null);
    assert.deepEqual(r.body.failedSources, ["user_hashtag_follows"]);
  });
  it("HT5 follow and unfollow, the hashtag read fails → 503 degraded_unavailable, never 404", async () => {
    use(world(), ["hashtags"]);
    const f = await call("POST", "/api/hashtags/jazz/follow");
    assert.equal(f.status, 503, JSON.stringify(f.body)); assert.equal(f.body.error, "degraded_unavailable");
    const u = await call("DELETE", "/api/hashtags/jazz/follow");
    assert.equal(u.status, 503, JSON.stringify(u.body)); assert.equal(u.body.error, "degraded_unavailable");
  });
  it("HTc CONTROL: healthy reads → no failedSources key; isFollowing, topCity and the follow routes as before", async () => {
    use(world({ hashtag_usage: [...usage(5, "Porto"), ...usage(2, "Lisbon")] }));
    const r = await call("GET", "/api/hashtags/jazz");
    assert.equal(r.body.isFollowing, true); assert.equal(r.body.topCity, "Porto"); assert.equal("failedSources" in r.body, false);
    use(world({ user_hashtag_follows: [] }));
    const s = await call("GET", "/api/hashtags/suggestions?q=ja");
    assert.equal(s.body.suggestions[0].isFollowing, false); assert.equal("failedSources" in s.body, false);
    use(world({ hashtags: [] }));
    assert.equal((await call("POST", "/api/hashtags/jazz/follow")).status, 404);
  });
});
