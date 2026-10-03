/**
 * postCountersHonest — census-media §47, defect 1 and the counter paths beside it.
 *
 * The DV-83 verifiers (census-discovery §118.13) found that POST and DELETE
 * /posts/:postId/save stamp `save_count: count ?? 0` over a count read that
 * FAILED: supabase-js resolves `{ count: null, error }`, so an outage wrote a
 * measured 0 into the cached counter and told the client `saveCount: 0`. The
 * comment paths (POST and DELETE /posts/:postId/comments) did the same to
 * `comment_count`, and the comment soft-delete answered `ok: true` over an
 * UPDATE that was refused.
 *
 *   PS1  save:   count unread → 200, saveCount null, failedSources ["post_saves"], cache KEPT
 *   PS2  unsave: count unread → 200, saveCount null, failedSources ["post_saves"], cache KEPT
 *   PS3  save:   healthy → the exact count, stamped (control)
 *   PS4  save:   the cache write refused → still the measured count, and the refusal logged
 *   PC1  comment create: count unread → 201, commentCount null, named, cache KEPT
 *   PC2  comment delete: count unread → 200, commentCount null, named, cache KEPT
 *   PC3  comment delete: the soft-delete UPDATE refused → db_error, never ok:true
 *   PC4  comment delete: the comment read failed → db_error, never "Comment not found"
 *   PC5  comment create: healthy → the exact count, stamped (control)
 *   PS5  GET /posts/:id/savers: the author check unread → db_error, never "Post not found"
 *   PS6  GET /posts/:id/savers: saver profiles unread → 503, never an empty "nobody saved this"
 *   PC6  comment create: the post read unread → db_error, never "Post not found"
 *   PC7  comment create, friends-only: the friendship read unread → 503, never "Only friends can comment"
 *   PC8  comment create, friends-only: friends with an accepted request in BOTH directions may comment
 *        (`.maybeSingle()` over the two-direction filter resolved PGRST116 and refused them)
 *   PC9  comment create, circle-only: the membership read unread → 503
 *   PC10 comment create, verified-only: the caller's profile unread → 503
 *   PR1  reply create: the post read unread → db_error, never "Post not found"
 *   PR2  reply create, friends-only: friends accepted in both directions may reply (the same PGRST116 refusal)
 *   PR3  reply create, verified-only: the caller's profile unread → 503
 *
 * Run: node --import tsx/esm --test src/test/postCountersHonest.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { makeFeedDb, type FakeFeedDb, type FakeFeedDbSpec } from "./helpers/fakeFeedDb.js";

const VIEWER = "aaaaaaaa-0000-4000-a000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-a000-000000000002";
const POST = "11111111-0000-4000-a000-000000000001";
const COMMENT = "33333333-0000-4000-a000-000000000001";
const TOKEN = "tok-viewer";

let db: FakeFeedDb;
let logged: Array<{ level: string; obj: any; msg: string }> = [];
let server: http.Server;
let base = "";

function seed(over: Partial<FakeFeedDbSpec> = {}): FakeFeedDbSpec {
  return {
    users: { [TOKEN]: VIEWER },
    tables: {
      posts: [{
        id: POST, author_id: AUTHOR, status: "active", post_status: "published", visibility: "public",
        trip_id: null, save_count: 7, comment_count: 4, like_count: 0, comments_setting: "everyone",
        content: "hello", created_at: "2026-09-01T00:00:00Z",
      }],
      post_saves: [
        { id: "ps-1", post_id: POST, user_id: "cccccccc-0000-4000-a000-000000000003" },
        { id: "ps-2", post_id: POST, user_id: "dddddddd-0000-4000-a000-000000000004" },
      ],
      posts_comments: [
        { id: COMMENT, post_id: POST, user_id: VIEWER, body: "mine", deleted_at: null, created_at: "2026-09-02T00:00:00Z" },
        { id: "33333333-0000-4000-a000-000000000002", post_id: POST, user_id: AUTHOR, body: "theirs", deleted_at: null, created_at: "2026-09-02T00:00:01Z" },
      ],
      profiles: [{ id: VIEWER, handle: "viewer", name: "Viewer", account_status: "active" }],
    },
    unique: { post_saves: ["post_id", "user_id"] },
    ...over,
  };
}

function use(spec: FakeFeedDbSpec) {
  db = makeFeedDb(spec);
  _setTestClient(db.client, true);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const postRow = () => db.tables.posts.find((p) => p.id === POST)!;
/** Fail only the HEAD count reads of `table` (the recount), not the other reads of it. */
const failCount = (table: string) => ({ [table]: (r: any) => r.head === true });

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const rec = (level: string) => (obj: any, msg?: string) => logged.push({ level, obj, msg: String(msg ?? "") });
    req.log = { trace() {}, debug() {}, info() {}, warn: rec("warn"), error: rec("error"), fatal: rec("fatal") };
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
beforeEach(() => { logged = []; });

