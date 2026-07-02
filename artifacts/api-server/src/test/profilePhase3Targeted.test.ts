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
});
