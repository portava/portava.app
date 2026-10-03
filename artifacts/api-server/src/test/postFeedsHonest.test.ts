/**
 * postFeedsHonest — census-media §47, defect 2 and the counts beside it, on the
 * post feeds: GET /posts (global and following), GET /trips/:tripId/posts and
 * GET /posts/:postId.
 *
 * Each feed read its engagement in one Promise.all and looked at none of the
 * errors. supabase-js resolves `{ data: null, error }`, so:
 *   - `savedByMe` / `likedByMe` / `isStampedByViewer` read as false when the
 *     viewer's own rows could not be read (the DV-83 verifiers' "isSaved over a
 *     failed enrichment read", census-discovery §118.13);
 *   - every count read as 0 when its read failed;
 *   - the stamp count was made by reading one row per stamp, an unbounded read
 *     PostgREST cuts at 1,000 rows, so a busy page was undercounted in silence;
 *   - `saveCount` and `commentCount` were the cached columns, and the cached
 *     save_count is not maintained by POST /media/:id/save at all.
 *
 *   PF0  global, healthy: stamps exact past 1,000; saves and comments counted
 *        live over a stale cache; the viewer's state right; no failedSources
 *   PF1  global: post_saves unread → savedByMe null, saveCount null, named
 *   PF2  global: content_stamps unread → like/stamp counts and flags null, named
 *   PF3  global: posts_comments unread → commentCount null, named
 *   PF4  following: post_saves unread → savedByMe null, named
 *   PF5  trip feed: content_stamps unread → null, named
 *   PF6  single post: post_saves unread → savedByMe and saveCount null, named
 *   PF7  single post: posts_comments unread → commentCount null, named
 *   PF8  single post, healthy: saveCount live, not the cached column
 *   PF9  global: post_hides unread → the page is served and the hide list NAMED
 *   PF10 global: a private account past the first 1,000 is still excluded
 *   PF11 single post, followers_only: an unread follow row is a 503, never "not found"
 *   PF12 global: post_media unread → each post's media is null (unknown), named
 *   PF13 global: the hashtag-boost reads unread → named (the page is served unboosted)
 *   PF14 following: a creator followed past the viewer's first 1,000 follows is still in the feed
 *   PF15 following: post_hides unread → the page is served and the hide list is named
 *   PF16 global: author profiles unread → named, never shown as "no author"
 *
 * Run: node --import tsx/esm --test src/test/postFeedsHonest.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { makeFeedDb, type FakeFeedDb, type FakeFeedDbSpec } from "./helpers/fakeFeedDb.js";

const VIEWER = "aaaaaaaa-0000-4000-a000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-a000-000000000002";
const TRIP = "eeeeeeee-0000-4000-a000-000000000001";
const P1 = "11111111-0000-4000-a000-000000000001";
const P2 = "11111111-0000-4000-a000-000000000002";
const P3 = "11111111-0000-4000-a000-000000000003";
const TOKEN = "tok-viewer";

const uid = (n: number) => `cccccccc-0000-4000-a000-${String(n).padStart(12, "0")}`;

function post(id: string, over: Record<string, unknown> = {}) {
  return {
    id, author_id: AUTHOR, status: "active", post_status: "published", visibility: "public", trip_id: null,
    content: `post ${id}`, created_at: `2026-09-0${id.slice(-1)}T00:00:00Z`,
    like_count: 5, comment_count: 7, save_count: 99, location_privacy_mode: "none",
    ...over,
  };
}

function seed(over: Partial<FakeFeedDbSpec> = {}): FakeFeedDbSpec {
  const stamps = [
    ...Array.from({ length: 1_700 }, (_, i) => ({ id: `s1-${String(i).padStart(5, "0")}`, user_id: uid(i + 10), entity_type: "post", entity_id: P1 })),
    { id: "s2-a", user_id: VIEWER, entity_type: "post", entity_id: P2 },
    { id: "s2-b", user_id: uid(3), entity_type: "post", entity_id: P2 },
    { id: "s2-c", user_id: uid(4), entity_type: "post", entity_id: P2 },
  ];
  return {
    users: { [TOKEN]: VIEWER },
    tables: {
      posts: [post(P1), post(P2), post(P3)],
      profiles: [
        { id: AUTHOR, handle: "author", name: "Author", username: "author", is_private: false, passport_visibility: "public", account_status: "active" },
        { id: VIEWER, handle: "viewer", name: "Viewer", username: "viewer", is_private: false, account_status: "active" },
      ],
      user_follows: [{ follower_id: VIEWER, following_id: AUTHOR }],
      post_saves: [
        { id: "ps-1", post_id: P1, user_id: VIEWER },
        { id: "ps-2", post_id: P1, user_id: uid(5) },
      ],
      posts_comments: [
        { id: "c-1", post_id: P1, user_id: uid(6), deleted_at: null },
        { id: "c-2", post_id: P1, user_id: uid(7), deleted_at: null },
        { id: "c-3", post_id: P1, user_id: uid(8), deleted_at: "2026-09-10T00:00:00Z" },
      ],
      content_stamps: stamps,
      trips: [{ id: TRIP, owner_id: VIEWER, visibility: "public" }],
      trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" }],
    },
    ...over,
  };
}

let db: FakeFeedDb;
let server: http.Server;
let base = "";

function use(spec: FakeFeedDbSpec) {
  db = makeFeedDb(spec);
  _setTestClient(db.client, true);
}

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const byId = (posts: any[], id: string) => posts.find((p) => p.id === id);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    next();
  });
  app.use("/api", postsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}/api`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("GET /posts (global) — counts exact and live, the viewer's state named when unread (census-media §47)", () => {
  it("PF0 — healthy: exact past the row cap, live over a stale cache, no failedSources", async () => {
    use(seed());
    const r = await get("/posts");
    assert.equal(r.status, 200);
    const p1 = byId(r.body.posts, P1), p2 = byId(r.body.posts, P2), p3 = byId(r.body.posts, P3);
    assert.equal(p1.likeCount, 1_700, "1,700 stamps — not the 1,000 rows PostgREST serves of them");
    assert.equal(p1.stampCount, 1_700);
    assert.equal(p2.likeCount, 3);
    assert.equal(p3.likeCount, 0);
    assert.equal(p1.saveCount, 2, "live post_saves, not the cached save_count (99)");
    assert.equal(p2.saveCount, 0);
    assert.equal(p1.commentCount, 2, "live, non-deleted comments, not the cached comment_count (7)");
    assert.equal(p1.savedByMe, true);
    assert.equal(p2.savedByMe, false);
    assert.equal(p2.likedByMe, true);
    assert.equal(p2.isStampedByViewer, true);
    assert.equal(p1.likedByMe, false);
    assert.equal(r.body.failedSources, undefined, "a healthy body is unchanged");
  });

  it("PF1 — post_saves unread: savedByMe and saveCount are null, and post_saves is named", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    for (const p of r.body.posts) {
      assert.equal(p.savedByMe, null, "unknown is not 'not saved'");
      assert.equal(p.saveCount, null, "unknown is not 0");
    }
    assert.deepEqual(r.body.failedSources, ["post_saves"]);
    assert.equal(byId(r.body.posts, P1).likeCount, 1_700, "the reads that worked still answer");
  });

  it("PF2 — content_stamps unread: like/stamp counts and the viewer's stamp are null, named", async () => {
    use(seed({ failReads: { content_stamps: true } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    for (const p of r.body.posts) {
      assert.equal(p.likeCount, null);
      assert.equal(p.stampCount, null);
      assert.equal(p.likedByMe, null);
      assert.equal(p.isStampedByViewer, null);
    }
    assert.deepEqual(r.body.failedSources, ["content_stamps"]);
  });

  it("PF3 — posts_comments unread: commentCount is null, named", async () => {
    use(seed({ failReads: { posts_comments: true } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    for (const p of r.body.posts) assert.equal(p.commentCount, null);
    assert.deepEqual(r.body.failedSources, ["posts_comments"]);
  });

  it("PF9 — post_hides unread: the page is served and the unread hide list is named", async () => {
    use(seed({ failReads: { post_hides: true } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    assert.ok((r.body.failedSources ?? []).includes("post_hides"), `got ${JSON.stringify(r.body.failedSources)}`);
  });

  it("PF10 — a private account past the first 1,000 is still excluded from the global feed", async () => {
    const LATE_PRIVATE = "ffffffff-0000-4000-a000-000000000999";
    const spec = seed();
    // 1,000 private accounts sorting BEFORE the late one, so a capped read never reaches it.
    for (let i = 0; i < 1_000; i++) spec.tables.profiles.push({ id: `dddddddd-0000-4000-a000-${String(i).padStart(12, "0")}`, is_private: true, passport_visibility: "public" });
    spec.tables.profiles.push({ id: LATE_PRIVATE, handle: "late", is_private: true, passport_visibility: "public", account_status: "active" });
    spec.tables.posts.push(post("11111111-0000-4000-a000-000000000009", { author_id: LATE_PRIVATE }));
    use(spec);
    const r = await get("/posts");
    assert.equal(r.status, 200);
    assert.equal(
      r.body.posts.some((p: any) => p.author_id === LATE_PRIVATE || p.authorId === LATE_PRIVATE),
      false,
      "the 1,001st private account's post must not reach the global feed",
    );
  });
});

describe("GET /posts?feed=following and GET /trips/:tripId/posts (census-media §47)", () => {
  it("PF4 — following: post_saves unread → savedByMe null, named", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get("/posts?feed=following");
    assert.equal(r.status, 200);
    assert.ok(r.body.posts.length > 0);
    for (const p of r.body.posts) assert.equal(p.savedByMe, null);
    assert.deepEqual(r.body.failedSources, ["post_saves"]);
  });

  it("PF5 — trip feed: content_stamps unread → null, named", async () => {
    const spec = seed({ failReads: { content_stamps: true } });
    spec.tables.posts = [post(P1, { trip_id: TRIP }), post(P2, { trip_id: TRIP })];
    use(spec);
    const r = await get(`/trips/${TRIP}/posts`);
    assert.equal(r.status, 200);
    assert.ok(r.body.posts.length > 0);
    for (const p of r.body.posts) {
      assert.equal(p.likeCount, null);
      assert.equal(p.likedByMe, null);
    }
    assert.deepEqual(r.body.failedSources, ["content_stamps"]);
  });
});

describe("GET /posts/:postId (census-media §47)", () => {
  it("PF6 — post_saves unread: savedByMe and saveCount null, named", async () => {
    use(seed({ failReads: { post_saves: true } }));
    const r = await get(`/posts/${P1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.savedByMe, null);
    assert.equal(r.body.saveCount, null);
    assert.ok((r.body.failedSources ?? []).includes("post_saves"));
  });

  it("PF7 — posts_comments unread: commentCount null, named", async () => {
    use(seed({ failReads: { posts_comments: true } }));
    const r = await get(`/posts/${P1}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.commentCount, null);
    assert.ok((r.body.failedSources ?? []).includes("posts_comments"));
  });

  it("PF8 — healthy: saveCount is live, not the cached column", async () => {
    use(seed());
    const r = await get(`/posts/${P2}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.saveCount, 0, "no post_saves rows: 0, whatever save_count (99) says");
    assert.equal(r.body.likeCount, 3);
    assert.equal(r.body.likedByMe, true);
    assert.equal(r.body.failedSources, undefined);
  });
});

describe("more of the same rule (census-media §47)", () => {
  it("PF11 — followers_only post, follow row unread: 503, never 'Post not found'", async () => {
    const spec = seed({ failReads: { user_follows: true } });
    spec.tables.posts = [post(P1, { visibility: "followers_only" })];
    use(spec);
    const r = await get(`/posts/${P1}`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("PF12 — global: post_media unread → media null on every post, and named", async () => {
    use(seed({ failReads: { post_media: (r: any) => r.select.includes("media_type") } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    for (const p of r.body.posts) assert.equal(p.media, null, "unknown is not 'this post has no media'");
    assert.ok(r.body.failedSources.includes("post_media"));
  });

  it("PF13 — global: the hashtag-boost reads unread → named, page still served", async () => {
    use(seed({ failReads: { user_hashtag_follows: true } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    assert.equal(r.body.posts.length, 3);
    assert.ok(r.body.failedSources.includes("user_hashtag_follows"));
  });

  it("PF14 — following: a creator followed past the first 1,000 follows still appears", async () => {
    const spec = seed();
    const LATE = "ffffffff-0000-4000-a000-0000000000ff";
    spec.tables.user_follows = Array.from({ length: 1_100 }, (_, i) => ({
      follower_id: VIEWER, following_id: `eeeeeeee-0000-4000-a000-${String(i).padStart(12, "0")}`,
    }));
    spec.tables.user_follows.push({ follower_id: VIEWER, following_id: LATE });
    spec.tables.profiles.push({ id: LATE, handle: "late", is_private: false, passport_visibility: "public", account_status: "active" });
    spec.tables.posts = [post(P1, { author_id: LATE })];
    use(spec);
    const r = await get("/posts?feed=following");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.posts.map((p: any) => p.id), [P1], "the 1,101st follow must not be cut");
  });
});

describe("hides and authors (census-media §47)", () => {
  it("PF15 — following: post_hides unread → served, and named", async () => {
    use(seed({ failReads: { post_hides: true } }));
    const r = await get("/posts?feed=following");
    assert.equal(r.status, 200);
    assert.ok((r.body.failedSources ?? []).includes("post_hides"), JSON.stringify(r.body.failedSources));
  });

  it("PF16 — global: author profiles unread → named", async () => {
    use(seed({ failReads: { profiles: (q: any) => q.select.includes("avatar_url") } }));
    const r = await get("/posts");
    assert.equal(r.status, 200);
    assert.ok((r.body.failedSources ?? []).includes("profiles"), JSON.stringify(r.body.failedSources));
  });
});