describe("POST/DELETE /posts/:postId/save never stamp a failed count (census-media §47, defect 1)", () => {
  it("PS1 — save with the count unread: saveCount null, named, and the cached save_count kept", async () => {
    use(seed({ failReads: failCount("post_saves") }));
    const r = await call("POST", `/posts/${POST}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.savedByMe, true, "the save itself succeeded");
    assert.equal(r.body.saveCount, null, "an unread count is not a measured 0");
    assert.deepEqual(r.body.failedSources, ["post_saves"]);
    assert.equal(postRow().save_count, 7, "the cached counter is kept, not overwritten with 0");
  });

  it("PS2 — unsave with the count unread: saveCount null, named, and the cached save_count kept", async () => {
    use(seed({ failReads: failCount("post_saves") }));
    const r = await call("DELETE", `/posts/${POST}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.savedByMe, false);
    assert.equal(r.body.saveCount, null);
    assert.deepEqual(r.body.failedSources, ["post_saves"]);
    assert.equal(postRow().save_count, 7);
  });

  it("PS3 — control: a healthy save answers and stamps the exact count", async () => {
    use(seed());
    const r = await call("POST", `/posts/${POST}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.saveCount, 3);
    assert.equal(r.body.failedSources, undefined, "a healthy body is unchanged");
    assert.equal(postRow().save_count, 3);
  });

  it("PS4 — a refused cache write still answers the measured count, and is logged", async () => {
    use(seed({ failWrites: { posts: true } }));
    const r = await call("POST", `/posts/${POST}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.saveCount, 3, "the count was measured; only the cache failed");
    assert.ok(
      logged.some((l) => l.level === "error" && /save_count/.test(l.msg)),
      `the refused save_count write must be logged; got ${JSON.stringify(logged.map((l) => l.msg))}`,
    );
  });
});

