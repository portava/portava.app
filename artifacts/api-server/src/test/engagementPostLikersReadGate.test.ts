/**
 * engagementPostLikersReadGate — GET /api/engagement/likes for a POST (`post_like`,
 * `post_reaction`) or a COMMENT (`comment_like`) answers whether the likers may be
 * listed with the post's OWN read decision plus the block check
 * POST /posts/:postId/like makes (census-media §54; B58 lane POSTS-LIKERS, from
 * verifier V-739's adjacent finding).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * routes/engagement.ts `checkPostAccess` admitted the author, a public post, or
 * any `trip_members` row for a trip_only post, over a `posts` read that
 * excluded only `status = 'deleted'`, and it read no `blocks`. POST
 * /posts/:postId/like refuses a pair blocked in EITHER direction with
 * `404 Post not found`; the same viewer was served the same post's likers, and
 * the likers of every comment on it. Anyone was served the likers of an
 * ARCHIVED (`status = 'hidden'`) or a not-yet-published public post, both of
 * which GET /posts/:postId refuses.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *  A. A block in either direction refuses with the post's own 404 — byte for
 *     byte the body POST /posts/:postId/like gives the same pair, and the body
 *     GET /posts/:postId gives a post that does not exist — for all three
 *     target types (a comment's refusal is the comment routes' own 404). A
 *     block between the viewer and a LIKER does not refuse the post: the roster
 *     drops that liker, as it did.
 *  B. An unreadable block state (a returned error, or a thrown read) at the
 *     gate refuses with that same 404, never 200 and never a 503 that only an
 *     existing post could earn. The author passes the gate without a block
 *     read, and the roster's own block read still refuses (503) when it fails.
 *  C. Every state GET /posts/:postId refuses this viewer — measured against the
 *     real GET on the same seed — this route refuses with GET's own bytes.
 *     Readers the post admits on main's narrower likers rule are admitted;
 *     readers it admits beyond that rule are NOT newly admitted (403).
 *  D. An unreadable `posts` (or `posts_comments`) read refuses 503 before the
 *     row's existence is known (the same bytes for a missing id); an unreadable
 *     trip membership or follow refuses with the missing post's 404.
 *
 * The double here models `.or()` with the real PostgREST grammar
 * (helpers/postgrestOrFilter): isBlockedBetween narrows ENTIRELY inside its
 * `.or()`, and a no-op `.or()` would make every seeded block row block every
 * pair — a pass this suite must not be able to get for free.
 *
 * Run: node --import tsx/esm --test src/test/engagementPostLikersReadGate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";

const VIEWER = "00000000-0000-0000-0000-0000000000b1";
const AUTHOR = "00000000-0000-0000-0000-0000000000b2";
const LIKER = "00000000-0000-0000-0000-0000000000b3";
const LIKER2 = "00000000-0000-0000-0000-0000000000b4";
const POST = "40000000-0000-0000-0000-000000000001";
const MISSING = "40000000-0000-0000-0000-0000000000ff";
const COMMENT = "50000000-0000-0000-0000-000000000001";
const COMMENT_MISSING = "50000000-0000-0000-0000-0000000000ff";
const TRIP = "60000000-0000-0000-0000-000000000001";
const TOKEN = "tok-plg-viewer";
const AUTHOR_TOKEN = "tok-plg-author";

const FAIL = { message: "connection terminated unexpectedly", code: "57P01" };

// ── The double ────────────────────────────────────────────────────────────────

interface ReadCtx { table: string; eqs: Record<string, unknown> }

interface Seed {
  /** Overrides on the one post; `null` = it does not exist. */
  post?: Record<string, unknown> | null;
  /** Overrides on the one comment; `null` = it does not exist. */
  comment?: Record<string, unknown> | null;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  follows?: Array<{ follower_id: string; following_id: string }>;
  tripMembers?: Array<Record<string, unknown>>;
  tripOwner?: string;
  /** Make THIS read resolve `{ data: null, error }`, the way supabase-js fails. */
  failOn?: (c: ReadCtx) => boolean;
  /** Make THIS read throw (a torn-down client, a rejected fetch). */
  throwOn?: (c: ReadCtx) => boolean;
  /** Extra likers of the post, by user id. */
  extraLikers?: string[];
}

