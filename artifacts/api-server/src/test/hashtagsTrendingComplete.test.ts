/**
 * census-discovery §108 (DV-83 round 11, lane W11-X2; D-W11X2-79). §108.1 BK6: GET /hashtags/trending
 * (the Discover screen's trending chips, D-W11X2-57) read the 48 h `hashtag_usage` window with no
 * limit, range or count. PostgREST caps every response at db-max-rows (production: 1000, census
 * §67.3) and says nothing: the answer is a PARTIAL read with `error: null`, and the chips were ranked
 * over it as the complete list. The route now reads each window to the end in ordered pages against
 * an exact count; a window it cannot read completely (over its row cap, or short of its count) is
 * served with the Discovery refusal envelope, coverage `partial`, never as the complete ranking.
 *
 * The fake below does what PostgREST does: every response — an unbounded select or a `range` — is
 * cut to its first MAX_ROWS rows in the requested order, silently; `count: "exact"` counts the whole
 * filtered set; `head: true` returns no rows.
 *
 *   V10-HT0  CONTROL: 900 rows in the window (under the cap) → #cold (500) then #warm (400)
 *   V10-HT1  1 800 rows, #hot (800) stored after #cold (600) and #warm (400) → never the list without #hot and unmarked
 *   HT1b     ... the ranking is complete: #hot, #cold, #warm, and no refusal
 *   HT2      a window larger than the route's row cap (a million rows) → refusal `partial`, naming hashtag_usage
 *   HT3      the post-engagement read is over the cap too → still complete (it is paged the same way)
 *   HT4      a page after the first fails → db_error, never a ranking of the pages that were read
 *   HT5      the city window is empty and the global fallback is over the cap → complete global ranking, #hot first
 *   HT6      the count says more rows than the pages return → refusal `partial`, never complete
 *   HT7      only the post-engagement read falls short of its count → refusal `partial`
 *   HT8      only the event-activity read falls short of its count → refusal `partial`
 *   HT9      the window's count read fails → db_error, never a ranking of unknown completeness
 *   HT10     the count says rows exist and the pages return none → refusal `nothing`, never "nothing trending"
 *   HT11     the city window is empty and only the global fallback falls short of its count → refusal `partial`
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/hashtagsTrendingComplete.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import hashtagsRouter from "../routes/hashtags.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000012";
const TOKEN = "tok-r11-trending";
const MAX_ROWS = 1000;
const TAGS: Record<string, string> = { "ht-cold": "cold", "ht-warm": "warm", "ht-hot": "hot" };
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

type Row = { id: string; hashtag_id: string; author_id: string; city: string | null; source_type: string; source_id: string; created_at: string };
interface FakeOpts { failRangeFrom?: number; countExtra?: number; posts?: Array<{ id: string; like_count: number; comment_count: number }>; /** inflate only the count of the reads filtered to this source_type ('window' = the unfiltered window) */ countExtraOn?: string; failHead?: boolean }

function client(rows: Row[], opts: FakeOpts = {}) {
  const posts = opts.posts ?? [];
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const eqs = new Map<string, unknown>();
    let head = false, count = false, range: [number, number] | null = null;
    const ordered: string[] = [];
    let single = false;
    const run = () => {
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [], error: null };
      if (table === "hashtags") {
        const ids = (inArgs.get("id") ?? []) as string[];
        return { data: ids.filter((id) => TAGS[id]).map((id) => ({ id, slug: TAGS[id], name: TAGS[id], usage_count: 0, is_blocked: false, is_hidden_from_trending: false })), error: null };
      }
      const src: any[] = table === "hashtag_usage" ? rows : table === "posts" ? posts : [];
      let all = src.filter((r) => filters.every((f) => f(r)));
      if (ordered.length > 0) all = [...all].sort((a, b) => { for (const k of ordered) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; });
      const on = (eqs.get('source_type') as string | undefined) ?? (eqs.has('city') ? 'city-window' : 'window');
      const total = all.length + (opts.countExtra ?? 0) + (opts.countExtraOn === on ? 5 : 0);
      if (head && opts.failHead) return { data: null, count: null, error: DB_ERR };
      if (head) return { data: null, count: count ? total : null, error: null };
      if (range && opts.failRangeFrom !== undefined && range[0] >= opts.failRangeFrom) return { data: null, error: DB_ERR };
      const window = range ? all.slice(range[0], range[1] + 1) : all;
      return { data: window.slice(0, MAX_ROWS), count: count ? total : null, error: null };  // PostgREST db-max-rows: silent
    };
    const inArgs = new Map<string, unknown[]>();
    const b: any = {
      select(_cols: string, o?: { count?: string; head?: boolean }) { if (o?.count === "exact") count = true; if (o?.head) head = true; return b; },
      eq(c: string, v: unknown) { eqs.set(c, v); filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: unknown[]) { inArgs.set(c, vs); filters.push((r) => vs.includes(r[c])); return b; },
      gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b; },
      not() { return b; },
      order(c: string) { ordered.push(c); return b; },
      range(f: number, t: number) { range = [f, t]; return b; },
      limit(n: number) { range = [0, n - 1]; return b; },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      single() { single = true; return Promise.resolve(run()); },
      then(f: any, r: any) { return Promise.resolve(run()).then(f, r); },
    };
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

