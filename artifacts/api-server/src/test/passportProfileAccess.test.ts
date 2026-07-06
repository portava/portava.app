/**
 * Passport & Profile — access-control and 404 tests
 *
 * Covers:
 *   1. GET /users/:username/profile — 404 for unknown username
 *   2. GET /users/:username/profile — limited_preview shape for private profile (unauthenticated)
 *   3. GET /users/:username/passport — 404 for unknown username
 *   4. POST /me/avatar/upload — rejects oversized payload (>5 MB)
 *   5. POST /me/avatar/upload — rejects unsupported MIME type
 *
 * Run: node --import tsx/esm --test src/test/passportProfileAccess.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";
import profileRouter from "../routes/profile.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME           = "aa000000-0000-4000-a000-000000000001";
const ALICE        = "bb000000-0000-4000-a000-000000000002"; // public profile
const BOB          = "cc000000-0000-4000-a000-000000000003"; // private profile

const ME_TOK = "tok-me";

// ── Helpers ───────────────────────────────────────────────────────────────────

function req(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null; rawBody?: Buffer; contentType?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const url = new URL(path, base);
    const payload = opts.rawBody ?? (opts.body ? Buffer.from(JSON.stringify(opts.body)) : undefined);
    const contentType =
      opts.contentType ??
      (opts.rawBody ? "image/jpeg" : opts.body ? "application/json" : undefined);
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    if (payload) headers["content-length"] = String(payload.length);

    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: url.pathname + url.search, method, headers },
      (res: any) => {
        let raw = "";
        res.on("data", (c: any) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

type FakeState = {
  users:                     Record<string, { id: string }>;
  profiles:                  any[];
  blocks?:                   any[];
  user_follows?:             any[];
  user_account_states?:      any[];
  profile_privacy_settings?: any[];
  user_privacy_settings?:    any[];
  user_message_settings?:    any[];
  user_mutes?:               any[];
  user_restrictions?:        any[];
  trust_restrictions?:       any[];
  moderation_actions?:       any[];
  user_interaction_cooldowns?: any[];
  user_friendships?:         any[];
  friend_requests?:          any[];
  trip_members?:             any[];
  circle_memberships?:       any[];
  rent_buddy_bookings?:      any[];
  rent_buddy_profiles?:      any[];
  rent_buddy_availability?:  any[];
  stamps?:                   any[];
  trips?:                    any[];
};

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "test/avatar.jpg" }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://storage.example.com/test/avatar.jpg" } }),
        remove: async () => ({ error: null }),
        list: async () => ({ data: [], error: null }),
      }),
      createBucket: async () => ({ error: null }),
    },
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      let _limit: number | null = null;
      let _head = false;
      let _count: string | null = null;
      let _singleMode = false;

      function source(): any[] {
        const t = table as keyof typeof state;
        if (t === "users") return Object.values(state.users ?? {});
        if (t === "profiles") return (state.profiles ?? []).map((p) => ({ account_status: "active", ...p }));
        if (t === "blocks") return state.blocks ?? [];
        if (t === "user_follows") return state.user_follows ?? [];
        if (t === "user_account_states") return state.user_account_states ?? [];
        if (t === "profile_privacy_settings") return state.profile_privacy_settings ?? [];
        if (t === "user_privacy_settings") return state.user_privacy_settings ?? [];
        if (t === "user_message_settings") return state.user_message_settings ?? [];
        if (t === "user_mutes") return state.user_mutes ?? [];
        if (t === "user_restrictions") return state.user_restrictions ?? [];
        if (t === "trust_restrictions") return state.trust_restrictions ?? [];
        if (t === "moderation_actions") return state.moderation_actions ?? [];
        if (t === "user_interaction_cooldowns") return state.user_interaction_cooldowns ?? [];
        if (t === "user_friendships") return state.user_friendships ?? [];
        if (t === "friend_requests") return state.friend_requests ?? [];
        if (t === "trip_members") return state.trip_members ?? [];
        if (t === "circle_memberships") return state.circle_memberships ?? [];
        if (t === "rent_buddy_profiles") return state.rent_buddy_profiles ?? [];
        if (t === "rent_buddy_availability") return state.rent_buddy_availability ?? [];
        if (t === "stamps") return state.stamps ?? [];
        if (t === "trips") return state.trips ?? [];
        return [];
      }

      function rows() {
        let r = source().filter((row) => filters.every((f) => f(row)));
        if (_limit !== null) r = r.slice(0, _limit);
        return r;
      }

      const builder: any = {
        select(_col?: string, opts?: any) {
          if (opts?.count) _count = opts.count;
          if (opts?.head) _head = true;
          return builder;
        },
        eq(col: string, val: any)    { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not(col: string, op: string, val: any) {
          if (op === "is") filters.push((r) => r[col] !== val);
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.(\w+)\.(.+)$/);
            if (!m) return null;
            const [, col, op, val] = m;
            if (op === "eq")    return (r: any) => String(r[col!]) === val;
            if (op === "ilike") return (r: any) => String(r[col!]).toLowerCase().includes((val ?? "").replace(/%/g, "").toLowerCase());
            return null;
          }).filter(Boolean) as Array<(r: any) => boolean>;
          if (parts.length) filters.push((r) => parts.some((f) => f(r)));
          return builder;
        },
        limit(n: number) { _limit = n; return builder; },
        order()          { return builder; },
        range()          { return builder; },
        single() {
          _singleMode = true;
          const r = rows();
          return Promise.resolve(
            r.length
              ? { data: r[0], error: null }
              : { data: null, error: { message: "no rows", code: "PGRST116" } },
          );
        },
        maybeSingle() {
          const r = rows();
          return Promise.resolve({ data: r[0] ?? null, error: null });
        },
        then(resolve: any, reject?: any) {
          if (_head && _count) {
            return Promise.resolve({ data: null, count: rows().length, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
        insert(vals: any) {
          const arr = Array.isArray(vals) ? vals : [vals];
          (state as any)[table] = [...((state as any)[table] ?? []), ...arr];
          if (_singleMode) {
            return Promise.resolve({ data: arr[0], error: null });
          }
          return Promise.resolve({ data: arr, error: null });
        },
        update(vals: any) {
          const tableData = (state as any)[table] ?? [];
          (state as any)[table] = tableData.map((r: any) =>
            filters.every((f) => f(r)) ? { ...r, ...vals } : r,
          );
          const updated = rows();
          if (_singleMode) {
            return Promise.resolve({ data: updated[0] ?? null, error: null });
          }
          const b2: any = {
            select() { return b2; },
            eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b2; },
            single() {
              const u = rows();
              return Promise.resolve({ data: u[0] ?? null, error: null });
            },
            then(resolve: any, reject?: any) {
              return Promise.resolve({ data: updated, error: null }).then(resolve, reject);
            },
          };
          return b2;
        },
        upsert(vals: any) {
          return builder.insert(vals);
        },
        delete() {
          (state as any)[table] = ((state as any)[table] ?? []).filter(
            (r: any) => !filters.every((f) => f(r)),
          );
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

// ── Test state ────────────────────────────────────────────────────────────────

const baseState: FakeState = {
  users: {
    [ME]: { id: ME },
  },
  profiles: [
    {
      id: ALICE, handle: "alice_public", username: "alice_public",
      display_name: "Alice", name: "Alice",
      avatar_url: "https://cdn.example.com/alice.jpg",
      cover_photo_url: null,
      bio: "I love travel", is_private: false,
      passport_visibility: "public",
      home_city: "Cebu", home_country: "Philippines",
      travel_style: "Adventure", interests: ["hiking"],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: ["English"],
      travel_styles: ["Adventure"], travel_pace: null,
      looking_for: [], account_status: "active",
    },
    {
      id: BOB, handle: "bob_private", username: "bob_private",
      display_name: "Bob", name: "Bob",
      avatar_url: "https://cdn.example.com/bob.jpg",
      cover_photo_url: null,
      bio: "Secret traveler", is_private: true,
      passport_visibility: "private",
      home_city: "Manila", home_country: "Philippines",
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [],
      travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
    },
    {
      id: ME, handle: "me_user", username: "me_user",
      display_name: "Me User", name: "Me User",
      avatar_url: null, cover_photo_url: null,
      bio: null, is_private: false,
      passport_visibility: "public",
      home_city: null, home_country: null,
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [], travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
    },
  ],
  blocks: [],
  user_follows: [],
  stamps: [],
  trips: [],
};

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());

  const client = makeClient(JSON.parse(JSON.stringify(baseState)));
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);

  app.use("/", passportRouter);
  app.use("/", profileRouter);

  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as import("net").AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /users/:username/profile", () => {
  it("returns 404 for an unknown username", async () => {
    const r = await req(server, "GET", "/users/does_not_exist_xyz/profile");
    assert.equal(r.status, 404, "should be 404");
    assert.equal(r.body.error, "not_found");
  });

  it("returns full profile for a public user (unauthenticated)", async () => {
    const r = await req(server, "GET", "/users/alice_public/profile");
    assert.equal(r.status, 200, "should be 200");
    assert.equal(r.body.username, "alice_public");
    assert.ok(r.body.displayName, "should have displayName");
    assert.ok(typeof r.body.tripCount === "number", "should have tripCount");
    assert.ok(typeof r.body.stampCount === "number", "should have stampCount");
    assert.equal(r.body.visibility, "public");
  });

  it("returns limited_preview for a private profile (unauthenticated)", async () => {
    const r = await req(server, "GET", "/users/bob_private/profile");
    assert.equal(r.status, 200, "should be 200");
    assert.equal(r.body.private, true, "private flag should be set");
    assert.equal(r.body.visibility, "private");
    assert.equal(r.body.avatarUrl, null, "avatarUrl should be null for private profile");
    assert.equal(r.body.coverUrl, null, "coverUrl should be null for private profile");
    assert.equal(r.body.tripCount, 0, "tripCount should be 0 for private profile");
    assert.equal(r.body.stampCount, 0, "stampCount should be 0 for private profile");
    assert.ok(!("bio" in r.body), "bio should not be exposed for private profile");
  });
});

describe("GET /users/:username/passport", () => {
  it("returns 404-equivalent (not_found error) for unknown username", async () => {
    const r = await req(server, "GET", "/users/ghost_user_xyz/passport");
    assert.equal(r.status, 404, "should be 404");
    assert.ok(
      r.body.error === "not_found" || r.body.message?.includes("not found"),
      "should include not_found error",
    );
  });

  it("returns full passport for a public profile (unauthenticated)", async () => {
    const r = await req(server, "GET", "/users/alice_public/passport");
    assert.equal(r.status, 200, "should be 200");
    assert.equal(r.body.username, "alice_public");
    assert.ok(r.body.viewer, "should have viewer object");
    assert.equal(r.body.viewer.is_me, false);
    assert.equal(r.body.viewer.is_following, false);
  });

  it("returns limited_preview shape for a private profile (unauthenticated)", async () => {
    const r = await req(server, "GET", "/users/bob_private/passport");
    assert.equal(r.status, 200, "should be 200");
    assert.equal(r.body.visibility, "private", "visibility should be 'private'");
    assert.ok(!r.body.viewer, "viewer object should be absent for limited_preview");
    assert.ok(!r.body.bio, "bio should not be exposed");
  });
});

describe("POST /me/avatar/upload", () => {
  it("rejects unsupported MIME type with 400", async () => {
    const small = Buffer.alloc(100, 0xff);
    const r = await req(server, "POST", "/me/avatar/upload", {
      rawBody: small,
      contentType: "image/gif",
      token: ME_TOK,
    });
    assert.equal(r.status, 400, "should reject unsupported MIME");
    assert.ok(r.body.error, "should have error field");
  });

  it("rejects payload exceeding 5 MB with 400", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    const r = await req(server, "POST", "/me/avatar/upload", {
      rawBody: big,
      contentType: "image/jpeg",
      token: ME_TOK,
    });
    assert.equal(r.status, 400, "should reject oversized upload");
    assert.ok(r.body.error, "should have error field");
  });
});