function client(s: Seed = {}) {
  const profile = (id: string, username: string) => ({
    id, username, handle: username, name: username, display_name: username, avatar_url: null,
    account_status: "active", verified: false, is_private: false, is_official: false,
  });
  const likers = [LIKER, ...(s.extraLikers ?? [])];
  const rows: Record<string, any[]> = {
    profiles: [profile(VIEWER, "viewer"), profile(AUTHOR, "author"), profile(LIKER, "liker"), profile(LIKER2, "liker2")],
    posts: s.post === null ? [] : [{
      id: POST, author_id: AUTHOR, visibility: "public", status: "active", post_status: "published",
      trip_id: null, content: "hola", created_at: "2026-01-01T00:00:00Z", ...(s.post ?? {}),
    }],
    // Real likers: without one, an empty roster would be the true answer anyway.
    content_stamps: likers.map((u, i) => ({ id: `cs-${i}`, user_id: u, entity_type: "post", entity_id: POST, created_at: `2026-01-0${2 + i}T00:00:00Z` })),
    post_reactions: likers.map((u, i) => ({ user_id: u, post_id: POST, emoji: "🙂", created_at: `2026-01-0${2 + i}T00:00:00Z` })),
    posts_comments: s.comment === null ? [] : [{
      id: COMMENT, post_id: POST, user_id: LIKER2, body: "nice", deleted_at: null, parent_comment_id: null,
      created_at: "2026-01-01T00:00:00Z", ...(s.comment ?? {}),
    }],
    comment_likes: likers.map((u, i) => ({ id: `cl-${i}`, user_id: u, comment_id: COMMENT, created_at: `2026-01-0${2 + i}T00:00:00Z` })),
    blocks: (s.blocks ?? []).map((b, i) => ({ id: `blk-${i}`, ...b })),
    user_follows: s.follows ?? [],
    trip_members: s.tripMembers ?? [],
    trips: [{ id: TRIP, owner_id: s.tripOwner ?? AUTHOR }],
    friend_requests: [],
    profile_privacy_settings: [],
  };

  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const eqs: Record<string, unknown> = {};
    let head = false;
    let wantCount = false;
    let orderCol: string | null = null;
    let asc = true;
    let limitN: number | null = null;

    function run(single: "maybe" | "one" | null) {
      const ctx: ReadCtx = { table, eqs };
      if (s.throwOn?.(ctx)) return Promise.reject(new Error(`${table}: fetch failed`));
      if (s.failOn?.(ctx)) return Promise.resolve({ data: null, error: FAIL, count: null });
      let out = (rows[table] ?? []).filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r }));
      if (orderCol) {
        const c = orderCol;
        out.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
      }
      if (limitN != null) out = out.slice(0, limitN);
      if (single) {
        if (out.length > 1) return Promise.resolve({ data: null, error: { message: "multiple rows", code: "PGRST116" }, count: null });
        if (single === "one" && out.length === 0) return Promise.resolve({ data: null, error: { message: "no rows", code: "PGRST116" }, count: null });
        return Promise.resolve({ data: out[0] ?? null, error: null, count: null });
      }
      return Promise.resolve({ data: head ? null : out, error: null, count: wantCount ? out.length : null });
    }

    const b: any = {
      select(_c?: string, o?: { head?: boolean; count?: string }) { if (o?.head) head = true; if (o?.count) wantCount = true; return b; },
      eq(c: string, v: unknown) { eqs[c] = v; preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: unknown) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: unknown[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: unknown) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt(c: string, v: any) { preds.push((r) => r[c] > v); return b; },
      lt(c: string, v: any) { preds.push((r) => r[c] < v); return b; },
      or(expr: string) { const p = orPredicate(expr); preds.push(p); return b; },
      order(c: string, o?: { ascending?: boolean }) { orderCol = c; asc = o?.ascending !== false; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle() { return run("maybe"); },
      single() { return run("one"); },
      then(f: any, j: any) { return run(null).then(f, j); },
    };
    return b;
  }

  const users: Record<string, string> = { [TOKEN]: VIEWER, [AUTHOR_TOKEN]: AUTHOR };
  return {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: { message: "no such function", code: "PGRST202" } }),
    auth: {
      getUser: async (tok: string) => (users[tok]
        ? { data: { user: { id: users[tok] } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } }),
    },
  };
}

