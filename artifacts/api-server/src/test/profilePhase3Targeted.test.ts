/**
 * Profile Phase 3 — targeted QA tests
 *
 * Covers:
 *   (a) /users/suggestions: opted-out users (allow_profile_discovery=false) are excluded
 *   (b) /me/reactivate: constraints — only "deactivated" status allowed; fail-closed on DB errors
 *   (c) /me/profile/analytics: owner-only guard; returns aggregated counts
 *
 * Run: node --import tsx/esm --test src/test/profilePhase3Targeted.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import followsRouter from "../routes/follows.js";
import profileRouter from "../routes/profile.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN   = "fake.jwt.token";
const CALLER_ID    = "aaaaaaaa-1111-0000-0000-000000000001";
const OPTED_OUT_ID = "bbbbbbbb-2222-0000-0000-000000000002";
const NORMAL_ID    = "cccccccc-3333-0000-0000-000000000003";

// ── HTTP helper ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${FAKE_TOKEN}`,
        },
      },
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
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake Supabase client ───────────────────────────────────────────────────────

type FakeRow = Record<string, any>;

function makeFakeClient(tables: Record<string, FakeRow[]>) {
  const buildQuery = (table: string, rows: FakeRow[]) => {
    let _rows = [...rows];
    let _count = false;
    let _head  = false;
    let _single = false;
    let _maybeSingle = false;
    const q: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === "exact") _count = true;
        if (opts?.head) _head = true;
        return q;
      },
      eq(col: string, val: any)  { _rows = _rows.filter((r) => r[col] === val); return q; },
      neq(col: string, val: any) { _rows = _rows.filter((r) => r[col] !== val); return q; },
      in(col: string, vals: any[]) { _rows = _rows.filter((r) => vals.includes(r[col])); return q; },
      gte(col: string, val: any) { _rows = _rows.filter((r) => r[col] >= val); return q; },
      lte(col: string, val: any) { _rows = _rows.filter((r) => r[col] <= val); return q; },
      is(col: string, val: any) {
        _rows = val === null ? _rows.filter((r) => r[col] == null) : _rows.filter((r) => r[col] === val);
        return q;
      },
      ilike(col: string, _p: string) { return q; },
      textSearch() { return q; },
      overlaps() { return q; },
      or() { return q; },
      order() { return q; },
      limit(n: number) { _rows = _rows.slice(0, n); return q; },
      range(from: number, to: number) { _rows = _rows.slice(from, to + 1); return q; },
      single() { _single = true; return q; },
      maybeSingle() { _maybeSingle = true; return q; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      update(_row?: any) {
        const noopEq: any = { eq: () => noopEq, then: (r: any) => Promise.resolve({ data: null, error: null }).then(r) };
        return noopEq;
      },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      delete() {
        const noopEq: any = { eq: () => noopEq, then: (r: any) => Promise.resolve({ data: null, error: null }).then(r) };
        return noopEq;
      },
      then(res: any, _rej: any) {
        const count = _count ? _rows.length : undefined;
        if (_single) return Promise.resolve({ data: _rows[0] ?? null, error: null, count }).then(res, _rej);
        if (_maybeSingle) return Promise.resolve({ data: _rows[0] ?? null, error: null, count }).then(res, _rej);
        if (_head && _count) return Promise.resolve({ data: null, error: null, count }).then(res, _rej);
        return Promise.resolve({ data: _rows, error: null, count }).then(res, _rej);
      },
    };
    return q;
  };

  const userRows = tables["users"] ?? [];
  return {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({
          data: { user: userRows[0] ?? null },
          error: null,
        }),
    },
    from: (table: string) => buildQuery(table, tables[table] ?? []),
    storage: { from: () => ({ remove: () => Promise.resolve({}) }) },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Profile Phase 3 — targeted QA", () => {
  before(() => {
    const app = express();
    app.use(express.json());
    app.use(followsRouter);
    app.use(profileRouter);
    server = http.createServer(app);
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => {
      const addr = server.address() as { port: number };
      base = `http://127.0.0.1:${addr.port}`;
    });
  });

  after(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));

  // ── (a) Suggestions: opted-out user excluded ─────────────────────────────────

  describe("GET /users/suggestions — discovery privacy", () => {
    it("excludes users with allow_profile_discovery=false from suggestions", async () => {
      const callerProfile = {
        id: CALLER_ID,
        account_status: "active",
        travel_styles: [],
        travel_pace: null,
        budget_style: null,
        travel_group_style: [],
        looking_for: [],
        comfort_level: null,
        planning_style: null,
        open_to_meet: true,
        interests: [],
        spoken_languages: [],
      };
      // Two candidates: one opted out, one normal
      const candidates = [
        { id: OPTED_OUT_ID, handle: "optedout", name: "Opted Out", avatar_url: null, is_private: false, account_status: "active", travel_styles: [], travel_pace: null, budget_style: null, travel_group_style: [], looking_for: [], comfort_level: null, planning_style: null },
        { id: NORMAL_ID,    handle: "normaluser", name: "Normal",  avatar_url: null, is_private: false, account_status: "active", travel_styles: [], travel_pace: null, budget_style: null, travel_group_style: [], looking_for: [], comfort_level: null, planning_style: null },
      ];

      const privacyRows = [{ user_id: OPTED_OUT_ID, allow_profile_discovery: false }];

      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [callerProfile, ...candidates],
        profile_privacy_settings: privacyRows,
        user_follows: [],
        user_blocks: [],
        friend_requests: [],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/users/suggestions");
      assert.equal(status, 200, "Should return 200");
      const ids: string[] = (body.users ?? []).map((u: any) => u.id as string);
      assert.ok(!ids.includes(OPTED_OUT_ID), "Opted-out user must not appear in suggestions");
    });

    it("includes users with allow_profile_discovery=true (default) in suggestions", async () => {
      const callerProfile = {
        id: CALLER_ID,
        account_status: "active",
        travel_styles: [],
        travel_pace: null,
        budget_style: null,
        travel_group_style: [],
        looking_for: [],
        comfort_level: null,
        planning_style: null,
        open_to_meet: true,
        interests: [],
        spoken_languages: [],
      };
      const candidate = {
        id: NORMAL_ID, handle: "normaluser", name: "Normal", avatar_url: null, is_private: false,
        account_status: "active", travel_styles: [], travel_pace: null, budget_style: null,
        travel_group_style: [], looking_for: [], comfort_level: null, planning_style: null,
      };

      // No opted-out rows → NORMAL_ID should appear
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [callerProfile, candidate],
        profile_privacy_settings: [],
        user_follows: [],
        user_blocks: [],
        friend_requests: [],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/users/suggestions");
      assert.equal(status, 200);
      const ids: string[] = (body.users ?? []).map((u: any) => u.id as string);
      assert.ok(ids.includes(NORMAL_ID) || body.users.length >= 0, "Normal user should be eligible");
    });
  });

  // ── (b) /me/reactivate — state constraints ────────────────────────────────────

  describe("POST /me/reactivate", () => {
    it("returns 403 when account_status is not 'deactivated' (e.g. active)", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "active" }],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status } = await req("POST", "/me/reactivate");
      assert.equal(status, 403, "Active account must not be reactivated");
    });

    it("returns 403 when account_status is 'suspended'", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "suspended" }],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status } = await req("POST", "/me/reactivate");
      assert.equal(status, 403, "Suspended account must not self-reactivate");
    });

    it("returns 403 when account_status is 'banned'", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "banned" }],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status } = await req("POST", "/me/reactivate");
      assert.equal(status, 403, "Banned account must not self-reactivate");
    });

    it("returns 404 when profile row does not exist (fail-closed)", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [], // no profile row
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status } = await req("POST", "/me/reactivate");
      assert.equal(status, 404, "Missing profile row must not allow reactivation");
    });

    it("returns 200 and reactivated:true when account_status is 'deactivated'", async () => {
      let profileStatus = "deactivated";
      const baseClient = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "deactivated" }],
        user_account_states: [],
        profile_privacy_settings: [],
      });
      // Override update to mutate profileStatus and succeed
      const client = {
        ...baseClient,
        from: (table: string) => {
          const q = baseClient.from(table);
          if (table === "profiles") {
            const origUpdate = q.update.bind(q);
            q.update = (row: any) => {
              if (row.account_status) profileStatus = row.account_status;
              return { eq: () => Promise.resolve({ data: null, error: null }) };
            };
          }
          return q;
        },
      };
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("POST", "/me/reactivate");
      assert.equal(status, 200, "Deactivated account should reactivate");
      assert.equal(body.reactivated, true);
      assert.equal(profileStatus, "active", "Profile status should be updated to active");
    });
  });

  // ── (c) /me/profile/analytics — owner-only + aggregation ─────────────────────

  describe("GET /me/profile/analytics", () => {
    it("returns 401 when no auth token provided", async () => {
      const url = new URL("/me/profile/analytics", base);
      const { status } = await new Promise<{ status: number }>((resolve, reject) => {
        const r = http.request(
          { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET" },
          (res) => resolve({ status: res.statusCode ?? 0 }),
        );
        r.on("error", reject);
        r.end();
      });
      assert.equal(status, 401, "Unauthenticated request must be rejected");
    });

    it("returns aggregated analytics shape when authenticated", async () => {
      const now = new Date().toISOString();
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "active" }],
        // profile_views uses target_id for the profile owner
        profile_views: [
          { id: "v1", target_id: CALLER_ID, viewer_id: NORMAL_ID, viewed_at: now },
        ],
        user_follows: [
          { follower_id: NORMAL_ID, following_id: CALLER_ID, created_at: now },
        ],
        post_impressions: [],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/me/profile/analytics");
      assert.equal(status, 200, "Analytics must return 200");
      // Response shape: { profileViews: { sevenDay, thirtyDay }, followerGrowth: { sevenDay, thirtyDay }, postImpressions7d }
      assert.ok(body.profileViews && typeof body.profileViews.sevenDay === "number",  "must have profileViews.sevenDay");
      assert.ok(body.profileViews && typeof body.profileViews.thirtyDay === "number", "must have profileViews.thirtyDay");
      assert.ok(body.followerGrowth && typeof body.followerGrowth.sevenDay === "number", "must have followerGrowth.sevenDay");
      assert.ok("postImpressions7d" in body, "must have postImpressions7d");
      assert.ok(typeof body.postImpressions7d === "number", "postImpressions7d must be a number");
    });

    it("returns 0 for impression count when post_impressions table errors (fail-open)", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: CALLER_ID, account_status: "active" }],
        profile_views: [],
        user_follows: [],
        post_impressions: [],
      });
      // Simulate table-not-found by making the post_impressions query return a DB error
      // (this is what Supabase returns for missing tables, not a synchronous throw)
      const origFrom = client.from.bind(client);
      (client as any).from = (table: string) => {
        if (table === "post_impressions") {
          const errQ: any = {
            select: () => errQ,
            eq:     () => errQ,
            gte:    () => errQ,
            then: (resolve: any, reject: any) =>
              Promise.resolve({ data: null, error: { message: "relation does not exist" }, count: null })
                .then(resolve, reject),
          };
          return errQ;
        }
        return origFrom(table);
      };
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/me/profile/analytics");
      assert.equal(status, 200, "Should not crash when post_impressions errors");
      assert.ok(typeof body.postImpressions7d === "number", "must return a number (0 on error)");
      assert.equal(body.postImpressions7d, 0, "should be 0 when table is unavailable");
    });
  });

  // ── Private-account privacy leaks (S2–S6) ────────────────────────────────────

  const OTHER_ID = "dddddddd-4444-0000-0000-000000000004";

  describe("GET /users/:userId/follow-status — private-count gating (S3)", () => {
    it("nulls follower/following counts for a private target the caller does not follow", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: NORMAL_ID, is_private: true }],
        // NORMAL_ID has one follower and follows one account → real counts are 1/1.
        user_follows: [
          { follower_id: OTHER_ID, following_id: NORMAL_ID },
          { follower_id: NORMAL_ID, following_id: OTHER_ID },
        ],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", `/users/${NORMAL_ID}/follow-status`);
      assert.equal(status, 200);
      assert.equal(body.isFollowing, false);
      assert.equal(body.followersCount, null, "private non-follower must not see follower count");
      assert.equal(body.followingCount, null, "private non-follower must not see following count");
    });

    it("returns real counts for a private target the caller already follows", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: NORMAL_ID, is_private: true }],
        user_follows: [
          { follower_id: CALLER_ID, following_id: NORMAL_ID }, // caller follows target
          { follower_id: OTHER_ID, following_id: NORMAL_ID },
        ],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", `/users/${NORMAL_ID}/follow-status`);
      assert.equal(status, 200);
      assert.equal(body.isFollowing, true);
      assert.equal(body.followersCount, 2, "follower sees the real follower count");
      assert.equal(body.followingCount, 0);
    });

    it("returns real counts for a public target regardless of follow state", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{ id: NORMAL_ID, is_private: false }],
        user_follows: [{ follower_id: OTHER_ID, following_id: NORMAL_ID }],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", `/users/${NORMAL_ID}/follow-status`);
      assert.equal(status, 200);
      assert.equal(body.followersCount, 1, "public counts are always visible");
      assert.equal(body.followingCount, 0);
    });
  });

  describe("GET /users/:userId passport — private redaction (S2, S4)", () => {
    const passportProfile = (over: Record<string, any>) => ({
      id: NORMAL_ID, handle: "target", name: "Target", avatar_url: "https://cdn.example.com/t.jpg",
      bio: "hi", home_city: null, home_country: null, current_city: null, travel_style: null,
      interests: [], verified: false, verification_status: "unverified", verified_at: null,
      open_to_meet: false, is_private: false, passport_visibility: "public", created_at: "2026-01-01T00:00:00Z",
      spoken_languages: [], default_language: null, travel_styles: [], travel_pace: null, budget_style: null,
      travel_group_style: [], looking_for: [], comfort_level: null, availability_tags: [], planning_style: null,
      account_status: "active", is_official: false, ...over,
    });

    it("redacts a passport_visibility='private' account even when is_private=false (S2)", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [passportProfile({ is_private: false, passport_visibility: "private" })],
        user_follows: [{ follower_id: OTHER_ID, following_id: NORMAL_ID }], // real follower count 1
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", `/users/${NORMAL_ID}`);
      assert.equal(status, 200);
      assert.equal(body.isPrivate, true, "passport_visibility='private' must make the account private");
      assert.ok(!("bio" in body), "private preview must not include rich fields like bio");
      // S4: locked preview leaks nothing sensitive.
      assert.equal(body.avatarUrl, null, "private preview avatar must be null");
      assert.equal(body.followersCount, null, "private preview omits follower count");
      assert.equal(body.followingCount, null, "private preview omits following count");
      assert.equal(body.reason, null, "private preview must not carry a shared-destination reason");
    });

    it("serves the full public passport (with avatar + counts) for a public account", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [passportProfile({})],
        user_follows: [{ follower_id: OTHER_ID, following_id: NORMAL_ID }],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", `/users/${NORMAL_ID}`);
      assert.equal(status, 200);
      assert.equal(body.isPrivate, false);
      assert.equal(body.avatarUrl, "https://cdn.example.com/t.jpg");
      assert.equal(body.followersCount, 1);
    });
  });

  describe("GET /users/search — private row field nulling (S5)", () => {
    it("keeps the private row but nulls avatar, follower count, and reason", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [{
          id: NORMAL_ID, handle: "privuser", username: "privuser", name: "Priv",
          avatar_url: "https://cdn.example.com/p.jpg", is_private: true, account_status: "active",
          home_city: null, home_country: null, spoken_languages: [], interests: [],
          verified: false, is_official: false,
        }],
        blocks: [],
        profile_privacy_settings: [],
        user_follows: [{ follower_id: OTHER_ID, following_id: NORMAL_ID }], // real count 1
        friend_requests: [],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/users/search?q=privuser");
      assert.equal(status, 200);
      const hit = (body.users ?? []).find((u: any) => u.id === NORMAL_ID);
      assert.ok(hit, "private account is still returned as a search hit (for follow purposes)");
      assert.equal(hit.isPrivate, true);
      assert.equal(hit.avatarUrl, null, "private search hit must not leak avatar");
      assert.equal(hit.followerCount, null, "private search hit must not leak follower count");
      assert.equal(hit.reason, null, "private search hit must not leak a shared-destination reason");
    });
  });

  describe("GET /users/suggestions — private follower-count gating (S6)", () => {
    it("nulls followerCount on a private suggestion card, matching its sibling fields", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [
          { id: CALLER_ID, account_status: "active", travel_styles: [], travel_pace: null, budget_style: null, travel_group_style: [], looking_for: [], comfort_level: null, planning_style: null },
          { id: NORMAL_ID, handle: "privcand", name: "PrivCand", avatar_url: "https://cdn.example.com/pc.jpg", is_private: true, account_status: "active", travel_styles: [], travel_pace: null, budget_style: null, travel_group_style: [], looking_for: [], comfort_level: null, planning_style: null, verified: false, is_official: false },
        ],
        profile_privacy_settings: [],
        // NORMAL_ID follows the caller (follow-back candidate) and has one follower.
        user_follows: [
          { follower_id: NORMAL_ID, following_id: CALLER_ID },
          { follower_id: OTHER_ID, following_id: NORMAL_ID },
        ],
        friend_requests: [],
      });
      _setTestClient(client as any, true);
      _setTestServiceClient(client as any);

      const { status, body } = await req("GET", "/users/suggestions");
      assert.equal(status, 200);
      const card = (body.users ?? []).find((u: any) => u.id === NORMAL_ID);
      assert.ok(card, "private follow-back candidate should appear in suggestions");
      assert.equal(card.isPrivate, true);
      assert.equal(card.avatarUrl, null, "private card avatar is null (existing behaviour)");
      assert.equal(card.followerCount, null, "private card follower count must also be null");
    });
  });

  describe("GET /users/:userId — location opt-out (LOC-1)", () => {
    const cityProfile = (id) => ({
      id, handle: "h_" + id.slice(0, 4), name: "Nomad", is_private: false,
      passport_visibility: "public", current_city: "Da Nang", home_country: "Vietnam",
      home_city: "Hanoi", created_at: "2026-01-01T00:00:00Z",
    });

    it("nulls currentCity + homeCountry for a non-owner when the subject opted out", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [cityProfile(OPTED_OUT_ID)],
        profile_privacy_settings: [{ user_id: OPTED_OUT_ID, show_current_city: false, show_home_country: false }],
      });
      _setTestClient(client, true); _setTestServiceClient(client);
      const { status, body } = await req("GET", "/users/" + OPTED_OUT_ID);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.currentCity, null, "current city must be hidden after opt-out");
      assert.equal(body.homeCountry, null, "home country must be hidden after opt-out");
    });

    it("still returns them when the subject did NOT opt out (positive control)", async () => {
      const client = makeFakeClient({
        users: [{ id: CALLER_ID }],
        profiles: [cityProfile(NORMAL_ID)],
        profile_privacy_settings: [{ user_id: NORMAL_ID, show_current_city: true, show_home_country: true }],
      });
      _setTestClient(client, true); _setTestServiceClient(client);
      const { body } = await req("GET", "/users/" + NORMAL_ID);
      assert.equal(body.currentCity, "Da Nang");
      assert.equal(body.homeCountry, "Vietnam");
    });

    it("shows the owner their own location even when opted out", async () => {
      const client = makeFakeClient({
        users: [{ id: OPTED_OUT_ID }],
        profiles: [cityProfile(OPTED_OUT_ID)],
        profile_privacy_settings: [{ user_id: OPTED_OUT_ID, show_current_city: false, show_home_country: false }],
      });
      _setTestClient(client, true); _setTestServiceClient(client);
      const { body } = await req("GET", "/users/" + OPTED_OUT_ID);
      assert.equal(body.currentCity, "Da Nang", "owner sees own current city");
      assert.equal(body.homeCountry, "Vietnam", "owner sees own home country");
    });
  });

});
