/**
 * Admin moderation action audit-log tests (Phase 7)
 *
 * Routes under test (artifacts/api-server/src/routes/admin.ts):
 *   PATCH /admin/users/:userId/moderation-action
 *   GET   /admin/users/:userId/moderation-summary
 *
 * Key invariant: EVERY admin moderation action must write an audit-log row to
 * the moderation_actions table. This file proves that invariant for all 13
 * action_type values.
 *
 * Run: node --import tsx/esm --test src/test/adminModeration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";

// ── Test server ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const FAKE_TOKEN = "fake.jwt.token";
const TARGET_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ADMIN_USER_ID  = "bbbbbbbb-0000-0000-0000-000000000002";
const REPORT_ID      = "cccccccc-0000-0000-0000-000000000003";

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

// ── Fake client builder ────────────────────────────────────────────────────────

/**
 * Returns a fake Supabase client that captures insert calls to moderation_actions
 * so tests can assert audit rows were written.
 */
function makeFakeClient(opts: {
  role?: string;
  captureAuditInserts?: any[];
  profiles?: Record<string, unknown>[];
  accountStates?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
  modActions?: Record<string, unknown>[];
}) {
  const {
    role = "admin",
    captureAuditInserts = [],
    profiles = [{ id: TARGET_USER_ID, handle: "target", name: "Target User", avatar_url: null, role: "user", verification_status: null, created_at: new Date().toISOString() }],
    accountStates = [],
    reports = [],
    modActions = [],
  } = opts;

  function builder(table: string, rows: unknown[]) {
    let _rows = [...rows];
    const b: any = {
      select:      () => b,
      insert:      (data: any) => {
        if (table === "moderation_actions") captureAuditInserts.push(data);
        _rows = Array.isArray(data) ? data : [data];
        return b;
      },
      update:      (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return b; },
      upsert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      delete:      () => { _rows = []; return b; },
      eq:          (_col: string, _val: any) => b,
      neq:         () => b,
      is:          () => b,
      ilike:       () => b,
      not:         () => b,
      in:          () => b,
      or:          () => b,
      gt:          () => b,
      order:       () => b,
      limit:       () => b,
      range:       () => b,
      then:        (resolve: any) => Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve),
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: { ...(_rows[0] as any), id: "new-audit-id", target_user_id: TARGET_USER_ID, performed_by: ADMIN_USER_ID, created_at: new Date().toISOString() }, error: null }),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") {
        if (profiles.some((p: any) => p.id === ADMIN_USER_ID || p.id === TARGET_USER_ID)) {
          return builder(table, profiles);
        }
        return builder(table, [{ id: ADMIN_USER_ID, role }]);
      }
      if (table === "user_account_states")    return builder(table, accountStates);
      if (table === "moderation_actions")     return builder(table, modActions);
      if (table === "reports")                return builder(table, reports);
      return builder(table, []);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
  } as any;
}

const DEFAULT_ADMIN_PROFILES = [
  { id: ADMIN_USER_ID, role: "admin" },
  { id: TARGET_USER_ID, handle: "target", name: "Target User", avatar_url: null, role: "user", verification_status: null, created_at: new Date().toISOString() },
];

function setAdminClient(captureAuditInserts: any[] = [], extra: Partial<Parameters<typeof makeFakeClient>[0]> = {}) {
  const c = makeFakeClient({
    role: "admin",
    captureAuditInserts,
    profiles: DEFAULT_ADMIN_PROFILES,
    ...extra,
  });
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Server setup ───────────────────────────────────────────────────────────────

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

// ── Tests: every action writes an audit-log row ───────────────────────────────

const ACTION_TYPES = [
  "warn",
  "message_limit",
  "invite_limit",
  "hosting_limit",
  "discovery_hidden",
  "rent_a_buddy_frozen",
  "temporary_suspension",
  "permanent_ban",
  "report_resolved",
  "content_removed",
  "event_removed",
  "circle_removed",
  "booking_frozen",
] as const;

describe("PATCH /admin/users/:userId/moderation-action — every action writes audit log", () => {
  for (const actionType of ACTION_TYPES) {
    it(`action_type '${actionType}' writes moderation_actions audit row`, async () => {
      const captured: any[] = [];
      setAdminClient(captured, {
        profiles: [
          { id: ADMIN_USER_ID, role: "admin" },
          { id: TARGET_USER_ID, handle: "target", role: "user" },
        ],
        reports: [{ id: REPORT_ID, status: "open" }],
      });

      const body: Record<string, unknown> = { action_type: actionType, reason: `Test: ${actionType}` };
      if (actionType === "temporary_suspension") body.expires_at = new Date(Date.now() + 86400000).toISOString();
      if (actionType === "report_resolved") body.target_ref_id = REPORT_ID;

      const { status, body: resp } = await req("PATCH", `/admin/users/${TARGET_USER_ID}/moderation-action`, body);

      assert.equal(status, 200, `Expected 200 for action '${actionType}', got ${status}: ${JSON.stringify(resp)}`);

      // Core invariant: at least one insert to moderation_actions was captured
      assert.ok(
        captured.length >= 1,
        `Expected audit insert for action '${actionType}', captured: ${JSON.stringify(captured)}`,
      );

      const auditRow = captured[0];
      assert.equal(auditRow.action_type, actionType, "audit row action_type must match requested action");
      assert.equal(auditRow.target_user_id, TARGET_USER_ID, "audit row target_user_id must match");
      assert.equal(auditRow.performed_by, ADMIN_USER_ID, "audit row performed_by must be the admin");
      assert.ok(auditRow.reason, "audit row should have the reason field");

      // Response must contain the audit action
      assert.ok(resp.action, "response must include action object");
    });
  }
});

describe("PATCH /admin/users/:userId/moderation-action — validation", () => {
  it("returns 400 for unknown action_type", async () => {
    setAdminClient();
    const { status, body } = await req("PATCH", `/admin/users/${TARGET_USER_ID}/moderation-action`, {
      action_type: "nuke_account",
      reason: "test",
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });

  it("returns 403 for non-admin users", async () => {
    const c = makeFakeClient({ role: "user" });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const { status, body } = await req("PATCH", `/admin/users/${TARGET_USER_ID}/moderation-action`, {
      action_type: "warn",
      reason: "test",
    });
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });
});

describe("GET /admin/users/:userId/moderation-summary — returns full moderation profile", () => {
  it("returns summary with all sections for an existing user", async () => {
    setAdminClient([], {
      profiles: [
        { id: ADMIN_USER_ID, role: "admin" },
        { id: TARGET_USER_ID, handle: "target", name: "Target User", avatar_url: null, role: "user", verification_status: null, created_at: new Date().toISOString() },
      ],
      modActions: [{ id: "act1", action_type: "warn", reason: "spamming", performed_by: ADMIN_USER_ID, created_at: new Date().toISOString() }],
    });

    const { status, body } = await req("GET", `/admin/users/${TARGET_USER_ID}/moderation-summary`);
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.profile, "response must have profile");
    assert.ok(Array.isArray(body.moderationActions), "moderationActions must be an array");
    assert.ok(Array.isArray(body.accountStates), "accountStates must be an array");
    assert.ok(Array.isArray(body.reportsReceived), "reportsReceived must be an array");
    assert.ok(Array.isArray(body.reportsFiled), "reportsFiled must be an array");
  });

  it("returns 403 for non-admin users", async () => {
    const c = makeFakeClient({ role: "user" });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const { status, body } = await req("GET", `/admin/users/${TARGET_USER_ID}/moderation-summary`);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });
});
