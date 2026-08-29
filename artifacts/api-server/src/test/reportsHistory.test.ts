/**
 * Report history endpoint tests
 *
 * GET /api/me/reports — list the authenticated user's filed reports
 *
 * Run: node --import tsx/esm --test src/test/reportsHistory.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import reportsRouter from "../routes/reports.js";

let server: http.Server;
let base: string;

const TOKEN_A   = "report-hist-token-a";
const TOKEN_B   = "report-hist-token-b";
const USER_A    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REPORT_1  = "11111111-1111-1111-1111-111111111111";
const REPORT_2  = "22222222-2222-2222-2222-222222222222";
const TARGET_1  = "44444444-4444-4444-4444-444444444444";
const TARGET_2  = "55555555-5555-5555-5555-555555555555";

function buildFakeClient() {
  const rows = {
    reports: [
      { id: REPORT_1, reporter_id: USER_A, target_type: "user",    target_id: TARGET_1, reason_code: "spam",        reason_detail: null,         severity: "low",    status: "pending",  created_at: "2025-05-01T10:00:00Z" },
      { id: REPORT_2, reporter_id: USER_A, target_type: "message", target_id: TARGET_2, reason_code: "harassment", reason_detail: "was rude",   severity: "medium", status: "reviewed", created_at: "2025-04-15T08:00:00Z" },
    ] as any[],
    profiles: [
      { id: USER_A, role: "user" },
      { id: USER_B, role: "user" },
    ],
  };

  function from(table: string) {
    let source = (rows as any)[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    let _countMode = false;
    let _offset = 0;
    let _limit: number | null = null;

    const b: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === "exact") _countMode = true;
        return b;
      },
      insert(row: any) { return b; },
      update(patch: any) { return b; },
      delete() { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      order()  { return b; },
      range(from: number, to: number) { _offset = from; _limit = to - from + 1; return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() { return resolveOne(true); },
      single()      { return resolveOne(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() {
      return source.filter((r: any) => filters.every((f) => f(r)));
    }

    async function resolveList() {
      let data = filtered();
      if (_limit !== null) data = data.slice(_offset, _offset + _limit);
      const count = filtered().length;
      if (_countMode) return { data, error: null, count };
      return { data, error: null };
    }

    async function resolveOne(maybe: boolean) {
      const data = filtered();
      if (data.length === 0) return { data: null, error: null };
      return { data: { ...data[0] }, error: null };
    }

    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === TOKEN_A) return { data: { user: { id: USER_A } }, error: null };
        if (token === TOKEN_B) return { data: { user: { id: USER_B } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from,
  };
}

function req(
  method: string,
  path: string,
  token: string = TOKEN_A,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", "authorization": token ? `Bearer ${token}` : "" } },
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

describe("GET /api/me/reports", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", reportsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const fc = buildFakeClient();
    _setTestClient(fc as any, true);
    _setTestServiceClient(fc as any);
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("returns reports for the authenticated user", async () => {
    const r = await req("GET", "/api/me/reports");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.reports), "should have reports array");
    assert.equal(typeof r.body.total, "number");
    assert.ok(r.body.reports.length >= 1, "user A should have at least 1 report");
    const ids = r.body.reports.map((rep: any) => rep.id);
    assert.ok(ids.includes(REPORT_1), "should include report 1");
    assert.ok(ids.includes(REPORT_2), "should include report 2");
  });

  it("does not return other users' reports", async () => {
    const r = await req("GET", "/api/me/reports", TOKEN_B);
    assert.equal(r.status, 200);
    assert.equal(r.body.reports.length, 0, "user B has no reports");
    assert.equal(r.body.total, 0);
  });

  it("returns 401 without a valid token", async () => {
    const r = await req("GET", "/api/me/reports", "bad-token");
    assert.equal(r.status, 401);
  });

  it("respects limit query param", async () => {
    const r = await req("GET", "/api/me/reports?limit=1");
    assert.equal(r.status, 200);
    assert.ok(r.body.reports.length <= 1, "should respect limit=1");
  });

  it("report rows have expected fields", async () => {
    const r = await req("GET", "/api/me/reports");
    assert.equal(r.status, 200);
    const rep = r.body.reports[0];
    assert.ok(rep.id,           "should have id");
    assert.ok(rep.target_type,  "should have target_type");
    assert.ok(rep.reason_code,  "should have reason_code");
    assert.ok(rep.status,       "should have status");
    assert.ok(rep.created_at,   "should have created_at");
    assert.equal(rep.reporter_id, undefined, "should not expose reporter_id");
  });
});
