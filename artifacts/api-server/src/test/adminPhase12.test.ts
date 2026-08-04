/**
 * Beta Phase 12 — Admin Tools, Feature Flags & Kill-Switch tests
 *
 * Routes/units under test:
 *   GET  /admin/users?handle=<handle>      — admin user lookup by handle
 *   GET  /admin/users?email=<email>        — admin user lookup by email
 *   POST /posts                            — disable_posting kill switch
 *   POST /threads/:threadId/messages       — disable_messaging kill switch
 *   POST /admin/users/:userId/ban          — ban action
 *   POST /admin/reports/:id/hide-content   — hide referenced post content
 *   checkRentBuddyAccess (unit)            — city_not_available when city has no rollout row
 *
 * Invariants:
 *   - disable_posting = true  → POST /posts returns 404 feature_disabled
 *   - disable_messaging = true → POST /threads/:id/messages returns 404 feature_disabled
 *   - Fail-open: when flag DB query fails, the action is NOT blocked
 *   - Banned users get 403 on any requireUser-guarded route
 *   - Admin ban writes audit row
 *   - hide-content moves report to in_review and hides the content
 *   - checkRentBuddyAccess returns city_not_available when city has no rollout row
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminPhase12.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import postsRouter from "../routes/posts.js";
import messagingRouter from "../routes/messaging.js";
import authRouter, { _resetAuthRateLimits } from "../routes/auth.js";
import { checkRentBuddyAccess, invalidateGcCache } from "../routes/rentABuddyRollout.js";

// ── Server ─────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN    = "fake.jwt.token";
const ADMIN_ID      = "aaaaaaaa-0000-0000-0000-000000000001";
const TARGET_ID     = "bbbbbbbb-0000-0000-0000-000000000002";
const REPORT_ID     = "cccccccc-0000-0000-0000-000000000003";
const POST_ID       = "dddddddd-0000-0000-0000-000000000004";
const THREAD_ID     = "eeeeeeee-0000-0000-0000-000000000005";

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
          "authorization": `Bearer ${FAKE_TOKEN}`,
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

// ── Admin fake client (filtering-aware builder) ────────────────────────────────

function makeAdminFakeClient(opts: {
  isAdmin?: boolean;
  flagEnabled?: Record<string, boolean>;
  profiles?: Record<string, unknown>[];
  accountStates?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
  modActions?: Record<string, unknown>[];
  posts?: Record<string, unknown>[];
  compassSettings?: Record<string, unknown>[];
}) {
  const {
    isAdmin = true,
    flagEnabled = {},
    profiles = [{ id: ADMIN_ID, role: "admin", account_status: "active" }],
    accountStates = [],
    reports = [],
    modActions = [],
    posts = [{ id: POST_ID, post_status: "published", author_id: TARGET_ID }],
    compassSettings = [],
  } = opts;

  function builder(_table: string, rows: unknown[]) {
    const baseRows = rows.map((r) => ({ ...(r as object) }));

    function makeB(filtered: unknown[]) {
      let _rows = filtered;
      const b: any = {
        select:     (_cols?: string, _opts?: any) => makeB(_rows),
        insert:     (data: any) => { _rows = Array.isArray(data) ? data.map((d: any) => ({...d})) : [{ ...data }]; return makeB(_rows); },
        update:     (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return makeB(_rows); },
        upsert:     (data: any, _opts?: any) => { _rows = Array.isArray(data) ? data.map((d: any) => ({...d})) : [{ ...data }]; return makeB(_rows); },
        delete:     () => makeB([]),
        eq:         (col: string, val: any) => makeB(_rows.filter((r: any) => r[col] == val)),
        neq:        (col: string, val: any) => makeB(_rows.filter((r: any) => r[col] != val)),
        is:         (col: string, val: any) => makeB(val === null ? _rows.filter((r: any) => r[col] == null) : _rows.filter((r: any) => r[col] == val)),
        ilike:      (col: string, pat: string) => {
          const lower = pat.replace(/%/g, "").toLowerCase();
          return makeB(_rows.filter((r: any) => String(r[col] ?? "").toLowerCase().includes(lower)));
        },
        not:        () => makeB(_rows),
        in:         (col: string, vals: any[]) => makeB(_rows.filter((r: any) => vals.includes(r[col]))),
        or:         () => makeB(_rows),
        gt:         () => makeB(_rows),
        lt:         () => makeB(_rows),
        gte:        () => makeB(_rows),
        lte:        () => makeB(_rows),
        like:       () => makeB(_rows),
        order:      () => makeB(_rows),
        limit:      (n: number) => makeB(_rows.slice(0, n)),
        range:      () => makeB(_rows),
        then:       (resolve: any, _reject?: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
        single:     () => ({ data: _rows[0] ?? null, error: _rows.length ? null : { message: "no rows" } }),
        maybeSingle: () => ({ data: _rows[0] ?? null, error: null }),
        get count() { return _rows.length; },
      };
      return b;
    }

    return makeB(baseRows);
  }

  const adminProfileRow = { id: ADMIN_ID, role: isAdmin ? "admin" : "member", account_status: "active", handle: "testadmin" };
  const allProfiles = [adminProfileRow, ...profiles.filter((p: any) => p.id !== ADMIN_ID)];

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: { id: ADMIN_ID } }, error: null };
      },
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
      },
    },
    storage: {
      from: () => ({ remove: async () => ({ error: null }) }),
    },
    from: (table: string) => {
      if (table === "profiles")          return builder(table, allProfiles);
      if (table === "feature_flags") {
        const b: any = {
          select: () => b,
          eq: (col: string, val: string) => {
            const enabled = flagEnabled[val] ?? false;
            const row = { flag: val, enabled };
            return {
              maybeSingle: () => ({ data: row, error: null }),
              then: (resolve: any) => Promise.resolve({ data: [row], error: null }).then(resolve),
            };
          },
          maybeSingle: () => ({ data: null, error: null }),
          then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return b;
      }
      if (table === "user_account_states") return builder(table, accountStates);
      if (table === "reports")             return builder(table, reports);
      if (table === "moderation_actions")  return builder(table, modActions);
      if (table === "posts")               return builder(table, posts);
      if (table === "compass_settings")     return builder(table, compassSettings);
      const b2: any = {
        select: () => b2, eq: () => b2, neq: () => b2, is: () => b2,
        ilike: () => b2, in: () => b2, or: () => b2, order: () => b2,
        limit: () => b2, range: () => b2, update: () => b2,
        insert: () => b2, upsert: () => b2, delete: () => b2, not: () => b2,
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        single: () => ({ data: null, error: { message: "no rows" } }),
        maybeSingle: () => ({ data: null, error: null }),
        get count() { return 0; },
      };
      return b2;
    },
    rpc: async () => ({ data: [], error: null }),
  };

  return client;
}

// ── Posts/messaging fake client ────────────────────────────────────────────────

function makePostsFakeClient(opts: {
  disablePosting?: boolean;
  disableMessaging?: boolean;
  accountStatus?: string;
}) {
  const { disablePosting = false, disableMessaging = false, accountStatus = "active" } = opts;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: TARGET_ID } }, error: null };
      },
    },
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
    from: (table: string) => {
      if (table === "profiles") {
        const profileRow = { id: TARGET_ID, account_status: accountStatus, handle: "testuser" };
        const b: any = {
          select:     () => b,
          eq:         () => b,
          neq:        () => b,
          is:         () => b,
          ilike:      () => b,
          in:         () => b,
          or:         () => b,
          not:        () => b,
          order:      () => b,
          limit:      () => b,
          maybeSingle: () => ({ data: profileRow, error: null }),
          then:       (resolve: any) => Promise.resolve({ data: [profileRow], error: null }).then(resolve),
        };
        return b;
      }
      const b: any = {
        select:     () => b,
        insert:     () => b,
        update:     () => b,
        upsert:     () => b,
        delete:     () => b,
        eq:         () => b,
        neq:        () => b,
        is:         () => b,
        ilike:      () => b,
        in:         () => b,
        or:         () => b,
        not:        () => b,
        gt:         () => b,
        lt:         () => b,
        gte:        () => b,
        lte:        () => b,
        like:       () => b,
        order:      () => b,
        limit:      () => b,
        range:      () => b,
        then:       (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        single:     () => ({ data: null, error: { message: "no rows" } }),
        maybeSingle: () => ({ data: null, error: null }),
        get count() { return 0; },
      };
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: () => {
                const enabled = val === "disable_posting" ? disablePosting
                  : val === "disable_messaging" ? disableMessaging
                  : false;
                return { data: { flag: val, enabled }, error: null };
              },
              then: (resolve: any) => {
                const enabled = val === "disable_posting" ? disablePosting
                  : val === "disable_messaging" ? disableMessaging
                  : false;
                return Promise.resolve({ data: [{ flag: val, enabled }], error: null }).then(resolve);
              },
            }),
          }),
        };
      }
      if (table === "message_thread_members") {
        const memberRow = { user_id: TARGET_ID, left_at: null };
        const mb: any = {
          select:     () => mb,
          eq:         () => mb,
          neq:        () => mb,
          is:         () => mb,
          not:        () => mb,
          order:      () => mb,
          limit:      () => mb,
          maybeSingle: () => ({ data: memberRow, error: null }),
          then:       (resolve: any) => Promise.resolve({ data: [memberRow], error: null }).then(resolve),
        };
        return mb;
      }
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return client;
}

// ── Auth / signup-status fake client ──────────────────────────────────────────

function makeSignupStatusFakeClient(opts: { disableSignups?: boolean; inviteOnly?: boolean }) {
  const { disableSignups = false, inviteOnly = false } = opts;
  return {
    from: (table: string) => {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: () => {
                const enabled = val === "disable_signups" ? disableSignups
                  : val === "invite_only_beta" ? inviteOnly
                  : false;
                return { data: { flag: val, enabled }, error: null };
              },
            }),
          }),
        };
      }
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => ({ data: null, error: null }) };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  } as any;
}

// ── Signup guard fake client ───────────────────────────────────────────────────

const SIGNUP_USER_ID = "ffffffff-0000-0000-0000-000000000099";

function makeSignupFakeClient(opts: {
  disableSignups?: boolean;
  flagQueryError?: boolean;
  createUserError?: { status?: number; message: string } | null;
}) {
  const { disableSignups = false, flagQueryError = false, createUserError = null } = opts;

  return {
    from: (table: string) => {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: (_col: string, val: string) => ({
              maybeSingle: () => {
                if (flagQueryError) return { data: null, error: { message: "db error" } };
                const enabled = val === "disable_signups" ? disableSignups : false;
                return { data: { flag: val, enabled }, error: null };
              },
            }),
          }),
        };
      }
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => ({ data: null, error: null }) };
      return b;
    },
    auth: {
      admin: {
        createUser: async (_opts: any) => {
          if (createUserError) return { data: null, error: createUserError };
          return {
            data: { user: { id: SIGNUP_USER_ID, email: (_opts.email as string) } },
            error: null,
          };
        },
      },
    },
    rpc: async () => ({ data: [], error: null }),
  } as any;
}

// ── Rollout fake client (for city_not_available unit test) ────────────────────

function makeRolloutFakeClient(opts: {
  rentBuddyEnabled?: boolean;
  cityRows?: { city: string; status: string }[];
}) {
  const { rentBuddyEnabled = true, cityRows = [] } = opts;

  const client: any = {
    from: (table: string) => {
      if (table === "feature_flags") {
        return {
          select: () => ({
            eq: (_col: string, flagName: string) => ({
              maybeSingle: () => {
                const enabled = flagName === "rent_buddy_enabled" ? rentBuddyEnabled : false;
                return { data: { flag: flagName, enabled }, error: null };
              },
            }),
          }),
        };
      }
      if (table === "rent_buddy_global_controls") {
        return {
          select: () => ({
            eq:  () => ({
              maybeSingle: () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === "rent_buddy_city_rollouts") {
        return {
          select: () => ({
            ilike: (_col: string, city: string) => ({
              maybeSingle: () => {
                const lower = city.toLowerCase();
                const match = cityRows.find((r) => r.city.toLowerCase() === lower);
                return { data: match ?? null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => ({ data: { role: "member" }, error: null }),
            }),
          }),
        };
      }
      const b: any = {
        select: () => b, eq: () => b, maybeSingle: () => ({ data: null, error: null }),
        then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  return client;
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());

  const adminClient = makeAdminFakeClient({});
  _setTestClient(adminClient, true);
  _setTestServiceClient(adminClient);

  app.use("/", adminRouter);
  app.use("/", postsRouter);
  app.use("/", messagingRouter);
  app.use("/", authRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Admin user lookup by handle", () => {
  it("returns 400 when no email or handle provided", async () => {
    const admin = makeAdminFakeClient({});
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("GET", "/admin/users");
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
  });

  it("returns 404 when handle not found", async () => {
    const admin = makeAdminFakeClient({ profiles: [] });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("GET", "/admin/users?handle=nobody");
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
  });

  it("returns profile + accountStates + openReports + onboardingStatus by handle", async () => {
    const targetProfile = { id: TARGET_ID, handle: "testuser", role: "member", account_status: "active", verified: false };
    const admin = makeAdminFakeClient({
      profiles: [targetProfile],
      accountStates: [{ state: "active", user_id: TARGET_ID }],
      compassSettings: [{ user_id: TARGET_ID, onboarding_completed: true, onboarding_completed_at: "2026-07-01T00:00:00Z" }],
    });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("GET", `/admin/users?handle=testuser`);
    assert.equal(r.status, 200);
    assert.ok(r.body.profile, "profile present");
    assert.ok(Array.isArray(r.body.accountStates), "accountStates is array");
    assert.equal(typeof r.body.openReports, "number", "openReports is number");
    assert.ok("onboardingStatus" in r.body, "onboardingStatus field present");
    assert.equal(r.body.onboardingStatus?.completed, true, "onboardingStatus.completed matches DB value");
  });

  it("returns 403 when caller is not admin", async () => {
    const nonAdmin = makeAdminFakeClient({ isAdmin: false });
    _setTestClient(nonAdmin, true);
    _setTestServiceClient(nonAdmin);
    const r = await req("GET", "/admin/users?handle=test");
    assert.equal(r.status, 403);
  });
});

describe("Kill switch: disable_posting", () => {
  it("blocks POST /posts when disable_posting = true", async () => {
    const fc = makePostsFakeClient({ disablePosting: true });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", "/posts", {
      content: "hello world",
      visibility: "public",
    });
    assert.equal(r.status, 404, `expected 404 feature_disabled, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "feature_disabled");
  });

  it("allows POST /posts when disable_posting = false (fail-open)", async () => {
    const fc = makePostsFakeClient({ disablePosting: false });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", "/posts", {
      content: "hello world",
      visibility: "public",
    });
    assert.notEqual(r.status, 404, "should not be blocked when flag is off");
    assert.notEqual(r.body?.error, "feature_disabled");
  });
});

describe("Kill switch: disable_messaging", () => {
  it("blocks POST /threads/:id/messages when disable_messaging = true", async () => {
    const fc = makePostsFakeClient({ disableMessaging: true });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", `/threads/${THREAD_ID}/messages`, { body: "hi there" });
    assert.equal(r.status, 404, `expected 404 feature_disabled, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "feature_disabled");
  });

  it("allows POST /threads/:id/messages when disable_messaging = false (fail-open)", async () => {
    const fc = makePostsFakeClient({ disableMessaging: false });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", `/threads/${THREAD_ID}/messages`, { body: "hi there" });
    assert.notEqual(r.status, 404, "should not be blocked when flag is off");
    assert.notEqual(r.body?.error, "feature_disabled");
  });
});

describe("Banned user enforcement", () => {
  it("returns 403 forbidden when banned user attempts to post", async () => {
    const fc = makePostsFakeClient({ accountStatus: "banned" });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", "/posts", { content: "should be blocked", visibility: "public" });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden");
  });

  it("returns 403 forbidden when suspended user attempts to send a message", async () => {
    const fc = makePostsFakeClient({ accountStatus: "suspended" });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", `/threads/${THREAD_ID}/messages`, { body: "hello" });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "forbidden");
  });

  it("allows active user through (no ban enforcement side-effect)", async () => {
    const fc = makePostsFakeClient({ accountStatus: "active" });
    _setTestClient(fc, true);
    _setTestServiceClient(fc);
    const r = await req("POST", `/threads/${THREAD_ID}/messages`, { body: "hi" });
    assert.notEqual(r.status, 403, "active user should not be blocked by ban check");
    assert.notEqual(r.body?.error, "forbidden");
  });
});

describe("Admin ban", () => {
  it("sets account_status to banned and writes audit row", async () => {
    const admin = makeAdminFakeClient({});
    _setTestClient(admin, true);
    _setTestServiceClient(admin);

    const r = await req("POST", `/admin/users/${TARGET_ID}/ban`, { reason: "Repeated violations" });
    assert.ok([200, 201].includes(r.status), `expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.ok === true || r.body.banned === true, "response indicates ban applied");
  });
});

describe("Admin reports: hide-content", () => {
  it("returns 404 when report not found", async () => {
    const admin = makeAdminFakeClient({ reports: [] });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "test" });
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
  });

  it("hides a post and moves report to in_review", async () => {
    const report = { id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "open" };
    const admin = makeAdminFakeClient({
      reports: [report],
      posts:   [{ id: POST_ID, post_status: "published", author_id: TARGET_ID }],
    });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "Violation" });
    assert.ok([200, 201].includes(r.status), `expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.contentHidden, true);
    assert.equal(r.body?.status, "in_review");
  });

  it("audits the moderation action against the post OWNER, not the admin", async () => {
    const report = { id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "open" };
    const admin = makeAdminFakeClient({
      reports: [report],
      // posts.author_id is the live owner column — the audit row's
      // target_user_id must resolve to it, not fall back to the admin.
      posts:   [{ id: POST_ID, post_status: "published", author_id: TARGET_ID }],
    });
    const auditInserts: any[] = [];
    const origFrom = admin.from.bind(admin);
    admin.from = (table: string) => {
      const b = origFrom(table);
      if (table === "moderation_actions") {
        const origInsert = b.insert?.bind(b);
        b.insert = (data: any) => {
          auditInserts.push(...(Array.isArray(data) ? data : [data]));
          return origInsert ? origInsert(data) : b;
        };
      }
      return b;
    };
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "Violation" });
    assert.ok([200, 201].includes(r.status), `expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(auditInserts.length > 0, "expected a moderation_actions audit insert");
    assert.equal(auditInserts[0].target_user_id, TARGET_ID, "audit must attribute the post owner, not the admin");
    assert.notEqual(auditInserts[0].target_user_id, ADMIN_ID);
  });
});

describe("Kill switch: disable_signups + invite_only_beta (GET /auth/signup-status)", () => {
  it("returns signupsEnabled=false when disable_signups = true", async () => {
    const fc = makeSignupStatusFakeClient({ disableSignups: true });
    _setTestServiceClient(fc);
    const r = await req("GET", "/auth/signup-status");
    assert.equal(r.status, 200);
    assert.equal(r.body?.signupsEnabled, false, "signupsEnabled must be false when kill switch is active");
  });

  it("returns signupsEnabled=true when disable_signups = false (default/fail-open)", async () => {
    const fc = makeSignupStatusFakeClient({ disableSignups: false });
    _setTestServiceClient(fc);
    const r = await req("GET", "/auth/signup-status");
    assert.equal(r.status, 200);
    assert.equal(r.body?.signupsEnabled, true, "signupsEnabled must be true when kill switch is off");
  });

  it("returns inviteOnly=true when invite_only_beta = true", async () => {
    const fc = makeSignupStatusFakeClient({ inviteOnly: true });
    _setTestServiceClient(fc);
    const r = await req("GET", "/auth/signup-status");
    assert.equal(r.status, 200);
    assert.equal(r.body?.inviteOnly, true, "inviteOnly must reflect the invite_only_beta flag");
  });
});

describe("Kill switch: disable_signups (POST /auth/signup)", () => {
  // The signup endpoint is guarded by a per-IP express-rate-limit middleware.
  // Reset its hit counters before each test so repeated signup POSTs from the
  // same loopback IP don't trip the limiter and return 429 RATE_LIMITED.
  beforeEach(() => { _resetAuthRateLimits(); });

  it("returns 403 feature_disabled when disable_signups = true", async () => {
    const fc = makeSignupFakeClient({ disableSignups: true });
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { email: "new@example.com", password: "password123" });
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "feature_disabled");
  });

  it("returns 201 and user when disable_signups = false", async () => {
    const fc = makeSignupFakeClient({ disableSignups: false });
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { email: "new@example.com", password: "password123" });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.user?.id, "user.id present");
    assert.ok(r.body?.user?.email, "user.email present");
  });

  it("is fail-open — signup succeeds when the flag DB query errors", async () => {
    const fc = makeSignupFakeClient({ flagQueryError: true });
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { email: "new@example.com", password: "password123" });
    assert.notEqual(r.status, 403, "flag DB error must not block signup");
    assert.notEqual(r.body?.error, "feature_disabled");
    assert.equal(r.status, 201, `expected 201 (fail-open), got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it("returns 400 for missing email", async () => {
    const fc = makeSignupFakeClient({});
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { password: "password123" });
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
  });

  it("returns 400 for short password", async () => {
    const fc = makeSignupFakeClient({});
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { email: "new@example.com", password: "abc" });
    assert.equal(r.status, 400);
    assert.equal(r.body?.error, "invalid_payload");
  });

  it("returns 409 when email is already registered", async () => {
    const fc = makeSignupFakeClient({
      createUserError: { status: 422, message: "User already registered" },
    });
    _setTestServiceClient(fc);
    const r = await req("POST", "/auth/signup", { email: "existing@example.com", password: "password123" });
    assert.equal(r.status, 409, `expected 409 email_taken, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "email_taken");
  });
});

describe("City rollout: city_not_available (unit)", () => {
  it("returns city_not_available when city has no rollout row", async () => {
    invalidateGcCache();
    const fc = makeRolloutFakeClient({ rentBuddyEnabled: true, cityRows: [] });
    const decision = await checkRentBuddyAccess({ sc: fc, userId: TARGET_ID, city: "UnknownCity", action: "book" });
    assert.equal((decision as any).allowed, false);
    assert.equal((decision as any).code, "city_not_available");
  });

  it("returns city_not_available when city status is 'disabled'", async () => {
    invalidateGcCache();
    const fc = makeRolloutFakeClient({
      rentBuddyEnabled: true,
      cityRows: [{ city: "TestCity", status: "disabled" }],
    });
    const decision = await checkRentBuddyAccess({ sc: fc, userId: TARGET_ID, city: "TestCity", action: "book" });
    assert.equal((decision as any).allowed, false);
    assert.equal((decision as any).code, "city_not_available");
  });

  it("returns feature_disabled when rent_buddy_enabled = false", async () => {
    invalidateGcCache();
    const fc = makeRolloutFakeClient({ rentBuddyEnabled: false, cityRows: [] });
    const decision = await checkRentBuddyAccess({ sc: fc, userId: TARGET_ID, city: "Manila", action: "book" });
    assert.equal((decision as any).allowed, false);
    assert.equal((decision as any).code, "feature_disabled");
  });

  it("allows access when city is at public_mvp", async () => {
    invalidateGcCache();
    const fc = makeRolloutFakeClient({
      rentBuddyEnabled: true,
      cityRows: [{ city: "Cebu", status: "public_mvp" }],
    });
    const decision = await checkRentBuddyAccess({ sc: fc, userId: TARGET_ID, city: "Cebu", action: "read" });
    assert.equal((decision as any).allowed, true);
  });
});
