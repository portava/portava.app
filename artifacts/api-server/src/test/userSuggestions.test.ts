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
  trips?:        { id: string; owner_id: string; end_date: string; destination_city?: string | null; destination_country?: string | null }[];
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
        { id: "trip-me", owner_id: ME, end_date: futureDate, destination_city: "Bali", destination_country: "Indonesia" },
        { id: "trip-b",  owner_id: B,  end_date: futureDate, destination_city: "Bali", destination_country: "Indonesia" },
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
        { id: "trip-me", owner_id: ME, end_date: futureDate, destination_city: "Bali", destination_country: "Indonesia" },
        { id: "trip-b",  owner_id: B,  end_date: futureDate, destination_city: "Bali", destination_country: "Indonesia" },
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