// ── Server and calls ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

interface Raw { status: number; text: string; type: string | null; length: string | null; body: any }

async function call(method: string, path: string, token = TOKEN): Promise<Raw> {
  const r = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, connection: "close" } });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, type: r.headers.get("content-type"), length: r.headers.get("content-length"), body };
}

const likers = (type: string, id: string, token = TOKEN) => call("GET", `/api/engagement/likes?targetType=${type}&targetId=${id}`, token);
const postRead = (id: string, token = TOKEN) => call("GET", `/api/posts/${id}`, token);
const postLike = (id: string, token = TOKEN) => call("POST", `/api/posts/${id}/like`, token);
const commentLike = (postId: string, commentId: string, token = TOKEN) => call("POST", `/api/posts/${postId}/comments/${commentId}/like`, token);

/** Byte-identical answers: status, the body's bytes, and the headers that describe them. */
function assertSameAnswer(got: Raw, want: Raw, what: string) {
  assert.equal(got.status, want.status, `${what}: status ${got.status} (${got.text}) vs ${want.status} (${want.text})`);
  assert.equal(got.text, want.text, `${what}: body`);
  assert.equal(got.type, want.type, `${what}: content-type`);
  assert.equal(got.length, want.length, `${what}: content-length`);
}

const POST_404 = '{"error":"not_found","message":"Post not found"}';
const COMMENT_404 = '{"error":"not_found","message":"Comment not found"}';

/** GET /posts/:missing, on the same seed: the post read's own "does not exist". */
async function missingPostAnswer(seed: Seed = {}): Promise<Raw> {
  _setTestClient(client(seed), true);
  const r = await postRead(MISSING);
  assert.equal(r.text, POST_404, "reference: GET /posts/:missing is the post's own 404");
  return r;
}

/** The comment routes' "does not exist", on the same seed (POST …/comments/:missing/like on a public post). */
async function missingCommentAnswer(seed: Seed = {}): Promise<Raw> {
  _setTestClient(client(seed), true);
  const r = await commentLike(POST, COMMENT_MISSING);
  assert.equal(r.text, COMMENT_404, "reference: a missing comment's own 404");
  return r;
}

const BLOCKS: Array<{ name: string; blocks: Seed["blocks"] }> = [
  { name: "the VIEWER blocked the author", blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR }] },
  { name: "the AUTHOR blocked the viewer", blocks: [{ blocker_id: AUTHOR, blocked_id: VIEWER }] },
  { name: "a mutual block", blocks: [{ blocker_id: VIEWER, blocked_id: AUTHOR }, { blocker_id: AUTHOR, blocked_id: VIEWER }] },
];

// ═════════════════════════════════════════════════════════════════════════════

