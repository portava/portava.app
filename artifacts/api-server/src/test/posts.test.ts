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
