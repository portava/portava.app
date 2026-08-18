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
const DAVE         = "dd000000-0000-4000-a000-000000000004"; // public, show_profile_picture_publicly=false
const EVE          = "ee000000-0000-4000-a000-000000000005"; // public, show_profile_picture_publicly=true
const FRAN         = "ff000000-0000-4000-a000-000000000006"; // private, show_profile_picture_publicly=false, friend of ME

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

      // Column projection for "profiles" only: without this, a mutation that
      // strips a column from a route's SELECT string (e.g. reverting the
      // show_profile_picture_publicly fix) would go unnoticed here, because
      // the mock would keep returning the full fixture row regardless of what
      // was actually requested.
      let profileCols: string[] | null = null;
      function rows() {
        let r = source().filter((row) => filters.every((f) => f(row)));
        if (table === "profiles" && profileCols) {
          r = r.map((row) => Object.fromEntries(profileCols!.filter((c) => c in row).map((c) => [c, row[c]])));
        }
        if (_limit !== null) r = r.slice(0, _limit);
        return r;
      }

      const builder: any = {
        select(cols?: string, opts?: any) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
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
          // Split on top-level commas only (skip commas inside parentheses)
          const terms: string[] = [];
          let depth = 0;
          let cur = "";
          for (const ch of expr) {
            if (ch === "(") { depth++; cur += ch; }
            else if (ch === ")") { depth--; cur += ch; }
            else if (ch === "," && depth === 0) { terms.push(cur); cur = ""; }
            else { cur += ch; }
          }
          if (cur) terms.push(cur);

          function simpleFilter(cond: string): ((r: any) => boolean) | null {
            const m = cond.trim().match(/^(\w+)\.(\w+)\.(.+)$/);
            if (!m) return null;
            const [, col, op, val] = m;
            if (op === "eq")    return (r: any) => String(r[col!]) === val;
            if (op === "neq")   return (r: any) => String(r[col!]) !== val;
            if (op === "ilike") return (r: any) => String(r[col!]).toLowerCase().includes((val ?? "").replace(/%/g, "").toLowerCase());
            return null;
          }

          const termFilters = terms.map((term) => {
            const t = term.trim();
            if (t.startsWith("and(") && t.endsWith(")")) {
              const inner = t.slice("and(".length, -1);
              const sub: Array<(r: any) => boolean> = [];
              let d2 = 0; let c2 = "";
              for (const ch of inner) {
                if (ch === "(") { d2++; c2 += ch; }
                else if (ch === ")") { d2--; c2 += ch; }
                else if (ch === "," && d2 === 0) { const f = simpleFilter(c2); if (f) sub.push(f); c2 = ""; }
                else { c2 += ch; }
              }
              if (c2) { const f = simpleFilter(c2); if (f) sub.push(f); }
              if (!sub.length) return null;
              return (r: any) => sub.every((f) => f(r));
            }
            return simpleFilter(t);
          }).filter(Boolean) as Array<(r: any) => boolean>;

          if (termFilters.length) filters.push((r) => termFilters.some((f) => f(r)));
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
      avatar_url: "https://cdn.example.com/me.jpg", cover_photo_url: null,
      bio: null, is_private: false,
      passport_visibility: "public",
      home_city: null, home_country: null,
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [], travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
      // Owner's own flag is OFF — proves the owner-always-sees-own-avatar
      // bypass is not just an accident of the flag defaulting true.
      show_profile_picture_publicly: false,
    },
    {
      id: DAVE, handle: "dave_hidden", username: "dave_hidden",
      display_name: "Dave", name: "Dave",
      avatar_url: "https://cdn.example.com/dave.jpg", cover_photo_url: null,
      bio: "Hides my photo", is_private: false,
      passport_visibility: "public",
      home_city: null, home_country: null,
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [], travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
      show_profile_picture_publicly: false,
    },
    {
      id: EVE, handle: "eve_shown", username: "eve_shown",
      display_name: "Eve", name: "Eve",
      avatar_url: "https://cdn.example.com/eve.jpg", cover_photo_url: null,
      bio: "Shows my photo", is_private: false,
      passport_visibility: "public",
      home_city: null, home_country: null,
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [], travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
      show_profile_picture_publicly: true,
    },
    {
      id: FRAN, handle: "fran_friend", username: "fran_friend",
      display_name: "Fran", name: "Fran",
      avatar_url: "https://cdn.example.com/fran.jpg", cover_photo_url: null,
      bio: "Friends only", is_private: true,
      passport_visibility: "private",
      home_city: null, home_country: null,
      travel_style: null, interests: [],
      verified: false, verification_status: "unverified", verified_at: null,
      spoken_languages: [], travel_styles: [], travel_pace: null,
      looking_for: [], account_status: "active",
      show_profile_picture_publicly: false,
    },
  ],
  blocks: [],
  user_follows: [],
  stamps: [],
  trips: [],
  // alice_public opted in to showing her real name; me_user did not.
  profile_privacy_settings: [
    { user_id: ALICE, show_real_name: true },
  ],
  // ME is an approved friend of FRAN — resolveProfileVisibility must grant
  // "followers_only" so the owner-photo-off flag does NOT hide the avatar
  // from an already-approved connection.
  user_friendships: [
    { user_a: ME, user_b: FRAN },
  ],
};

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });

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
    // alice_public opted in to real-name visibility (show_real_name: true).
    assert.equal(r.body.displayName, "Alice", "opted-in user shows real display name");
    assert.ok(typeof r.body.tripCount === "number", "should have tripCount");
    assert.ok(typeof r.body.stampCount === "number", "should have stampCount");
    assert.equal(r.body.visibility, "public");
  });

  it("hides real name for a public user without the name-visibility opt-in", async () => {
    // me_user has no profile_privacy_settings row → show_real_name defaults false.
    const r = await req(server, "GET", "/users/me_user/profile");
    assert.equal(r.status, 200, "should be 200");
    assert.equal(r.body.username, "me_user");
    assert.equal(r.body.displayName, null, "non-opted-in user hides real display name");
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

  // ── show_profile_picture_publicly enforcement ───────────────────────────────

  it("hides avatarUrl for a public profile whose owner turned the photo off", async () => {
    const r = await req(server, "GET", "/users/dave_hidden/profile");
    assert.equal(r.status, 200);
    assert.equal(r.body.avatarUrl, null, "avatarUrl must be null when show_profile_picture_publicly=false");
  });

  it("shows avatarUrl for a public profile whose owner left the photo on", async () => {
    const r = await req(server, "GET", "/users/eve_shown/profile");
    assert.equal(r.status, 200);
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/eve.jpg");
  });

  it("the owner always sees their own avatarUrl, even with the flag off", async () => {
    const r = await req(server, "GET", "/users/me_user/profile", { token: ME_TOK });
    assert.equal(r.status, 200);
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/me.jpg");
  });

  it("an approved friend of a private+flag-off profile still sees the avatar", async () => {
    const r = await req(server, "GET", "/users/fran_friend/profile", { token: ME_TOK });
    assert.equal(r.status, 200);
    assert.ok(!r.body.private, "an approved friend must get the full shape, not the limited_preview one");
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/fran.jpg");
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

  // ── show_profile_picture_publicly enforcement (the priority leak) ──────────
  // GET /users/:username/passport is the route toPublicProfilePreview /
  // toFullProfileView actually feed (via PUBLIC_PROFILE_COLUMNS). Before this
  // fix, the column was never selected, so r.show_profile_picture_publicly was
  // always undefined and the gate's `!== false` check always passed.

  it("hides avatarUrl for a public passport whose owner turned the photo off", async () => {
    const r = await req(server, "GET", "/users/dave_hidden/passport");
    assert.equal(r.status, 200);
    assert.equal(r.body.avatarUrl, null, "avatarUrl must be null when show_profile_picture_publicly=false");
  });

  it("shows avatarUrl for a public passport whose owner left the photo on", async () => {
    const r = await req(server, "GET", "/users/eve_shown/passport");
    assert.equal(r.status, 200);
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/eve.jpg");
  });

  it("the owner always sees their own avatarUrl on their own passport, even with the flag off", async () => {
    const r = await req(server, "GET", "/users/me_user/passport", { token: ME_TOK });
    assert.equal(r.status, 200);
    assert.equal(r.body.viewer.is_me, true);
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/me.jpg");
  });

  it("an approved friend of a private+flag-off passport still sees the avatar", async () => {
    const r = await req(server, "GET", "/users/fran_friend/passport", { token: ME_TOK });
    assert.equal(r.status, 200);
    assert.ok(r.body.viewer, "an approved friend must get the full viewer shape, not limited_preview");
    assert.equal(r.body.avatarUrl, "https://cdn.example.com/fran.jpg");
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

// ── Block enforcement — passport deep-link endpoint ───────────────────────────
//
// resolveProfileVisibility performs a FAIL-CLOSED block check: any row in the
// `blocks` table for the (viewer, target) pair (either direction) causes the
// endpoint to return { blocked: true, targetId } rather than exposing profile
// data.  The two describes below each spin up their own isolated server so
// block state doesn't bleed into the shared baseState tests above.
//
// Note on the fake client: the `.or()` helper doesn't parse Supabase's
// `and(col.eq.X,col.eq.Y)` compound syntax, so it returns ALL rows in the
// blocks table when called.  This is fine here because each describe seeds
// only the relevant block entry and the check is binary (any row → blocked).

describe("GET /users/:username/passport — viewer blocked by target", () => {
  let blockSrv: ReturnType<typeof createServer>;

  before(async () => {
    const app = express();
    app.use(express.json());
    const state: FakeState = {
      ...JSON.parse(JSON.stringify(baseState)),
      // Alice (target) has blocked ME (viewer)
      blocks: [{ blocker_id: ALICE, blocked_id: ME }],
    };
    const client = makeClient(state);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    app.use("/", passportRouter);
    blockSrv = createServer(app);
    await new Promise<void>((r) => blockSrv.listen(0, "127.0.0.1", r));
  });

  after(async () => {
    await new Promise<void>((r) => blockSrv.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("returns { blocked: true, targetId } for authenticated viewer blocked by target", async () => {
    const r = await req(blockSrv, "GET", "/users/alice_public/passport", { token: ME_TOK });
    assert.equal(r.status, 200, "HTTP status should be 200");
    assert.equal(r.body.blocked, true, "body.blocked should be true");
    assert.equal(r.body.targetId, ALICE, "body.targetId should identify the target");
    assert.ok(!("username" in r.body), "username should not be exposed when blocked");
    assert.ok(!("displayName" in r.body), "displayName should not be exposed when blocked");
  });

  it("still serves the full passport to an unauthenticated request (no viewer → block check skipped)", async () => {
    // resolveProfileVisibility only runs the block query when viewerId is non-null.
    // Anonymous visitors should still be able to see public profiles.
    const r = await req(blockSrv, "GET", "/users/alice_public/passport");
    assert.equal(r.status, 200, "HTTP status should be 200");
    assert.equal(r.body.username, "alice_public", "unauthenticated request should see the public profile");
    assert.ok(!r.body.blocked, "blocked flag must be absent for unauthenticated viewers");
  });
});

describe("GET /users/:username/passport — viewer has blocked target", () => {
  let blockSrv: ReturnType<typeof createServer>;

  before(async () => {
    const app = express();
    app.use(express.json());
    const state: FakeState = {
      ...JSON.parse(JSON.stringify(baseState)),
      // ME (viewer) has blocked Alice (target)
      blocks: [{ blocker_id: ME, blocked_id: ALICE }],
    };
    const client = makeClient(state);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    app.use("/", passportRouter);
    blockSrv = createServer(app);
    await new Promise<void>((r) => blockSrv.listen(0, "127.0.0.1", r));
  });

  after(async () => {
    await new Promise<void>((r) => blockSrv.close(() => r()));
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("returns { blocked: true, targetId } when the viewer has blocked the target", async () => {
    const r = await req(blockSrv, "GET", "/users/alice_public/passport", { token: ME_TOK });
    assert.equal(r.status, 200, "HTTP status should be 200");
    assert.equal(r.body.blocked, true, "body.blocked should be true");
    assert.equal(r.body.targetId, ALICE, "body.targetId should identify the target");
    assert.ok(!("username" in r.body), "username should not be exposed when blocked");
    assert.ok(!("displayName" in r.body), "displayName should not be exposed when blocked");
  });
});
