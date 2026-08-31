/**
 * Reports route tests
 *
 * Tests POST /reports (all target types), GET /reports/:id, and the
 * admin GET /admin/reports endpoint WITHOUT a live database.
 * Uses the node:test + fake-client pattern.
 *
 * Run: node --import tsx/esm --test src/test/reports.test.ts
 *
 * NOTE: All suites live inside one outer describe so node:test runs them
 * sequentially (top-level describes run in parallel by default, which would
 * race on the shared _setTestClient global).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import reportsRouter from "../routes/reports.js";
// GET /admin/reports lives in routes/admin.ts, not routes/reports.ts — it moved
// and this harness was never updated, so the four "GET /admin/reports" cases
// below asserted against a route the test app had never mounted and every one
// of them 404'd. Mounted here so they exercise the real handler and its guard.
import adminRouter from "../routes/admin.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const USER_A_TOKEN  = "reports-token-a";
const USER_B_TOKEN  = "reports-token-b";
const USER_C_TOKEN  = "reports-token-c";
const USER_D_TOKEN  = "reports-token-d";
const USER_E_TOKEN  = "reports-token-e";
const ADMIN_TOKEN   = "reports-admin-token";
const USER_A_ID     = "aaaaaaaa-0001-0002-0003-aaaaaaaaa001";
const USER_B_ID     = "bbbbbbbb-0001-0002-0003-bbbbbbbb0001";
const USER_C_ID     = "cccccccc-0001-0002-0003-cccccccc0001";
const USER_D_ID     = "dddddddd-0001-0002-0003-dddddddd0001";
const USER_E_ID     = "eeeeeeee-0001-0002-0003-eeeeeeee0001";
const ADMIN_ID      = "ffffffff-0001-0002-0003-ffffffff0001";

const TARGET_ID     = "11111111-0001-0002-0003-111111110001";
const REPORT_ID     = "22222222-0001-0002-0003-222222220001";
const POST_ID       = "33333333-0001-0002-0003-333333330001";
const MSG_ID        = "44444444-0001-0002-0003-444444440001";
const TRIP_ID       = "55555555-0001-0002-0003-555555550001";
const EVENT_ID      = "66666666-0001-0002-0003-666666660001";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = USER_A_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    };
    const r = http.request(
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
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client builder ───────────────────────────────────────────────────────

interface FakeState {
  reports?:                    Record<string, any>[];
  profiles?:                   Record<string, any>[];
  blocks?:                     Record<string, any>[];
  user_account_states?:        Record<string, any>[];
  user_restrictions?:          Record<string, any>[];
  user_interaction_cooldowns?: Record<string, any>[];
  report_evidence?:            Record<string, any>[];
  posts?:                      Record<string, any>[];
  trips?:                      Record<string, any>[];
  moderation_actions?:         Record<string, any>[];
}

function makeFakeClient(
  state: FakeState,
  callerToken: string,
  callerId: string,
  upsertErrors: Record<string, { message: string }> = {},
) {
  const inserted: Record<string, any[]> = {};

  function getRows(table: string): any[] {
    if (table === "reports")                    return (state.reports ?? []).map((r) => ({ ...r }));
    if (table === "profiles")                   return (state.profiles ?? []).map((r) => ({ ...r }));
    if (table === "blocks")                     return (state.blocks ?? []).map((r) => ({ ...r }));
    if (table === "user_account_states")        return (state.user_account_states ?? []).map((r) => ({ ...r }));
    if (table === "user_restrictions")          return (state.user_restrictions ?? []).map((r) => ({ ...r }));
    if (table === "user_interaction_cooldowns") return (state.user_interaction_cooldowns ?? []).map((r) => ({ ...r }));
    if (table === "report_evidence")            return (state.report_evidence ?? []).map((r) => ({ ...r }));
    if (table === "posts")                      return (state.posts ?? []).map((r) => ({ ...r }));
    if (table === "trips")                      return (state.trips ?? []).map((r) => ({ ...r }));
    if (table === "moderation_actions")         return (state.moderation_actions ?? []).map((r) => ({ ...r }));
    return [];
  }

  function builder(table: string) {
    let rows = getRows(table);
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingUpsertError: { message: string } | null = null;
    const filters: Array<(r: any) => boolean> = [];
    let _single = false;
    let _maybe  = false;

    const b: any = {
      select(_cols?: string, _opts?: any) { return b; },
      insert(row: any) {
        pendingInsert = row;
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push({ ...row });
        return b;
      },
      update(patch: any) { pendingUpdate = patch; return b; },
      upsert(row: any, _opts?: any) {
        // Injected failure: simulate a DB error on the upsert for this table
        // (real PostgREST would insert nothing), so tests can prove the handler
        // checks the result instead of swallowing it.
        if (upsertErrors[table]) { pendingUpsertError = upsertErrors[table]; return b; }
        if (!inserted[table]) inserted[table] = [];
        if (Array.isArray(row)) inserted[table].push(...row);
        else inserted[table].push({ ...row });
        return b;
      },
      delete() { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      or(_filter: string)          { return b; },
      order()                      { return b; },
      limit(_n: number)            { return b; },
      range()                      { return b; },
      maybeSingle() { _maybe = true; _single = true; return resolve(); },
      single()      { _single = true; return resolve(); },
      then(onF: any, onR: any)     { return resolveList().then(onF, onR); },
    };

    async function resolve() {
      if (pendingUpsertError) return { data: null, error: pendingUpsertError };
      if (pendingInsert) {
        const base = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        const row = { id: `gen-${table}-${Math.random().toString(36).slice(2)}`, status: "open", severity: "normal", ...base };
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        const row = matched[0] ? { ...matched[0], ...pendingUpdate } : null;
        return { data: row, error: null };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (_maybe) return { data: matched[0] ?? null, error: null };
      return { data: matched[0] ?? null, error: null };
    }

    async function resolveList() {
      if (pendingUpsertError) return { data: null, error: pendingUpsertError, count: 0 };
      if (pendingInsert) {
        const base = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
        const row = { id: `gen-${table}-${Math.random().toString(36).slice(2)}`, status: "open", severity: "normal", ...base };
        return { data: [row], error: null, count: 1 };
      }
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      return { data: matched, error: null, count: matched.length };
    }

    return b;
  }

  const client: any = {
    from: (table: string) => builder(table),
    auth: {
      getUser: async (token: string) => {
        if (token === callerToken) return { data: { user: { id: callerId } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    __inserted: inserted,
  };
  return client;
}

function makeAdminClient() {
  const state: FakeState = {
    reports: [{
      id: REPORT_ID, reporter_id: USER_A_ID, target_type: "post", target_id: POST_ID,
      reason_code: "spam", severity: "normal", status: "open", created_at: new Date().toISOString(),
    }],
    profiles: [{ id: ADMIN_ID, role: "admin", is_private: false }],
  };
  return makeFakeClient(state, ADMIN_TOKEN, ADMIN_ID);
}

function setClients(c: any) {
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(() => new Promise<void>((resolve) => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/", reportsRouter);
  // reports.ts only declares /reports, /reports/:id and /me/reports, so nothing
  // here shadows /admin/reports.
  app.use("/", adminRouter);
  server = app.listen(0, "127.0.0.1", () => {
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    resolve();
  });
}));

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  server.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reports routes", () => {

  describe("POST /reports — content target types", () => {
    it("1a. post report accepted with target_type=post", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "spam" }, USER_A_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId, "response must include reportId");
      assert.equal(r.body.status, "open");
    });

    it("1b. message report accepted with target_type=message", async () => {
      setClients(makeFakeClient({}, USER_B_TOKEN, USER_B_ID));
      const r = await req("POST", "/reports", { target_type: "message", target_id: MSG_ID, reason_code: "harassment" }, USER_B_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1c. trip report accepted with target_type=trip", async () => {
      setClients(makeFakeClient({}, USER_C_TOKEN, USER_C_ID));
      const r = await req("POST", "/reports", { target_type: "trip", target_id: TRIP_ID, reason_code: "misinformation" }, USER_C_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1d. event report accepted with target_type=event", async () => {
      setClients(makeFakeClient({}, USER_D_TOKEN, USER_D_ID));
      const r = await req("POST", "/reports", { target_type: "event", target_id: EVENT_ID, reason_code: "spam" }, USER_D_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1e. place report accepted with target_type=place", async () => {
      const placeId = "77777777-0001-0002-0003-777777770001";
      setClients(makeFakeClient({}, USER_E_TOKEN, USER_E_ID));
      const r = await req("POST", "/reports", { target_type: "place", target_id: placeId, reason_code: "other" }, USER_E_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1i. thread report accepted with target_type=thread", async () => {
      const threadId = "88888888-0001-0002-0003-888888880001";
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "thread", target_id: threadId, reason_code: "harassment" }, USER_A_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1j. profile report accepted with target_type=profile (requires reason_detail)", async () => {
      // target_type=profile is how buddy profile reports are submitted —
      // "buddy" is not a separate target_type; it maps to profile/user.
      // profile reports require a non-empty reason_detail.
      setClients(makeFakeClient({}, USER_B_TOKEN, USER_B_ID));
      const r = await req("POST", "/reports", {
        target_type: "profile", target_id: TARGET_ID,
        reason_code: "impersonation", reason_detail: "This account is impersonating a travel influencer",
      }, USER_B_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.reportId);
    });

    it("1f. severity=high for harassment reason_code", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "harassment" }, USER_A_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "high");
    });

    it("1g. severity=high for hate_speech reason_code", async () => {
      setClients(makeFakeClient({}, USER_B_TOKEN, USER_B_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "hate_speech" }, USER_B_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "high");
    });

    it("1h. severity=normal for spam reason_code", async () => {
      setClients(makeFakeClient({}, USER_C_TOKEN, USER_C_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "spam" }, USER_C_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "normal");
    });
  });

  describe("POST /reports — validation", () => {
    it("2a. self-report returns 400 invalid_payload", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "user", target_id: USER_A_ID, reason_code: "spam" }, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("2b. non-UUID target_id returns 400", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: "not-a-uuid", reason_code: "spam" }, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("2c. invalid reason_code returns 400", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "nonsense_reason" }, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("2d. invalid target_type returns 400", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "widget", target_id: POST_ID, reason_code: "spam" }, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("2e. profile report without reason_detail returns 400", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "profile", target_id: TARGET_ID, reason_code: "impersonation" }, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("2f. unauthenticated request returns 401", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", { target_type: "post", target_id: POST_ID, reason_code: "spam" }, "bad-token");
      assert.equal(r.status, 401);
    });
  });

  describe("POST /reports — user target (permission engine)", () => {
    it("3a. high-severity user report accepted (violence reason_code)", async () => {
      // Use is_private: true so the permission engine hits the priority-6 gate
      // (canViewProfile=false) and returns early with canReport: true, without
      // reaching context-queries that would need additional table stubs.
      setClients(makeFakeClient({
        blocks:   [],
        profiles: [{ id: TARGET_ID, is_private: true }],
      }, USER_D_TOKEN, USER_D_ID));
      const r = await req("POST", "/reports", { target_type: "user", target_id: TARGET_ID, reason_code: "violence" }, USER_D_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "high");
      assert.ok(r.body.reportId);
    });

    it("3b. normal-severity user report accepted (spam reason_code)", async () => {
      setClients(makeFakeClient({
        blocks:   [],
        profiles: [{ id: TARGET_ID, is_private: true }],
      }, USER_E_TOKEN, USER_E_ID));
      const r = await req("POST", "/reports", { target_type: "user", target_id: TARGET_ID, reason_code: "spam" }, USER_E_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "normal");
    });
  });

  // ── REPORT-1: 'profile' and 'user' address the same subject ────────────────
  // A 'profile' target is the same id space as a 'user' target, so every
  // user-subject guard must treat them alike. Before the fix a 'profile' report
  // slipped past the self-report guard and never triggered reporter protection.
  describe("POST /reports — profile/user normalization (REPORT-1)", () => {
    it("R1a. reporting your OWN profile via target_type=profile is blocked", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("POST", "/reports", {
        target_type: "profile", target_id: USER_A_ID,
        reason_code: "harassment", reason_detail: "self-report attempt routed through profile",
      }, USER_A_TOKEN);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, "invalid_payload");
      assert.match(r.body.message, /yourself/i);
    });

    it("R1b. high-severity profile report protects the reporter (restriction + cooldowns)", async () => {
      // 'profile' does not run the permission engine, so empty state is enough.
      const client = makeFakeClient({}, USER_D_TOKEN, USER_D_ID);
      setClients(client);
      const r = await req("POST", "/reports", {
        target_type: "profile", target_id: TARGET_ID,
        reason_code: "harassment", reason_detail: "abusive profile content",
      }, USER_D_TOKEN);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.severity, "high");
      assert.equal(r.body.protectionApplied, true);

      const restrictions = client.__inserted.user_restrictions ?? [];
      assert.equal(restrictions.length, 1, "auto-restrict must be written for a profile high-severity report");
      assert.equal(restrictions[0].restrictor_id, USER_D_ID);
      assert.equal(restrictions[0].restricted_id, TARGET_ID);

      const cooldowns = client.__inserted.user_interaction_cooldowns ?? [];
      assert.equal(cooldowns.length, 2, "both anti-retaliation cooldowns must be written");
      assert.ok(cooldowns.every((c: any) => c.user_id === TARGET_ID && c.target_user_id === USER_D_ID));
    });

    it("R1c. a failed protection upsert is surfaced (protectionApplied=false), not swallowed", async () => {
      const client = makeFakeClient(
        { blocks: [], profiles: [{ id: TARGET_ID, is_private: true }] },
        USER_E_TOKEN, USER_E_ID,
        { user_restrictions: { message: "unique or fk violation" } },
      );
      setClients(client);
      const r = await req("POST", "/reports", {
        target_type: "user", target_id: TARGET_ID, reason_code: "violence",
      }, USER_E_TOKEN);
      // The report itself still succeeds; the protection failure must be reported.
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.protectionApplied, false,
        "a failed protection upsert must be reported, not silently discarded");
    });
  });

  describe("GET /reports/:id", () => {
    it("4a. returns own report by ID", async () => {
      const now = new Date().toISOString();
      setClients(makeFakeClient({
        reports: [{
          id: REPORT_ID, reporter_id: USER_A_ID, target_type: "post", target_id: POST_ID,
          reason_code: "spam", reason_detail: null, severity: "normal", status: "open", created_at: now,
        }],
      }, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", `/reports/${REPORT_ID}`, undefined, USER_A_TOKEN);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.id, REPORT_ID);
      assert.equal(r.body.target_type, "post");
      assert.equal(r.body.reason_code, "spam");
    });

    it("4b. returns 404 for non-existent report", async () => {
      setClients(makeFakeClient({ reports: [] }, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", `/reports/${REPORT_ID}`, undefined, USER_A_TOKEN);
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "not_found");
    });

    it("4c. returns 404 when report belongs to a different user", async () => {
      setClients(makeFakeClient({
        reports: [{
          id: REPORT_ID, reporter_id: USER_B_ID, target_type: "post", target_id: POST_ID,
          reason_code: "spam", severity: "normal", status: "open", created_at: new Date().toISOString(),
        }],
      }, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", `/reports/${REPORT_ID}`, undefined, USER_A_TOKEN);
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "not_found");
    });

    it("4d. invalid report id returns 400", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", "/reports/not-a-uuid", undefined, USER_A_TOKEN);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
    });

    it("4e. unauthenticated returns 401", async () => {
      setClients(makeFakeClient({}, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", `/reports/${REPORT_ID}`, undefined, "bad-token");
      assert.equal(r.status, 401);
    });
  });

  describe("GET /admin/reports", () => {
    it("5a. non-admin user gets 403", async () => {
      setClients(makeFakeClient({ profiles: [{ id: USER_A_ID, role: "user" }], reports: [] }, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", "/admin/reports", undefined, USER_A_TOKEN);
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "forbidden");
    });

    it("5b. user with no profile record gets 403", async () => {
      setClients(makeFakeClient({ profiles: [], reports: [] }, USER_A_TOKEN, USER_A_ID));
      const r = await req("GET", "/admin/reports", undefined, USER_A_TOKEN);
      assert.equal(r.status, 403);
    });

    it("5c. admin user gets 200 with report list", async () => {
      setClients(makeAdminClient());
      const r = await req("GET", "/admin/reports", undefined, ADMIN_TOKEN);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(Array.isArray(r.body.reports), "response must have reports array");
    });

    it("5d. unauthenticated returns 401", async () => {
      setClients(makeAdminClient());
      const r = await req("GET", "/admin/reports", undefined, "bad-token");
      assert.equal(r.status, 401);
    });
  });

  // ── 6. Resolving / dismissing reports — the audit target ────────────────────
  //
  // moderation_actions.target_user_id is NOT NULL REFERENCES profiles(id)
  // (confirmed live). Resolve and dismiss used to pass reports.target_id
  // straight in, so for any report whose target was NOT a user the insert
  // violated the FK, the fail-closed audit aborted, and the endpoint 500'd
  // before the report could be resolved.
  //
  // These tests use a POST report on purpose. A user report would pass against
  // the broken code — target_id IS a profile id in that case — so it would
  // prove nothing. The post case is the one that was broken.

  describe("POST /admin/reports/:id/resolve — audit target", () => {
    const POST_AUTHOR_ID = USER_C_ID;

    function makeResolveClient(targetType: string, targetId: string) {
      return makeFakeClient({
        profiles: [{ id: ADMIN_ID, role: "admin", is_private: false }],
        reports: [{
          id: REPORT_ID, reporter_id: USER_A_ID,
          target_type: targetType, target_id: targetId,
          reason_code: "spam", severity: "normal", status: "open",
          created_at: new Date().toISOString(),
        }],
        posts: [{ id: POST_ID, author_id: POST_AUTHOR_ID }],
        trips: [{ id: TRIP_ID, owner_id: USER_D_ID }],
      }, ADMIN_TOKEN, ADMIN_ID);
    }

    it("6a. resolving a POST report succeeds and audits against the post AUTHOR, not the post id", async () => {
      const client = makeResolveClient("post", POST_ID);
      setClients(client);

      const r = await req("POST", `/admin/reports/${REPORT_ID}/resolve`,
        { action: "content_removed", notes: "spam" }, ADMIN_TOKEN);

      // Pre-fix this was 500 "Audit write failed" against a real database.
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.report.status, "resolved");
      assert.equal(r.body.audit, "recorded");

      const rows = client.__inserted.moderation_actions ?? [];
      assert.equal(rows.length, 1, "exactly one audit row");
      // The assertion that fails against the old code: it wrote POST_ID here.
      assert.equal(rows[0].target_user_id, POST_AUTHOR_ID,
        "target_user_id must be the post's author (a profile id), not the post id");
      assert.notEqual(rows[0].target_user_id, POST_ID);
    });

    it("6b. the audit row carries report_id and the content target in metadata", async () => {
      const client = makeResolveClient("post", POST_ID);
      setClients(client);

      await req("POST", `/admin/reports/${REPORT_ID}/resolve`,
        { action: "content_removed", notes: "spam" }, ADMIN_TOKEN);

      const meta = (client.__inserted.moderation_actions ?? [])[0]?.metadata;
      assert.ok(meta, "metadata must be written — it is the only place these fit");
      assert.equal(meta.report_id, REPORT_ID,
        "without report_id an action cannot be traced to the complaint that caused it");
      assert.equal(meta.target_type, "post");
      assert.equal(meta.target_id, POST_ID);
    });

    it("6c. a TRIP report audits against the trip owner", async () => {
      const client = makeResolveClient("trip", TRIP_ID);
      setClients(client);

      const r = await req("POST", `/admin/reports/${REPORT_ID}/resolve`,
        { action: "content_removed" }, ADMIN_TOKEN);

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = client.__inserted.moderation_actions ?? [];
      assert.equal(rows[0].target_user_id, USER_D_ID);
      assert.equal(rows[0].metadata.target_id, TRIP_ID);
    });

    it("6d. a USER report still audits against that user (unchanged behaviour)", async () => {
      const client = makeResolveClient("user", USER_B_ID);
      setClients(client);

      const r = await req("POST", `/admin/reports/${REPORT_ID}/resolve`,
        { action: "warn" }, ADMIN_TOKEN);

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = client.__inserted.moderation_actions ?? [];
      assert.equal(rows[0].target_user_id, USER_B_ID);
      assert.equal(rows[0].metadata.report_id, REPORT_ID);
    });

    it("6e. an unowned target (place) resolves without inventing a target user", async () => {
      const client = makeResolveClient("place", TARGET_ID);
      setClients(client);

      const r = await req("POST", `/admin/reports/${REPORT_ID}/resolve`,
        { action: "dismissed_no_action" }, ADMIN_TOKEN);

      // Places have no owner. The report must still be resolvable, and the
      // audit must not attribute the action to an arbitrary profile (the old
      // hide-content path used the acting admin's own id here).
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.audit, "skipped_no_owner");
      const rows = client.__inserted.moderation_actions ?? [];
      assert.equal(rows.length, 0, "no audit row rather than a fabricated target");
    });

    it("6f. dismissing a POST report audits against the author too", async () => {
      const client = makeResolveClient("post", POST_ID);
      setClients(client);

      const r = await req("POST", `/admin/reports/${REPORT_ID}/dismiss`,
        { notes: "not a violation" }, ADMIN_TOKEN);

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const rows = client.__inserted.moderation_actions ?? [];
      assert.equal(rows[0].target_user_id, POST_AUTHOR_ID);
      assert.equal(rows[0].action_type, "report_dismissed");
      assert.equal(rows[0].metadata.report_id, REPORT_ID);
    });
  });
});