let seq = 0;
const recent = () => new Date(Date.now() - 3_600_000 + (seq++ % 1000)).toISOString();
const usage = (id: string, n: number, city: string | null = null, sourceType = "comment") =>
  Array.from({ length: n }, (_, i) => ({ id: `u-${id}-${String(i).padStart(6, "0")}`, hashtag_id: id, author_id: `a-${id}-${i % 50}`, city, source_type: sourceType, source_id: `s-${id}-${i}`, created_at: recent() }));

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", hashtagsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());

async function get(qs = "limit=20") {
  const r = await fetch(`${base}/hashtags/trending?${qs}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as any };
}
const slugs = (body: any) => body.trending?.map((t: any) => t.slug);

describe("§108 (BK6) GET /hashtags/trending never ranks a truncated read as complete", () => {
  it("V10-HT0 CONTROL: under the cap → the complete ranking", async () => {
    _setTestClient(client([...usage("ht-cold", 500), ...usage("ht-warm", 400)]) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.deepEqual(slugs(body), ["cold", "warm"]);
    assert.equal(body.refusal, undefined);
  });
  it("V10-HT1 over the cap → must not be served as the complete list without #hot and with no incomplete marker", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-warm", 400), ...usage("ht-hot", 800)]) as any, true);
    const { status, body } = await get();
    const marked = body.refusal != null || body.partial === true || body.truncated === true;
    assert.ok(slugs(body)?.includes("hot") || marked || status !== 200, `served ${status} ${JSON.stringify(slugs(body))} with no incomplete marker (true top: hot 800)`);
  });
  it("HT1b ... the whole window is read: #hot, #cold, #warm, complete", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-warm", 400), ...usage("ht-hot", 800)]) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.deepEqual(slugs(body), ["hot", "cold", "warm"]);
    assert.equal(body.refusal, undefined, JSON.stringify(body.refusal));
  });
  it("HT2 a window over the route's row cap → refusal `partial` naming hashtag_usage, never complete", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-hot", 300)], { countExtra: 1_000_000 }) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["hashtag_usage"]);
    assert.equal(body.refusal?.route, "GET /hashtags/trending");
  });
  it("HT3 the post-engagement read is over the cap too → complete, and the engagement of every post counts", async () => {
    const hotPosts = usage("ht-hot", 1200, null, "post");
    const coldPosts = usage("ht-cold", 1300, null, "post");
    const posts = hotPosts.map((r) => ({ id: r.source_id, like_count: 1, comment_count: 0 }));
    _setTestClient(client([...coldPosts, ...hotPosts], { posts }) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.refusal, undefined, JSON.stringify(body.refusal));
    assert.deepEqual(slugs(body), ["hot", "cold"], JSON.stringify(body.trending));
  });
  it("HT4 a page after the first fails → db_error, never a ranking of the pages that were read", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-warm", 400), ...usage("ht-hot", 800)], { failRangeFrom: 1000 }) as any, true);
    const { status, body } = await get();
    assert.notEqual(status, 200, JSON.stringify(body));
    assert.equal(body.error, "db_error");
  });
  it("HT5 the city window is empty and the global fallback is over the cap → the complete global ranking", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-warm", 400), ...usage("ht-hot", 800)]) as any, true);
    const { status, body } = await get("scope=city&city_id=Rome&limit=20");
    assert.equal(status, 200);
    assert.equal(body.scope, "global");
    assert.deepEqual(slugs(body), ["hot", "cold", "warm"]);
    assert.equal(body.refusal, undefined);
  });
  it("HT6 the count says more rows than the pages return → refusal `partial`, never complete", async () => {
    _setTestClient(client([...usage("ht-cold", 600), ...usage("ht-hot", 300)], { countExtra: 5 }) as any, true);
    const { body } = await get();
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
  });
  it("HT7 only the post-engagement read falls short of its count → refusal `partial`", async () => {
    _setTestClient(client([...usage("ht-cold", 60, null, "post"), ...usage("ht-hot", 40, null, "post")], { countExtraOn: "post" }) as any, true);
    const { body } = await get();
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
  });
  it("HT8 only the event-activity read falls short of its count → refusal `partial`", async () => {
    _setTestClient(client([...usage("ht-cold", 60, null, "event"), ...usage("ht-hot", 40, null, "event")], { countExtraOn: "event" }) as any, true);
    const { body } = await get();
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
  });
  it("HT9 the window's count read fails → db_error, never a ranking of unknown completeness", async () => {
    _setTestClient(client([...usage("ht-cold", 60), ...usage("ht-hot", 40)], { failHead: true }) as any, true);
    const { status, body } = await get();
    assert.notEqual(status, 200, JSON.stringify(body));
    assert.equal(body.error, "db_error");
  });
  it("HT10 the count says rows exist and the pages return none → refusal `nothing`, never 'nothing trending'", async () => {
    _setTestClient(client([], { countExtra: 5 }) as any, true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.deepEqual(body.trending, []);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
  });
  it("HT11 the city window is empty and only the global fallback falls short of its count → refusal `partial`", async () => {
    _setTestClient(client([...usage("ht-cold", 60), ...usage("ht-hot", 40)], { countExtraOn: "window" }) as any, true);
    const { status, body } = await get("scope=city&city_id=Rome&limit=20");
    assert.equal(status, 200);
    assert.equal(body.scope, "global");
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
  });
});
