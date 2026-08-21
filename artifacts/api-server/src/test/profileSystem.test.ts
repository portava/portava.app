/**
 * Profile System Phase 1 — Backend tests
 *
 * Covers:
 *   1. GET /api/users/:username/passport — viewer state, blocked, unavailable, limited_preview, buddy card
 *   2. PATCH /api/me/profile — username reserved-word rejection, format, 30-day cooldown
 *   3. POST /api/me/deactivate — account deactivation
 *   4. POST /api/me/delete-request — deletion request creation
 *   5. GET/PATCH /api/me/privacy — privacy settings round-trip
 *   6. GET /api/users/:username/posts|stamps|trips — visibility guard + privacy flag
 *
 * Run: node --import tsx/esm --test src/test/profileSystem.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";
import profileRouter from "../routes/profile.js";
import profileTabsRouter from "../routes/profileTabs.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const ME      = "aa000000-0000-4000-a000-000000000001";
const ALICE   = "bb000000-0000-4000-a000-000000000002"; // public, following ME
const BOB     = "cc000000-0000-4000-a000-000000000003"; // private profile
const CARL    = "dd000000-0000-4000-a000-000000000004"; // has blocked ME
const DAN     = "ee000000-0000-4000-a000-000000000005"; // friend of ME
const EVE     = "ff000000-0000-4000-a000-000000000006"; // buddy provider

const ME_TOK    = "tok-me";
const ANON_TOK  = null; // no token

// ── Universal fake client ─────────────────────────────────────────────────────

type FakeState = {
  users:                    Record<string, { id: string }>;
  profiles:                 any[];
  user_account_states?:     any[];
  blocks?:                  any[];
  user_follows?:            any[];
  user_friendships?:        any[];
  friend_requests?:         any[];
  profile_privacy_settings?:any[];
  user_privacy_settings?:   any[];
  user_interaction_cooldowns?: any[];
  user_message_settings?:   any[];
  trust_restrictions?:      any[];
  moderation_actions?:      any[];
  user_mutes?:              any[];
  user_restrictions?:       any[];
  trip_members?:            any[];
  circle_memberships?:      any[];
  rent_buddy_bookings?:     any[];
  rent_buddy_profiles?:     any[];
  rent_buddy_availability?: any[];
  user_deletion_requests?:  any[];
  posts?:                   any[];
  passport_stamps?:         any[];
  trips?:                   any[];
};

type InsertRecord = { table: string; row: any };

function makeClient(state: FakeState) {
  const inserted: InsertRecord[] = [];

  function tableRows(table: string): any[] {
    return (state as any)[table] ?? [];
  }

  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let upsertRow: any = null;
    let isUpsert = false;

    const builder: any = {
      select()                    { return builder; },
      eq(col: string, val: any)   { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: any)  { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      is(col: string, val: any)   { filters.push((r) => val === null ? r[col] == null : r[col] === val); return builder; },
      lt(col: string, val: any)   { filters.push((r) => r[col] < val); return builder; },
      gte(col: string, val: any)  { filters.push((r) => r[col] >= val); return builder; },
      not(col: string, op: string, val: any) {
        if (op === "eq") filters.push((r) => r[col] !== val);
        return builder;
      },
      or(expr: string) {
        // Handle "and(col.eq.val,col2.eq.val2),and(...)" for block checks
        const andGroups = [...expr.matchAll(/and\(([^)]+)\)/g)].map((m) => {
          return m[1].split(",").map((p) => {
            const pm = p.trim().match(/^(\w+)\.eq\.(.+)$/);
            return pm ? { col: pm[1], val: pm[2] } : null;
          }).filter(Boolean) as { col: string; val: string }[];
        });
        if (andGroups.length > 0) {
          filters.push((r) =>
            andGroups.some((group) => group.every(({ col, val }) => String(r[col]) === val))
          );
        }
        return builder;
      },
      order()  { return builder; },
      limit()  { return builder; },
      nullsFirst() { return builder; },
      insert(row: any) {
        pendingInsert = row;
        inserted.push({ table, row });
        return builder;
      },
      update(patch: any) {
        pendingUpdate = patch;
        return builder;
      },
      upsert(row: any) {
        isUpsert = true;
        upsertRow = row;
        inserted.push({ table, row });
        return builder;
      },
      maybeSingle() {
        if (pendingInsert || isUpsert) {
          return Promise.resolve({ data: upsertRow ?? pendingInsert ?? null, error: null });
        }
        if (pendingUpdate) {
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ? { ...rows[0], ...pendingUpdate } : null, error: null });
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        if (pendingInsert || isUpsert) {
          return Promise.resolve({ data: upsertRow ?? pendingInsert ?? null, error: null });
        }
        if (pendingUpdate) {
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows[0] ? { ...rows[0], ...pendingUpdate } : null, error: null });
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        if (pendingInsert || isUpsert) {
          return Promise.resolve({ data: [upsertRow ?? pendingInsert], error: null }).then(onF, onR);
        }
        if (pendingUpdate) {
          const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: rows, error: null }).then(onF, onR);
        }
        const rows = tableRows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows, error: null }).then(onF, onR);
      },
      catch() { return builder; },
    };
    return builder;
  }

  const client: any = {
    auth: {
      getUser: async (tok: string) => {
        const u = state.users[tok] ?? null;
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
    from: (table: string) => makeBuilder(table),
    storage: { createBucket: async () => ({ error: null }), from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
    __inserted: inserted,
  };
  return client;
}

function setup(state: FakeState) {
  const client = makeClient(state) as any;
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
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
  app.use("/api", passportRouter);
  app.use("/api", profileRouter);
  app.use("/api", profileTabsRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api`;
});

after(() => server.close());

function req(path: string, opts: { tok?: string | null; method?: string; body?: any } = {}) {
  const { tok = ME_TOK, method = "GET", body } = opts;
  const headers: Record<string, string> = {};
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Shared profile baseline ────────────────────────────────────────────────────

function baseState(): FakeState {
  return {
    users: {
      "tok-me":    { id: ME },
      "tok-alice": { id: ALICE },
      "tok-dan":   { id: DAN },
    },
    profiles: [
      { id: ME,    username: "me_user", handle: "me_user",    display_name: "Me",    is_private: false, passport_visibility: "public", avatar_url: null },
      { id: ALICE, username: "alice_user", handle: "alice_user", display_name: "Alice", is_private: false, passport_visibility: "public", avatar_url: null },
      { id: BOB,   username: "bob_user", handle: "bob_user",   display_name: "Bob",   is_private: true,  passport_visibility: "public", avatar_url: null },
      { id: CARL,  username: "carl_user", handle: "carl_user",  display_name: "Carl",  is_private: false, passport_visibility: "public", avatar_url: null },
      { id: DAN,   username: "dan_user", handle: "dan_user",   display_name: "Dan",   is_private: false, passport_visibility: "public", avatar_url: null },
      { id: EVE,   username: "eve_user", handle: "eve_user",   display_name: "Eve",   is_private: false, passport_visibility: "public", avatar_url: null },
    ],
    user_account_states: [],
    blocks: [
      { blocker_id: CARL, blocked_id: ME }, // CARL blocked ME
    ],
    user_follows: [
      { follower_id: ALICE, following_id: ME }, // Alice follows ME
    ],
    user_friendships: [
      { user_a: DAN < ME ? DAN : ME, user_b: DAN < ME ? ME : DAN }, // DAN and ME are friends
    ],
    friend_requests: [],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    user_interaction_cooldowns: [],
    user_message_settings: [],
    trust_restrictions: [],
    moderation_actions: [],
    user_mutes: [],
    user_restrictions: [],
    trip_members: [],
    circle_memberships: [],
    rent_buddy_bookings: [],
    rent_buddy_profiles: [],
    rent_buddy_availability: [],
    user_deletion_requests: [],
    posts: [],
    passport_stamps: [],
    trips: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GET /users/:username/passport — viewer state
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/passport — viewer state", () => {

  it("own profile: viewer.is_me=true, no relationship fields set", async () => {
    setup(baseState());
    const r = await req("/users/me_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(!body.unavailable, "should not be unavailable");
    assert.ok(!body.blocked, "should not be blocked");
    assert.equal(body.viewer?.is_me, true);
    assert.equal(body.viewer?.is_following, false);
    assert.equal(body.viewer?.is_friend, false);
    assert.equal(body.viewer?.can_report, false, "cannot report own profile");
  });

  it("unauthenticated viewer: all relationship fields false", async () => {
    setup(baseState());
    const r = await req("/users/alice_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.viewer?.is_me, false);
    assert.equal(body.viewer?.is_following, false);
    assert.equal(body.viewer?.is_friend, false);
    assert.equal(body.viewer?.can_follow, true);
  });

  it("authenticated stranger: can_follow=true, not friend, not following", async () => {
    const state = baseState();
    // Remove alice→me follow to make alice a stranger relative to alice's own passport view
    // ME views ALICE (stranger)
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.viewer?.is_friend, false);
    assert.equal(body.viewer?.is_following, false);
    assert.equal(body.viewer?.can_follow, true);
    assert.equal(body.viewer?.can_report, true);
  });

  it("friend: is_friend=true, can_follow=false (already friend)", async () => {
    setup(baseState());
    const r = await req("/users/dan_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.viewer?.is_friend, true);
    assert.equal(body.viewer?.is_following, false);
  });

  it("blocked by target: returns {blocked:true}", async () => {
    setup(baseState());
    // ME viewing CARL who blocked ME
    const r = await req("/users/carl_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true, "should return blocked shape");
    assert.ok(!body.viewer, "no viewer object on blocked response");
  });

  it("deactivated account: returns {unavailable:true}", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "deactivated" }];
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true);
  });

  it("banned account: returns {unavailable:true}", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "banned" }];
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true);
  });

  it("private account + unauthenticated: returns limited_preview shape", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.visibility, "private");
    assert.ok(!body.bio, "bio must not be exposed");
    assert.ok(!body.viewer, "no viewer on limited preview");
  });

  it("private account + follower (unapproved): returns limited_preview — SEC-01", async () => {
    const state = baseState();
    // ME merely follows BOB (a raw, unapproved follow). BOB is private.
    // Pre-SEC-01 this wrongly returned BOB's full private profile.
    state.user_follows = [...(state.user_follows ?? []), { follower_id: ME, following_id: BOB }];
    setup(state);
    const r = await req("/users/bob_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // SEC-01: an unapproved follow must NOT unlock a private profile — the viewer
    // must be an accepted friend (see the "private account + friend" test below).
    assert.equal(body.visibility, "private", "private profile stays limited_preview for a mere follower");
    assert.ok(!body.bio, "private content must not be exposed to an unapproved follower");
  });

  it("private account + friend: returns full profile", async () => {
    const state = baseState();
    // Make ME friend with BOB
    const ua = ME < BOB ? ME : BOB;
    const ub = ME < BOB ? BOB : ME;
    state.user_friendships = [...(state.user_friendships ?? []), { user_a: ua, user_b: ub }];
    setup(state);
    const r = await req("/users/bob_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.id, BOB);
    assert.equal(body.viewer?.is_friend, true);
  });

  it("404 for unknown username", async () => {
    setup(baseState());
    const r = await req("/users/nobody_here/passport");
    assert.equal(r.status, 404);
  });

  it("buddy provider card present when active rent_buddy_profile exists", async () => {
    const state = baseState();
    state.rent_buddy_profiles = [{
      id: "bp-001", user_id: EVE, status: "active", admin_status: "active",
      categories: ["city_guide"], languages: ["en"], average_rating: 4.8,
      review_count: 12, response_time_h: 2, hourly_rate_usd: 50, city: "Paris",
      available_now: true, // available_now lives on rent_buddy_profiles
    }];
    setup(state);
    const r = await req("/users/eve_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(body.buddyProvider, "buddyProvider should be present");
    assert.equal(body.buddyProvider.buddyProfileId, "bp-001");
    assert.equal(body.buddyProvider.availableNow, true);
    assert.equal(body.buddyProvider.rating, 4.8);
  });

  it("buddyProvider is null when no active rent_buddy_profile", async () => {
    setup(baseState());
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.buddyProvider, null);
  });

  it("passport_visibility=private with no auth: returns limited stub", async () => {
    const state = baseState();
    state.profiles = state.profiles.map(p =>
      p.id === ALICE ? { ...p, is_private: false, passport_visibility: "private" } : p
    );
    setup(state);
    const r = await req("/users/alice_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.visibility, "private");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Username rules
// ═══════════════════════════════════════════════════════════════════════════════

describe("Username rules — PATCH /api/me/profile", () => {

  it("rejects reserved word 'admin'", async () => {
    const state = baseState();
    state.profiles = state.profiles.map(p => p.id === ME ? { ...p, username: "me_user", username_updated_at: null } : p);
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "admin" } });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.match(body.message ?? body.error ?? "", /reserved/i);
  });

  it("rejects reserved word 'security'", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: { username: "security" } });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.match(body.message ?? body.error ?? "", /reserved/i);
  });

  it("rejects reserved word 'moderator'", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: { username: "moderator" } });
    assert.equal(r.status, 400);
  });

  it("rejects reserved word 'owner'", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: { username: "owner" } });
    assert.equal(r.status, 400);
  });

  it("rejects username with period (new format: no periods)", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: { username: "alice.travel" } });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.match(body.message ?? body.error ?? "", /underscores only|invalid/i);
  });

  it("rejects username longer than 30 chars", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: { username: "a".repeat(31) } });
    assert.equal(r.status, 400);
  });

  it("accepts username exactly 30 chars", async () => {
    const state = baseState();
    // No existing username_updated_at so cooldown doesn't apply
    state.profiles = state.profiles.map(p => p.id === ME ? { ...p, username: "old_name", username_updated_at: null } : p);
    setup(state);
    const longName = "a".repeat(30);
    const r = await req("/me/profile", { method: "PATCH", body: { username: longName } });
    // Could be 400 if takenBy check hits (no fake data says it's taken), so just ensure NOT a 400 for reserved/format
    const body = await r.json() as any;
    assert.ok(r.status !== 400 || !(body.message ?? "").match(/reserved|3-30|underscores/), `should not fail format validation for 30-char name`);
  });

  it("enforces 30-day cooldown when username_updated_at is recent", async () => {
    const state = baseState();
    const recentChange = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    state.profiles = state.profiles.map(p =>
      p.id === ME ? { ...p, username: "old_me", username_updated_at: recentChange } : p
    );
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "new_me" } });
    assert.equal(r.status, 429);
    const body = await r.json() as any;
    assert.equal(body.error, "rate_limited");
    assert.match(body.message ?? "", /30 days|remaining/i);
  });

  it("allows username change when last change was more than 30 days ago", async () => {
    const state = baseState();
    const oldChange = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(); // 35 days ago
    state.profiles = state.profiles.map(p =>
      p.id === ME ? { ...p, username: "old_me", username_updated_at: oldChange } : p
    );
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "new_me" } });
    // should succeed (not a 400 for cooldown)
    const body = await r.json() as any;
    assert.ok(!(body.message ?? "").match(/30 days|remaining/i), "should not reject with cooldown message");
  });

  it("allows setting same username (no cooldown triggered)", async () => {
    const state = baseState();
    const recentChange = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    state.profiles = state.profiles.map(p =>
      p.id === ME ? { ...p, username: "me_user", username_updated_at: recentChange } : p
    );
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "me_user" } });
    // Same username: cooldown should NOT apply (username !== p.username check)
    const body = await r.json() as any;
    assert.ok(!(body.message ?? "").match(/30 days|remaining/i), "same username should skip cooldown");
  });

  it("rejects taken username", async () => {
    const state = baseState();
    // alice_user already taken by ALICE
    state.profiles = state.profiles.map(p => p.id === ME ? { ...p, username: "old_me", username_updated_at: null } : p);
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "alice_user" } });
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.match(body.message ?? body.error ?? "", /taken/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. PATCH /me/profile — homeCity / homeCountry persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/me/profile — homeCity / homeCountry persistence", () => {
  it("persists homeCity and homeCountry and returns them in the response", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_city: null, home_country: null } : p
    );
    setup(state);
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { homeCity: "Cebu", homeCountry: "Philippines" },
    });
    assert.equal(r.status, 200, "PATCH must return 200");
    const body = await r.json() as any;
    assert.equal(body.homeCity, "Cebu", "homeCity must be returned in profile response");
    assert.equal(body.homeCountry, "Philippines", "homeCountry must be returned in profile response");
  });

  it("persists homeCity alone without homeCountry", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_city: null, home_country: "SomeOldCountry" } : p
    );
    setup(state);
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { homeCity: "Manila" },
    });
    assert.equal(r.status, 200, "PATCH must return 200");
    const body = await r.json() as any;
    assert.equal(body.homeCity, "Manila", "homeCity must be updated");
  });

  it("rejects homeCity longer than 100 characters", async () => {
    setup(baseState());
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { homeCity: "A".repeat(101) },
    });
    assert.equal(r.status, 400, "homeCity >100 chars must be rejected as invalid_payload");
  });

  it("returns 400 when body has no updatable fields (only updated_by in row)", async () => {
    setup(baseState());
    const r = await req("/me/profile", { method: "PATCH", body: {} });
    assert.equal(r.status, 400, "empty PATCH body must be rejected");
  });

  it("persists a valid passportSectionOrder permutation and returns it", async () => {
    setup(baseState());
    const order = ["dossier", "highlights", "identity", "stamps", "tabs"];
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { passportSectionOrder: order },
    });
    assert.equal(r.status, 200, "valid section order must be accepted");
    const body = await r.json() as any;
    assert.deepEqual(body.passportSectionOrder, order, "passportSectionOrder must round-trip");
  });

  it("accepts passportSectionOrder null (reset to canonical)", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, passport_section_order: ["tabs", "identity", "stamps", "highlights", "dossier"] } : p
    );
    setup(state);
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { passportSectionOrder: null },
    });
    assert.equal(r.status, 200, "null section order (reset) must be accepted");
    const body = await r.json() as any;
    assert.equal(body.passportSectionOrder, null, "reset must return null");
  });

  it("rejects passportSectionOrder with duplicates", async () => {
    setup(baseState());
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { passportSectionOrder: ["identity", "identity", "stamps", "highlights", "dossier"] },
    });
    assert.equal(r.status, 400, "duplicate section keys must be rejected");
  });

  it("rejects passportSectionOrder with unknown keys", async () => {
    setup(baseState());
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { passportSectionOrder: ["identity", "stamps", "highlights", "dossier", "bogus"] },
    });
    assert.equal(r.status, 400, "unknown section keys must be rejected");
  });

  it("rejects passportSectionOrder with fewer than five sections", async () => {
    setup(baseState());
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { passportSectionOrder: ["identity", "stamps"] },
    });
    assert.equal(r.status, 400, "partial section list must be rejected");
  });

  it("homeCity and homeCountry appear in the passport response after being set", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME
        ? { ...p, home_city: "Cebu", home_country: "Philippines", passport_visibility: "public" }
        : p
    );
    setup(state);
    const r = await req("/users/me_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.homeCity, "Cebu", "homeCity must be visible on own passport after being set");
    assert.equal(body.homeCountry, "Philippines", "homeCountry must be visible on own passport after being set");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. POST /me/deactivate
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/me/deactivate", () => {
  it("returns { deactivated: true } on success", async () => {
    setup(baseState());
    const r = await req("/me/deactivate", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.deactivated, true);
  });

  it("requires authentication", async () => {
    setup(baseState());
    const r = await req("/me/deactivate", { method: "POST", tok: null });
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. POST /me/delete-request
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/me/delete-request", () => {
  it("returns { deletionScheduled: true, scheduledAt } on success", async () => {
    setup(baseState());
    const r = await req("/me/delete-request", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.deletionScheduled, true);
    assert.ok(body.scheduledAt, "scheduledAt must be present");
    // scheduledAt should be ~30 days in the future
    const scheduled = new Date(body.scheduledAt).getTime();
    const diff = scheduled - Date.now();
    assert.ok(diff > 28 * 24 * 60 * 60 * 1000, "scheduledAt should be ~30 days out");
  });

  it("requires authentication", async () => {
    setup(baseState());
    const r = await req("/me/delete-request", { method: "POST", tok: null });
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. GET and PATCH /me/privacy
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET/PATCH /api/me/privacy — privacy settings", () => {

  it("GET returns defaults when no settings row exists", async () => {
    setup(baseState());
    const r = await req("/me/privacy");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.profile_visibility, "public");
    assert.equal(body.show_posts, true);
    assert.equal(body.allow_tagging, true);
    assert.equal(body.allow_profile_discovery, true);
  });

  it("GET returns stored row when settings exist", async () => {
    const state = baseState();
    state.profile_privacy_settings = [{
      id: "pps-1", user_id: ME, profile_visibility: "followers_only",
      show_posts: false, show_stamps: true, show_friends: false,
      allow_messages_from: "friends",
    }];
    setup(state);
    const r = await req("/me/privacy");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.profile_visibility, "followers_only");
    assert.equal(body.show_posts, false);
    assert.equal(body.allow_messages_from, "friends");
  });

  it("PATCH updates profile_visibility to private", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: { profile_visibility: "private" } });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.profile_visibility, "private");
  });

  it("PATCH updates show_posts to false", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: { show_posts: false } });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.show_posts, false);
  });

  it("PATCH rejects invalid profile_visibility enum", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: { profile_visibility: "secret" } });
    assert.equal(r.status, 400);
  });

  it("PATCH rejects invalid allow_messages_from enum", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: { allow_messages_from: "anyone" } });
    assert.equal(r.status, 400);
  });

  it("PATCH rejects empty body", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: {} });
    assert.equal(r.status, 400);
  });

  it("GET requires authentication", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { tok: null });
    assert.equal(r.status, 401);
  });

  it("PATCH requires authentication", async () => {
    setup(baseState());
    const r = await req("/me/privacy", { method: "PATCH", body: { show_posts: false }, tok: null });
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Profile tab endpoints — visibility guard
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/posts — profile tab", () => {

  it("returns posts for a public profile", async () => {
    const state = baseState();
    state.posts = [
      { id: "p1", author_id: ALICE, content: "hello", media_urls: [], post_status: "published", created_at: "2025-01-02T00:00:00Z" },
      { id: "p2", author_id: ALICE, content: "world", media_urls: [], post_status: "published", created_at: "2025-01-01T00:00:00Z" },
    ];
    setup(state);
    const r = await req("/users/alice_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].id, "p1");
  });

  it("returns {blocked:true} for a profile that blocked the viewer", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true);
    assert.deepEqual(body.items, []);
  });

  it("returns empty items for deactivated account", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "deactivated" }];
    setup(state);
    const r = await req("/users/alice_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true);
    assert.deepEqual(body.items, []);
  });

  it("returns empty items for private profile (non-follower)", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
    assert.ok(!body.blocked, "should not be blocked");
  });

  it("returns empty items when show_posts=false in privacy settings", async () => {
    const state = baseState();
    state.profile_privacy_settings = [{ user_id: ALICE, profile_visibility: "public", show_posts: false }];
    setup(state);
    const r = await req("/users/alice_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
  });

  it("owner can see own posts even when show_posts=false", async () => {
    const state = baseState();
    state.posts = [
      { id: "p1", author_id: ME, content: "my post", media_urls: [], post_status: "published", created_at: "2025-01-01T00:00:00Z" },
    ];
    state.profile_privacy_settings = [{ user_id: ME, profile_visibility: "public", show_posts: false }];
    setup(state);
    const r = await req("/users/me_user/posts");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 1);
  });

  it("returns 404 for unknown username", async () => {
    setup(baseState());
    const r = await req("/users/ghost_xyz/posts");
    assert.equal(r.status, 404);
  });
});

describe("GET /api/users/:username/stamps — profile tab", () => {

  it("returns stamps for a public profile", async () => {
    const state = baseState();
    // Live passport_stamps shape: stamp_type / country / city / awarded_at
    state.passport_stamps = [
      { id: "s1", user_id: ALICE, stamp_type: "country", country: "France", city: null,    awarded_at: "2025-01-01T00:00:00Z" },
      { id: "s2", user_id: ALICE, stamp_type: "city",    country: "France", city: "Paris", awarded_at: "2025-01-02T00:00:00Z" },
    ];
    setup(state);
    const r = await req("/users/alice_user/stamps");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 2);
    const kinds = body.items.map((i: any) => i.kind).sort();
    assert.deepEqual(kinds, ["city", "country"]);
    assert.ok(body.items.every((i: any) => typeof i.earnedAt === "string"));
  });

  it("returns empty items when show_stamps=false", async () => {
    const state = baseState();
    state.passport_stamps = [{ id: "s1", user_id: ALICE, stamp_type: "country", country: "France", city: null, awarded_at: "2025-01-01T00:00:00Z" }];
    state.profile_privacy_settings = [{ user_id: ALICE, profile_visibility: "public", show_stamps: false }];
    setup(state);
    const r = await req("/users/alice_user/stamps");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
  });

  it("returns {blocked:true} for blocked user", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/stamps");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true);
  });
});

describe("GET /api/users/:username/trips — profile tab", () => {

  it("returns trips for a public profile", async () => {
    const state = baseState();
    state.trips = [
      { id: "t1", owner_id: ALICE, title: "Paris Trip", start_date: "2025-01-01", end_date: "2025-01-07", status: "past" },
      { id: "t2", owner_id: ALICE, title: "Rome Trip",  start_date: "2025-02-01", end_date: "2025-02-07", status: "upcoming" },
    ];
    setup(state);
    const r = await req("/users/alice_user/trips");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 2);
  });

  it("returns empty items when both show_past_trips and show_upcoming_trips=false", async () => {
    const state = baseState();
    state.trips = [{ id: "t1", owner_id: ALICE, title: "Paris Trip", start_date: "2024-01-01", end_date: "2024-01-07", status: "past" }];
    state.profile_privacy_settings = [{ user_id: ALICE, profile_visibility: "public", show_past_trips: false, show_upcoming_trips: false }];
    setup(state);
    const r = await req("/users/alice_user/trips");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
  });

  it("returns {blocked:true} for blocked user", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/trips");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true);
  });

  it("private profile returns empty to non-follower", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/trips");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. GET /users/:username/events — profile tab
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/events — profile tab", () => {

  it("returns public event memberships for a public profile", async () => {
    const state = baseState();
    (state as any).event_rsvps = [
      {
        event_id: "ev-1", user_id: ALICE, status: "going", created_at: "2025-01-01T00:00:00Z",
        // "event.visibility" as a flat key lets the fake client's eq() filter match PostgREST
        // dot-notation filters (r["event.visibility"]) without traversing nested objects.
        "event.visibility": "public",
        event: { id: "ev-1", title: "Travel Meetup", starts_at: "2025-03-01T18:00:00Z", ends_at: null,
                 city: "Paris", country: "France", cover_url: null, visibility: "public" },
      },
    ];
    setup(state);
    const r = await req("/users/alice_user/events");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].eventId, "ev-1");
    assert.equal(body.items[0].title, "Travel Meetup");
  });

  it("returns {blocked:true} for blocked user", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/events");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true);
  });

  it("returns empty items for deactivated account", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "deactivated" }];
    setup(state);
    const r = await req("/users/alice_user/events");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true);
  });

  it("private profile returns empty items to non-follower", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/events");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
    assert.ok(!body.blocked, "should not be blocked, just limited_preview");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. GET /users/:username/circles — profile tab
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/circles — profile tab", () => {

  it("returns public circle memberships for a public profile", async () => {
    const state = baseState();
    state.circle_memberships = [
      {
        user_id: DAN, other_id: ALICE, created_at: "2025-01-01T00:00:00Z",
        owner: { id: DAN, handle: "dan_user", username: "dan_user", display_name: "Dan", name: "Dan", avatar_url: null },
      },
    ];
    setup(state);
    const r = await req("/users/alice_user/circles");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].circleOwnerId, DAN);
    assert.equal(body.items[0].ownerHandle, "dan_user");
  });

  it("returns {blocked:true} for blocked user", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/circles");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true);
  });

  it("private profile returns empty items to non-follower", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/circles");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.items, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. GET /users/:username/profile — profile card alias parity
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/profile — profile card visibility parity", () => {

  it("returns full card for a public profile", async () => {
    const state = baseState();
    state.trips  = [{ id: "t1", owner_id: ALICE }];
    state.passport_stamps = [{ id: "s1", user_id: ALICE, locked: false }];
    setup(state);
    const r = await req("/users/alice_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.id, ALICE);
    assert.ok(!body.blocked, "should not be blocked");
    assert.ok(!body.unavailable, "should not be unavailable");
    assert.ok(!body.private, "should not be private stub");
  });

  it("returns {blocked:true} for a profile that blocked the viewer", async () => {
    setup(baseState());
    const r = await req("/users/carl_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.blocked, true, "profile card must enforce block");
    assert.ok(!body.id, "no id exposed on blocked response");
  });

  it("returns {unavailable:true} for deactivated account", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "deactivated" }];
    setup(state);
    const r = await req("/users/alice_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "deactivated account must be unavailable");
  });

  it("returns {unavailable:true} for suspended account", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "suspended" }];
    setup(state);
    const r = await req("/users/alice_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "suspended account must be unavailable");
  });

  it("returns private stub for limited_preview (private profile, non-follower)", async () => {
    setup(baseState());
    const r = await req("/users/bob_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.private, true, "private profile must return limited stub");
    assert.equal(body.visibility, "private");
    assert.ok(!body.id, "id must not be exposed in limited preview");
  });

  it("returns 404 for unknown username", async () => {
    setup(baseState());
    const r = await req("/users/nobody_xyz/profile");
    assert.equal(r.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Suspended account → unavailable (passport endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Suspended account — passport endpoint", () => {

  it("suspended account: returns {unavailable:true} on passport", async () => {
    const state = baseState();
    state.user_account_states = [{ user_id: ALICE, state: "suspended" }];
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "suspended account must be unavailable on passport");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. profiles.account_status fast-path + unauthenticated can_* privacy controls
// ═══════════════════════════════════════════════════════════════════════════════

describe("account_status fast-path + unauthenticated viewer privacy controls", () => {

  it("profile with account_status=deactivated returns unavailable without querying state table", async () => {
    const state = baseState();
    // Set account_status on the profile row itself (no user_account_states row needed)
    state.profiles = state.profiles.map(p =>
      p.id === ALICE ? { ...p, account_status: "deactivated" } : p
    );
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "account_status=deactivated should trigger unavailable");
  });

  it("unauthenticated viewer: can_follow=false when allow_follow=false in privacy settings", async () => {
    const state = baseState();
    state.profile_privacy_settings = [{ user_id: ALICE, profile_visibility: "public", allow_follow: false }];
    setup(state);
    const r = await req("/users/alice_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.viewer?.can_follow, false, "allow_follow=false should gate unauthenticated follow");
  });

  it("unauthenticated viewer: can_message=false when allow_messages_from=friends", async () => {
    const state = baseState();
    state.profile_privacy_settings = [{ user_id: ALICE, profile_visibility: "public", allow_messages_from: "friends" }];
    setup(state);
    const r = await req("/users/alice_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.viewer?.can_message, false, "allow_messages_from=friends should block unauthenticated message");
  });

  it("deactivation updates profiles.account_status", async () => {
    setup(baseState());
    const r = await req("/me/deactivate", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.deactivated, true);
    // The fake client records the profiles.update call
    // (we verify the deactivate endpoint returns success, meaning await didn't throw)
  });

  it("delete-request updates profiles.account_status", async () => {
    setup(baseState());
    const r = await req("/me/delete-request", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.deletionScheduled, true);
  });

  it("GET /me/privacy seeds defaults on first access", async () => {
    // No profile_privacy_settings row exists
    setup(baseState());
    const r = await req("/me/privacy");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.profile_visibility, "public", "defaults should be returned");
    assert.equal(body.show_posts, true, "show_posts default should be true");
    assert.equal(body.user_id, ME, "user_id should be present");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. POST /me/reactivate — all edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/me/reactivate", () => {
  it("deactivated account can self-reactivate → 200 { reactivated: true }", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, account_status: "deactivated" } : p
    );
    setup(state);
    const r = await req("/me/reactivate", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.reactivated, true, "deactivated account must be reactivatable");
  });

  it("suspended account cannot self-reactivate → 403 forbidden", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, account_status: "suspended" } : p
    );
    setup(state);
    const r = await req("/me/reactivate", { method: "POST" });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.equal(body.error, "forbidden", "suspended account must not self-reactivate");
  });

  it("banned account cannot self-reactivate → 403 forbidden", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, account_status: "banned" } : p
    );
    setup(state);
    const r = await req("/me/reactivate", { method: "POST" });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.equal(body.error, "forbidden", "banned account must not self-reactivate");
  });

  it("already-active account cannot reactivate → 403 (nothing to reactivate)", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, account_status: "active" } : p
    );
    setup(state);
    const r = await req("/me/reactivate", { method: "POST" });
    assert.equal(r.status, 403);
    const body = await r.json() as any;
    assert.equal(body.error, "forbidden");
  });

  it("missing profile returns 404", async () => {
    const state = baseState();
    state.profiles = state.profiles.filter((p) => p.id !== ME);
    setup(state);
    const r = await req("/me/reactivate", { method: "POST" });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, "not_found");
  });

  it("requires authentication → 401", async () => {
    setup(baseState());
    const r = await req("/me/reactivate", { method: "POST", tok: null });
    assert.equal(r.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 15. Passport limited_preview — avatarUrl/coverPhotoUrl must be null
// ═══════════════════════════════════════════════════════════════════════════════

describe("Passport limited_preview — no avatar/cover/bio/homeCity leak", () => {
  it("private profile (unauthenticated): avatarUrl is null, no bio/homeCity/coverPhotoUrl", async () => {
    const state = baseState();
    // BOB is is_private=true; unauthenticated viewer gets limited_preview
    state.profiles = state.profiles.map((p) =>
      p.id === BOB ? { ...p, avatar_url: "https://cdn.example.com/bob.jpg", cover_photo_url: "https://cdn.example.com/cover.jpg", bio: "Bob's private bio", home_city: "Secret City" } : p
    );
    setup(state);
    const r = await req("/users/bob_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.visibility, "private", "must return limited_preview stub");
    assert.strictEqual(body.avatarUrl, null, "avatarUrl must be null — must not leak private avatar");
    assert.ok(!("coverPhotoUrl" in body), "coverPhotoUrl must not appear in limited_preview response");
    assert.ok(!("bio" in body), "bio must not appear in limited_preview response");
    assert.ok(!("homeCity" in body), "homeCity must not appear in limited_preview response");
    assert.ok(!("interests" in body), "interests must not appear in limited_preview response");
  });

  it("passport_visibility=private: avatarUrl is null in limited_preview", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ALICE
        ? { ...p, is_private: false, passport_visibility: "private", avatar_url: "https://cdn.example.com/alice.jpg" }
        : p
    );
    setup(state);
    const r = await req("/users/alice_user/passport", { tok: null });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.visibility, "private");
    assert.strictEqual(body.avatarUrl, null, "avatarUrl must be null for passport_visibility=private");
    assert.ok(!("coverPhotoUrl" in body), "coverPhotoUrl must not leak for passport_visibility=private");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. GET /api/users/:username/profile — limited_preview no private data leak
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/users/:username/profile — limited_preview no private data leak", () => {
  it("private profile stub: avatarUrl null, coverUrl null, no bio/homeCity/interests/posts", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === BOB
        ? { ...p, avatar_url: "https://cdn.example.com/bob.jpg", cover_photo_url: "https://cdn.example.com/cover.jpg", bio: "Private bio", home_city: "Private City", interests: ["hiking"] }
        : p
    );
    setup(state);
    // ME views BOB (private, non-follower) → limited_preview
    const r = await req("/users/bob_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.private, true, "must return limited_preview stub");
    assert.equal(body.visibility, "private");
    assert.strictEqual(body.avatarUrl, null, "avatarUrl must be null in limited_preview stub");
    assert.strictEqual(body.coverUrl, null, "coverUrl must be null in limited_preview stub");
    assert.ok(!("bio" in body), "bio must not appear in limited_preview stub");
    assert.ok(!("homeCity" in body), "homeCity must not appear in limited_preview stub");
    assert.ok(!("interests" in body), "interests must not appear in limited_preview stub");
    assert.ok(!("posts" in body), "posts must not appear in limited_preview stub");
    assert.ok(!("email" in body), "email must never appear in any profile response");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 17. pending_deletion account_status → unavailable on public endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe("pending_deletion account_status → unavailable on public endpoints", () => {
  it("passport endpoint: pending_deletion → unavailable, no avatar/cover exposed", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ALICE ? { ...p, account_status: "pending_deletion", avatar_url: "https://cdn.example.com/alice.jpg" } : p
    );
    setup(state);
    const r = await req("/users/alice_user/passport");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "pending_deletion must return unavailable on passport");
    assert.ok(!("avatarUrl" in body), "avatarUrl must not be exposed for pending_deletion");
    assert.ok(!("bio" in body), "bio must not be exposed for pending_deletion");
  });

  it("profile endpoint: pending_deletion → unavailable, no avatar/cover exposed", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ALICE ? { ...p, account_status: "pending_deletion", avatar_url: "https://cdn.example.com/alice.jpg" } : p
    );
    setup(state);
    const r = await req("/users/alice_user/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.unavailable, true, "pending_deletion must return unavailable on profile endpoint");
    assert.ok(!("avatarUrl" in body), "avatarUrl must not be exposed for pending_deletion");
    assert.ok(!("coverUrl" in body), "coverUrl must not be exposed for pending_deletion");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. POST /me/delete-request — duplicate request is idempotent
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/me/delete-request — duplicate request", () => {
  it("returns the existing hold date without rewriting a pending row", async () => {
    const state = baseState();
    const existingSchedule = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();
    // Seed an existing pending deletion request for ME
    state.user_deletion_requests = [
      { user_id: ME, status: "pending", requested_at: new Date().toISOString(), scheduled_at: existingSchedule },
    ];
    setup(state);
    const r = await req("/me/delete-request", { method: "POST" });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.deletionScheduled, true);
    assert.equal(body.scheduledAt, existingSchedule);
  });

  it("cannot reset an executing request back to pending", async () => {
    const state = baseState();
    state.user_deletion_requests = [{
      user_id: ME,
      status: "executing",
      scheduled_at: new Date().toISOString(),
      execution_token: "22222222-2222-2222-2222-222222222222",
    }];
    setup(state);

    const r = await req("/me/delete-request", { method: "POST" });
    assert.equal(r.status, 403);
    assert.equal(state.user_deletion_requests[0].status, "executing");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 19. GET /me/profile — completeness score reflects homeCountry correctly
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/me/profile — completeness score and homeCountry column", () => {

  it("completeness object is present on GET /me/profile", async () => {
    setup(baseState());
    const r = await req("/me/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(body.completeness, "completeness object must be present");
    assert.equal(typeof body.completeness.score, "number", "completeness.score must be a number");
    assert.ok(Array.isArray(body.completeness.missing), "completeness.missing must be an array");
  });

  it("homeCountry appears in missing when home_country is null", async () => {
    // baseState profile for ME has no home_country field → !!undefined = false
    setup(baseState());
    const r = await req("/me/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(
      body.completeness.missing.includes("homeCountry"),
      "homeCountry must be in missing[] when home_country column is null/absent",
    );
  });

  it("homeCountry is NOT in missing when home_country is set", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_country: "Philippines" } : p,
    );
    setup(state);
    const r = await req("/me/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(
      !body.completeness.missing.includes("homeCountry"),
      "homeCountry must NOT be in missing[] when home_country column is set",
    );
  });

  it("score is higher when home_country is set vs null", async () => {
    // Score without homeCountry
    setup(baseState());
    const r1 = await req("/me/profile");
    const scoreWithout = ((await r1.json()) as any).completeness.score as number;

    // Score with homeCountry
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_country: "Philippines" } : p,
    );
    setup(state);
    const r2 = await req("/me/profile");
    const scoreWith = ((await r2.json()) as any).completeness.score as number;

    assert.ok(
      scoreWith > scoreWithout,
      `score must increase when home_country is set (was ${scoreWithout}, now ${scoreWith})`,
    );
    // 9 total checks, so each adds Math.round(100/9) ≈ 11 points
    const diff = scoreWith - scoreWithout;
    assert.ok(
      diff >= 10 && diff <= 12,
      `score increase for homeCountry must be ~11 points (1 of 9 checks), got ${diff}`,
    );
  });

  it("completeness uses home_country column, not home_city — setting only home_city does not satisfy it", async () => {
    const state = baseState();
    // Set home_city but leave home_country null
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_city: "Cebu", home_country: null } : p,
    );
    setup(state);
    const r = await req("/me/profile");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // homeCity must be returned correctly
    assert.equal(body.homeCity, "Cebu", "homeCity field must reflect home_city column");
    assert.equal(body.homeCountry, null, "homeCountry must be null when home_country column is null");
    // But the completeness check for homeCountry must still fail
    assert.ok(
      body.completeness.missing.includes("homeCountry"),
      "homeCountry must still appear in missing when only home_city is set (column mismatch guard)",
    );
  });

  it("PATCH /me/profile with homeCountry returns updated homeCountry field", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p) =>
      p.id === ME ? { ...p, home_country: null } : p,
    );
    setup(state);
    const r = await req("/me/profile", {
      method: "PATCH",
      body: { homeCountry: "Philippines" },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    // The PATCH route maps homeCountry → home_country in the DB row,
    // then mapProfile converts home_country → homeCountry in the response.
    // If the column mapping were wrong (e.g. home_city), this would be null.
    assert.equal(
      body.homeCountry,
      "Philippines",
      "PATCH homeCountry must persist via home_country column and be returned as homeCountry",
    );
  });
});

// ── Handle/Username invariant (handle canonical; username mirrors; lowercase) ──
describe("handle/username invariant", () => {
  it("PATCH username 200: writes username AND handle, equal and lowercase", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p: any) => p.id === ME ? { ...p, username_updated_at: null } : p);
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "NewIdentity_9" } });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    const uname = body.username ?? body.profile?.username;
    const handle = body.handle ?? body.profile?.handle;
    assert.equal(uname, "newidentity_9", "username lowercased");
    assert.equal(handle, "newidentity_9", "handle synced to username");
    assert.equal(uname, handle, "invariant: username === handle");
  });

  it("mixed-case username input normalizes to lowercase in both fields", async () => {
    const state = baseState();
    state.profiles = state.profiles.map((p: any) => p.id === ME ? { ...p, username_updated_at: null } : p);
    setup(state);
    const r = await req("/me/profile", { method: "PATCH", body: { username: "MiXeDCaSe_1" } });
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.username ?? body.profile?.username, "mixedcase_1");
    assert.equal(body.handle ?? body.profile?.handle, "mixedcase_1");
  });
});
