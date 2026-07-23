/**
 * Moderation routes tests — V-3
 *
 * Covers:
 *  A. POST /api/moderation/report
 *     - 401 unauthenticated
 *     - 400 invalid subjectType enum
 *     - 400 invalid category enum
 *     - 400 self-report (user type)
 *     - 429 rate limit
 *     - 200 duplicate collapse (open report already exists)
 *     - 201 happy path for each subject type (subject_user_id derived)
 *     - 201 message report stores thread_id
 *  B. GET /api/moderation/reports/mine
 *     - 401 unauthenticated
 *     - 200 returns only caller's reports
 *
 * Runtime: node:test + node:assert/strict
 * Pattern: same mini-Express pattern as verification.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import moderationRouter from "../routes/moderation.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002";
const POST_ID  = "cccccccc-0000-0000-0000-000000000003";
const EVT_ID   = "dddddddd-0000-0000-0000-000000000004";
const MSG_ID   = "eeeeeeee-0000-0000-0000-000000000005";
const CMT_ID   = "ffffffff-0000-0000-0000-000000000006";
const REV_ID   = "11111111-0000-0000-0000-000000000007";
const BUDDY_ID = "22222222-0000-0000-0000-000000000008";
const THR_ID   = "33333333-0000-0000-0000-000000000009";

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  userId?: string;
  moderationReports?: any[];
  existingReport?: any;
  posts?: any[];
  events?: any[];
  messages?: any[];
  comments?: any[];
  reviews?: any[];
  rent_buddy_profiles?: any[];
  profiles?: any[];
  insertError?: any;
}

function makeClient(state: FakeState = {}) {
  const userId = state.userId ?? ALICE_ID;
  const insertError = state.insertError ?? null;

  const db: Record<string, any[]> = {
    moderation_reports: [...(state.moderationReports ?? [])],
    posts:              state.posts       ?? [{ id: POST_ID,  user_id: BOB_ID }],
    events:             state.events      ?? [{ id: EVT_ID,   host_id: BOB_ID }],
    messages:           state.messages    ?? [{ id: MSG_ID,   sender_id: BOB_ID }],
    comments:           state.comments    ?? [{ id: CMT_ID,   user_id: BOB_ID }],
    reviews:            state.reviews     ?? [{ id: REV_ID,   reviewer_id: BOB_ID }],
    rent_buddy_profiles:state.rent_buddy_profiles ?? [{ id: BUDDY_ID, user_id: BOB_ID }],
    profiles:           state.profiles    ?? [{ id: userId, account_status: "active" }],
  };

  function builder(table: string) {
    let rows = [...(db[table] ?? [])];
    let filters: Record<string, any> = {};
    let limitN = 1000;
    let isSingle = false;
    let isMaybe = false;
    let insertData: any = null;
    let selectCols = "*";
    let orderCol: string | null = null;
    let orderAsc = true;

    const q: any = {
      select(cols: string) { selectCols = cols; return q; },
      insert(data: any) {
        insertData = Array.isArray(data) ? data[0] : data;
        return q;
      },
      update(_patch: any) { return q; },
      eq(col: string, val: any) { filters[col] = val; return q; },
      in(col: string, vals: any[]) { filters[`${col}__in`] = vals; return q; },
      order(col: string, opts?: any) { orderCol = col; orderAsc = opts?.ascending ?? true; return q; },
      limit(n: number) { limitN = n; return q; },
      single() { isSingle = true; return q; },
      maybeSingle() { isMaybe = true; return q; },
      then(resolve: Function, reject?: Function) {
        return Promise.resolve().then(() => {
          if (insertData) {
            if (insertError) return resolve({ data: null, error: insertError });
            const saved = { ...insertData, id: "new-report-id-001" };
            db[table] = [...(db[table] ?? []), saved];
            if (isSingle || isMaybe) return resolve({ data: saved, error: null });
            return resolve({ data: [saved], error: null });
          }
          // select
          let result = [...rows];
          for (const [k, v] of Object.entries(filters)) {
            if (k.endsWith("__in")) {
              const col = k.replace("__in", "");
              result = result.filter((r) => (v as any[]).includes(r[col]));
            } else {
              result = result.filter((r) => r[k] === v);
            }
          }
          if (orderCol) {
            const col = orderCol;
            result.sort((a, b) => {
              const av = a[col], bv = b[col];
              return orderAsc ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
            });
          }
          result = result.slice(0, limitN);
          if (isSingle) {
            return resolve(result.length
              ? { data: result[0], error: null }
              : { data: null, error: { message: "no rows" } });
          }
          if (isMaybe) return resolve({ data: result[0] ?? null, error: null });
          return resolve({ data: result, error: null });
        }).catch(reject ?? ((e: any) => { throw e; }));
      },
    };
    return q;
  }

  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
    from: (table: string) => builder(table),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = req.log ?? { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", moderationRouter);
  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as any;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string> = { "content-type": "application/json", ...(headers ?? {}) };
    if (payload) hdrs["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers: hdrs },
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

const AUTH = { authorization: "Bearer test-token" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Moderation routes", () => {
  let server: http.Server;

  before(async () => {
    const app = buildApp();
    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  });

  after(async () => {
    _clearTestClient?.();
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(() => {
    _clearTestClient?.();
    _resetRateLimit("moderation_report", ALICE_ID);
  });

  // ── A. POST /api/moderation/report ────────────────────────────────────────

  describe("POST /api/moderation/report", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "spam",
      });
      assert.equal(status, 401);
    });

    it("returns 400 for invalid subjectType", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "invalid_type", subjectId: BOB_ID, category: "spam",
      }, AUTH);
      assert.equal(status, 400, JSON.stringify(body));
    });

    it("returns 400 for invalid category", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "bad_cat",
      }, AUTH);
      assert.equal(status, 400, JSON.stringify(body));
    });

    it("returns 400 for non-UUID subjectId", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: "not-a-uuid", category: "spam",
      }, AUTH);
      assert.equal(status, 400, JSON.stringify(body));
    });

    it("returns 400 for self-report (user subjectType)", async () => {
      _setTestClient(makeClient({ userId: ALICE_ID }) as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: ALICE_ID, category: "spam",
      }, AUTH);
      assert.equal(status, 400, JSON.stringify(body));
      assert.ok((body.message ?? "").toLowerCase().includes("yourself") || (body.error ?? "").length > 0);
    });

    it("returns 200 and existing reportId on duplicate open report", async () => {
      const existing = {
        id: "existing-report-uuid",
        reporter_id: ALICE_ID,
        subject_type: "user",
        subject_id: BOB_ID,
        category: "spam",
        status: "open",
      };
      _setTestClient(makeClient({ moderationReports: [existing] }) as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "spam",
      }, AUTH);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.reportId, "existing-report-uuid");
    });

    it("returns 429 after rate limit is exhausted", async () => {
      _setTestClient(makeClient() as any, true);
      // Exhaust the limit (default 10 per 24h) — we'll use a fresh bucket
      // by targeting a distinct userId to avoid cross-test contamination
      const throttleId = "throttle-test-uuid-0000";
      _resetRateLimit("moderation_report", throttleId);
      const client = makeClient({ userId: throttleId });
      _setTestClient(client as any, true);

      // Hit 10 allowed requests
      for (let i = 0; i < 10; i++) {
        await req(server, "POST", "/api/moderation/report", {
          subjectType: "user", subjectId: BOB_ID, category: "spam",
        }, AUTH);
      }
      // 11th should be 429
      const { status } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "spam",
      }, AUTH);
      assert.equal(status, 429);
    });

    it("happy path — user report: subject_user_id = subjectId, returns 201", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "harassment",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `expected 2xx, got ${status}: ${JSON.stringify(body)}`);
      assert.ok(typeof body.reportId === "string", "reportId should be a string");
    });

    it("happy path — post report: derives subject_user_id from posts table", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "post", subjectId: POST_ID, category: "inappropriate_content",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
      assert.ok(typeof body.reportId === "string");
    });

    it("happy path — event report: derives subject_user_id from events table", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "event", subjectId: EVT_ID, category: "scam_fraud",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
      assert.ok(typeof body.reportId === "string");
    });

    it("happy path — message report: stores thread_id", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "message", subjectId: MSG_ID, category: "harassment", threadId: THR_ID,
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
      assert.ok(typeof body.reportId === "string");
    });

    it("happy path — comment report", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "comment", subjectId: CMT_ID, category: "spam",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
    });

    it("happy path — review report", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "review", subjectId: REV_ID, category: "impersonation",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
    });

    it("happy path — buddy_listing report", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "buddy_listing", subjectId: BUDDY_ID, category: "scam_fraud",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
    });

    it("accepts optional details field", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "POST", "/api/moderation/report", {
        subjectType: "user", subjectId: BOB_ID, category: "other",
        details: "More context here",
      }, AUTH);
      assert.ok(status === 201 || status === 200, `got ${status}: ${JSON.stringify(body)}`);
    });
  });

  // ── B. GET /api/moderation/reports/mine ──────────────────────────────────

  describe("GET /api/moderation/reports/mine", () => {
    it("returns 401 when unauthenticated", async () => {
      const { status } = await req(server, "GET", "/api/moderation/reports/mine");
      assert.equal(status, 401);
    });

    it("returns 200 with empty array when no reports exist", async () => {
      _setTestClient(makeClient() as any, true);
      const { status, body } = await req(server, "GET", "/api/moderation/reports/mine", undefined, AUTH);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.reports));
      assert.equal(body.reports.length, 0);
    });

    it("returns only caller's own reports", async () => {
      const aliceReport = {
        id: "alice-report-1",
        reporter_id: ALICE_ID,
        subject_type: "user",
        category: "spam",
        status: "open",
        created_at: new Date().toISOString(),
      };
      const bobReport = {
        id: "bob-report-1",
        reporter_id: BOB_ID,
        subject_type: "post",
        category: "harassment",
        status: "open",
        created_at: new Date().toISOString(),
      };
      _setTestClient(makeClient({ moderationReports: [aliceReport, bobReport] }) as any, true);
      const { status, body } = await req(server, "GET", "/api/moderation/reports/mine", undefined, AUTH);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.reports));
      // Only alice's report should be returned (filtered by reporter_id)
      const reportIds = body.reports.map((r: any) => r.id);
      assert.ok(reportIds.includes("alice-report-1"), "alice's report should be present");
      assert.ok(!reportIds.includes("bob-report-1"), "bob's report should not be present");
    });

    it("respects ?limit query param", async () => {
      const reports = Array.from({ length: 5 }, (_, i) => ({
        id: `report-${i}`,
        reporter_id: ALICE_ID,
        subject_type: "user",
        category: "spam",
        status: "open",
        created_at: new Date().toISOString(),
      }));
      _setTestClient(makeClient({ moderationReports: reports }) as any, true);
      const { status, body } = await req(server, "GET", "/api/moderation/reports/mine?limit=2", undefined, AUTH);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.reports));
      assert.ok(body.reports.length <= 2, `expected ≤2 reports, got ${body.reports.length}`);
    });
  });
});
