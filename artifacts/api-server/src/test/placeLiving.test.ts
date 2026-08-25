/**
 * Tests for GET /api/places/:id/living (placeLiving assembler).
 *
 * All sub-calls (DB, weather, best-of, AI summary) are mocked so tests run
 * without a live DB or OpenAI key.
 *
 * Covers:
 *   1. Cache hit path — returns cached payload without reassembly.
 *   2. Cache miss — assembles fresh payload, writes to cache, returns MISS.
 *   3. Stale cache — serves stale payload (204 from supabase skip), enqueues revalidation.
 *   4. sparseMode — true when total post count < 5.
 *   5. AI summary not called when < 3 posts.
 *   6. Null fields when sub-calls fail (no 500s).
 *   7. 404 when place not found.
 *   8. Timeline: today slice returns posts from last 24 h.
 *   9. Timeline: invalid slice returns 400.
 *
 * Run: node --import tsx/esm --test src/test/placeLiving.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import placeLivingRouter from "../routes/placeLiving.js";

// ── Test identities ───────────────────────────────────────────────────────────
const PLACE_ID = "aa000000-0000-0000-0000-000000000001";
const USER_ID  = "bb000000-0000-0000-0000-000000000002";

function now() { return new Date().toISOString(); }
function hoursAgo(h: number) {
  return new Date(Date.now() - h * 60 * 60 * 1_000).toISOString();
}

// ── Fake place row ────────────────────────────────────────────────────────────
const FAKE_PLACE = {
  id:               PLACE_ID,
  name:             "Test Falls",
  primary_category: "waterfall",
  city:             "Test City",
  latitude:         10.0,
  longitude:        120.0,
  merged_into_place_id: null,
  status:           "active",
};

// ── Factory: fake Supabase client ─────────────────────────────────────────────

function makeFakeSc(opts: {
  place?:           any;
  posts?:           any[];
  buckets?:         any[];
  dedupGroups?:     any[];
  contributors?:    any[];
  livingCache?:     any | null;
  bestOf?:          any | null;
  aiSummaries?:     any | null;
  capturedUpserts?: Array<{ table: string; row: any }>;
}) {
  // Use `in` check so an explicit `place: null` means "no place" (not "use default")
  const place          = "place" in opts ? opts.place : FAKE_PLACE;
  const posts          = opts.posts       ?? [];
  const buckets        = opts.buckets     ?? [];
  const dedupGroups    = opts.dedupGroups ?? [];
  const contributors   = opts.contributors ?? [];
  const livingCache    = opts.livingCache;
  const bestOf         = opts.bestOf;
  const aiSummaries    = opts.aiSummaries;
  const capturedUpserts = opts.capturedUpserts ?? [];

  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "external_places_enabled", enabled: true },
      { flag: "live_places_enabled",     enabled: true },
    ],
    places:                     place ? [place] : [],
    external_place_references:  [],
    posts:                      posts,
    place_coverage_buckets:     buckets,
    media_dedup_groups:         dedupGroups,
    place_top_contributors:     contributors,
    place_living_cache:         livingCache ? [livingCache] : [],
    place_best_of:              bestOf ? [bestOf] : [],
    place_ai_summaries:         aiSummaries ? [aiSummaries] : [],
    place_cache_invalidation_queue: [],
    profiles:                   [],
  };

  function buildChain(tableData: any[], filters: Record<string, any> = {}) {
    let result = [...tableData];
    let _limit: number | null = null;
    let _selectCols: string | null = null;
    let _maybeSingle = false;
    let _order: { col: string; asc: boolean } | null = null;

    const chain: any = {
      select(cols: string) { _selectCols = cols; return chain; },
      eq(col: string, val: any) {
        result = result.filter((r) => r[col] === val);
        return chain;
      },
      is(col: string, val: any) {
        result = result.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return chain;
      },
      neq(col: string, val: any) {
        result = result.filter((r) => r[col] !== val);
        return chain;
      },
      in(col: string, vals: any[]) {
        result = result.filter((r) => vals.includes(r[col]));
        return chain;
      },
      gte(col: string, val: any) {
        result = result.filter((r) => r[col] >= val);
        return chain;
      },
      lt(col: string, val: any) {
        result = result.filter((r) => r[col] < val);
        return chain;
      },
      order(col: string, opts2: any) {
        _order = { col, asc: opts2?.ascending ?? false };
        return chain;
      },
      limit(n: number) { _limit = n; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      single() { _maybeSingle = true; return chain; },
      catch() { return chain; },
      then(resolve: any) {
        if (_order) {
          const { col, asc } = _order;
          result.sort((a, b) => asc
            ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
            : String(b[col] ?? "").localeCompare(String(a[col] ?? "")));
        }
        if (_limit !== null) result = result.slice(0, _limit);
        if (_maybeSingle) {
          return resolve({ data: result[0] ?? null, error: null });
        }
        return resolve({ data: result, error: null });
      },
    };
    return chain;
  }

  const sc: any = {
    from(table: string) {
      const tableData = tables[table] ?? [];
      return {
        select: (cols: string) => buildChain(tableData).select(cols),
        insert: (row: any) => {
          capturedUpserts.push({ table, row });
          return { then: (r: any) => r({ data: row, error: null }), catch: () => ({}) };
        },
        upsert: (row: any) => {
          capturedUpserts.push({ table, row });
          return {
            then:  (r: any) => r({ data: row, error: null }),
            catch: () => ({}),
          };
        },
        update: (_row: any) => ({
          eq:   () => ({ then: (r: any) => r({ data: null, error: null }) }),
          then: (r: any) => r({ data: null, error: null }),
        }),
      };
    },
  };
  return sc;
}

// ── Test app factory ──────────────────────────────────────────────────────────

function makeApp(sc: any) {
  _setTestClient(sc, true);
  const app = express();
  app.use(express.json());
  // Inject a mock requireMaybeUser (auth optional — always pass through)
  app.use((req: any, _res: any, next: any) => {
    req.user = null; // unauthenticated but allowed
    next();
  });
  app.use(placeLivingRouter);
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port:     (server.address() as any).port,
      path,
      method,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        resolve({
          status:  res.statusCode ?? 0,
          body:    raw ? JSON.parse(raw) : null,
          headers: res.headers as Record<string, string>,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /places/:id/living", () => {
  let server: http.Server;
  let capturedUpserts: Array<{ table: string; row: any }>;

  // Disable OpenAI for all tests (return null from AI calls)
  before(() => {
    _setTestOpenAI({
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: null } }] }),
        },
      },
    } as any);
  });

  after(() => {
    _setTestOpenAI(null);
    server?.close();
  });

  beforeEach(() => {
    capturedUpserts = [];
  });

  it("returns 404 when place does not exist", async () => {
    const sc  = makeFakeSc({ place: null } as any);
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 404);

    server.close();
  });

  it("returns 400 for an invalid UUID", async () => {
    const sc  = makeFakeSc({});
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", "/places/not-a-uuid/living");
    assert.equal(res.status, 400);

    server.close();
  });

  it("cache miss: assembles fresh payload and writes to cache", async () => {
    const posts = Array.from({ length: 6 }, (_, i) => ({
      id:                  `post-${i}`,
      canonical_place_id:  PLACE_ID,
      status:              "active",
      visibility:          "public",
      content:             `Caption ${i}`,
      media_urls:          [`https://cdn.example.com/img${i}.jpg`],
      media_type:          "photo",
      media_thumbnail_url: null,
      author_id:           USER_ID,
      created_at:          hoursAgo(i),
      like_count:          i * 2,
      save_count:          i,
      share_count:         0,
      post_buckets:        ["drone"],
    }));

    const sc  = makeFakeSc({ posts, capturedUpserts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-cache"]?.toLowerCase(), "miss");

    const body = res.body;
    assert.equal(body.placeId, PLACE_ID);
    assert.equal(typeof body.sparseMode, "boolean");
    assert.ok("hero"         in body);
    assert.ok("officialInfo" in body);
    assert.ok("bestOf"       in body);
    assert.ok("timeline"     in body);
    assert.ok("thinBuckets"  in body);
    // Backward-compatible IG read path: crowdLevel is unchanged, and the new
    // liveClaims field is present as an array (empty with the flag off), never
    // undefined and never a fabricated claim.
    assert.ok("crowdLevel" in body, "crowdLevel contract preserved");
    assert.ok(Array.isArray(body.liveClaims), "liveClaims is always an array");
    assert.equal(body.liveClaims.length, 0, "no live intel with the flag off");

    // Cache should have been written
    const cacheWrite = capturedUpserts.find((u) => u.table === "place_living_cache");
    assert.ok(cacheWrite, "expected a place_living_cache upsert");

    server.close();
  });

  it("bucket posts are populated from post_buckets — not empty", async () => {
    // buckets from place_coverage_buckets (canonical_place_id required for the .eq filter)
    const buckets = [{ bucket: "drone", post_count: 3, canonical_place_id: PLACE_ID }];
    // posts that include post_buckets: ["drone"] so they match
    const posts = Array.from({ length: 3 }, (_, i) => ({
      id:                  `drone-post-${i}`,
      canonical_place_id:  PLACE_ID,
      status:              "active",
      visibility:          "public",
      content:             `Drone shot ${i}`,
      media_urls:          [`https://cdn.example.com/drone${i}.jpg`],
      media_type:          "photo",
      media_thumbnail_url: null,
      author_id:           USER_ID,
      created_at:          hoursAgo(i),
      like_count:          5,
      save_count:          1,
      share_count:         0,
      post_buckets:        ["drone"],
    }));

    const sc  = makeFakeSc({ posts, buckets });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 200);

    const droneBucket = (res.body.buckets as any[]).find((b: any) => b.bucket === "drone");
    assert.ok(droneBucket, "expected a drone bucket");
    assert.ok(
      droneBucket.posts.length > 0,
      `expected drone bucket posts to be non-empty (got ${droneBucket.posts.length})`,
    );
    assert.equal(droneBucket.posts[0].id, "drone-post-0");

    server.close();
  });

  it("cache hit: returns cached payload without reassembly", async () => {
    const cachedPayload = {
      placeId:    PLACE_ID,
      sparseMode: false,
      hero:       { imageUrl: null, videoUrl: null },
      rating:     null,
      officialInfo: {},
      generatedAt: hoursAgo(0.1),
    };
    const livingCache = {
      place_id:  PLACE_ID,
      payload:   cachedPayload,
      cached_at: hoursAgo(0.5), // 30 min ago — within 1 h TTL
      sparse:    false,
    };

    const sc  = makeFakeSc({ livingCache });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-cache"]?.toLowerCase(), "hit");
    assert.equal(res.body.placeId, PLACE_ID);

    server.close();
  });

  it("sparseMode is true when < 5 total posts", async () => {
    const posts = [
      {
        id: "p1", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "a", media_urls: [], media_type: "photo",
        media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(1), like_count: 0, save_count: 0, share_count: 0, view_count: 0, post_buckets: [],
      },
      {
        id: "p2", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "b", media_urls: [], media_type: "photo",
        media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(2), like_count: 0, save_count: 0, share_count: 0, view_count: 0, post_buckets: [],
      },
    ]; // only 2 posts → sparse

    const sc  = makeFakeSc({ posts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sparseMode, true);

    server.close();
  });

  it("AI summary is null when posts < 3", async () => {
    // Mock OpenAI to throw if called (should not be called at all with < 3 posts)
    _setTestOpenAI({
      chat: {
        completions: {
          create: async () => {
            throw new Error("AI should not be called with < 3 posts");
          },
        },
      },
    } as any);

    const posts = [
      {
        id: "p1", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "hi", media_urls: [], media_type: "photo",
        media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(1), like_count: 0, save_count: 0, share_count: 0, view_count: 0, post_buckets: [],
      },
    ]; // 1 post — below threshold

    const sc  = makeFakeSc({ posts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    assert.equal(res.status, 200);
    assert.equal(res.body.aiSummary, null);

    // Restore
    _setTestOpenAI({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: null } }] }) } },
    } as any);

    server.close();
  });

  it("null fields when sub-calls fail — no 500", async () => {
    // Build a client where coverage buckets throws
    const sc = makeFakeSc({ capturedUpserts });
    // Override place_coverage_buckets to return an error
    const origFrom = sc.from.bind(sc);
    sc.from = (table: string) => {
      if (table === "place_coverage_buckets") {
        return {
          select: () => ({
            eq:    () => ({
              order: () => ({
                then: (r: any) => r({ data: null, error: { message: "table not found" } }),
              }),
            }),
          }),
        };
      }
      return origFrom(table);
    };

    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living`);
    // Should still succeed (200) with buckets falling back gracefully
    assert.equal(res.status, 200);
    assert.ok(res.body.buckets !== undefined);

    server.close();
  });
});

describe("GET /places/:id/living/timeline", () => {
  let server: http.Server;

  before(() => {
    _setTestOpenAI({
      chat: { completions: { create: async () => ({ choices: [{ message: { content: null } }] }) } },
    } as any);
  });

  after(() => {
    _setTestOpenAI(null);
    server?.close();
  });

  it("returns posts within last 24 h for slice=today", async () => {
    const posts = [
      {
        id: "recent", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "recent", media_urls: ["https://cdn.example.com/a.jpg"],
        media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(1), like_count: 5, post_buckets: [],
      },
      {
        id: "old", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "old post", media_urls: [],
        media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(48), like_count: 0, post_buckets: [],
      },
    ];

    const sc  = makeFakeSc({ posts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living/timeline?slice=today`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slice, "today");
    // Only the recent post should be returned (old is > 24 h)
    assert.ok(res.body.posts.some((p: any) => p.id === "recent"));
    assert.ok(!res.body.posts.some((p: any) => p.id === "old"));

    server.close();
  });

  it("timeline never returns private, trip_only or unpublished posts to an anonymous caller", async () => {
    // Regression lock. The living page is an ANONYMOUS surface (optionalUser,
    // mounted bare) served through the SERVICE-ROLE client, so RLS is bypassed.
    // All three of its post queries filtered only on canonical_place_id +
    // status, with no visibility predicate, so private and trip_only captions
    // and not-yet-published delayed posts were returned to any caller at all.
    //
    // Unlike compass-cache.test.ts — whose fake DB ignores .eq() on the array
    // path, leaving only the in-memory gate observable — the fake client here
    // implements .eq() as a real r[col] === val filter. So this exercises BOTH
    // halves: the SQL predicate AND the isEligiblePlaceDayPost gate that covers
    // post_status / publish_at.
    const base = {
      canonical_place_id: PLACE_ID, content: "x", media_urls: [],
      media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
      created_at: hoursAgo(1), like_count: 0, post_buckets: [],
    };
    const posts = [
      { ...base, id: "ok-public",   status: "active", visibility: "public" },
      { ...base, id: "no-private",  status: "active", visibility: "private" },
      { ...base, id: "no-triponly", status: "active", visibility: "trip_only" },
      // Public, but its delayed-publish geofence has not cleared yet — only the
      // isEligiblePlaceDayPost gate catches this one.
      { ...base, id: "no-pending",  status: "active", visibility: "public", post_status: "pending_location_exit" },
    ];

    const sc  = makeFakeSc({ posts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living/timeline?slice=today`);
    assert.equal(res.status, 200);
    const ids = (res.body.posts ?? []).map((p: any) => p.id);

    assert.ok(ids.includes("ok-public"), "public published posts must still be returned");
    assert.ok(!ids.includes("no-private"),  "private posts must never reach the living page");
    assert.ok(!ids.includes("no-triponly"), "trip_only posts must never reach the living page");
    assert.ok(!ids.includes("no-pending"),  "delayed posts must not surface before they publish");

    server.close();
  });

  it("week slice: posts include like_count so client engagement sort works", async () => {
    const posts = [
      {
        id: "high-likes", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "popular", media_urls: ["https://cdn.example.com/a.jpg"],
        media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(120), like_count: 42, post_buckets: [],
      },
      {
        id: "low-likes", canonical_place_id: PLACE_ID, status: "active", visibility: "public",
        content: "recent but unpopular", media_urls: ["https://cdn.example.com/b.jpg"],
        media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(1), like_count: 1, post_buckets: [],
      },
    ];

    const sc  = makeFakeSc({ posts });
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living/timeline?slice=week`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slice, "week");

    // like_count must be present on every returned post so the client can sort
    const allHaveLikeCount = (res.body.posts as any[]).every(
      (p: any) => typeof p.like_count === "number",
    );
    assert.ok(allHaveLikeCount, `some posts missing like_count: ${JSON.stringify(res.body.posts)}`);

    // Verify the counts actually match the source data (not zeroed out)
    const highPost = res.body.posts.find((p: any) => p.id === "high-likes");
    assert.ok(highPost, "high-likes post not found in week response");
    assert.equal(highPost.like_count, 42, "like_count should be 42 for high-likes post");

    server.close();
  });

  it("returns 400 for an invalid slice value", async () => {
    const sc  = makeFakeSc({});
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", `/places/${PLACE_ID}/living/timeline?slice=badvalue`);
    assert.equal(res.status, 400);

    server.close();
  });

  it("returns 400 for an invalid place UUID", async () => {
    const sc  = makeFakeSc({});
    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    const res = await request(server, "GET", "/places/not-valid/living/timeline?slice=today");
    assert.equal(res.status, 400);

    server.close();
  });

  it("merged place ID: timeline returns survivor posts, not empty", async () => {
    // A stale/merged place ID that points to the survivor
    const MERGED_ID   = "cc000000-0000-0000-0000-000000000003";
    const SURVIVOR_ID = PLACE_ID; // PLACE_ID is the canonical survivor

    // The merged place row points to the survivor
    const mergedPlace = {
      id:                   MERGED_ID,
      name:                 "Old Falls (merged)",
      city:                 "Test City",
      primary_category:     "waterfall",
      latitude:             10.0,
      longitude:            120.0,
      merged_into_place_id: SURVIVOR_ID, // <-- merge pointer
      status:               "merged",
    };

    // Posts are stored against the survivor
    const posts = [
      {
        id: "survivor-post-1", canonical_place_id: SURVIVOR_ID, status: "active", visibility: "public",
        content: "great view", media_urls: ["https://cdn.example.com/p1.jpg"],
        media_type: "photo", media_thumbnail_url: null, author_id: USER_ID,
        created_at: hoursAgo(1), like_count: 3, post_buckets: [],
      },
    ];

    // Build a fake client that holds BOTH the merged and survivor place rows
    const sc = makeFakeSc({ place: FAKE_PLACE, posts });
    // Override places table to include the merged place row too
    const origFrom = sc.from.bind(sc);
    sc.from = (table: string) => {
      if (table === "places") {
        const allPlaces = [FAKE_PLACE, mergedPlace];
        const chain = origFrom(table);
        // Rebuild with both rows: return a custom chain that filters correctly
        return {
          select: (cols: string) => {
            let result = [...allPlaces];
            let _maybeSingle = false;
            const c: any = {
              select(c2: string) { return c; },
              eq(col: string, val: any) { result = result.filter((r) => r[col as keyof typeof r] === val); return c; },
              in(col: string, vals: any[]) { result = result.filter((r) => vals.includes(r[col as keyof typeof r])); return c; },
              maybeSingle() { _maybeSingle = true; return c; },
              then(resolve: any) {
                return resolve({ data: _maybeSingle ? (result[0] ?? null) : result, error: null });
              },
            };
            return c;
          },
        };
      }
      return origFrom(table);
    };

    const app = makeApp(sc);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

    // Request using the MERGED (stale) ID
    const res = await request(server, "GET", `/places/${MERGED_ID}/living/timeline?slice=today`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    // Must return survivor's posts — not empty
    assert.ok(
      res.body.posts.some((p: any) => p.id === "survivor-post-1"),
      `expected survivor post in timeline, got: ${JSON.stringify(res.body.posts)}`,
    );

    server.close();
  });
});
