/**
 * Privacy fail-OPEN regression suite.
 *
 * One mechanism, six surfaces: supabase-js RESOLVES `{data, error}` rather than
 * throwing, so a privacy read that FAILS hands the caller `data: null`. Every
 * one of the call sites below then ran its "no restriction" default —
 * `?.field === false`, `?? []`, `!tier` — and served content the owner had
 * restricted. Each test injects a read error, requests as a NON-owner, and
 * asserts the restricted content is withheld.
 *
 * Run: node --import tsx/esm --test src/test/privacyFailClosed.test.ts
 *
 * NOTE: every suite lives in ONE outer describe so node:test runs them
 * sequentially — top-level describes run in parallel and would race on the
 * shared `_setTestClient` global.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { resolveProfileVisibility } from "../lib/profileVisibility.js";
import { loadCollectionVisibility } from "../services/passport/PassportProjectionService.js";
import { buildYearbook } from "../services/passport/PassportYearbookService.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";

// ── IDs ──────────────────────────────────────────────────────────────────────

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const VIEWER_TOKEN = "fail-closed-viewer-token";

// ── Generic fake client ──────────────────────────────────────────────────────

type ErrSpec = { code?: string; message: string };

/**
 * Minimal PostgREST-shaped fake. `errors[table]` makes every read of that table
 * RESOLVE `{data: null, error}` — the exact shape supabase-js produces for an
 * RLS denial, a dropped column, or a schema-cache miss, and the shape that made
 * all six of these sites fail open.
 */
