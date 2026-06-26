/**
 * GET /api/users/suggestions — "people you may know" endpoint
 *
 * Primary: followers the caller hasn't followed back, excluding blocked.
 * Fallback: when no follow-back candidates exist, returns a sample of
 * recently-joined profiles so new users always see suggestions.
 * Gracefully returns [] on DB errors.
 *
 * Run: node --import tsx/esm --test src/test/userSuggestions.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearAllSeen } from "../lib/suggestionSeenCache.js";
import followsRouter from "../routes/follows.js";

// ── fake state ────────────────────────────────────────────────────────────────

const ME = "user-me";
const A  = "user-a";
const B  = "user-b";
const C  = "user-c";   // blocked by me

const ME_TOK = "tok-me";

type ProfileEntry = {
  id: string;
  handle: string;
  name: string;
  avatar_url: string | null;
  is_private: boolean;
  travel_styles?: string[] | null;
  travel_pace?: string | null;
  budget_style?: string | null;
  travel_group_style?: string[] | null;
  looking_for?: string[] | null;
  comfort_level?: string | null;
  planning_style?: string | null;
};

function makeFakeClient(state: {
  follows:       { follower_id: string; following_id: string }[];
  profiles:      ProfileEntry[];
  blocks:        { blocker_id: string; blocked_id: string }[];
  trips?:        { id: string; owner_id: string; end_date: string; created_at?: string; destination_city?: string | null; destination_country?: string | null }[];
  trip_members?: { trip_id: string; user_id: string; role: string }[];
}) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK ? { data: { user: { id: ME } }, error: null }
                       : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];

      const builder: any = {
        select()  { return builder; },
        eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
        gte(col: string, val: any)   { filters.push((r) => r[col] >= val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "in") {
            const vals: any[] = Array.isArray(val) ? val : [];
            filters.push((r) => !vals.includes(r[col]));
          }
          return builder;
        },
        or(expr: string) {
          // parse "blocker_id.eq.X,blocked_id.eq.X" style
          const parts = expr.split(",").map((p) => p.trim().split("."));
          filters.push((r) =>
            parts.some(([col, , val]) => String(r[col]) === String(val))
          );
          return builder;
        },
        limit() { return builder; },
        order() { return builder; },
        maybeSingle() { return resolveSingle(); },
        then(onF: any, onR: any) { return resolveList().then(onF, onR); },
      };

      function source(): any[] {
        if (table === "user_follows")  return state.follows;
        if (table === "profiles")      return state.profiles;
        if (table === "user_blocks")   return state.blocks;
        if (table === "trips")         return state.trips ?? [];
        if (table === "trip_members")  return state.trip_members ?? [];
        return [];
      }

      function rows() { return source().filter((r) => filters.every((f) => f(r))); }

      async function resolveList() { return { data: rows(), error: null }; }
      async function resolveSingle() { const r = rows(); return { data: r[0] ?? null, error: null }; }

      return builder;
    },
  };
}

// ── server ────────────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", followsRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function req(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
}

function setup(state: Parameters<typeof makeFakeClient>[0]) {
  const client = makeFakeClient(state) as any;
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/users/suggestions", () => {
  // Wipe the seen-IDs cache between every test so exclusion state doesn't bleed across cases.
  beforeEach(() => _clearAllSeen());
  it("returns 401 when unauthenticated", async () => {
    setup({ follows: [], profiles: [], blocks: [] });
    const r = await req("/users/suggestions", "bad-token");
    assert.equal(r.status, 401);
  });

  it("returns [] when caller has no followers and no other profiles exist", async () => {
    setup({ follows: [], profiles: [], blocks: [] });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.users, []);
  });

  it("falls back to recent profiles when caller has no followers", async () => {
    // New user (ME) has no followers — should see A and B from fallback query
    setup({
      follows: [],
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
        { id: ME, handle: "me", name: "Me",    avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids = body.users.map((u: any) => u.id);
    assert.ok(ids.includes(A), "A should appear in fallback suggestions");
    assert.ok(ids.includes(B), "B should appear in fallback suggestions");
    assert.ok(!ids.includes(ME), "ME (self) should not appear");
  });

  it("fallback excludes blocked users", async () => {
    // New user with no followers — fallback should not return C (blocked)
    setup({
      follows: [],
      profiles: [
        { id: B, handle: "bbb", name: "Bob",  avatar_url: null, is_private: false },
        { id: C, handle: "ccc", name: "Carl", avatar_url: null, is_private: false },
      ],
      blocks: [{ blocker_id: ME, blocked_id: C }],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids = body.users.map((u: any) => u.id);
    assert.ok(ids.includes(B),  "B (not blocked) should appear in fallback");
    assert.ok(!ids.includes(C), "C (blocked) should not appear in fallback");
  });

  it("fallback excludes already-followed users", async () => {
    // ME follows A but A doesn't follow back — fallback should not suggest A again
    setup({
      follows: [{ follower_id: ME, following_id: A }],
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids = body.users.map((u: any) => u.id);
    assert.ok(!ids.includes(A), "A (already followed) should not appear in fallback");
    assert.ok(ids.includes(B),  "B (not yet followed) should appear in fallback");
  });

  it("returns [] when all followers are already followed back", async () => {
    setup({
      follows: [
        { follower_id: A, following_id: ME },  // A follows me
        { follower_id: ME, following_id: A },  // I follow A back
      ],
      profiles: [{ id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false }],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.users, []);
  });

  it("returns followers I haven't followed back", async () => {
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
        { follower_id: ME, following_id: A },  // already following A
      ],
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // Only B should appear (A is already followed back)
    assert.equal(body.users.length, 1);
    assert.equal(body.users[0].id, B);
    assert.equal(body.users[0].isFollowing, false);
    assert.equal(body.users[0].username, "bbb");
  });

  it("excludes blocked users", async () => {
    setup({
      follows: [
        { follower_id: B, following_id: ME },
        { follower_id: C, following_id: ME },
      ],
      profiles: [
        { id: B, handle: "bbb", name: "Bob",  avatar_url: null, is_private: false },
        { id: C, handle: "ccc", name: "Carl", avatar_url: null, is_private: false },
      ],
      blocks: [{ blocker_id: ME, blocked_id: C }],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids = body.users.map((u: any) => u.id);
    assert.ok(ids.includes(B), "B (not blocked) should appear");
    assert.ok(!ids.includes(C), "C (blocked) should not appear");
  });

  it("fallback uses a daily seed — same ordering for all requests within a day", async () => {
    // Build a pool of 10 distinct profiles (no followers, so fallback is used)
    const pool = Array.from({ length: 10 }, (_, i) => ({
      id: `pool-user-${i}`,
      handle: `user${i}`,
      name: `User ${i}`,
      avatar_url: null,
      is_private: false,
    }));
    setup({ follows: [], profiles: pool, blocks: [] });

    // 20 requests on the same calendar day must all return the same ordering
    const orderings = await Promise.all(
      Array.from({ length: 20 }, () =>
        req("/users/suggestions")
          .then((r) => r.json())
          .then((body: any) => body.users.map((u: any) => u.id).join(","))
      )
    );

    const unique = new Set(orderings);
    assert.equal(
      unique.size,
      1,
      `Expected a single stable ordering within the same day, got ${unique.size} distinct orderings`
    );
  });

  it("primary follow-back candidates use a daily seed — same ordering for all requests within a day", async () => {
    // 10 users all follow ME — these become primary candidates (not fallback)
    const followers = Array.from({ length: 10 }, (_, i) => ({
      id: `follower-${i}`,
      handle: `follower${i}`,
      name: `Follower ${i}`,
      avatar_url: null,
      is_private: false,
    }));
    const follows = followers.map((f) => ({ follower_id: f.id, following_id: ME }));
    setup({ follows, profiles: followers, blocks: [] });

    // 20 requests on the same calendar day must all return the same ordering
    const orderings = await Promise.all(
      Array.from({ length: 20 }, () =>
        req("/users/suggestions")
          .then((r) => r.json())
          .then((body: any) => body.users.map((u: any) => u.id).join(","))
      )
    );

    const unique = new Set(orderings);
    assert.equal(
      unique.size,
      1,
      `Expected a single stable ordering within the same day, got ${unique.size} distinct orderings`
    );
  });

  it("returns correct TravelerSearchResult shape", async () => {
    setup({
      follows: [{ follower_id: B, following_id: ME }],
      profiles: [{ id: B, handle: "traveler1", name: "Trav One", avatar_url: "https://cdn/a.jpg", is_private: false }],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const u = body.users[0];
    assert.equal(u.id, B);
    assert.equal(u.displayName, "Trav One");
    assert.equal(u.username, "traveler1");
    assert.equal(u.avatarUrl, "https://cdn/a.jpg");
    assert.equal(typeof u.followerCount, "number");
    assert.equal(u.isFollowing, false);
    assert.equal(u.isPrivate, false);
    assert.equal(typeof u.mutualCount, "number");
  });

  it("follow-back candidate gets reason 'Follows you'", async () => {
    // B follows ME — so B is a follow-back candidate
    setup({
      follows: [{ follower_id: B, following_id: ME }],
      profiles: [{ id: B, handle: "bbb", name: "Bob", avatar_url: null, is_private: false }],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const u = body.users[0];
    assert.equal(u.reason, "Follows you");
  });

  it("mutual connection count is computed and reflected in reason", async () => {
    // ME follows A; A also follows B; B is in the fallback pool (doesn't follow ME)
    // => 1 mutual connection between ME and B (via A)
    setup({
      follows: [
        { follower_id: ME, following_id: A },   // ME follows A
        { follower_id: A,  following_id: B },   // A follows B
      ],
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const bUser = body.users.find((u: any) => u.id === B);
    assert.ok(bUser, "B should appear in suggestions");
    assert.equal(bUser.mutualCount, 1);
    assert.equal(bUser.reason, "1 mutual connection");
  });

  it("plural mutual connections reason when count > 1", async () => {
    // ME follows A and C; both A and C follow B
    const D = "user-d"; // ME follows D; D follows B too
    setup({
      follows: [
        { follower_id: ME, following_id: A },
        { follower_id: ME, following_id: D },
        { follower_id: A,  following_id: B },
        { follower_id: D,  following_id: B },
      ],
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
        { id: D, handle: "ddd", name: "Dave",  avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const bUser = body.users.find((u: any) => u.id === B);
    assert.ok(bUser, "B should appear in suggestions");
    assert.equal(bUser.mutualCount, 2);
    assert.equal(bUser.reason, "2 mutual connections");
  });

  it("reason is null when no mutual connections and candidate does not follow back", async () => {
    // Pure fallback: ME has no followers, B has no connection to ME at all
    setup({
      follows: [],
      profiles: [{ id: B, handle: "bbb", name: "Bob", avatar_url: null, is_private: false }],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const bUser = body.users.find((u: any) => u.id === B);
    assert.ok(bUser, "B should appear in fallback suggestions");
    assert.equal(bUser.mutualCount, 0);
    assert.equal(bUser.reason, null);
  });

  it("combined reason when candidate both follows caller and shares a trip destination", async () => {
    // B follows ME (primary follow-back candidate) AND both have a trip to Bali.
    const futureDate = "2099-12-31";
    setup({
      follows:  [{ follower_id: B, following_id: ME }],
      profiles: [{ id: B, handle: "bbb", name: "Bob", avatar_url: null, is_private: false }],
      blocks:   [],
      trips: [
        { id: "trip-me", owner_id: ME, end_date: futureDate, created_at: new Date().toISOString(), destination_city: "Bali", destination_country: "Indonesia" },
        { id: "trip-b",  owner_id: B,  end_date: futureDate, created_at: new Date().toISOString(), destination_city: "Bali", destination_country: "Indonesia" },
      ],
      trip_members: [
        { trip_id: "trip-me", user_id: ME, role: "owner" },
        { trip_id: "trip-b",  user_id: B,  role: "owner" },
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const u = body.users.find((x: any) => x.id === B);
    assert.ok(u, "B should appear in suggestions");
    assert.equal(u.reason, "Follows you · Both going to Bali");
  });

  it("destination-only reason when candidate shares a destination but does not follow caller", async () => {
    // B does NOT follow ME, but they share a trip to Bali — reason should be "Both going to Bali" only.
    const futureDate = "2099-12-31";
    setup({
      follows:  [],
      profiles: [{ id: B, handle: "bbb", name: "Bob", avatar_url: null, is_private: false }],
      blocks:   [],
      trips: [
        { id: "trip-me", owner_id: ME, end_date: futureDate, created_at: new Date().toISOString(), destination_city: "Bali", destination_country: "Indonesia" },
        { id: "trip-b",  owner_id: B,  end_date: futureDate, created_at: new Date().toISOString(), destination_city: "Bali", destination_country: "Indonesia" },
      ],
      trip_members: [
        { trip_id: "trip-me", user_id: ME, role: "owner" },
        { trip_id: "trip-b",  user_id: B,  role: "owner" },
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const u = body.users.find((x: any) => x.id === B);
    assert.ok(u, "B should appear in suggestions");
    assert.equal(u.reason, "Both going to Bali");
  });

  // ── seen-cache exclusion — primary (follow-back) path ────────────────────────

  it("primary follow-back excludes candidates seen in a previous request", async () => {
    // 20 followers — more than the 10-item per-request slice.
    // First call returns up to 10; second call must only return IDs not yet seen.
    const followers = Array.from({ length: 20 }, (_, i) => ({
      id: `fb-user-${i}`,
      handle: `fb${i}`,
      name: `Follower ${i}`,
      avatar_url: null,
      is_private: false,
    }));
    const follows = followers.map((f) => ({ follower_id: f.id, following_id: ME }));
    setup({ follows, profiles: followers, blocks: [] });

    const r1 = await req("/users/suggestions");
    const body1 = await r1.json() as any;
    const seenAfterFirst = new Set<string>(body1.users.map((u: any) => u.id));
    assert.ok(seenAfterFirst.size > 0, "first request should return some followers");

    const r2 = await req("/users/suggestions");
    const body2 = await r2.json() as any;
    for (const u of body2.users) {
      assert.ok(
        !seenAfterFirst.has(u.id),
        `${u.id} was already seen in the first request and should be excluded from primary follow-back`
      );
    }
  });

  it("primary follow-back resets and returns results when all candidates have been seen", async () => {
    // Only 2 followers — both are served in the first call.
    // The second call must reset and still return suggestions (not an empty list).
    const follows = [
      { follower_id: A, following_id: ME },
      { follower_id: B, following_id: ME },
    ];
    setup({
      follows,
      profiles: [
        { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
        { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });

    const r1 = await req("/users/suggestions");
    assert.equal(r1.status, 200);
    const body1 = await r1.json() as any;
    assert.ok(body1.users.length > 0, "first call should have results");

    const r2 = await req("/users/suggestions");
    assert.equal(r2.status, 200);
    const body2 = await r2.json() as any;
    assert.ok(body2.users.length > 0, "second call should reset and return results instead of empty list");
  });

  // ── seen-cache exclusion — fallback path ──────────────────────────────────────

  it("fallback excludes IDs seen in a previous request", async () => {
    // Pool of 20 profiles — larger than the 10-item per-request slice.
    // First call returns up to 10; second call must only return IDs not yet seen.
    const pool = Array.from({ length: 20 }, (_, i) => ({
      id: `pool-${i}`,
      handle: `u${i}`,
      name: `User ${i}`,
      avatar_url: null,
      is_private: false,
    }));
    setup({ follows: [], profiles: pool, blocks: [] });

    const r1 = await req("/users/suggestions");
    const body1 = await r1.json() as any;
    const seenAfterFirst = new Set<string>(body1.users.map((u: any) => u.id));
    assert.ok(seenAfterFirst.size > 0, "first request should return some users");

    // Second call — the seen IDs should not reappear (pool still has unseen profiles)
    const r2 = await req("/users/suggestions");
    const body2 = await r2.json() as any;
    for (const u of body2.users) {
      assert.ok(
        !seenAfterFirst.has(u.id),
        `${u.id} was already seen in the first request and should be excluded`
      );
    }
  });

  it("fallback resets and returns results when all pool IDs have been seen", async () => {
    // Only 2 profiles in the pool. After the first call both are seen.
    // The second call should reset and still return results (not an empty list).
    const pool = [
      { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
      { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
    ];
    setup({ follows: [], profiles: pool, blocks: [] });

    const r1 = await req("/users/suggestions");
    assert.equal(r1.status, 200);
    const body1 = await r1.json() as any;
    assert.ok(body1.users.length > 0, "first call should have results");

    // After first call the whole pool is exhausted — second call must still work.
    const r2 = await req("/users/suggestions");
    assert.equal(r2.status, 200);
    const body2 = await r2.json() as any;
    assert.ok(body2.users.length > 0, "second call should reset and return results instead of empty list");
  });

  // ── interest-scoring / ranking ────────────────────────────────────────────────

  it("ranking: overlapping travel_styles rank a candidate above one without", async () => {
    // ME has travel_styles ["adventure", "backpacking"].
    // A shares one style (score 1). B shares none (score 0).
    // With primary follow-back path: both A and B follow ME.
    // After scoring, A (score 1) must appear before B (score 0).
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me", name: "Me", avatar_url: null, is_private: false,
          travel_styles: ["adventure", "backpacking"] },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          travel_styles: ["adventure"] },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          travel_styles: [] },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (1 style match) should rank before B (0 matches), got order ${ids.join(", ")}`
    );
  });

  it("ranking: travel_pace and budget_style each contribute independently to the score", async () => {
    // ME has travel_pace "slow" and budget_style "budget".
    // A matches travel_pace only  → score 1
    // B matches budget_style only → score 1
    // C matches both              → score 2
    // Expected order: C first, then A and B (in any order), none absent.
    const D_LOCAL = "user-d-local";
    setup({
      follows: [
        { follower_id: A,       following_id: ME },
        { follower_id: B,       following_id: ME },
        { follower_id: C,       following_id: ME },
        { follower_id: D_LOCAL, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me", name: "Me", avatar_url: null, is_private: false,
          travel_pace: "slow", budget_style: "budget" },
        { id: A,       handle: "aaa", name: "Alice",  avatar_url: null, is_private: false,
          travel_pace: "slow" },
        { id: B,       handle: "bbb", name: "Bob",    avatar_url: null, is_private: false,
          budget_style: "budget" },
        { id: C,       handle: "ccc", name: "Carol",  avatar_url: null, is_private: false,
          travel_pace: "slow", budget_style: "budget" },
        { id: D_LOCAL, handle: "ddd", name: "Dave",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posC = ids.indexOf(C);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posC !== -1, "C (both matches, score 2) should appear");
    assert.ok(posA !== -1, "A (pace match, score 1) should appear");
    assert.ok(posB !== -1, "B (budget match, score 1) should appear");
    assert.ok(
      posC < posA && posC < posB,
      `C (score 2) must rank above A and B (score 1 each); got ${ids.join(", ")}`
    );
  });

  it("ranking: caller with empty profile gets all scores 0 — seeded-shuffle order is stable", async () => {
    // ME has no interest profile. All candidates score 0, so the seeded-shuffle
    // order must be used unchanged. Multiple calls within the same day must
    // return the same ordering (same stability guarantee as seeded-shuffle alone).
    const followers = Array.from({ length: 10 }, (_, i) => ({
      id: `rank-user-${i}`,
      handle: `rank${i}`,
      name: `Rank ${i}`,
      avatar_url: null as null,
      is_private: false,
    }));
    const follows = followers.map((f) => ({ follower_id: f.id, following_id: ME }));
    // ME has no profile row (maybeSingle returns null → all caller interest fields empty)
    setup({ follows, profiles: followers, blocks: [] });

    const orderings = await Promise.all(
      Array.from({ length: 10 }, () =>
        req("/users/suggestions")
          .then((r) => r.json())
          .then((body: any) => (body.users as any[]).map((u) => u.id).join(","))
      )
    );
    const unique = new Set(orderings);
    assert.equal(
      unique.size,
      1,
      `Empty caller profile: expected stable seeded order across all calls, got ${unique.size} distinct orderings`
    );
  });

  it("ranking: blocked users are never returned regardless of interest score", async () => {
    // ME has travel_styles ["adventure"].
    // C is blocked by ME and has a very high style overlap (score 3).
    // B has no overlap (score 0) but is not blocked.
    // C must never appear; B must appear.
    setup({
      follows: [
        { follower_id: B, following_id: ME },
        { follower_id: C, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",   avatar_url: null, is_private: false,
          travel_styles: ["adventure"] },
        { id: B,  handle: "bbb", name: "Bob",  avatar_url: null, is_private: false,
          travel_styles: [] },
        { id: C,  handle: "ccc", name: "Carl", avatar_url: null, is_private: false,
          travel_styles: ["adventure", "backpacking", "luxury"] },
      ],
      blocks: [{ blocker_id: ME, blocked_id: C }],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    assert.ok(!ids.includes(C), "C (blocked, high score) must never appear");
    assert.ok(ids.includes(B), "B (not blocked, score 0) must still appear");
  });

  it("ranking: high mutual-connection count beats high interest-only score", async () => {
    // Both A and B follow ME — both are primary follow-back candidates.
    // ME follows D_MUT and E_MUT, who both follow A.
    //   → A has 2 mutual connections with ME, 0 style matches.
    //   → B has 0 mutual connections, 1 style match with ME.
    // Combined scores: A = 2×3 + 0 = 6; B = 0×3 + 1 = 1.
    // A must rank above B even though B has a direct interest match.
    const D_MUT = "user-d-mut";
    const E_MUT = "user-e-mut";
    setup({
      follows: [
        { follower_id: A,     following_id: ME },    // A follows ME → candidate
        { follower_id: B,     following_id: ME },    // B follows ME → candidate
        { follower_id: ME,    following_id: D_MUT }, // ME follows D (mutual source)
        { follower_id: ME,    following_id: E_MUT }, // ME follows E (mutual source)
        { follower_id: D_MUT, following_id: A },    // D follows A → 1st mutual for A
        { follower_id: E_MUT, following_id: A },    // E follows A → 2nd mutual for A
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false,
          travel_styles: ["adventure"] },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false,
          travel_styles: [] },                        // 0 style matches, 2 mutual connections
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false,
          travel_styles: ["adventure"] },              // 1 style match, 0 mutual connections
        { id: D_MUT, handle: "dmut", name: "Dave",  avatar_url: null, is_private: false },
        { id: E_MUT, handle: "emut", name: "Eve",   avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (2 mutual connections) should appear in suggestions");
    assert.ok(posB !== -1, "B (1 interest match) should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (mutualCount=2, combined=6) must rank above B (mutualCount=0, combined=1); got order ${ids.join(", ")}`
    );
  });

  it("ranking: candidate with both mutual connections and interest overlap scores highest", async () => {
    // A has 1 mutual connection + 1 style match → combined = 1×3 + 1 = 4
    // B has 0 mutual connections + 2 style matches → combined = 0×3 + 2 = 2
    // A must rank above B.
    const F_MUT = "user-f-mut";
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: F_MUT },
        { follower_id: F_MUT, following_id: A },   // A has 1 mutual connection
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false,
          travel_styles: ["adventure"] },           // 1 style match + 1 mutual
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] }, // 2 style matches, 0 mutual
        { id: F_MUT, handle: "fmut", name: "Faye",  avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (mutual=1, interest=1, combined=4) must rank above B (mutual=0, interest=2, combined=2); got ${ids.join(", ")}`
    );
  });

  // ── interaction decay on mutual connections ────────────────────────────────────

  it("decay: interacted mutual (shared trip) outweighs non-interacted mutual of the same count", async () => {
    // ME and D_MUT share a trip → D_MUT is an interacted mutual (weight 1.0)
    // ME follows E_MUT but no shared trip → E_MUT is a non-interacted mutual (weight 0.5)
    // D_MUT follows A → A's decayed score = 1.0, combined = 1.0×3 = 3
    // E_MUT follows B → B's decayed score = 0.5, combined = 0.5×3 = 1.5
    // A must rank above B.
    const D_MUT = "user-d-mut";
    const E_MUT = "user-e-mut";
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: D_MUT },
        { follower_id: ME,    following_id: E_MUT },
        { follower_id: D_MUT, following_id: A },
        { follower_id: E_MUT, following_id: B },
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false },
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false },
        { id: D_MUT, handle: "dmut", name: "Dave",  avatar_url: null, is_private: false },
        { id: E_MUT, handle: "emut", name: "Eve",   avatar_url: null, is_private: false },
      ],
      blocks: [],
      trips: [
        { id: "trip-shared", owner_id: ME, end_date: "2099-12-31", created_at: new Date().toISOString() },
      ],
      trip_members: [
        { trip_id: "trip-shared", user_id: ME,    role: "owner" },
        { trip_id: "trip-shared", user_id: D_MUT, role: "member" }, // D_MUT interacted with ME
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (interacted mutual D_MUT) should appear");
    assert.ok(posB !== -1, "B (non-interacted mutual E_MUT) should appear");
    assert.ok(
      posA < posB,
      `A (interacted mutual, decay=1.0, combined=3) must rank above B (non-interacted, decay=0.5, combined=1.5); got ${ids.join(", ")}`,
    );
  });

  it("decay: non-interacted mutual loses to sufficient interest-score when interest beats decayed weight", async () => {
    // Without decay: A with 1 mutual → 1×3=3 > B with 2 style matches = 2 → A wins.
    // With decay (non-interacted): A with 1 non-interacted mutual → 0.5×3=1.5 < B = 2 → B now wins.
    const F_MUT = "user-f-mut";
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: F_MUT },
        { follower_id: F_MUT, following_id: A },   // A has 1 non-interacted mutual
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false,
          travel_styles: [] },                       // 0 style matches, 1 non-interacted mutual
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] }, // 2 style matches, 0 mutuals
        { id: F_MUT, handle: "fmut", name: "Faye",  avatar_url: null, is_private: false },
      ],
      blocks: [],
      // No shared trips → F_MUT is non-interacted, decay = 0.5
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (1 non-interacted mutual) should appear");
    assert.ok(posB !== -1, "B (2 style matches) should appear");
    assert.ok(
      posB < posA,
      `B (interest=2, combined=2) must rank above A (non-interacted mutual, combined=1.5); got ${ids.join(", ")}`,
    );
  });

  it("decay: interacted mutual still beats interest-only score (decay preserves mutual advantage when interaction exists)", async () => {
    // A has 1 interacted mutual (weight 1.0) → combined = 1.0×3 = 3
    // B has 0 mutuals but 2 style matches → combined = 0 + 2 = 2
    // A must rank above B (interacted mutual is still a stronger signal than interest alone).
    const G_MUT = "user-g-mut";
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: G_MUT },
        { follower_id: G_MUT, following_id: A },
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false,
          travel_styles: [] },                       // 0 style matches, 1 interacted mutual
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false,
          travel_styles: ["adventure", "luxury"] }, // 2 style matches, 0 mutuals
        { id: G_MUT, handle: "gmut", name: "Gus",   avatar_url: null, is_private: false },
      ],
      blocks: [],
      trips: [
        { id: "trip-g", owner_id: ME, end_date: "2099-12-31", created_at: new Date().toISOString() },
      ],
      trip_members: [
        { trip_id: "trip-g", user_id: ME,    role: "owner" },
        { trip_id: "trip-g", user_id: G_MUT, role: "member" },
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (1 interacted mutual) should appear");
    assert.ok(posB !== -1, "B (2 style matches) should appear");
    assert.ok(
      posA < posB,
      `A (interacted mutual, combined=3) must rank above B (interest only, combined=2); got ${ids.join(", ")}`,
    );
  });

  // ── recency weighting (time-based decay) ──────────────────────────────────

  it("recency: very recent shared trip (7 days) outranks a 2-year-old shared trip", async () => {
    // H_MUT shared a trip with ME 7 days ago → weight = max(0.5, exp(-7/90)) ≈ 0.926
    //   → H_MUT follows A → A's score ≈ 0.926×3 ≈ 2.78
    // K_MUT shared a trip with ME 730 days ago → weight = max(0.5, exp(-730/90)) ≈ max(0.5, 0) = 0.5
    //   → K_MUT follows B → B's score = 0.5×3 = 1.5
    // A must rank above B.
    const H_MUT = "user-h-mut";
    const K_MUT = "user-k-mut";
    const recentDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const oldDate    = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: H_MUT },
        { follower_id: ME,    following_id: K_MUT },
        { follower_id: H_MUT, following_id: A },
        { follower_id: K_MUT, following_id: B },
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false },
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false },
        { id: H_MUT, handle: "hmut", name: "Hana",  avatar_url: null, is_private: false },
        { id: K_MUT, handle: "kmut", name: "Karl",  avatar_url: null, is_private: false },
      ],
      blocks: [],
      trips: [
        { id: "trip-recent", owner_id: ME, end_date: "2099-12-31", created_at: recentDate },
        { id: "trip-old",    owner_id: ME, end_date: "2024-01-01", created_at: oldDate    },
      ],
      trip_members: [
        { trip_id: "trip-recent", user_id: ME,    role: "owner"  },
        { trip_id: "trip-recent", user_id: H_MUT, role: "member" }, // H_MUT: recent interaction
        { trip_id: "trip-old",    user_id: ME,    role: "owner"  },
        { trip_id: "trip-old",    user_id: K_MUT, role: "member" }, // K_MUT: old interaction → floor
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (recent-interaction mutual) should appear");
    assert.ok(posB !== -1, "B (old-interaction mutual) should appear");
    assert.ok(
      posA < posB,
      `A (recent mutual H_MUT, weight≈0.926, combined≈2.78) must rank above B (old mutual K_MUT, weight=0.5, combined=1.5); got ${ids.join(", ")}`,
    );
  });

  it("recency: best-of-multiple-trips is used when a mutual shares more than one trip", async () => {
    // L_MUT shares TWO trips with ME: one old (730 days), one recent (3 days).
    // Best weight = max(0.5, exp(-3/90)) ≈ 0.967, combined ≈ 2.9.
    // M_MUT shares ONE trip (730 days old) → weight = 0.5, combined = 1.5.
    // A (via L_MUT) must rank above B (via M_MUT).
    const L_MUT = "user-l-mut";
    const M_MUT = "user-m-mut";
    const recentDate = new Date(Date.now() - 3  * 24 * 60 * 60 * 1000).toISOString();
    const oldDate    = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    setup({
      follows: [
        { follower_id: A,     following_id: ME },
        { follower_id: B,     following_id: ME },
        { follower_id: ME,    following_id: L_MUT },
        { follower_id: ME,    following_id: M_MUT },
        { follower_id: L_MUT, following_id: A },
        { follower_id: M_MUT, following_id: B },
      ],
      profiles: [
        { id: ME,    handle: "me",   name: "Me",   avatar_url: null, is_private: false },
        { id: A,     handle: "aaa",  name: "Alice", avatar_url: null, is_private: false },
        { id: B,     handle: "bbb",  name: "Bob",   avatar_url: null, is_private: false },
        { id: L_MUT, handle: "lmut", name: "Lena",  avatar_url: null, is_private: false },
        { id: M_MUT, handle: "mmut", name: "Max",   avatar_url: null, is_private: false },
      ],
      blocks: [],
      trips: [
        { id: "trip-l-old",    owner_id: ME, end_date: "2024-01-01", created_at: oldDate    },
        { id: "trip-l-recent", owner_id: ME, end_date: "2099-12-31", created_at: recentDate },
        { id: "trip-m-old",    owner_id: ME, end_date: "2024-01-01", created_at: oldDate    },
      ],
      trip_members: [
        { trip_id: "trip-l-old",    user_id: ME,    role: "owner"  },
        { trip_id: "trip-l-old",    user_id: L_MUT, role: "member" }, // old trip
        { trip_id: "trip-l-recent", user_id: ME,    role: "owner"  },
        { trip_id: "trip-l-recent", user_id: L_MUT, role: "member" }, // recent trip — wins
        { trip_id: "trip-m-old",    user_id: ME,    role: "owner"  },
        { trip_id: "trip-m-old",    user_id: M_MUT, role: "member" }, // only old trip
      ],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A (best-of: recent trip wins) should appear");
    assert.ok(posB !== -1, "B (only old trip) should appear");
    assert.ok(
      posA < posB,
      `A (L_MUT best-of-two: weight≈0.967, combined≈2.9) must rank above B (M_MUT: weight=0.5, combined=1.5); got ${ids.join(", ")}`,
    );
  });

  // ── new profile fields: travel_group_style / looking_for / comfort_level / planning_style ──

  it("ranking: overlapping travel_group_style ranks a candidate above one without", async () => {
    // ME has travel_group_style ["couples", "solo"].
    // A shares one entry (score 1). B shares none (score 0).
    // Both A and B follow ME → primary follow-back path.
    // A must rank before B in the result.
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          travel_group_style: ["couples", "solo"] },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          travel_group_style: ["couples"] },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          travel_group_style: [] },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (1 group_style match) should rank before B (0 matches), got order ${ids.join(", ")}`
    );
  });

  it("ranking: multiple travel_group_style matches accumulate score — higher overlap ranks first", async () => {
    // ME has travel_group_style ["solo", "couples", "group"].
    // A matches 2 entries (score 2). B matches 1 entry (score 1).
    // A must rank before B.
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          travel_group_style: ["solo", "couples", "group"] },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          travel_group_style: ["solo", "couples"] },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          travel_group_style: ["group"] },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (score 2) should rank before B (score 1), got order ${ids.join(", ")}`
    );
  });

  it("ranking: overlapping looking_for ranks a candidate above one without", async () => {
    // ME has looking_for ["travel_partner", "friends"].
    // A shares one entry (score 1). B shares none (score 0).
    // A must rank before B in the primary follow-back path.
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          looking_for: ["travel_partner", "friends"] },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          looking_for: ["travel_partner"] },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          looking_for: [] },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (1 looking_for match) should rank before B (0 matches), got order ${ids.join(", ")}`
    );
  });

  it("ranking: comfort_level exact match contributes +1 to score", async () => {
    // ME has comfort_level "adventurous".
    // A matches comfort_level → score 1. B does not → score 0.
    // A must rank before B.
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          comfort_level: "adventurous" },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          comfort_level: "adventurous" },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          comfort_level: "comfortable" },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (comfort_level match, score 1) should rank before B (mismatch, score 0), got order ${ids.join(", ")}`
    );
  });

  it("ranking: planning_style exact match contributes +1 to score", async () => {
    // ME has planning_style "spontaneous".
    // A matches → score 1. B has a different planning_style → score 0.
    // A must rank before B.
    setup({
      follows: [
        { follower_id: A, following_id: ME },
        { follower_id: B, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          planning_style: "spontaneous" },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          planning_style: "spontaneous" },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          planning_style: "detailed_planner" },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    assert.ok(posA !== -1, "A should appear in suggestions");
    assert.ok(posB !== -1, "B should appear in suggestions");
    assert.ok(
      posA < posB,
      `A (planning_style match, score 1) should rank before B (mismatch, score 0), got order ${ids.join(", ")}`
    );
  });

  it("ranking: new fields only — high scorer surfaces above low scorer (no overlap with old fields)", async () => {
    // ME has ONLY the new fields set; old fields (travel_styles, travel_pace, budget_style) are empty.
    // A matches on travel_group_style (2 pts) + looking_for (1 pt) + comfort_level (1 pt) + planning_style (1 pt) = 5 pts.
    // B matches nothing → 0 pts.
    // C matches only travel_group_style (1 pt) → 1 pt.
    // Expected order: A (5) then C (1) then B (0).
    const D_LOCAL = "user-d-local";
    setup({
      follows: [
        { follower_id: A,       following_id: ME },
        { follower_id: B,       following_id: ME },
        { follower_id: C,       following_id: ME },
        { follower_id: D_LOCAL, following_id: ME },
      ],
      profiles: [
        { id: ME, handle: "me",  name: "Me",    avatar_url: null, is_private: false,
          travel_group_style: ["solo", "couples"],
          looking_for:        ["travel_partner"],
          comfort_level:      "adventurous",
          planning_style:     "spontaneous" },
        { id: A,  handle: "aaa", name: "Alice", avatar_url: null, is_private: false,
          travel_group_style: ["solo", "couples"],
          looking_for:        ["travel_partner"],
          comfort_level:      "adventurous",
          planning_style:     "spontaneous" },
        { id: B,  handle: "bbb", name: "Bob",   avatar_url: null, is_private: false,
          travel_group_style: [],
          looking_for:        [],
          comfort_level:      "comfortable",
          planning_style:     "detailed_planner" },
        { id: C,  handle: "ccc", name: "Carol", avatar_url: null, is_private: false,
          travel_group_style: ["solo"],
          looking_for:        [],
          comfort_level:      null,
          planning_style:     null },
        { id: D_LOCAL, handle: "ddd", name: "Dave",  avatar_url: null, is_private: false },
      ],
      blocks: [],
    });
    const r = await req("/users/suggestions");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const ids: string[] = body.users.map((u: any) => u.id);
    const posA = ids.indexOf(A);
    const posB = ids.indexOf(B);
    const posC = ids.indexOf(C);
    assert.ok(posA !== -1, "A (score 5) should appear");
    assert.ok(posB !== -1, "B (score 0) should appear");
    assert.ok(posC !== -1, "C (score 1) should appear");
    assert.ok(
      posA < posC,
      `A (score 5) must rank above C (score 1), got order ${ids.join(", ")}`
    );
    assert.ok(
      posC < posB,
      `C (score 1) must rank above B (score 0), got order ${ids.join(", ")}`
    );
    assert.ok(
      posA < posB,
      `A (score 5) must rank above B (score 0), got order ${ids.join(", ")}`
    );
  });

  it("seen-cache is per-user and does not bleed between users", async () => {
    const ME2 = "user-me2";
    const ME2_TOK = "tok-me2";

    const pool = [
      { id: A, handle: "aaa", name: "Alice", avatar_url: null, is_private: false },
      { id: B, handle: "bbb", name: "Bob",   avatar_url: null, is_private: false },
    ];

    // Create a second fake client that authenticates ME2
    const me2Client = {
      auth: {
        getUser: async (tok: string) =>
          tok === ME2_TOK
            ? { data: { user: { id: ME2 } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
      },
      from: (table: string) => {
        const builder: any = {
          select() { return builder; },
          eq()    { return builder; },
          neq()   { return builder; },
          in()    { return builder; },
          not()   { return builder; },
          or()    { return builder; },
          limit() { return builder; },
          order() { return builder; },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
          then(onF: any, onR: any) {
            const rows = table === "profiles" ? pool : [];
            return Promise.resolve({ data: rows, error: null }).then(onF, onR);
          },
        };
        return builder;
      },
    };

    // ME does a first call — A and B get marked as seen for ME
    setup({ follows: [], profiles: pool, blocks: [] });
    const r1 = await req("/users/suggestions");
    const body1 = await r1.json() as any;
    assert.ok(body1.users.length > 0, "ME first call should have results");

    // Now switch to ME2 — their seen cache should be empty so they still see A and B
    _setTestClient(me2Client as any, true);
    _setTestServiceClient(me2Client as any);
    const r2 = await fetch(`${base}/users/suggestions`, {
      headers: { Authorization: `Bearer ${ME2_TOK}` },
    });
    assert.equal(r2.status, 200);
    const body2 = await r2.json() as any;
    assert.ok(body2.users.length > 0, "ME2 should still see suggestions (independent cache)");
  });
});
