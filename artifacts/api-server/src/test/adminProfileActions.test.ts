/**
 * Admin profile action tests — Phase 3 additions
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   GET    /admin/users/:userId/summary
 *   POST   /admin/users/:userId/verify
 *   POST   /admin/users/:userId/unverify
 *   POST   /admin/users/:userId/warn
 *   POST   /admin/users/:userId/restrict
 *   POST   /admin/users/:userId/suspend
 *   POST   /admin/users/:userId/ban
 *   POST   /admin/users/:userId/restore
 *   DELETE /admin/users/:userId/avatar
 *   DELETE /admin/users/:userId/cover
 *   GET    /admin/reports
 *   POST   /admin/reports/:id/resolve
 *   POST   /admin/reports/:id/dismiss
 *   GET    /admin/deletion-requests
 *   POST   /admin/deletion-requests/:id/execute
 *
 * Run: node --import tsx/esm --test src/test/adminProfileActions.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOKEN     = "fake.jwt.token";
const TARGET_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN_USER_ID  = "bbbbbbbb-0000-0000-0000-000000000002";
const REPORT_ID      = "cccccccc-0000-0000-0000-000000000003";
const DELETION_REQ_ID = "dddddddd-0000-0000-0000-000000000004";

// ── HTTP helper ───────────────────────────────────────────────────────────────

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
          ...(method === "DELETE" ? {} : {}),
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

// ── Fake client builder ───────────────────────────────────────────────────────

function makeFakeClient(opts: {
  role?: string;
  captureInserts?: any[];
  captureUpdates?: any[];
  profiles?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
  deletionRequests?: Record<string, unknown>[];
  accountStates?: Record<string, unknown>[];
}) {
  const {
    role = "admin",
    captureInserts = [],
    captureUpdates = [],
    profiles = [
      { id: ADMIN_USER_ID, role: "admin" },
      { id: TARGET_USER_ID, handle: "target", name: "Target User", avatar_url: null, cover_photo_url: null, role: "user", verified: false, verification_status: "unverified", account_status: "active", created_at: new Date().toISOString() },
    ],
    reports = [
      { id: REPORT_ID, reporter_id: "e1e1e1e1-0000-0000-0000-000000000001", target_type: "user", target_id: TARGET_USER_ID, reason_code: "spam", severity: "low", status: "open", created_at: new Date().toISOString(), reviewed_at: null, reviewed_by: null, moderation_notes: null },
    ],
    deletionRequests = [
      { id: DELETION_REQ_ID, user_id: TARGET_USER_ID, requested_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), status: "pending" },
    ],
    accountStates = [],
    failInsertsOn = null as string | null,
  } = opts;

  function builder(table: string, rows: unknown[]) {
    let _rows = rows;
    let _failed = false;
    let _pendingUpdate: any = null;
    const _updateFilters: Array<[string, any]> = [];
    const DB_ERR = { message: "simulated audit write failure", code: "XX000" };
    const materialize = () => {
      if (_pendingUpdate == null) return _rows;
      const matchedIndices = _rows.reduce<number[]>((acc, row: any, index) => {
        if (_updateFilters.every(([col, val]) => row?.[col] === val)) acc.push(index);
        return acc;
      }, []);
      for (const index of matchedIndices) {
        (_rows as any[])[index] = { ...(_rows as any[])[index], ..._pendingUpdate };
      }
      return matchedIndices.map((index) => (_rows as any[])[index]);
    };
    const b: any = {
      select:      () => b,
      insert:      (data: any) => {
        captureInserts.push({ table, data });
        if (failInsertsOn === table) { _failed = true; return b; }
        _rows = Array.isArray(data) ? data : [data];
        return b;
      },
      update:      (data: any) => {
        captureUpdates.push({ table, data });
        _pendingUpdate = data;
        return b;
      },
      upsert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      delete:      () => { _rows = []; return b; },
      eq:          (col: string, val: any) => {
        // AccountDeletionService verifies UPDATE ... RETURNING with
        // maybeSingle(). Scope those returning rows like PostgREST does.
        if (_pendingUpdate != null) _updateFilters.push([col, val]);
        return b;
      },
      lte:         () => b,
      neq:         () => b,
      is:          () => b,
      ilike:       () => b,
      not:         () => b,
      in:          () => b,
      or:          () => b,
      gt:          () => b,
      gte:         () => b,
      order:       () => b,
      limit:       () => b,
      range:       () => b,
      then:        (resolve: any) => {
        const data = materialize();
        return Promise.resolve(_failed ? { data: null, error: DB_ERR, count: 0 } : { data, error: null, count: data.length }).then(resolve);
      },
      maybeSingle: () => {
        const data = materialize();
        return Promise.resolve(_failed ? { data: null, error: DB_ERR } : { data: data[0] ?? null, error: null });
      },
      single:      () => {
        const data = materialize();
        return Promise.resolve(_failed ? { data: null, error: DB_ERR } : { data: { ...(data[0] as any ?? {}), id: "new-row-id", performed_by: ADMIN_USER_ID, created_at: new Date().toISOString() }, error: null });
      },
    };
    return b;
  }

  const storage: any = {
    from: () => ({ remove: () => Promise.resolve({ error: null }) }),
  };

  return {
    rpc: (name: string) => {
      if (
        name === "revoke_journey_consent_and_delete_segments"
        || name === "delete_journey_observations_for_user_v1"
        || name === "delete_journey_segments_for_user"
      ) {
        return Promise.resolve({ data: 0, error: null });
      }
      return Promise.resolve({
        data: null,
        error: { message: `unexpected RPC ${name}`, code: "PGRST202" },
      });
    },
    from: (table: string) => {
      if (table === "profiles")               return builder(table, profiles);
      if (table === "reports")                return builder(table, reports);
      if (table === "user_deletion_requests") return builder(table, deletionRequests);
      if (table === "user_account_states")    return builder(table, accountStates);
      if (table === "moderation_actions")     return builder(table, []);
      if (table === "trust_restrictions")     return builder(table, []);
      return builder(table, []);
    },
    storage,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
      // The deletion cascade removes the Supabase Auth user as a FATAL step —
      // without this stub the execute endpoint would (correctly) refuse to
      // mark the request completed.
      admin: {
        deleteUser: (_id: string) => Promise.resolve({ data: {}, error: null }),
      },
    },
  } as any;
}

function setClient(captureInserts: any[] = [], captureUpdates: any[] = [], extra: Partial<Parameters<typeof makeFakeClient>[0]> = {}) {
  const c = makeFakeClient({ captureInserts, captureUpdates, ...extra });
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

// ── Tests: user summary ───────────────────────────────────────────────────────

describe("GET /admin/users/:userId/summary", () => {
  it("returns profile + moderation context for admin", async () => {
    setClient();
    const { status, body } = await req("GET", `/admin/users/${TARGET_USER_ID}/summary`);
    assert.equal(status, 200);
    assert.ok(body.profile, "profile should be present");
    assert.ok(Array.isArray(body.accountStates), "accountStates should be array");
    assert.ok(Array.isArray(body.moderationActions), "moderationActions should be array");
    assert.ok(Array.isArray(body.reportsReceived), "reportsReceived should be array");
  });
});

// ── Tests: verify / unverify ──────────────────────────────────────────────────

describe("POST /admin/users/:userId/verify", () => {
  it("returns verified: true and writes audit log", async () => {
    const inserts: any[] = [];
    setClient(inserts);
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/verify`, { reason: "legit account" });
    assert.equal(status, 200);
    assert.equal(body.verified, true);
    const auditInsert = inserts.find((i) => i.table === "moderation_actions");
    assert.ok(auditInsert, "should insert moderation_actions row");
    assert.equal(auditInsert.data.action_type, "verify");
  });
});

describe("POST /admin/users/:userId/unverify", () => {
  it("returns verified: false", async () => {
    setClient();
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/unverify`);
    assert.equal(status, 200);
    assert.equal(body.verified, false);
  });
});

// ── Tests: warn ───────────────────────────────────────────────────────────────

describe("POST /admin/users/:userId/warn", () => {
  it("creates a warn moderation_action and returns 201", async () => {
    setClient();
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/warn`, { reason: "repeated spam" });
    assert.equal(status, 201);
    assert.ok(body.action, "should return the action row");
  });

  // For `warn`, the moderation_actions row IS the entire effect — there is no
  // separate state change to fall back on. If that write fails and the endpoint
  // still answers 2xx, an operator sees a warning they believe was recorded and
  // nothing exists. Now that this is a button in the admin UI rather than a
  // hand-crafted request, that is a believable mistake to make.
  it("fails loudly when the moderation_actions write fails — never reports a warn it did not record", async () => {
    const inserts: any[] = [];
    setClient(inserts, [], { failInsertsOn: "moderation_actions" });
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/warn`, { reason: "repeated spam" });

    assert.notEqual(status, 201, "must not report success when nothing was logged");
    assert.equal(status, 500, `expected 500, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      String(body?.message ?? "").toLowerCase().includes("audit"),
      `error should name the audit write; got ${JSON.stringify(body)}`,
    );
  });
});

// ── Tests: restrict / suspend / ban / restore ─────────────────────────────────

describe("POST /admin/users/:userId/restrict", () => {
  it("returns restricted: true", async () => {
    setClient();
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/restrict`, { reason: "too many reports" });
    assert.equal(status, 200);
    assert.equal(body.restricted, true);
  });
});

describe("POST /admin/users/:userId/suspend", () => {
  it("returns suspended: true and updates account_status", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/suspend`, { reason: "tos violation", expires_at: null });
    assert.equal(status, 200);
    assert.equal(body.suspended, true);
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles table");
    assert.equal(profileUpdate.data.account_status, "suspended");
  });
});

describe("POST /admin/users/:userId/ban", () => {
  it("returns banned: true and sets account_status=banned", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/ban`, { reason: "egregious violation" });
    assert.equal(status, 200);
    assert.equal(body.banned, true);
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles table");
    assert.equal(profileUpdate.data.account_status, "banned");
  });
});

describe("POST /admin/users/:userId/restore", () => {
  it("returns restored: true and resets account_status=active", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("POST", `/admin/users/${TARGET_USER_ID}/restore`, { reason: "appeal approved" });
    assert.equal(status, 200);
    assert.equal(body.restored, true);
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles table");
    assert.equal(profileUpdate.data.account_status, "active");
  });
});

// ── Tests: admin media deletion ───────────────────────────────────────────────

describe("DELETE /admin/users/:userId/avatar", () => {
  it("nulls avatar_url and returns ok", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("DELETE", `/admin/users/${TARGET_USER_ID}/avatar`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles");
    assert.strictEqual(profileUpdate.data.avatar_url, null);
  });
});

describe("DELETE /admin/users/:userId/cover", () => {
  it("nulls cover_photo_url and returns ok", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("DELETE", `/admin/users/${TARGET_USER_ID}/cover`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles");
    assert.strictEqual(profileUpdate.data.cover_photo_url, null);
  });
});

// ── Tests: report admin routes ────────────────────────────────────────────────

describe("GET /admin/reports", () => {
  it("returns paginated report list", async () => {
    setClient();
    const { status, body } = await req("GET", "/admin/reports?status=open&page=1&limit=10");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reports), "should return reports array");
    assert.ok(typeof body.total === "number", "should return total count");
  });
});

describe("POST /admin/reports/:id/resolve", () => {
  it("marks report resolved and returns updated row", async () => {
    setClient();
    const { status, body } = await req("POST", `/admin/reports/${REPORT_ID}/resolve`, {
      action: "warned_user",
      notes: "User was warned and agreed to comply.",
    });
    assert.equal(status, 200);
    assert.ok(body.report, "should return report row");
  });

  it("returns 400 if action field is missing", async () => {
    setClient();
    const { status } = await req("POST", `/admin/reports/${REPORT_ID}/resolve`, {});
    assert.equal(status, 400);
  });
});

describe("POST /admin/reports/:id/dismiss", () => {
  it("marks report dismissed", async () => {
    setClient();
    const { status, body } = await req("POST", `/admin/reports/${REPORT_ID}/dismiss`, {
      notes: "Report was not actionable.",
    });
    assert.equal(status, 200);
    assert.ok(body.report, "should return report row");
  });
});

// ── Tests: deletion queue ─────────────────────────────────────────────────────

describe("GET /admin/deletion-requests", () => {
  it("returns pending deletion requests", async () => {
    setClient();
    const { status, body } = await req("GET", "/admin/deletion-requests");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.requests), "should return requests array");
    assert.ok(typeof body.total === "number");
  });
});

describe("POST /admin/deletion-requests/:id/execute", () => {
  it("anonymises user data and marks request executed", async () => {
    const updates: any[] = [];
    setClient([], updates);
    const { status, body } = await req("POST", `/admin/deletion-requests/${DELETION_REQ_ID}/execute`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.executedAt, "should return executedAt timestamp");
    const profileUpdate = updates.find((u) => u.table === "profiles");
    assert.ok(profileUpdate, "should update profiles");
    assert.equal(profileUpdate.data.account_status, "deleted");
    assert.strictEqual(profileUpdate.data.avatar_url, null);
    assert.match(profileUpdate.data.handle, /^deleted_[a-f0-9]{22}$/);
    const requestUpdate = updates.find(
      (u) => u.table === "user_deletion_requests" && u.data.status === "executed",
    );
    assert.equal(requestUpdate?.data.status, "executed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Admin role guard — non-admin caller gets 403 (profiles.role check)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Admin routes — non-admin caller gets 403 (uses profiles.role, not is_admin)", () => {
  it("caller with role='user' gets 403 on suspend", async () => {
    // ADMIN_USER_ID profile has role='user' → requireAdmin must reject
    setClient([], [], {
      profiles: [
        { id: ADMIN_USER_ID, role: "user" },
        { id: TARGET_USER_ID, role: "user", account_status: "active" },
      ],
    });
    const r = await req("POST", `/admin/users/${TARGET_USER_ID}/suspend`, { reason: "test", expires_in_days: 7 });
    assert.equal(r.status, 403, "non-admin must get 403");
    assert.equal(r.body.error, "forbidden", "error code must be 'forbidden'");
  });

  it("caller with role='user' gets 403 on ban", async () => {
    setClient([], [], {
      profiles: [
        { id: ADMIN_USER_ID, role: "user" },
        { id: TARGET_USER_ID, role: "user", account_status: "active" },
      ],
    });
    const r = await req("POST", `/admin/users/${TARGET_USER_ID}/ban`, { reason: "test" });
    assert.equal(r.status, 403, "non-admin must get 403 on ban");
    assert.equal(r.body.error, "forbidden");
  });

  it("caller with role='moderator' (not 'admin') also gets 403", async () => {
    setClient([], [], {
      profiles: [
        { id: ADMIN_USER_ID, role: "moderator" },
        { id: TARGET_USER_ID, role: "user", account_status: "active" },
      ],
    });
    const r = await req("POST", `/admin/users/${TARGET_USER_ID}/suspend`, { reason: "test", expires_in_days: 1 });
    assert.equal(r.status, 403, "moderator role must not pass admin guard");
  });
});
