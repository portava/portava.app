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
  moderationReports?: Record<string, unknown>[];
  places?: Record<string, unknown>[];
}) {
  const {
    role = "admin",
    captureAuditInserts = [],
    profiles = [{ id: TARGET_USER_ID, handle: "target", name: "Target User", avatar_url: null, role: "user", verification_status: null, created_at: new Date().toISOString() }],
    accountStates = [],
    reports = [],
    modActions = [],
    moderationReports = [],
    places = [],
  } = opts;

  function builder(table: string, rows: unknown[]) {
    let _rows = [...rows];
    let _eqFilters: Record<string, any> = {};
    let _inFilter: { col: string; vals: any[] } | null = null;
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
      eq:          (col: string, val: any) => { _eqFilters[col] = val; return b; },
      neq:         () => b,
      is:          () => b,
      ilike:       () => b,
      not:         () => b,
      in:          (col: string, vals: any[]) => { _inFilter = { col, vals }; return b; },
      or:          () => b,
      gt:          () => b,
      order:       () => b,
      limit:       () => b,
      range:       () => b,
      then:        (resolve: any) => {
        let result = [..._rows];
        for (const [col, val] of Object.entries(_eqFilters)) {
          result = result.filter((r: any) => r[col] === val);
        }
        if (_inFilter) {
          const { col, vals } = _inFilter;
          result = result.filter((r: any) => vals.includes(r[col]));
        }
        return Promise.resolve({ data: result, error: null, count: result.length }).then(resolve);
      },
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
      if (table === "moderation_reports")     return builder(table, moderationReports);
      if (table === "places")                 return builder(table, places);
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
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

// ── Tests: GET /admin/moderation/reports ──────────────────────────────────────

const PLACE_ID = "dddddddd-1111-0000-0000-000000000001";

describe("GET /admin/moderation/reports — place reports in the moderation queue", () => {
  it("returns 403 for non-admin users", async () => {
    const c = makeFakeClient({ role: "user" });
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const { status, body } = await req("GET", "/admin/moderation/reports");
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("returns empty list when no reports exist", async () => {
    setAdminClient([], { moderationReports: [] });
    const { status, body } = await req("GET", "/admin/moderation/reports");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.reports), "reports must be an array");
    assert.equal(body.reports.length, 0);
    assert.equal(body.total, 0);
  });

  it("returns place reports when subject_type filter is 'place'", async () => {
    setAdminClient([], {
      moderationReports: [
        { id: "rep-place-1", subject_type: "place", subject_id: PLACE_ID, category: "wrong_photo", status: "open", created_at: new Date().toISOString() },
        { id: "rep-user-1",  subject_type: "user",  subject_id: TARGET_USER_ID, category: "spam", status: "open", created_at: new Date().toISOString() },
      ],
    });
    const { status, body } = await req("GET", "/admin/moderation/reports?subject_type=place");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.reports));
    assert.ok(body.reports.every((r: any) => r.subject_type === "place"), "only place reports should be returned");
  });

  it("returns all report types when subject_type is 'all'", async () => {
    setAdminClient([], {
      moderationReports: [
        { id: "rep-place-1", subject_type: "place", subject_id: PLACE_ID, category: "closed",    status: "open", created_at: new Date().toISOString() },
        { id: "rep-user-1",  subject_type: "user",  subject_id: TARGET_USER_ID, category: "spam", status: "open", created_at: new Date().toISOString() },
      ],
    });
    const { status, body } = await req("GET", "/admin/moderation/reports?subject_type=all");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.reports));
    assert.equal(body.reports.length, 2, "all report types should be returned");
  });

  it("enriches place reports with place_name and place_address from the places table", async () => {
    setAdminClient([], {
      moderationReports: [
        { id: "rep-place-1", subject_type: "place", subject_id: PLACE_ID, category: "wrong_photo", status: "open", created_at: new Date().toISOString() },
      ],
      places: [
        { id: PLACE_ID, name: "The Grand Café", address: "1 Main St, Paris" },
      ],
    });
    const { status, body } = await req("GET", "/admin/moderation/reports?subject_type=place");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.reports.length, 1);
    const report = body.reports[0];
    assert.equal(report.place_name, "The Grand Café", "place_name must be resolved from places table");
    assert.equal(report.place_address, "1 Main St, Paris", "place_address must be resolved from places table");
  });

  it("sets place_name/place_address to null when the place row is not found", async () => {
    setAdminClient([], {
      moderationReports: [
        { id: "rep-place-2", subject_type: "place", subject_id: PLACE_ID, category: "duplicate", status: "open", created_at: new Date().toISOString() },
      ],
      places: [], // no places in DB
    });
    const { status, body } = await req("GET", "/admin/moderation/reports?subject_type=place");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.reports.length, 1);
    assert.strictEqual(body.reports[0].place_name, null, "place_name should be null when place not found");
    assert.strictEqual(body.reports[0].place_address, null, "place_address should be null when place not found");
  });

  it("does not add place_name/place_address fields to non-place reports", async () => {
    setAdminClient([], {
      moderationReports: [
        { id: "rep-user-1", subject_type: "user", subject_id: TARGET_USER_ID, category: "harassment", status: "open", created_at: new Date().toISOString() },
      ],
    });
    const { status, body } = await req("GET", "/admin/moderation/reports");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.reports.length, 1);
    assert.ok(!("place_name" in body.reports[0]), "non-place reports must not have place_name");
  });
});
