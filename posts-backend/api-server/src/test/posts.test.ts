import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { makeApp, BEARER, type FakeState } from "./helpers";

/**
 * Backend authorization tests for the posts API. Each test stages an in-memory
 * DB state and drives the real route handlers via supertest. These prove the
 * security rules WITHOUT a live database (the fake client mirrors the subset of
 * supabase-js the routes use).
 *
 * Identity tokens used:
 *   "owner-tok"  -> user owner-1   (trip owner)
 *   "member-tok" -> user member-1  (accepted member)
 *   "invited-tok"-> user invited-1 (invited, NOT accepted)
 *   "stranger-tok"-> user stranger-1 (no trip relation)
 *   "bad-tok"    -> invalid (auth.getUser fails)
 */

const TRIP = "trip-1";

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

beforeEach(() => {
  vi.resetModules();
});

describe("POST /api/posts — create", () => {
  it("1. authenticated user can create a standalone post", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("member-tok"))
      .send({ content: "hello world", visibility: "public" });
    expect(res.status).toBe(201);
    expect(res.body.author_id).toBe("member-1");
    expect(res.body.trip_id).toBeNull();
  });

  it("2. server sets author_id from the verified token, ignoring client author_id", async () => {
    const { app, client } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("member-tok"))
      .send({ content: "x", author_id: "owner-1", user_id: "owner-1", created_by: "owner-1" });
    expect(res.status).toBe(201);
    // the actual inserted row must carry the verified user, not the spoofed one
    const insertedPost = client.__inserted.find((r: any) => r.table === "posts");
    expect(insertedPost.row.author_id).toBe("member-1");
    expect(insertedPost.row.created_by).toBe("member-1");
  });

  it("3. unauthenticated request (no token) fails 401", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).post("/api/posts").send({ content: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("3b. invalid/expired token fails 401", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).post("/api/posts").set(BEARER("bad-tok")).send({ content: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthenticated");
  });

  it("4. empty payload (no content, no media) fails 400 invalid_payload", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).post("/api/posts").set(BEARER("member-tok")).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("5. owner can post to their trip feed", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("owner-tok"))
      .send({ content: "trip note", tripId: TRIP, visibility: "trip_only" });
    expect(res.status).toBe(201);
    expect(res.body.trip_id).toBe(TRIP);
  });

  it("6. accepted member can post to the trip feed", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("member-tok"))
      .send({ content: "member note", tripId: TRIP, visibility: "trip_only" });
    expect(res.status).toBe(201);
  });

  it("7. invited-but-not-accepted user CANNOT post to the trip feed (403 not_member)", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("invited-tok"))
      .send({ content: "sneaky", tripId: TRIP, visibility: "trip_only" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_member");
  });

  it("8. non-member (stranger) cannot post to the trip feed (403 not_member)", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("stranger-tok"))
      .send({ content: "intrude", tripId: TRIP, visibility: "public" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_member");
  });

  it("9. posting to a non-existent trip fails 404 not_found", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("owner-tok"))
      .send({ content: "x", tripId: "trip-does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("10. trip_only without tripId fails 400 (cross-field rule)", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app)
      .post("/api/posts")
      .set(BEARER("member-tok"))
      .send({ content: "x", visibility: "trip_only" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });
});

describe("GET /api/posts — global feed", () => {
  it("11. global feed returns only public standalone active posts (no trip_only/private leak)", async () => {
    const st = baseState();
    st.posts = [
      { id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "a", media_urls: [], created_at: "2026-01-03" },
      { id: "p2", author_id: "member-1", trip_id: null, visibility: "private", status: "active", content: "secret", media_urls: [], created_at: "2026-01-02" },
      { id: "p3", author_id: "owner-1", trip_id: TRIP, visibility: "trip_only", status: "active", content: "trip", media_urls: [], created_at: "2026-01-01" },
    ];
    const { app } = await makeApp(st);
    const res = await request(app).get("/api/posts").set(BEARER("stranger-tok"));
    expect(res.status).toBe(200);
    const ids = res.body.posts.map((p: any) => p.id);
    expect(ids).toContain("p1");
    expect(ids).not.toContain("p2"); // private must not leak
    expect(ids).not.toContain("p3"); // trip_only must not leak
  });
});

describe("PATCH /api/posts/:id — author-only edit", () => {
  it("12. author can edit their own post", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
    const { app } = await makeApp(st);
    const res = await request(app).patch("/api/posts/p1").set(BEARER("member-tok")).send({ content: "new" });
    expect(res.status).toBe(200);
  });

  it("13. non-author cannot edit another user's post (403 forbidden)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "old", media_urls: [] }];
    const { app } = await makeApp(st);
    const res = await request(app).patch("/api/posts/p1").set(BEARER("stranger-tok")).send({ content: "hijack" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("14. cannot set trip_only on a standalone post (400)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { app } = await makeApp(st);
    const res = await request(app).patch("/api/posts/p1").set(BEARER("member-tok")).send({ visibility: "trip_only" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });
});

describe("DELETE /api/posts/:id — author-only soft delete", () => {
  it("15. author can soft-delete their own post", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { app, client } = await makeApp(st);
    const res = await request(app).delete("/api/posts/p1").set(BEARER("member-tok"));
    expect(res.status).toBe(204);
  });

  it("16. non-author cannot delete another user's post (403 forbidden)", async () => {
    const st = baseState();
    st.posts = [{ id: "p1", author_id: "member-1", trip_id: null, visibility: "public", status: "active", content: "x", media_urls: [] }];
    const { app } = await makeApp(st);
    const res = await request(app).delete("/api/posts/p1").set(BEARER("stranger-tok"));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });
});

describe("GET /api/trips/:tripId/posts — trip feed membership", () => {
  it("17. non-member request to trip feed succeeds but is flagged isMember=false", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).get(`/api/trips/${TRIP}/posts`).set(BEARER("stranger-tok"));
    expect(res.status).toBe(200);
    expect(res.body.isMember).toBe(false);
  });

  it("17b. accepted member sees isMember=true", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).get(`/api/trips/${TRIP}/posts`).set(BEARER("member-tok"));
    expect(res.status).toBe(200);
    expect(res.body.isMember).toBe(true);
  });

  it("17c. invited user is NOT counted as a member (isMember=false)", async () => {
    const { app } = await makeApp(baseState());
    const res = await request(app).get(`/api/trips/${TRIP}/posts`).set(BEARER("invited-tok"));
    expect(res.status).toBe(200);
    expect(res.body.isMember).toBe(false);
  });
});