function makeClient(opts: {
  db?: Record<string, any[]>;
  errors?: Record<string, ErrSpec>;
  users?: Record<string, string>;
} = {}) {
  const db = opts.db ?? {};
  const errors = opts.errors ?? {};
  const users = opts.users ?? { [VIEWER_TOKEN]: VIEWER };

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pending: "select" | "write" = "select";

    const rows = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const err = () => errors[table] ?? null;

    const obj: any = {
      select() { pending = "select"; return obj; },
      insert() { pending = "write"; return obj; },
      update() { pending = "write"; return obj; },
      upsert() { pending = "write"; return obj; },
      delete() { pending = "write"; return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return obj; },
      or() { return obj; },
      not() { return obj; },
      gt() { return obj; },
      gte() { return obj; },
      lt() { return obj; },
      lte() { return obj; },
      ilike() { return obj; },
      limit() { return obj; },
      range() { return obj; },
      order() { return obj; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e }).then(onF, onR);
        if (pending === "write") return Promise.resolve({ data: [], error: null }).then(onF, onR);
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        const id = users[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (table: string) => chain(table),
    rpc: async () => ({ data: null, error: null }),
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }),
    },
  };
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function req(method: string, path: string, token: string | null, server: Server) {
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = httpRequest(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TARGET_PROFILE = {
  id: OWNER,
  username: "restricted",
  handle: "restricted",
  name: "Restricted Owner",
  display_name: "Restricted Owner",
  is_private: false,
  passport_visibility: "public",
  account_status: "active",
  avatar_url: null,
  full_name: "Restricted Owner",
  is_official: false,
};

const RLS_DENIAL: ErrSpec = { code: "42501", message: "permission denied for table profile_privacy_settings" };
const CONN_ERROR: ErrSpec = { message: "fetch failed" };

// =============================================================================

describe("privacy fail-closed", () => {
  let server: Server;

  before(() => new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  }));
  after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  // ── SITE 2 — passport collection visibility ────────────────────────────────

  describe("PassportProjectionService.loadCollectionVisibility", () => {
    it("unreadable preference row DENIES stamps and memories to a public caller", async () => {
      const sc = makeClient({ errors: { passport_visibility_preferences: RLS_DENIAL } }) as any;
      const v = await loadCollectionVisibility(sc, OWNER, "public");
      assert.equal(v.stamps, false, "stamps must be withheld when the tier could not be read");
      assert.equal(v.memories, false, "memories must be withheld — the column defaults to 'circle'");
      assert.equal(v.unavailable, true, "the caller must be able to say 'we could not check'");
    });

    it("unreadable preference row DENIES stamps and memories to a circle caller too", async () => {
      const sc = makeClient({ errors: { passport_visibility_preferences: CONN_ERROR } }) as any;
      const v = await loadCollectionVisibility(sc, OWNER, "circle");
      assert.equal(v.stamps, false);
      assert.equal(v.memories, false);
    });

    it("the OWNER still sees their own collections when the row is unreadable", async () => {
      const sc = makeClient({ errors: { passport_visibility_preferences: RLS_DENIAL } }) as any;
      const v = await loadCollectionVisibility(sc, OWNER, "owner");
      assert.equal(v.stamps, true, "an unreadable row is no reason to hide an owner's own content");
      assert.equal(v.memories, true);
    });

    it("an ABSENT row is a SUCCESSFUL read and keeps its existing default handling", async () => {
      // No error, no row — the pre-existing behaviour (defaults govern) must be
      // untouched; this fix changes only the FAILURE path.
      const sc = makeClient({ db: { passport_visibility_preferences: [] } }) as any;
      const v = await loadCollectionVisibility(sc, OWNER, "public");
      assert.equal(v.unavailable, false, "absent != unreadable");
      assert.equal(v.stamps, true);
      assert.equal(v.memories, true);
    });

    it("a stored 'private' tier is still enforced on a successful read", async () => {
      const sc = makeClient({
        db: { passport_visibility_preferences: [{ user_id: OWNER, stamps_visible: "private", memories_visible: "circle" }] },
      }) as any;
      const v = await loadCollectionVisibility(sc, OWNER, "public");
      assert.equal(v.stamps, false);
      assert.equal(v.memories, false);
      assert.equal(v.unavailable, false);
    });
  });

  // ── SITE 2b — the yearbook retelling of the same gate ──────────────────────

  describe("PassportYearbookService.buildYearbook", () => {
    it("an unreadable preference row excludes stamps/memories as 'unavailable', not as a visibility choice", async () => {
      // The yearbook's `.catch()` fallback never fired for this failure —
      // loadCollectionVisibility RESOLVED — so the yearbook both included the
      // collections AND, once the gate was fixed, would have blamed the owner's
      // settings for a read error. Both halves are asserted here.
      const sc = makeClient({
        db: { trips: [], passport_stamps: [], user_stamps: [], memories: [], travel_dna_preferences: [] },
        errors: { passport_visibility_preferences: RLS_DENIAL },
      }) as any;

      const yb = await buildYearbook(sc, OWNER, {
        isSelf: false,
        canSeeTrips: true,
        canSeeRestricted: false,
        callerCtx: "public",
        viewerId: VIEWER,
      });

      assert.equal(yb.included.stamps, false, "stamps must not be included when the tier could not be read");
      assert.equal(yb.included.memories, false, "memories must not be included when the tier could not be read");
      const reasons = new Map(yb.exclusions.map((e: any) => [e.collection, e.reason]));
      assert.equal(reasons.get("stamps"), "unavailable",
        "the surface must say 'we could not check', not blame the owner's visibility settings");
      assert.equal(reasons.get("memories"), "unavailable");
    });
  });

  // ── SITE 3 — resolveProfileVisibility ──────────────────────────────────────

  describe("resolveProfileVisibility", () => {
    const baseDb = {
      profiles: [TARGET_PROFILE],
      blocks: [],
      user_account_states: [],
      profile_privacy_settings: [],
      user_friendships: [],
      user_follows: [],
    };

    it("an unreadable user_account_states hides the profile (was: stayed visible)", async () => {
      const sc = makeClient({ db: baseDb, errors: { user_account_states: RLS_DENIAL } }) as any;
      const r = await resolveProfileVisibility(sc, VIEWER, OWNER, TARGET_PROFILE);
      assert.equal(r.visibility, "unavailable",
        "a deactivated/banned/deleted account must not stay visible because the state read failed");
    });

    it("a genuinely ABSENT user_account_states table is still skipped (42P01)", async () => {
      const sc = makeClient({
        db: baseDb,
        errors: { user_account_states: { code: "42P01", message: 'relation "user_account_states" does not exist' } },
      }) as any;
      const r = await resolveProfileVisibility(sc, VIEWER, OWNER, TARGET_PROFILE);
      assert.equal(r.visibility, "full", "a table that does not exist carries no restriction to read");
    });

    it("PGRST204 (missing COLUMN) on user_account_states is NOT a missing table → hidden", async () => {
      const sc = makeClient({
        db: baseDb,
        errors: { user_account_states: { code: "PGRST204", message: "Could not find the 'state' column" } },
      }) as any;
      const r = await resolveProfileVisibility(sc, VIEWER, OWNER, TARGET_PROFILE);
      assert.equal(r.visibility, "unavailable");
    });

    it("an unreadable profile_privacy_settings raises privacySettingsUnavailable and denies 'full'", async () => {
      const sc = makeClient({ db: baseDb, errors: { profile_privacy_settings: RLS_DENIAL } }) as any;
      const r = await resolveProfileVisibility(sc, VIEWER, OWNER, TARGET_PROFILE);
      assert.equal(r.privacySettingsUnavailable, true,
        "callers gate on `?.show_x === false`; a NULL settings object must be distinguishable from a read failure");
      assert.notEqual(r.visibility, "full",
        "an unknown tier must not resolve to the public tier from the profiles-row fallback");
      assert.equal(r.visibility, "limited_preview");
    });

    it("a clean read of a public profile is unchanged", async () => {
      const sc = makeClient({ db: baseDb }) as any;
      const r = await resolveProfileVisibility(sc, VIEWER, OWNER, TARGET_PROFILE);
      assert.equal(r.visibility, "full");
      assert.equal(r.privacySettingsUnavailable, false);
    });
  });

  // ── SITE 3b — profile tab routes ───────────────────────────────────────────

  describe("GET /users/:username/{posts,stamps,trips}", () => {
    const TAB_DB = (friend: boolean) => ({
      profiles: [TARGET_PROFILE],
      blocks: [],
      user_account_states: [],
      // ua/ub are the sorted pair; OWNER sorts before VIEWER.
      user_friendships: friend ? [{ user_a: OWNER, user_b: VIEWER }] : [],
      user_follows: [],
      posts: [{ id: "p1", author_id: OWNER, content: "secret", post_status: "published", created_at: "2026-01-01T00:00:00Z" }],
      passport_stamps: [{ id: "s1", user_id: OWNER, stamp_type: "city", country: "JP", city: "Tokyo", awarded_at: "2026-01-01T00:00:00Z" }],
      trips: [{ id: "t1", owner_id: OWNER, title: "Trip", start_date: "2026-01-01", end_date: "2026-01-05", visibility: "public", created_at: "2026-01-01T00:00:00Z" }],
    });

    for (const tab of ["posts", "stamps", "trips"]) {
      it(`${tab}: a STRANGER gets nothing when the settings row is unreadable`, async () => {
        // The profile is public in `profiles`, so before the fix the unreadable
        // settings row fell back to "public" → visibility "full" → the tab's
        // `?.show_x === false` test saw null and SERVED the owner's content.
        _setTestClient(makeClient({ db: TAB_DB(false), errors: { profile_privacy_settings: RLS_DENIAL } }), true);
        const { status, body } = await req("GET", `/api/users/restricted/${tab}`, VIEWER_TOKEN, server);
        assert.ok(status === 200 || status === 503, `unexpected status ${status}`);
        const items = Array.isArray(body.items) ? body.items : [];
        assert.equal(items.length, 0, `show_${tab} is UNKNOWN, not true — the tab must not be served`);
      });

      it(`${tab}: an otherwise-granted viewer gets a retryable 503, not the content`, async () => {
        // A friend clears the visibility tier, so the per-tab flag is the ONLY
        // remaining gate — and it could not be read.
        _setTestClient(makeClient({ db: TAB_DB(true), errors: { profile_privacy_settings: RLS_DENIAL } }), true);
        const { status, body } = await req("GET", `/api/users/restricted/${tab}`, VIEWER_TOKEN, server);
        assert.equal(status, 503, `show_${tab} is UNKNOWN — answer "could not check", never the content`);
        assert.equal(body.error, "degraded_unavailable");
        assert.equal(body.retryable, true);
        assert.ok(!Array.isArray(body.items) || body.items.length === 0);
      });
    }
  });

  // ── SITE 4 — global feed ───────────────────────────────────────────────────

  describe("GET /api/posts (global feed)", () => {
    it("an unreadable private-author lookup yields 503 instead of an unfiltered page", async () => {
      _setTestClient(
        makeClient({
          db: {
            profiles: [{ ...TARGET_PROFILE, is_private: true }],
            post_hides: [],
            posts: [{ id: "p1", author_id: OWNER, content: "private-account post", visibility: "public", status: "active", post_status: "published", created_at: "2026-01-01T00:00:00Z" }],
          },
          errors: { profile_privacy_settings: RLS_DENIAL },
        }),
        true,
      );
      const { status, body } = await req("GET", "/api/posts", VIEWER_TOKEN, server);
      assert.equal(status, 503, "without the exclusion list every private account's posts surface on this page");
      assert.equal(body.error, "degraded_unavailable");
      assert.ok(!body.posts, "no post payload may accompany the failure");
    });
  });

  // ── SITE 6 — discovery opt-out ─────────────────────────────────────────────

  describe("discovery opt-out surfaces", () => {
    it("GET /me/profile/viewers → 503 when allow_profile_discovery is unreadable", async () => {
      _setTestClient(
        makeClient({
          db: {
            profile_views: [{ viewer_id: OTHER, viewed_at: new Date().toISOString(), target_id: VIEWER }],
            profiles: [{ id: OTHER, username: "lurker", full_name: "Lurker", avatar_url: null, is_official: false }],
          },
          errors: { profile_privacy_settings: CONN_ERROR },
        }),
        true,
      );
      const { status, body } = await req("GET", "/api/me/profile/viewers", VIEWER_TOKEN, server);
      assert.equal(status, 503, "a discovery-opted-out viewer must not be listed because the read failed");
      assert.equal(body.error, "degraded_unavailable");
      assert.ok(!body.viewers, "no viewer list may accompany the failure");
    });

    it("GET /posts/:id/savers → 503 when allow_profile_discovery is unreadable", async () => {
      _setTestClient(
        makeClient({
          db: {
            posts: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", author_id: VIEWER }],
            post_saves: [{ user_id: OTHER, post_id: "aaaaaaaa-0000-4000-8000-000000000001", created_at: "2026-01-01T00:00:00Z" }],
            profiles: [{ id: OTHER, username: "saver", display_name: "Saver", name: "Saver", full_name: "Saver", avatar_url: null, is_official: false }],
          },
          errors: { profile_privacy_settings: CONN_ERROR },
        }),
        true,
      );
      const { status, body } = await req(
        "GET", "/api/posts/aaaaaaaa-0000-4000-8000-000000000001/savers", VIEWER_TOKEN, server,
      );
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
      assert.ok(!body.savers);
    });
  });

  // ── SITE 5 — interaction opt-outs vs column drift ──────────────────────────

  describe("interactionPermissions column drift (PGRST204)", () => {
    it("a missing COLUMN on profile_privacy_settings must not silently permit follow/tag/friend-request", async () => {
      const sc = makeClient({
        db: {
          blocks: [],
          trust_restrictions: [],
          moderation_actions: [],
          user_privacy_settings: [],
          profiles: [TARGET_PROFILE, { id: VIEWER, username: "viewer" }],
          user_friendships: [],
          friend_requests: [],
          user_follows: [],
        },
        errors: {
          profile_privacy_settings: { code: "PGRST204", message: "Could not find the 'allow_follow' column of 'profile_privacy_settings' in the schema cache" },
        },
      }) as any;

      let permitted: any = null;
      let threw = false;
      try {
        permitted = await resolveInteractionPermissions(sc, VIEWER, OWNER);
      } catch {
        threw = true;
      }

      if (!threw) {
        // If the resolver chooses to answer at all, it must NOT answer "allowed"
        // off an opt-out column it could not read.
        assert.ok(
          !(permitted.canFollow === true && permitted.canSendFriendRequest === true && permitted.canTag === true),
          "column drift must not silently re-enable every interaction opt-out",
        );
      }
      assert.ok(threw, "PGRST204 is a missing COLUMN, not a missing table — it must surface as an error");
    });
  });
});
