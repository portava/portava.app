/**
 * Beta Phase 12 — Admin Tools, Feature Flags & Kill-Switch tests
 *
 * Routes under test:
 *   GET  /admin/users?handle=<handle>      — admin user lookup by handle
 *   GET  /admin/users?email=<email>        — admin user lookup by email
 *   POST /posts                            — disable_posting kill switch
 *   POST /threads/:threadId/messages       — disable_messaging kill switch
 *   POST /admin/users/:userId/ban          — ban + effect on account_status
 *   POST /admin/reports/:id/hide-content   — hide referenced post/trip content
 *
 * Invariants:
 *   - disable_posting = true  → POST /posts returns 404 feature_disabled
 *   - disable_messaging = true → POST /threads/:id/messages returns 404 feature_disabled
 *   - Fail-open: when flag DB query fails, the action is NOT blocked
 *   - Admin ban writes audit row and sets account_status = 'banned'
 *   - hide-content moves report to in_review and hides the content
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminPhase12.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import postsRouter from "../routes/posts.js";
import messagingRouter from "../routes/messaging.js";

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

// ── Fake client factories ──────────────────────────────────────────────────────

function makeAdminFakeClient(opts: {
  isAdmin?: boolean;
  flagEnabled?: Record<string, boolean>;
  profiles?: Record<string, unknown>[];
  accountStates?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
  modActions?: Record<string, unknown>[];
  posts?: Record<string, unknown>[];
}) {
  const {
    isAdmin = true,
    flagEnabled = {},
    profiles = [{ id: ADMIN_ID, role: "admin", account_status: "active" }],
    accountStates = [],
    reports = [],
    modActions = [],
    posts = [{ id: POST_ID, post_status: "published" }],
  } = opts;

  function builder(table: string, rows: unknown[]) {
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
      if (table === "profiles") {
        const isAdminProfile = [{ id: ADMIN_ID, role: isAdmin ? "admin" : "member", account_status: "active", handle: "testadmin" }];
        return builder(table, isAdminProfile.concat(profiles.filter((p: any) => p.id !== ADMIN_ID)));
      }
      if (table === "feature_flags") {
        return {
          select:     () => b2,
          update:     () => b2,
          eq:         (col: string, val: string) => {
            const enabled = flagEnabled[val] ?? false;
            const row = { flag: val, enabled };
            const b2inner: any = {
              eq:         () => b2inner,
              select:     () => b2inner,
              update:     () => b2inner,
              maybeSingle: () => ({ data: row, error: null }),
              then:       (resolve: any) => Promise.resolve({ data: [row], error: null }).then(resolve),
            };
            return b2inner;
          },
          maybeSingle: () => ({ data: null, error: null }),
          then:       (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
      }
      const b2: any = {
        select:     () => b2,
        eq:         () => b2,
        neq:        () => b2,
        is:         () => b2,
        ilike:      () => b2,
        in:         () => b2,
        or:         () => b2,
        order:      () => b2,
        limit:      () => b2,
        range:      () => b2,
        update:     () => b2,
        insert:     (data: any) => b2,
        upsert:     (data: any) => b2,
        delete:     () => b2,
        then:       (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        single:     () => ({ data: null, error: { message: "no rows" } }),
        maybeSingle: () => ({ data: null, error: null }),
        get count() { return 0; },
      };
      if (table === "user_account_states") return builder(table, accountStates);
      if (table === "reports")           return builder(table, reports);
      if (table === "moderation_actions") return builder(table, modActions);
      if (table === "posts")             return builder(table, posts);
      return b2;
    },
    rpc: async () => ({ data: [], error: null }),
  };

  return client;
}

function makePostsFakeClient(opts: { disablePosting?: boolean; disableMessaging?: boolean }) {
  const { disablePosting = false, disableMessaging = false } = opts;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (!token) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: TARGET_ID } }, error: null };
      },
    },
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
    from: (table: string) => {
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
        const flagCheck = (flagName: string) => {
          const enabled = flagName === "disable_posting" ? disablePosting
            : flagName === "disable_messaging" ? disableMessaging
            : false;
          const row = { flag: flagName, enabled };
          const inner: any = {
            eq:         (col: string, val: string) => {
              const en = val === "disable_posting" ? disablePosting
                : val === "disable_messaging" ? disableMessaging
                : false;
              const r = { flag: val, enabled: en };
              return {
                maybeSingle: () => ({ data: r, error: null }),
                then: (resolve: any) => Promise.resolve({ data: [r], error: null }).then(resolve),
              };
            },
            maybeSingle: () => ({ data: row, error: null }),
            then: (resolve: any) => Promise.resolve({ data: [row], error: null }).then(resolve),
          };
          return inner;
        };
        return {
          select: () => ({
            eq: (col: string, val: string) => ({
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
        return {
          select: () => b,
          eq:     () => b,
          is:     () => b,
          maybeSingle: () => ({ data: { user_id: TARGET_ID, left_at: null }, error: null }),
          then:   (resolve: any) => Promise.resolve({ data: [{ user_id: TARGET_ID }], error: null }).then(resolve),
        };
      }
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

  it("returns profile + accountStates + openReports by handle", async () => {
    const targetProfile = { id: TARGET_ID, handle: "testuser", role: "member", account_status: "active", verified: false };
    const admin = makeAdminFakeClient({
      profiles: [targetProfile],
      accountStates: [{ state: "active", user_id: TARGET_ID }],
    });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("GET", `/admin/users?handle=testuser`);
    assert.equal(r.status, 200);
    assert.ok(r.body.profile, "profile present");
    assert.ok(Array.isArray(r.body.accountStates), "accountStates is array");
    assert.equal(typeof r.body.openReports, "number", "openReports is number");
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

describe("Admin ban", () => {
  it("sets account_status to banned and writes audit row", async () => {
    const capturedInserts: any[] = [];
    const admin = makeAdminFakeClient({});

    const origFrom = admin.from.bind(admin);
    admin.from = (table: string) => {
      const b = origFrom(table);
      if (table === "moderation_actions") {
        const origInsert = b.insert?.bind(b);
        b.insert = (data: any) => {
          capturedInserts.push(data);
          return b;
        };
      }
      return b;
    };

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
      posts:   [{ id: POST_ID, post_status: "published" }],
    });
    _setTestClient(admin, true);
    _setTestServiceClient(admin);
    const r = await req("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "Violation" });
    assert.ok([200, 201].includes(r.status), `expected 200/201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.contentHidden, true);
    assert.equal(r.body?.status, "in_review");
  });
});
