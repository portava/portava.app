/**
 * Block exclusion — app-wide visibility enforcement
 *
 * Verifies that blocked users are hidden from:
 *   1. GET /api/users/search  (both directions)
 *   2. GET /api/circles/:id/invitable-users  (otherFollowers section)
 *   3. GET /api/trips/:id/invitable-users    (otherFollowers section)
 *
 * Run: node --import tsx/esm --test src/test/blockExclusion.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import followsRouter from "../routes/follows.js";
import friendsRouter from "../routes/friends.js";
import tripsRouter from "../routes/trips.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME       = "aaa00000-0000-4000-a000-000000000001";
const ALICE    = "bbb00000-0000-4000-a000-000000000002"; // not blocked
const BOB      = "ccc00000-0000-4000-a000-000000000003"; // ME blocked BOB
const CARL     = "ddd00000-0000-4000-a000-000000000004"; // CARL blocked ME
const TRIP_ID  = "eee00000-0000-4000-a000-000000000005";

const ME_TOK = "tok-me";

// ── Fake Supabase client ──────────────────────────────────────────────────────

type FakeState = {
  profiles:          { id: string; handle: string; name: string; avatar_url: string | null; is_private?: boolean }[];
  blocks:            { blocker_id: string; blocked_id: string }[];
  user_follows?:     { follower_id: string; following_id: string }[];
  user_friendships?: ({ user_a: string; user_b: string })[];
  circle_memberships?: { owner_id: string; member_id: string }[];
  trip_members?:     { trip_id: string; user_id: string; role: string }[];
};

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];

      function source(): any[] {
        if (table === "profiles")           return state.profiles;
        if (table === "blocks")             return state.blocks;
        if (table === "user_follows")       return state.user_follows ?? [];
        if (table === "user_friendships")   return state.user_friendships ?? [];
        if (table === "circle_memberships") return state.circle_memberships ?? [];
        if (table === "trip_members")       return state.trip_members ?? [];
        return [];
      }

      function rows() { return source().filter((r) => filters.every((f) => f(r))); }

      const builder: any = {
        select()               { return builder; },
        eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        limit()                { return builder; },
        order()                { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: rows()[0] ?? null, error: null });
        },
        or(expr: string) {
          // Parses "col.op.val" pairs separated by commas.
          // Supports "eq" (equality) and "ilike" (case-insensitive LIKE with %).
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
            if (!m) return null;
            return { col: m[1], op: m[2].toLowerCase(), val: m[3] };
          }).filter(Boolean) as { col: string; op: string; val: string }[];

          filters.push((r) =>
            parts.some(({ col, op, val }) => {
              if (op === "ilike") {
                const escaped = val.replace(/[.+^${}()|[\]\\]/g, "\\$&");
                const pattern = "^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$";
                return new RegExp(pattern, "i").test(String(r[col] ?? ""));
              }
              return String(r[col]) === val;
            })
          );
          return builder;
        },
        then(onF: any, onR: any) {
          return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
        },
      };

      return builder;
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", followsRouter);
  app.use("/api", friendsRouter);
  app.use("/api", tripsRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function req(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
}

function setup(state: FakeState) {
  const client = makeClient(state) as any;
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── 1. GET /users/search ──────────────────────────────────────────────────────

describe("GET /api/users/search — block exclusion", () => {
  beforeEach(() => {
    setup({
      profiles: [
        { id: ALICE, handle: "alice",  name: "Alice Smith",   avatar_url: null, is_private: false },
        { id: BOB,   handle: "bob",    name: "Bob Jones",     avatar_url: null, is_private: false },
        { id: CARL,  handle: "carl",   name: "Carl Kent",     avatar_url: null, is_private: false },
      ],
      blocks: [
        { blocker_id: ME,   blocked_id: BOB  },   // ME blocked BOB
        { blocker_id: CARL, blocked_id: ME   },   // CARL blocked ME
      ],
      user_follows: [],
    });
  });

  it("returns unblocked users normally", async () => {
    const r = await req("/users/search?q=alice");
    assert.equal(r.status, 200);
    const { users } = await r.json() as any;
    assert.equal(users.length, 1);
    assert.equal(users[0].id, ALICE);
  });

  it("excludes a user that the caller blocked", async () => {
    const r = await req("/users/search?q=bob");
    assert.equal(r.status, 200);
    const { users } = await r.json() as any;
    const ids = users.map((u: any) => u.id);
    assert.ok(!ids.includes(BOB), "BOB (blocked by ME) must not appear");
  });

  it("excludes a user that blocked the caller", async () => {
    const r = await req("/users/search?q=carl");
    assert.equal(r.status, 200);
    const { users } = await r.json() as any;
    const ids = users.map((u: any) => u.id);
    assert.ok(!ids.includes(CARL), "CARL (who blocked ME) must not appear");
  });

  it("broad search excludes all blocked users while returning unblocked ones", async () => {
    const r = await req("/users/search?q=a");
    assert.equal(r.status, 200);
    const { users } = await r.json() as any;
    const ids = users.map((u: any) => u.id);
    assert.ok(ids.includes(ALICE), "ALICE should appear");
    assert.ok(!ids.includes(BOB),  "BOB (blocked by ME) must not appear");
    assert.ok(!ids.includes(CARL), "CARL (blocked ME) must not appear");
  });
});

// ── 2. GET /circles/:circleOwnerId/invitable-users ───────────────────────────

describe("GET /api/circles/:id/invitable-users — block exclusion", () => {
  it("excludes a friend that the caller blocked from otherFollowers", async () => {
    // ME is the circle owner; ALICE and BOB are friends; ME blocked BOB.
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null },
        { id: BOB,   handle: "bob",   name: "Bob",   avatar_url: null },
      ],
      blocks: [{ blocker_id: ME, blocked_id: BOB }],
      circle_memberships: [],
      user_friendships: [
        { user_a: ME, user_b: ALICE },
        { user_a: ME, user_b: BOB  },
      ],
    });
    const r = await req(`/circles/${ME}/invitable-users`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const otherIds = (body.otherFollowers ?? []).map((u: any) => u.id);
    assert.ok(otherIds.includes(ALICE), "ALICE (not blocked) should appear in otherFollowers");
    assert.ok(!otherIds.includes(BOB),  "BOB (blocked by ME) must not appear in otherFollowers");
  });

  it("excludes a friend who blocked the caller from otherFollowers", async () => {
    // ME is the circle owner; CARL blocked ME.
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null },
        { id: CARL,  handle: "carl",  name: "Carl",  avatar_url: null },
      ],
      blocks: [{ blocker_id: CARL, blocked_id: ME }],
      circle_memberships: [],
      user_friendships: [
        { user_a: ME, user_b: ALICE },
        { user_a: CARL, user_b: ME  },
      ],
    });
    const r = await req(`/circles/${ME}/invitable-users`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const otherIds = (body.otherFollowers ?? []).map((u: any) => u.id);
    assert.ok(otherIds.includes(ALICE), "ALICE should appear");
    assert.ok(!otherIds.includes(CARL), "CARL (who blocked ME) must not appear");
  });
});

// ── 3. GET /trips/:tripId/invitable-users ────────────────────────────────────

describe("GET /api/trips/:id/invitable-users — block exclusion", () => {
  it("excludes a friend that the caller blocked from otherFollowers", async () => {
    // ME is an accepted trip member; ALICE and BOB are friends; ME blocked BOB.
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null },
        { id: BOB,   handle: "bob",   name: "Bob",   avatar_url: null },
      ],
      blocks: [{ blocker_id: ME, blocked_id: BOB }],
      trip_members: [{ trip_id: TRIP_ID, user_id: ME, role: "owner" }],
      user_friendships: [
        { user_a: ME, user_b: ALICE },
        { user_a: ME, user_b: BOB  },
      ],
    });
    const r = await req(`/trips/${TRIP_ID}/invitable-users`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const otherIds = (body.otherFollowers ?? []).map((u: any) => u.id);
    assert.ok(otherIds.includes(ALICE), "ALICE (not blocked) should appear");
    assert.ok(!otherIds.includes(BOB),  "BOB (blocked by ME) must not appear");
  });

  it("excludes a friend who blocked the caller from otherFollowers", async () => {
    // CARL blocked ME; CARL and ALICE are both friends of ME.
    setup({
      profiles: [
        { id: ALICE, handle: "alice", name: "Alice", avatar_url: null },
        { id: CARL,  handle: "carl",  name: "Carl",  avatar_url: null },
      ],
      blocks: [{ blocker_id: CARL, blocked_id: ME }],
      trip_members: [{ trip_id: TRIP_ID, user_id: ME, role: "owner" }],
      user_friendships: [
        { user_a: ME,   user_b: ALICE },
        { user_a: CARL, user_b: ME    },
      ],
    });
    const r = await req(`/trips/${TRIP_ID}/invitable-users`);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const otherIds = (body.otherFollowers ?? []).map((u: any) => u.id);
    assert.ok(otherIds.includes(ALICE), "ALICE should appear");
    assert.ok(!otherIds.includes(CARL), "CARL (who blocked ME) must not appear");
  });
});