describe("§54 A. a block either way refuses a post's and a comment's likers with the post's own 404", () => {
  it("CONTROL: an unblocked stranger is served a public post's likers (the fixture CAN produce a roster)", async () => {
    for (const type of ["post_like", "post_reaction"]) {
      _setTestClient(client(), true);
      const r = await likers(type, POST);
      assert.equal(r.status, 200, `${type}: ${r.text}`);
      assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER], type);
    }
    _setTestClient(client(), true);
    const c = await likers("comment_like", COMMENT);
    assert.equal(c.status, 200, c.text);
    assert.deepEqual(c.body.users.map((u: any) => u.id), [LIKER]);
  });

  for (const b of BLOCKS) {
    for (const type of ["post_like", "post_reaction"]) {
      it(`${type}: ${b.name} → POST /posts/:postId/like's refusal, byte for byte, and a missing post's`, async () => {
        const seed: Seed = { blocks: b.blocks };
        _setTestClient(client(seed), true);
        const got = await likers(type, POST);
        _setTestClient(client(seed), true);
        const likeRefusal = await postLike(POST);
        assert.equal(likeRefusal.text, POST_404, "reference: the like route refuses this pair");
        assertSameAnswer(got, likeRefusal, `${type} vs POST /posts/:postId/like`);
        assertSameAnswer(got, await missingPostAnswer(seed), `${type} vs a missing post`);
        _setTestClient(client(seed), true);
        assertSameAnswer(await likers(type, MISSING), got, `${type}: a missing post and a blocked one cannot be told apart`);
      });
    }
    it(`comment_like: ${b.name} (the post's author) → the comment's own 404, the same as no comment`, async () => {
      const seed: Seed = { blocks: b.blocks };
      _setTestClient(client(seed), true);
      const got = await likers("comment_like", COMMENT);
      assertSameAnswer(got, await missingCommentAnswer(), "comment_like vs a missing comment");
      _setTestClient(client(seed), true);
      assertSameAnswer(await likers("comment_like", COMMENT_MISSING), got, "comment_like: missing vs blocked");
    });
  }

  it("a block between the viewer and a LIKER (not the author) refuses nothing: the roster drops that liker", async () => {
    for (const blocks of [[{ blocker_id: VIEWER, blocked_id: LIKER2 }], [{ blocker_id: LIKER2, blocked_id: VIEWER }]]) {
      _setTestClient(client({ blocks, extraLikers: [LIKER2] }), true);
      const r = await likers("post_like", POST);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER], "the blocked liker is withheld, the other listed");
    }
  });

  it("the author is served their own post's likers whatever the blocks say (the gate reads no block for the author)", async () => {
    _setTestClient(client({ blocks: [{ blocker_id: AUTHOR, blocked_id: VIEWER }] }), true);
    const r = await likers("post_like", POST, AUTHOR_TOKEN);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
  });
});

describe("§54 B. an unreadable block state at the gate refuses with the missing post's 404", () => {
  const blocksFail = (c: ReadCtx) => c.table === "blocks";

  it("a RETURNED blocks error: a non-author gets the post's 404 — not the roster, and not a 503 only a real post could earn", async () => {
    for (const type of ["post_like", "post_reaction"]) {
      _setTestClient(client({ failOn: blocksFail }), true);
      const got = await likers(type, POST);
      assertSameAnswer(got, await missingPostAnswer(), `${type}: blocks unreadable`);
    }
    _setTestClient(client({ failOn: blocksFail }), true);
    assertSameAnswer(await likers("comment_like", COMMENT), await missingCommentAnswer(), "comment_like: blocks unreadable");
  });

  it("a THROWN blocks read: the same 404 (isBlockedBetween denies a thrown read)", async () => {
    _setTestClient(client({ throwOn: blocksFail }), true);
    const got = await likers("post_like", POST);
    assertSameAnswer(got, await missingPostAnswer(), "post_like: blocks read threw");
  });

  it("a NON-author who passed the gate (its pair read healthy) still gets the roster's own refusal when the roster's block read fails", async () => {
    // Split failure: the gate's isBlockedBetween narrows inside `.or()` (no `.eq`), the roster's
    // readBlockExclusions(among) reads by `.eq(blocker_id | blocked_id)`. Only the second fails.
    _setTestClient(client({ failOn: (c) => c.table === "blocks" && Object.keys(c.eqs).length > 0 }), true);
    const r = await likers("post_like", POST);
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.message, "Could not verify who is blocked. Please try again.", "the ROSTER's refusal, not the gate's");
  });

  it("the AUTHOR passes the gate without a block read, and the roster's own block read still refuses (503)", async () => {
    _setTestClient(client({ failOn: blocksFail }), true);
    const r = await likers("post_like", POST, AUTHOR_TOKEN);
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, "Could not verify who is blocked. Please try again.", "the ROSTER's refusal, not the gate's");
  });
});

