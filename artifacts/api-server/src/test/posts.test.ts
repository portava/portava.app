import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startApp, BEARER, type FakeState } from "./helpers.js";

/**
 * Backend authorization tests for the posts API. Each test stages an in-memory
 * DB state and drives the real route handlers via node:http + fetch. These prove
 * the security rules WITHOUT a live database (the fake client mirrors the subset
 * of supabase-js the routes use).
 *
 * Identity tokens used:
 *   "owner-tok"   -> user owner-1   (trip owner)
 *   "member-tok"  -> user member-1  (accepted member)
 *   "invited-tok" -> user invited-1 (invited, NOT accepted)
 *   "stranger-tok"-> user stranger-1 (no trip relation)
 *   "bad-tok"     -> invalid (auth.getUser fails)
 *
 * TRIP id must be UUID format — the trips/:tripId/posts route validates it.
 */

const TRIP = "00000000-0000-0000-0000-000000000001";

function baseState(): FakeState {
  return {
    users: {
      "owner-tok": { id: "owner-1" },
      "member-tok": { id: "member-1" },
      "invited-tok": { id: "invited-1" },
      "stranger-tok": { id: "stranger-1" },
      // bad-tok intentionally absent -> getUser returns null
    },
    trips: new Set([TRIP]),
    members: [
      { trip_id: TRIP, user_id: "owner-1", role: "owner" },
      { trip_id: TRIP, user_id: "member-1", role: "member" },
      { trip_id: TRIP, user_id: "invited-1", role: "invited" }, // not accepted
    ],
    posts: [],
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function doPost(baseUrl: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function doGet(baseUrl: string, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function doPatch(baseUrl: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function doDel(baseUrl: string, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${baseUrl}${path}`, { method: "DELETE", headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/posts — create", () => {
  it("1. authenticated user can create a standalone post", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("member-tok"), {
      content: "hello world",
      visibility: "public",
    });
    await close();
    assert.equal(status, 201);
    assert.equal(body.author_id, "member-1");
    assert.equal(body.trip_id, null);
  });

  it("2. server sets author_id from the verified token, ignoring client author_id", async () => {
    const { baseUrl, close, client } = await startApp(baseState());
    const { status } = await doPost(baseUrl, "/api/posts", BEARER("member-tok"), {
      content: "x",
      author_id: "owner-1",
      user_id: "owner-1",
      created_by: "owner-1",
    });
    await close();
    assert.equal(status, 201);
    const insertedPost = client.__inserted.find((r: any) => r.table === "posts");
    assert.equal(insertedPost.row.author_id, "member-1");
    assert.equal(insertedPost.row.created_by, "member-1");
  });

  it("3. unauthenticated request (no token) fails 401", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", undefined, { content: "x" });
    await close();
    assert.equal(status, 401);
    assert.equal(body.error, "unauthenticated");
  });

  it("3b. invalid/expired token fails 401", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("bad-tok"), { content: "x" });
    await close();
    assert.equal(status, 401);
    assert.equal(body.error, "unauthenticated");
  });

  it("4. empty payload (no content, no media) fails 400 invalid_payload", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("member-tok"), {});
    await close();
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("5. owner can post to their trip feed", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("owner-tok"), {
      content: "trip note",
      tripId: TRIP,
      visibility: "trip_only",
    });
    await close();
    assert.equal(status, 201);
    assert.equal(body.trip_id, TRIP);
  });

  it("6. accepted member can post to the trip feed", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status } = await doPost(baseUrl, "/api/posts", BEARER("member-tok"), {
      content: "member note",
      tripId: TRIP,
      visibility: "trip_only",
    });
    await close();
    assert.equal(status, 201);
  });

  it("7. invited-but-not-accepted user CANNOT post to the trip feed (403 not_member)", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("invited-tok"), {
      content: "sneaky",
      tripId: TRIP,
      visibility: "trip_only",
    });
    await close();
    assert.equal(status, 403);
    assert.equal(body.error, "not_member");
  });

  it("8. non-member (stranger) cannot post to the trip feed (403 not_member)", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("stranger-tok"), {
      content: "intrude",
      tripId: TRIP,
      visibility: "public",
    });
    await close();
    assert.equal(status, 403);
    assert.equal(body.error, "not_member");
  });

  it("9. posting to a non-existent trip fails 404 not_found", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("owner-tok"), {
      content: "x",
      tripId: "00000000-0000-0000-0000-000000000099",
    });
    await close();
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });

  it("10. trip_only without tripId fails 400 (cross-field rule)", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doPost(baseUrl, "/api/posts", BEARER("member-tok"), {
      content: "x",
      visibility: "trip_only",
    });
    await close();
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

describe("GET /api/posts — global feed", () => {
  it("11. global feed returns only public standalone active posts (no trip_only/private leak)", async () => {
    const st = baseState();
    // post_status must be "published" — global feed filters eq("post_status", "published")
    st.posts = [
      { id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", post_status: "published", content: "a", media_urls: [], created_at: "2026-01-03" },
      { id: "p2", author_id: "member-1", trip_id: null, visibility: "private", status: "active", post_status: "published", content: "secret", media_urls: [], created_at: "2026-01-02" },
      { id: "p3", author_id: "owner-1", trip_id: TRIP, visibility: "trip_only", status: "active", post_status: "published", content: "trip", media_urls: [], created_at: "2026-01-01" },
    ];
    const { baseUrl, close } = await startApp(st);
    const { status, body } = await doGet(baseUrl, "/api/posts", BEARER("stranger-tok"));
    await close();
    assert.equal(status, 200);
    const ids = body.posts.map((p: any) => p.id);
    assert.ok(ids.includes("p1"), "p1 (public) should appear");
    assert.ok(!ids.includes("p2"), "p2 (private) must not leak");
    assert.ok(!ids.includes("p3"), "p3 (trip_only) must not leak");
  });
});

describe("GET /api/posts?feed=following — author identity", () => {
  it("returns the author's real username/name (not stripped) — matches the /api/pulse identity contract", async () => {
    const st = baseState();
    st.user_follows = [{ follower_id: "member-1", following_id: "owner-1" }];
    st.posts = [
      { id: "p1", author_id: "owner-1", trip_id: null, visibility: "public", status: "active", post_status: "published", content: "hi", media_urls: [], created_at: "2026-01-03" },
    ];
    // profiles table uses username/full_name live — not the legacy handle/name
    // columns. Following must resolve the same fields /api/pulse does, or the
    // mobile client falls back to a generic "Traveler" label.
    st.profiles = [
      { id: "owner-1", username: "portava", full_name: "Portava Official", is_official: true },
    ];
    const { baseUrl, close } = await startApp(st);
    const { status, body } = await doGet(baseUrl, "/api/posts?feed=following", BEARER("member-tok"));
    await close();
    assert.equal(status, 200);
    const post = body.posts.find((p: any) => p.id === "p1");
    assert.ok(post, "post from a followed author must appear in the following feed");
    assert.equal(post.author.username, "portava", `expected username to be resolved, got: ${JSON.stringify(post.author)}`);
    assert.notEqual(post.author.name, undefined, "author.name must not be undefined (legacy column drift)");
  });
});

describe("PATCH /api/posts/:id — author-only edit", () => {
  it("12. author can edit their own post", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
    const { baseUrl, close } = await startApp(st);
    const { status } = await doPatch(baseUrl, "/api/posts/p1", BEARER("member-tok"), { content: "new" });
    await close();
    assert.equal(status, 200);
  });

  it("13. non-author cannot edit another user's post (403 forbidden)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
    const { baseUrl, close } = await startApp(st);
    const { status, body } = await doPatch(baseUrl, "/api/posts/p1", BEARER("stranger-tok"), { content: "hijack" });
    await close();
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("14. cannot set trip_only on a standalone post (400)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { baseUrl, close } = await startApp(st);
    const { status, body } = await doPatch(baseUrl, "/api/posts/p1", BEARER("member-tok"), { visibility: "trip_only" });
    await close();
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

describe("DELETE /api/posts/:id — author-only soft delete", () => {
  it("15. author can soft-delete their own post", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { baseUrl, close } = await startApp(st);
    const { status } = await doDel(baseUrl, "/api/posts/p1", BEARER("member-tok"));
    await close();
    assert.equal(status, 204);
  });

  it("16. non-author cannot delete another user's post (403 forbidden)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { baseUrl, close } = await startApp(st);
    const { status, body } = await doDel(baseUrl, "/api/posts/p1", BEARER("stranger-tok"));
    await close();
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });
});

describe("GET /api/trips/:tripId/posts — trip feed membership", () => {
  it("17. non-member request to trip feed succeeds but is flagged isMember=false", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("stranger-tok"));
    await close();
    assert.equal(status, 200);
    assert.equal(body.isMember, false);
  });

  it("17b. accepted member sees isMember=true", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("member-tok"));
    await close();
    assert.equal(status, 200);
    assert.equal(body.isMember, true);
  });

  it("17c. invited user is NOT counted as a member (isMember=false)", async () => {
    const { baseUrl, close } = await startApp(baseState());
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("invited-tok"));
    await close();
    assert.equal(status, 200);
    assert.equal(body.isMember, false);
  });
});

/* ===========================================================================
 * GET /api/trips/:tripId/posts — delayed-publish gate (§23 / §37)
 * ===========================================================================
 * POST /posts writes a delayed-geotag post as status='active' with a PENDING
 * post_status ('pending_location_exit' / 'pending_delay'; moderation can park
 * one at 'pending_safety_review'), and a sweeper flips it to 'published' later.
 * The trip feed gated only status='active' — and POST_COLUMNS has SELECTED
 * post_status all along, the same "selected but never read" shape as the
 * visibility leak on GET /posts/:postId. Every trip member saw the post, its
 * city and its venue label while the author was still standing at the place.
 *
 * The predicate is author-OR-published, matching GET /posts/:postId rather than
 * the strict gate on the Wall / global / Following feeds: this route
 * deliberately shows a viewer their own posts, so a strict gate would hide an
 * author's own pending post from their own trip.
 */
describe("GET /api/trips/:tripId/posts — delayed-publish gate", () => {
  const tripPost = (id: string, over: Record<string, any> = {}) => ({
    id, trip_id: TRIP, author_id: "member-1", content: `post ${id}`,
    visibility: "public", status: "active",
    // NOT NULL DEFAULT 'published' in the schema — a real row always has one.
    post_status: "published",
    created_at: "2026-09-01T10:00:00Z", media_urls: [],
    ...over,
  });
  const PENDING_IDS = ["pending-exit-1", "pending-delay-1", "review-1"];
  function feedState(extra: Partial<FakeState> = {}): FakeState {
    return {
      ...baseState(),
      posts: [
        tripPost("published-1"),
        tripPost("pending-exit-1", { post_status: "pending_location_exit" }),
        tripPost("pending-delay-1", { post_status: "pending_delay" }),
        tripPost("review-1", { post_status: "pending_safety_review" }),
        // No post_status key at all: absent reads as published, exactly as
        // GET /posts/:postId and lib/mediaEligibility treat it.
        (() => { const r: any = tripPost("legacy-1"); delete r.post_status; return r; })(),
      ],
      ...extra,
    };
  }
  const idsOf = (body: any) => ((body.posts ?? []) as any[]).map((p: any) => p.id).sort();

  it("17d. the feed query CARRIES the publication predicate (DB layer)", async () => {
    const captured: FakeState["captured"] = [];
    const { baseUrl, close } = await startApp(feedState({ captured }));
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("stranger-tok"));
    await close();
    assert.equal(status, 200);
    // The fake applies `post_status.eq.published` the way the DB would, so the
    // key-less legacy row does not match here. That is faithful: the column is
    // NOT NULL DEFAULT 'published', so no real row lacks a value — absence only
    // ever comes from a caller that did not select the column, which is what
    // 17e covers.
    assert.deepEqual(idsOf(body), ["published-1"], "only the published post is served");

    const feedReads = (captured ?? []).filter((c) => c.table === "posts" && c.eqs.trip_id === TRIP);
    assert.ok(feedReads.length >= 1, "the trip feed read posts");
    for (const q of feedReads) {
      assert.equal(q.eqs.status, "active");
      assert.ok(
        q.ors.some((o) => o.includes("post_status.eq.published")),
        "the trip-feed query must carry the publication predicate",
      );
    }
  });

  it("17e. pending rows fed PAST the query filter are still refused in memory", async () => {
    const { baseUrl, close } = await startApp(feedState({ ignorePredicateCols: ["post_status"] }));
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("stranger-tok"));
    await close();
    assert.equal(status, 200);
    const ids = idsOf(body);
    for (const id of PENDING_IDS) {
      assert.ok(!ids.includes(id), `${id} (status='active', pending post_status) must never be served`);
    }
    assert.deepEqual(ids, ["legacy-1", "published-1"], "published + legacy (absent ⇒ published)");
  });

  it("17f. the AUTHOR still sees their own pending post (no lockout)", async () => {
    const { baseUrl, close } = await startApp(feedState({ ignorePredicateCols: ["post_status"] }));
    const { status, body } = await doGet(baseUrl, `/api/trips/${TRIP}/posts`, BEARER("member-tok"));
    await close();
    assert.equal(status, 200);
    const ids = idsOf(body);
    for (const id of PENDING_IDS) {
      assert.ok(ids.includes(id), `the author must still see their own ${id}`);
    }
  });
});