describe("the comment paths never stamp a failed count (census-media §47)", () => {
  it("PC1 — comment create with the count unread: commentCount null, named, cache kept", async () => {
    use(seed({ failReads: failCount("posts_comments") }));
    const r = await call("POST", `/posts/${POST}/comments`, { body: "a new comment" });
    assert.equal(r.status, 201);
    assert.equal(r.body.commentCount, null);
    assert.deepEqual(r.body.failedSources, ["posts_comments"]);
    assert.equal(postRow().comment_count, 4);
  });

  it("PC2 — comment delete with the count unread: commentCount null, named, cache kept", async () => {
    use(seed({ failReads: failCount("posts_comments") }));
    const r = await call("DELETE", `/posts/${POST}/comments/${COMMENT}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.commentCount, null);
    assert.deepEqual(r.body.failedSources, ["posts_comments"]);
    assert.equal(postRow().comment_count, 4);
  });

  it("PC3 — a refused soft-delete is db_error, never ok:true", async () => {
    use(seed({ failWrites: { posts_comments: true } }));
    const r = await call("DELETE", `/posts/${POST}/comments/${COMMENT}`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.equal(db.tables.posts_comments.find((c) => c.id === COMMENT)!.deleted_at, null);
  });

  it("PC4 — an unread comment is db_error, never 'Comment not found'", async () => {
    use(seed({ failReads: { posts_comments: (r: any) => r.head !== true } }));
    const r = await call("DELETE", `/posts/${POST}/comments/${COMMENT}`);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
  });

  it("PC5 — control: a healthy comment create answers and stamps the exact count", async () => {
    use(seed());
    const r = await call("POST", `/posts/${POST}/comments`, { body: "a new comment" });
    assert.equal(r.status, 201);
    assert.equal(r.body.commentCount, 3);
    assert.equal(r.body.failedSources, undefined);
    assert.equal(postRow().comment_count, 3);
  });
});

describe("savers and comment permissions never answer an outage as a fact (census-media §47)", () => {
  const SAVER = "cccccccc-0000-4000-a000-000000000003";
  const asAuthor = (spec: FakeFeedDbSpec) => ({ ...spec, users: { [TOKEN]: AUTHOR } });

  it("PS5 — savers: the author check unread → db_error", async () => {
    use(asAuthor(seed({ failReads: { posts: true } })));
    const r = await call("GET", `/posts/${POST}/savers`);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("PS6 — savers: saver profiles unread → 503, never an empty list", async () => {
    const spec = asAuthor(seed({ failReads: { profiles: (q: any) => q.select.includes("username") } }));
    spec.tables.profiles.push({ id: SAVER, username: "saver", account_status: "active" });
    use(spec);
    const r = await call("GET", `/posts/${POST}/savers`);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("PC6 — comment create: the post read unread → db_error", async () => {
    use(seed({ failReads: { posts: true } }));
    const r = await call("POST", `/posts/${POST}/comments`, { body: "hi" });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  const withSetting = (setting: string, over: Partial<FakeFeedDbSpec> = {}) => {
    const spec = seed(over);
    spec.tables.posts[0].comments_setting = setting;
    return spec;
  };

  it("PC7 — friends-only: the friendship read unread → 503", async () => {
    use(withSetting("friends", { failReads: { friend_requests: true } }));
    const r = await call("POST", `/posts/${POST}/comments`, { body: "hi" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("PC8 — friends-only: an accepted request in both directions still lets a friend comment", async () => {
    const spec = withSetting("friends");
    spec.tables.friend_requests = [
      { id: "fr-a", requester_id: VIEWER, recipient_id: AUTHOR, status: "accepted" },
      { id: "fr-b", requester_id: AUTHOR, recipient_id: VIEWER, status: "accepted" },
    ];
    use(spec);
    const r = await call("POST", `/posts/${POST}/comments`, { body: "hi" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it("PC9 — circle-only: the membership read unread → 503", async () => {
    use(withSetting("circle", { failReads: { circle_memberships: true } }));
    const r = await call("POST", `/posts/${POST}/comments`, { body: "hi" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });

  it("PC10 — verified-only: the caller's profile unread → 503", async () => {
    use(withSetting("verified", { failReads: { profiles: (q: any) => q.select === "verified" } }));
    const r = await call("POST", `/posts/${POST}/comments`, { body: "hi" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
});

describe("reply permissions, the same rule (census-media §47)", () => {
  const withSetting = (setting: string, over: Partial<FakeFeedDbSpec> = {}) => {
    const spec = seed(over);
    spec.tables.posts[0].comments_setting = setting;
    return spec;
  };
  const replyPath = `/posts/${POST}/comments/33333333-0000-4000-a000-000000000002/replies`;

  it("PR1 — reply create: the post read unread → db_error", async () => {
    use(seed({ failReads: { posts: true } }));
    const r = await call("POST", replyPath, { body: "re" });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "db_error");
  });

  it("PR2 — friends-only: friends accepted in both directions may reply", async () => {
    const spec = withSetting("friends");
    spec.tables.friend_requests = [
      { id: "fr-a", requester_id: VIEWER, recipient_id: AUTHOR, status: "accepted" },
      { id: "fr-b", requester_id: AUTHOR, recipient_id: VIEWER, status: "accepted" },
    ];
    spec.tables.posts_comments.forEach((c) => { c.parent_comment_id = null; });
    use(spec);
    const r = await call("POST", replyPath, { body: "re" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it("PR3 — verified-only: the caller's profile unread → 503", async () => {
    const spec = withSetting("verified", { failReads: { profiles: (q: any) => q.select === "verified" } });
    spec.tables.posts_comments.forEach((c) => { c.parent_comment_id = null; });
    use(spec);
    const r = await call("POST", replyPath, { body: "re" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
  });
});