/** States GET /posts/:postId refuses this (non-author) viewer — each one listable through this route before the fix, or 403 there. */
const REFUSED: Array<{ name: string; seed: Seed }> = [
  { name: "a private post", seed: { post: { visibility: "private" } } },
  { name: "an ARCHIVED public post (status 'hidden')", seed: { post: { status: "hidden" } } },
  { name: "a deleted post (status 'deleted')", seed: { post: { status: "deleted" } } },
  { name: "a public post not yet published (post_status 'pending_delay')", seed: { post: { post_status: "pending_delay" } } },
  { name: "a trip_only post, viewer not on the trip", seed: { post: { visibility: "trip_only", trip_id: TRIP } } },
  { name: "a trip_only post, viewer only INVITED", seed: { post: { visibility: "trip_only", trip_id: TRIP }, tripMembers: [{ trip_id: TRIP, user_id: VIEWER, role: "invited", status: "invited" }] } },
  { name: "a trip_only post with no trip", seed: { post: { visibility: "trip_only", trip_id: null } } },
  { name: "a followers_only post, viewer not a follower", seed: { post: { visibility: "followers_only" } } },
  { name: "an unknown visibility tier", seed: { post: { visibility: "crew_secret" } } },
];

describe("§54 C. the post's own read decision, measured against the real GET /posts/:postId", () => {
  for (const c of REFUSED) {
    it(`${c.name}: GET /posts/:postId refuses it, and so does the likers route — with GET's bytes`, async () => {
      _setTestClient(client(c.seed), true);
      const got = await likers("post_like", POST);
      _setTestClient(client(c.seed), true);
      const read = await postRead(POST);
      assert.equal(read.text, POST_404, `reference: GET /posts/:postId refuses ${c.name}`);
      assertSameAnswer(got, read, c.name);
      assertSameAnswer(got, await missingPostAnswer(c.seed), `${c.name} vs a missing post`);
      _setTestClient(client(c.seed), true);
      assertSameAnswer(await likers("comment_like", COMMENT), await missingCommentAnswer(), `${c.name}: a comment on it`);
    });
  }

  it("a missing post id: the post's 404 (was 403)", async () => {
    _setTestClient(client(), true);
    assertSameAnswer(await likers("post_like", MISSING), await missingPostAnswer(), "missing");
  });

  it("readers main's likers rule admits are still admitted: an ACCEPTED trip member, the author of a private or pending post", async () => {
    const cases: Array<{ name: string; seed: Seed; token: string }> = [
      { name: "accepted trip member", seed: { post: { visibility: "trip_only", trip_id: TRIP }, tripMembers: [{ trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" }] }, token: TOKEN },
      { name: "author, private post", seed: { post: { visibility: "private" } }, token: AUTHOR_TOKEN },
      { name: "author, pending post", seed: { post: { post_status: "pending_delay" } }, token: AUTHOR_TOKEN },
    ];
    for (const c of cases) {
      _setTestClient(client(c.seed), true);
      const r = await likers("post_like", POST, c.token);
      assert.equal(r.status, 200, `${c.name}: ${r.text}`);
      assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER], c.name);
    }
  });

  it("the trip's OWNER (no trip_members row, by design) reads a trip_only post's likers, as GET and the like route admit them", async () => {
    _setTestClient(client({ post: { visibility: "trip_only", trip_id: TRIP }, tripOwner: VIEWER }), true);
    const r = await likers("post_like", POST);
    assert.equal(r.status, 200, r.text);
  });

  it("the author of an ARCHIVED post gets GET /posts/:postId's own answer to them (404): the read serves no archived post to anyone", async () => {
    const seed: Seed = { post: { status: "hidden" } };
    _setTestClient(client(seed), true);
    const got = await likers("post_like", POST, AUTHOR_TOKEN);
    _setTestClient(client(seed), true);
    assertSameAnswer(got, await postRead(POST, AUTHOR_TOKEN), "archived, author");
  });

  it("NOT WIDENED: a reader the post admits beyond main's likers rule — a follower of a followers_only post, a legacy row with no visibility — still gets 403", async () => {
    const cases: Array<{ name: string; seed: Seed }> = [
      { name: "follower, followers_only", seed: { post: { visibility: "followers_only" }, follows: [{ follower_id: VIEWER, following_id: AUTHOR }] } },
      { name: "legacy row, visibility null", seed: { post: { visibility: null } } },
    ];
    for (const c of cases) {
      _setTestClient(client(c.seed), true);
      const r = await likers("post_like", POST);
      assert.equal(r.status, 403, `${c.name}: ${r.text}`);
      assert.equal(r.body.error, "forbidden", c.name);
      _setTestClient(client(c.seed), true);
      const cr = await likers("comment_like", COMMENT);
      assert.equal(cr.status, 403, `${c.name} (comment): ${cr.text}`);
    }
  });
});

describe("§54 D. unreadable gate reads", () => {
  it("an unreadable `posts` read refuses 503 — the same bytes for a real post and a missing one (no existence oracle)", async () => {
    const seed: Seed = { failOn: (c) => c.table === "posts" };
    _setTestClient(client(seed), true);
    const real = await likers("post_like", POST);
    assert.equal(real.status, 503, real.text);
    assert.equal(real.body.error, "degraded_unavailable");
    assert.equal(real.body.message, "Reactions are temporarily unavailable");
    _setTestClient(client(seed), true);
    assertSameAnswer(await likers("post_like", MISSING), real, "posts unreadable: real vs missing");
    _setTestClient(client(seed), true);
    assertSameAnswer(await likers("comment_like", COMMENT), real, "posts unreadable: a comment's post");
  });

  it("an unreadable `posts_comments` read refuses 503, the same for a real comment and a missing one", async () => {
    const seed: Seed = { failOn: (c) => c.table === "posts_comments" };
    _setTestClient(client(seed), true);
    const real = await likers("comment_like", COMMENT);
    assert.equal(real.status, 503, real.text);
    assert.equal(real.body.message, "Reactions are temporarily unavailable");
    _setTestClient(client(seed), true);
    assertSameAnswer(await likers("comment_like", COMMENT_MISSING), real, "posts_comments unreadable: real vs missing");
  });

  it("an unreadable trip membership refuses with the missing post's 404 (not a 503 only an existing trip_only post could earn)", async () => {
    for (const table of ["trip_members", "trips"]) {
      const seed: Seed = { post: { visibility: "trip_only", trip_id: TRIP }, failOn: (c) => c.table === table };
      _setTestClient(client(seed), true);
      assertSameAnswer(await likers("post_like", POST), await missingPostAnswer(), `${table} unreadable`);
    }
  });

  it("an unreadable follow refuses with the missing post's 404", async () => {
    const seed: Seed = {
      post: { visibility: "followers_only" },
      follows: [{ follower_id: VIEWER, following_id: AUTHOR }],
      failOn: (c) => c.table === "user_follows",
    };
    _setTestClient(client(seed), true);
    assertSameAnswer(await likers("post_like", POST), await missingPostAnswer(), "user_follows unreadable");
  });
});

describe("§54 E. a comment's likers", () => {
  it("a soft-deleted comment and a missing one answer alike: the comment's own 404 (both were 403)", async () => {
    _setTestClient(client({ comment: { deleted_at: "2026-01-05T00:00:00Z" } }), true);
    const deleted = await likers("comment_like", COMMENT);
    assertSameAnswer(deleted, await missingCommentAnswer(), "deleted comment");
    _setTestClient(client(), true);
    assertSameAnswer(await likers("comment_like", COMMENT_MISSING), deleted, "missing comment");
  });
});
