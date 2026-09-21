/**
 * The intel live-scope OPERATOR SURFACE — routes/admin.ts
 *   GET  /admin/intel/live-scopes
 *   GET  /admin/intel/live-scopes/:scopeKey
 *   POST /admin/intel/live-scopes/promote
 *   POST /admin/intel/live-scopes/withdraw
 *
 * THE PROPERTIES UNDER TEST, each pinned against the fake's write/rpc ledger
 * so a refusal is proven to have written nothing, not just to have said no:
 *
 *   1. Admin only: a non-admin gets 403 before any flag read or RPC.
 *   2. Surface flag (2570) absent / false / unreadable ⇒ closed (404),
 *      no other table is read, no RPC is made.
 *   3. THE STATE PRODUCTION IS IN: 2430 unapplied. Writer-flag row absent ⇒
 *      503 naming 2430. Function missing (42883 / PGRST202) ⇒ 503 naming
 *      2430. Columns missing (42703) on list/inspect ⇒ 503 naming 2430, never
 *      an empty 200.
 *   4. Writer flag present but FALSE ⇒ 404 naming the flag, no RPC.
 *   5. Provenance is mandatory: no evidence, evidence without reasoning or
 *      assessment, no expiresAt, past expiresAt ⇒ 400, no RPC.
 *   6. Idempotency at the ROUTE level: re-promote ⇒ already_active with one
 *      row; later horizon ⇒ renewed; withdraw twice ⇒ withdrawn then
 *      already_withdrawn, row kept; withdraw ⇒ re-promote ⇒ repromoted.
 *   7. Audit: promoted_by / withdrawn_by are the admin's id; evidence and
 *      reason are stored verbatim; the row is never written by the route
 *      itself (only through rpc).
 *   8. A resolved non-schema database error is 500, never a success or an
 *      empty list; an unreadable flag is never a promotion.
 *
 * The fake applies 2430's documented state machine in memory (same technique
 * as intelLiveScopePromotion.test.ts). It is NOT a database: the SQL bodies
 * are pinned by that suite's text contracts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/intelLiveScopeOps.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter, { LIVE_SCOPE_ADMIN_SURFACE_FLAG, LIVE_SCOPE_WRITER_FLAG, LIVE_SCOPE_ROW_COLUMNS } from "../routes/admin.js";
import { LIVE_SCOPE_PROMOTION_FLAG } from "../lib/intelLiveScopePromotion.js";
import { PROMOTED_SCOPE_COLUMNS } from "../lib/liveClaimRead.js";

const ADMIN_ID    = "aaaaaaaa-1111-4111-8111-000000000001";
const NONADMIN_ID = "bbbbbbbb-2222-4222-8222-000000000002";
const ADMIN_TOKEN = "admin.jwt";
const USER_TOKEN  = "user.jwt";

const HOUR = 60 * 60 * 1000;
const future = (ms = 6 * HOUR) => new Date(Date.now() + ms).toISOString();

const EVIDENCE = {
  assessment: { gate: "density", metrics: { weeklyObservations: 412 }, certifiable: false, uninstrumented: ["crowdCalibrationAccuracy", "expiryCorrectness"] },
  reasoning: "412 qualifying observations/week over four weeks; overriding the non-certifiable verdict for a two-week trial.",
};

interface ScopeRow {
  scope_key: string; zone_id: string | null; claim_type: string; promoted_at: string; promoted_by: string | null;
  note: string | null; expires_at: string | null; withdrawn_at: string | null; withdrawn_by: string | null;
  withdrawn_reason: string | null; promoted_via: "manual" | "service"; evidence: unknown; updated_at: string;
}

interface FakeOpts {
  /** feature_flags rows. A key absent from the map is an absent ROW. */
  flags: Record<string, boolean>;
  /** A flag whose read RESOLVES with an error. */
  unreadableFlag?: string;
  /** 2430 unapplied: selecting its columns 42703s, calling its functions 42883s. */
  pre2430?: boolean;
  /** Every rpc resolves with a non-schema error. */
  rpcError?: { code: string; message: string };
  /** Every intel_live_promoted_scopes read resolves with a non-schema error. */
  scopeReadError?: { code: string; message: string };
  /** Pre-seeded rows. */
  rows?: ScopeRow[];
}

function fakeDb(opts: FakeOpts) {
  const scopes = new Map<string, ScopeRow>((opts.rows ?? []).map((r) => [r.scope_key, r]));
  const rpcCalls: { fn: string; args: any }[] = [];
  const tablesRead: string[] = [];
  const profiles: Record<string, any> = {
    [ADMIN_ID]:    { id: ADMIN_ID, role: "admin", account_status: "active", display_name: "Ops Admin", username: null, handle: "ops" },
    [NONADMIN_ID]: { id: NONADMIN_ID, role: "user", account_status: "active", display_name: "Plain User", username: null, handle: "plain" },
  };
  const forbid = () => { throw new Error("the route must never write intel_live_promoted_scopes directly"); };

  const api: any = {
    scopes, rpcCalls, tablesRead,
    auth: {
      getUser: async (token: string) => {
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_ID } }, error: null };
        if (token === USER_TOKEN) return { data: { user: { id: NONADMIN_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from(table: string) {
      tablesRead.push(table);
      if (table === "profiles") {
        let id = "";
        const q: any = {
          select: () => q,
          eq: (k: string, v: string) => { if (k === "id") id = v; return q; },
          maybeSingle: async () => ({ data: profiles[id] ?? null, error: null }),
          single: async () => ({ data: profiles[id] ?? null, error: null }),
        };
        return q;
      }
      if (table === "feature_flags") {
        let flag = "";
        const q: any = {
          select: () => q,
          eq: (k: string, v: string) => { if (k === "flag") flag = v; return q; },
          maybeSingle: async () => {
            if (opts.unreadableFlag === flag) return { data: null, error: { code: "XX000", message: "flag read exploded" } };
            return flag in opts.flags ? { data: { enabled: opts.flags[flag] }, error: null } : { data: null, error: null };
          },
        };
        return q;
      }
      if (table === "intel_live_promoted_scopes") {
        let cols = "";
        let keyEq: string | null = null;
        const answer = () => {
          if (opts.scopeReadError) return { data: null, error: opts.scopeReadError };
          if (opts.pre2430 && /expires_at|withdrawn_at|evidence|promoted_via/.test(cols)) {
            return { data: null, error: { code: "42703", message: 'column intel_live_promoted_scopes.expires_at does not exist' } };
          }
          const wanted = cols.split(",").map((s) => s.trim());
          let rows = [...scopes.values()];
          if (keyEq !== null) rows = rows.filter((r) => r.scope_key === keyEq);
          rows.sort((a, b) => (a.promoted_at < b.promoted_at ? 1 : -1));
          return { data: rows.map((r) => Object.fromEntries(wanted.map((k) => [k, (r as any)[k]]))), error: null };
        };
        const q: any = {
          select: (c: string) => { cols = c; return q; },
          order: () => q,
          eq: (k: string, v: string) => { if (k === "scope_key") keyEq = v; return q; },
          maybeSingle: async () => {
            const a = answer();
            if (a.error) return a;
            return { data: a.data![0] ?? null, error: null };
          },
          insert: forbid, upsert: forbid, update: forbid, delete: forbid,
          then: (res: any) => res(answer()),
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      if (opts.pre2430) {
        return { data: null, error: { code: "42883", message: `function public.${fn}(...) does not exist` } };
      }
      const now: string = args.p_now;
      if (fn === "system_promote_intel_live_scope") {
        const key = `${args.p_zone_id ?? ""}|${args.p_claim_type}`;
        const row = scopes.get(key);
        let action: string;
        if (!row) {
          scopes.set(key, {
            scope_key: key, zone_id: args.p_zone_id ?? null, claim_type: args.p_claim_type, promoted_at: now,
            promoted_by: args.p_promoted_by ?? null, note: args.p_note ?? null, expires_at: args.p_expires_at,
            withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, promoted_via: "service",
            evidence: args.p_evidence ?? null, updated_at: now,
          });
          action = "promoted";
        } else if (row.withdrawn_at != null || (row.expires_at != null && row.expires_at <= now)) {
          Object.assign(row, {
            promoted_at: now, promoted_by: args.p_promoted_by ?? null, note: args.p_note ?? null,
            expires_at: args.p_expires_at, promoted_via: "service", evidence: args.p_evidence ?? null,
            withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, updated_at: now,
          });
          action = "repromoted";
        } else if (row.expires_at == null || args.p_expires_at > row.expires_at) {
          Object.assign(row, { expires_at: args.p_expires_at, promoted_via: "service", updated_at: now,
            evidence: args.p_evidence ?? row.evidence, note: args.p_note ?? row.note });
          action = "renewed";
        } else {
          action = "already_active";
        }
        const r = scopes.get(key)!;
        return { data: { scope_key: key, action, promoted_at: r.promoted_at, expires_at: r.expires_at }, error: null };
      }
      if (fn === "system_withdraw_intel_live_scope") {
        const key = `${args.p_zone_id ?? ""}|${args.p_claim_type}`;
        const row = scopes.get(key);
        if (!row) return { data: { scope_key: key, action: "not_found" }, error: null };
        if (row.withdrawn_at != null) return { data: { scope_key: key, action: "already_withdrawn" }, error: null };
        Object.assign(row, { withdrawn_at: now, withdrawn_by: args.p_withdrawn_by ?? null, withdrawn_reason: args.p_reason, updated_at: now });
        return { data: { scope_key: key, action: "withdrawn", withdrawn_at: now }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return api;
}

/** Both flags ON — the post-2430, owner-enabled state. */
const OPEN = { [LIVE_SCOPE_ADMIN_SURFACE_FLAG]: true, [LIVE_SCOPE_PROMOTION_FLAG]: true };

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function request(method: "GET" | "POST", path: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const promoteBody = (over: Record<string, unknown> = {}) => ({ zoneId: "z1", claimType: "crowd.level", expiresAt: future(), evidence: EVIDENCE, ...over });
const withdrawBody = (over: Record<string, unknown> = {}) => ({ zoneId: "z1", claimType: "crowd.level", reason: "trial over", ...over });
const KEY = "z1|crowd.level";
const KEY_PATH = `/admin/intel/live-scopes/${encodeURIComponent(KEY)}`;

function use(db: any) { _setTestClient(db, true); _setTestServiceClient(db); return db; }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { _setTestServiceClient(null); });

// ── 1. Admin only ─────────────────────────────────────────────────────────────

describe("live-scope surface — admin only", () => {
  it("a non-admin is 403 on all four routes, before any flag read and with no RPC", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const r = [
      await request("GET", "/admin/intel/live-scopes", USER_TOKEN),
      await request("GET", KEY_PATH, USER_TOKEN),
      await request("POST", "/admin/intel/live-scopes/promote", USER_TOKEN, promoteBody()),
      await request("POST", "/admin/intel/live-scopes/withdraw", USER_TOKEN, withdrawBody()),
    ];
    assert.deepEqual(r.map((x) => x.status), [403, 403, 403, 403]);
    assert.equal(db.rpcCalls.length, 0, "no RPC for a non-admin");
    assert.ok(!db.tablesRead.includes("feature_flags"), "flags are not even read for a non-admin");
    assert.ok(!db.tablesRead.includes("intel_live_promoted_scopes"));
  });
  it("no token is 401 everywhere", async () => {
    use(fakeDb({ flags: OPEN }));
    assert.equal((await request("POST", "/admin/intel/live-scopes/promote", undefined, promoteBody())).status, 401);
    assert.equal((await request("GET", "/admin/intel/live-scopes", undefined)).status, 401);
  });
});

// ── 2. The surface flag (2570) ────────────────────────────────────────────────

describe("live-scope surface — intel_live_scope_admin_surface_enabled (2570) fail-closed", () => {
  for (const [label, flags] of [
    ["absent (2570 unapplied)", { [LIVE_SCOPE_PROMOTION_FLAG]: true }],
    ["false (the seed)", { [LIVE_SCOPE_ADMIN_SURFACE_FLAG]: false, [LIVE_SCOPE_PROMOTION_FLAG]: true }],
  ] as const) {
    it(`flag ${label} ⇒ 404 feature_disabled on all four, no scope read, no RPC`, async () => {
      const db = use(fakeDb({ flags: flags as Record<string, boolean> }));
      const r = [
        await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN),
        await request("GET", KEY_PATH, ADMIN_TOKEN),
        await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody()),
        await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody()),
      ];
      assert.deepEqual(r.map((x) => [x.status, x.body.error]), Array(4).fill([404, "feature_disabled"]));
      for (const x of r) assert.match(x.body.message, /intel_live_scope_admin_surface_enabled/);
      if (label.startsWith("absent")) for (const x of r) assert.match(x.body.message, /2570/, "an absent row names the migration that seeds it");
      assert.equal(db.rpcCalls.length, 0);
      assert.ok(!db.tablesRead.includes("intel_live_promoted_scopes"), "the allowlist is not read behind a closed surface");
    });
  }
  it("flag UNREADABLE ⇒ closed (404), no scope read, no RPC — an unreadable flag is never ON", async () => {
    const db = use(fakeDb({ flags: OPEN, unreadableFlag: LIVE_SCOPE_ADMIN_SURFACE_FLAG }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    assert.deepEqual([p.status, p.body.error, l.status, l.body.error], [404, "feature_disabled", 404, "feature_disabled"]);
    for (const x of [p, l]) assert.match(x.body.message, /could not be read/);
    assert.equal(db.rpcCalls.length, 0);
    assert.equal(db.scopes.size, 0);
    assert.ok(!db.tablesRead.includes("intel_live_promoted_scopes"));
  });
  it("the route's writer-flag literal is 2430's flag (the polarity check resolves names per file)", () => {
    assert.equal(LIVE_SCOPE_WRITER_FLAG, LIVE_SCOPE_PROMOTION_FLAG);
    assert.equal(LIVE_SCOPE_ADMIN_SURFACE_FLAG, "intel_live_scope_admin_surface_enabled");
  });
});

// ── 3. The state production is in: 2430 unapplied ────────────────────────────

describe("live-scope surface — 2430 unapplied (production and portava-ci today) degrades loudly", () => {
  it("writer flag row ABSENT ⇒ promote/withdraw are 503 server_not_configured naming 2430, no RPC", async () => {
    const db = use(fakeDb({ flags: { [LIVE_SCOPE_ADMIN_SURFACE_FLAG]: true }, pre2430: true }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    for (const x of [p, w]) {
      assert.equal(x.status, 503, JSON.stringify(x.body));
      assert.equal(x.body.error, "server_not_configured");
      assert.match(x.body.message, /2430/);
      assert.match(x.body.message, /intel_live_scope_promotion_enabled has no row/);
    }
    assert.equal(db.rpcCalls.length, 0, "nothing is attempted against a function that does not exist");
    assert.equal(db.scopes.size, 0);
  });
  it("writer flag hand-inserted ON but functions missing (42883) ⇒ 503 naming 2430, not a success", async () => {
    const db = use(fakeDb({ flags: OPEN, pre2430: true }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    for (const x of [p, w]) {
      assert.equal(x.status, 503, JSON.stringify(x.body));
      assert.equal(x.body.error, "server_not_configured");
      assert.match(x.body.message, /42883/);
      assert.match(x.body.message, /2430/);
      assert.equal(x.body.action, undefined, "no action is reported for a failed write");
    }
    assert.equal(db.rpcCalls.length, 2, "the library was called and its resolved error was surfaced");
    assert.equal(db.scopes.size, 0);
  });
  it("columns missing (42703) ⇒ list and inspect are 503 naming 2430, NEVER an empty 200", async () => {
    const db = use(fakeDb({ flags: OPEN, pre2430: true }));
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    const i = await request("GET", KEY_PATH, ADMIN_TOKEN);
    for (const x of [l, i]) {
      assert.equal(x.status, 503, JSON.stringify(x.body));
      assert.equal(x.body.error, "server_not_configured");
      assert.match(x.body.message, /42703/);
      assert.match(x.body.message, /2430/);
      assert.equal(x.body.scopes, undefined);
      assert.equal(x.body.scope, undefined);
    }
    assert.ok(db.tablesRead.includes("intel_live_promoted_scopes"), "the read was attempted, not skipped");
  });
});

// ── 4. Writer flag present but OFF ────────────────────────────────────────────

describe("live-scope surface — intel_live_scope_promotion_enabled (2430) present but FALSE", () => {
  it("promote and withdraw are 404 feature_disabled naming the writer flag; no RPC; list still works", async () => {
    const db = use(fakeDb({ flags: { [LIVE_SCOPE_ADMIN_SURFACE_FLAG]: true, [LIVE_SCOPE_PROMOTION_FLAG]: false } }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    for (const x of [p, w]) {
      assert.deepEqual([x.status, x.body.error], [404, "feature_disabled"]);
      assert.match(x.body.message, /intel_live_scope_promotion_enabled is off/);
    }
    assert.equal(db.rpcCalls.length, 0);
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    assert.deepEqual([l.status, l.body.scopes], [200, []], "reads need only the surface flag");
  });
  it("writer flag UNREADABLE ⇒ 503 closed, no RPC — an unreadable flag is never a promotion", async () => {
    const db = use(fakeDb({ flags: OPEN, unreadableFlag: LIVE_SCOPE_PROMOTION_FLAG }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    for (const x of [p, w]) {
      assert.deepEqual([x.status, x.body.error], [503, "server_not_configured"]);
      assert.match(x.body.message, /intel_live_scope_promotion_enabled/);
      assert.match(x.body.message, /could not be read/);
    }
    assert.equal(db.rpcCalls.length, 0);
    assert.equal(db.scopes.size, 0);
  });
});

// ── 5. Provenance is mandatory ────────────────────────────────────────────────

describe("live-scope surface — provenance is required by the schema, not optional", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["no evidence",                     { evidence: undefined }],
    ["evidence without reasoning",      { evidence: { assessment: EVIDENCE.assessment } }],
    ["evidence with empty reasoning",   { evidence: { assessment: EVIDENCE.assessment, reasoning: "" } }],
    ["evidence without assessment",     { evidence: { reasoning: EVIDENCE.reasoning } }],
    ["evidence not an object",          { evidence: "looked fine" }],
    ["no expiresAt",                    { expiresAt: undefined }],
    ["expiresAt null (the legacy hand-insert shape)", { expiresAt: null }],
    ["expiresAt not a date",            { expiresAt: "next tuesday" }],
    ["expiresAt in the past",           { expiresAt: new Date(Date.now() - HOUR).toISOString() }],
    ["zoneId missing (must be said, even as null)", { zoneId: undefined }],
    ["claimType empty",                 { claimType: "" }],
  ];
  for (const [label, over] of cases) {
    it(`${label} ⇒ 400 invalid_payload, no RPC, no row`, async () => {
      const db = use(fakeDb({ flags: OPEN }));
      const body = promoteBody(over);
      for (const k of Object.keys(over)) if (over[k] === undefined) delete (body as any)[k];
      const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, body);
      assert.deepEqual([p.status, p.body.error], [400, "invalid_payload"], JSON.stringify(p.body));
      // The ROUTE's schema refused it (its message names the body shape or the
      // horizon rule) — not the library's later invalid_input, which would mean
      // the schema had let it through.
      assert.match(p.body.message, label.includes("past") ? /must be in the future/ : /^Body must be/, p.body.message);
      assert.equal(db.rpcCalls.length, 0);
      assert.equal(db.scopes.size, 0);
    });
  }
  it("withdraw without a reason ⇒ 400, no RPC", async () => {
    const db = use(fakeDb({ flags: OPEN, rows: [] }));
    for (const body of [withdrawBody({ reason: undefined }), withdrawBody({ reason: "" })]) {
      if (body.reason === undefined) delete (body as any).reason;
      const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, body);
      assert.deepEqual([w.status, w.body.error], [400, "invalid_payload"]);
      assert.match(w.body.message, /^Body must be/);
    }
    assert.equal(db.rpcCalls.length, 0);
  });
});

// ── 6 + 7. The happy path: idempotent, audited, through the library only ─────

describe("live-scope surface — promote / withdraw through the 2430 functions, idempotently, with provenance", () => {
  it("promote ⇒ promoted; the row carries the admin, the evidence verbatim, the horizon, 'service' provenance", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const exp = future();
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ expiresAt: exp, note: "two-week trial" }));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual(p.body, { scopeKey: KEY, action: "promoted", expiresAt: exp, promotedBy: { userId: ADMIN_ID, displayName: "Ops Admin" } });

    assert.deepEqual(db.rpcCalls.map((c: { fn: string }) => c.fn), ["system_promote_intel_live_scope"], "written through the library's RPC and nothing else");
    assert.equal(db.rpcCalls[0]!.args.p_promoted_by, ADMIN_ID, "promoted_by is the admin — the row is the audit trail");
    assert.deepEqual(db.rpcCalls[0]!.args.p_evidence, EVIDENCE, "evidence stored verbatim");
    assert.equal(db.rpcCalls[0]!.args.p_expires_at, exp);
    assert.equal(db.rpcCalls[0]!.args.p_note, "two-week trial");

    const row = db.scopes.get(KEY)!;
    assert.equal(db.scopes.size, 1);
    assert.equal(row.promoted_via, "service");
    assert.equal(row.promoted_by, ADMIN_ID);
    assert.deepEqual(row.evidence, EVIDENCE);
    assert.equal(row.withdrawn_at, null);
  });

  it("re-promote with the same horizon ⇒ already_active, still ONE row, no second write", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const exp = future();
    const a = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ expiresAt: exp }));
    const before = JSON.stringify(db.scopes.get(KEY));
    const b = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ expiresAt: exp }));
    assert.deepEqual([a.status, a.body.action, b.status, b.body.action], [200, "promoted", 200, "already_active"]);
    assert.equal(db.scopes.size, 1, "renewing is not duplicating");
    assert.equal(JSON.stringify(db.scopes.get(KEY)), before, "already_active changed nothing on the row");
  });

  it("re-promote with a LATER horizon ⇒ renewed, one row, horizon extended", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const exp1 = future(HOUR), exp2 = future(2 * HOUR);
    await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ expiresAt: exp1 }));
    const b = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ expiresAt: exp2 }));
    assert.deepEqual([b.status, b.body.action, b.body.expiresAt], [200, "renewed", exp2]);
    assert.equal(db.scopes.size, 1);
    assert.equal(db.scopes.get(KEY)!.expires_at, exp2);
  });

  it("withdraw ⇒ withdrawn (row KEPT, withdrawn_by = admin, reason verbatim); again ⇒ already_withdrawn, no write", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w1 = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody({ reason: "calibration drifted" }));
    assert.equal(w1.status, 200, JSON.stringify(w1.body));
    assert.deepEqual(w1.body, { scopeKey: KEY, action: "withdrawn", withdrawnBy: { userId: ADMIN_ID, displayName: "Ops Admin" } });
    const row = db.scopes.get(KEY)!;
    assert.equal(db.scopes.size, 1, "withdrawal keeps the row");
    assert.equal(row.withdrawn_by, ADMIN_ID);
    assert.equal(row.withdrawn_reason, "calibration drifted");
    assert.ok(row.withdrawn_at);

    const snapshot = JSON.stringify(row);
    const w2 = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody({ reason: "again" }));
    assert.deepEqual([w2.status, w2.body.action], [200, "already_withdrawn"], "withdrawing twice is not an error");
    assert.equal(JSON.stringify(db.scopes.get(KEY)), snapshot, "the original reason stands; no second write");
    assert.equal(db.rpcCalls.filter((c: { fn: string }) => c.fn === "system_withdraw_intel_live_scope").length, 2);
  });

  it("withdraw a scope never promoted ⇒ 404 not_found (nothing to withdraw), no row created", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody({ zoneId: "nowhere" }));
    assert.deepEqual([w.status, w.body.error], [404, "not_found"]);
    assert.equal(db.scopes.size, 0);
  });

  it("withdraw then promote ⇒ repromoted in place: withdrawal cleared, fresh evidence, still one row", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    const ev2 = { ...EVIDENCE, reasoning: "second trial after fixing calibration" };
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ evidence: ev2 }));
    assert.deepEqual([p.status, p.body.action], [200, "repromoted"]);
    const row = db.scopes.get(KEY)!;
    assert.equal(db.scopes.size, 1);
    assert.equal(row.withdrawn_at, null);
    assert.equal(row.withdrawn_reason, null);
    assert.deepEqual(row.evidence, ev2);
  });

  it("a zone-less scope (zoneId: null) composes the '|claim' key 2179's CHECK expects", async () => {
    const db = use(fakeDb({ flags: OPEN }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody({ zoneId: null }));
    assert.deepEqual([p.status, p.body.scopeKey], [200, "|crowd.level"]);
    assert.equal(db.rpcCalls[0]!.args.p_zone_id, null);
  });
});

// ── List / inspect ────────────────────────────────────────────────────────────

describe("live-scope surface — list and inspect show the serve-path truth", () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const row = (over: Partial<ScopeRow>): ScopeRow => ({
    scope_key: "z|c", zone_id: "z", claim_type: "c", promoted_at: iso(-2 * HOUR), promoted_by: ADMIN_ID, note: null,
    expires_at: iso(HOUR), withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, promoted_via: "service",
    evidence: EVIDENCE, updated_at: iso(-2 * HOUR), ...over,
  });
  const rows = [
    row({ scope_key: "a|c", zone_id: "a", promoted_at: iso(-3 * HOUR) }),
    row({ scope_key: "b|c", zone_id: "b", expires_at: iso(-1), promoted_at: iso(-2 * HOUR) }),
    row({ scope_key: "d|c", zone_id: "d", withdrawn_at: iso(-30 * 60_000), withdrawn_by: ADMIN_ID, withdrawn_reason: "drift", promoted_at: iso(-HOUR) }),
    row({ scope_key: "e|c", zone_id: "e", expires_at: null, promoted_via: "manual", evidence: null, promoted_at: iso(-4 * HOUR) }),
  ];

  it("list defaults to ACTIVE only, computed the way liveClaimRead computes it; ?all=1 adds withdrawn and expired with their state", async () => {
    const db = use(fakeDb({ flags: OPEN, rows }));
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    assert.equal(l.status, 200, JSON.stringify(l.body));
    assert.deepEqual(l.body.scopes.map((s: any) => [s.scope_key, s.state]).sort(), [["a|c", "active"], ["e|c", "active"]]);
    assert.deepEqual([l.body.total, l.body.includesInactive], [2, false]);

    const a = await request("GET", "/admin/intel/live-scopes?all=1", ADMIN_TOKEN);
    assert.deepEqual(a.body.scopes.map((s: any) => [s.scope_key, s.state]).sort(),
      [["a|c", "active"], ["b|c", "expired"], ["d|c", "withdrawn"], ["e|c", "active"]]);
    assert.equal(a.body.includesInactive, true);
    assert.ok(db.tablesRead.includes("intel_live_promoted_scopes"));
  });

  it("list selects every 2430 column (a superset of the serve path's projection) and returns them all", async () => {
    const db = use(fakeDb({ flags: OPEN, rows: [rows[0]!] }));
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    const s = l.body.scopes[0];
    for (const c of LIVE_SCOPE_ROW_COLUMNS.split(",").map((x) => x.trim())) assert.ok(c in s, `column ${c} present`);
    for (const c of PROMOTED_SCOPE_COLUMNS.split(",").map((x) => x.trim())) assert.ok(LIVE_SCOPE_ROW_COLUMNS.includes(c), `serve-path column ${c} is in the operator's view`);
    assert.equal(db.scopes.size, 1);
  });

  it("inspect returns the whole row — who, when, evidence, withdrawal — and its state", async () => {
    use(fakeDb({ flags: OPEN, rows }));
    const i = await request("GET", `/admin/intel/live-scopes/${encodeURIComponent("d|c")}`, ADMIN_TOKEN);
    assert.equal(i.status, 200, JSON.stringify(i.body));
    assert.equal(i.body.scope.state, "withdrawn");
    assert.equal(i.body.scope.withdrawn_by, ADMIN_ID);
    assert.equal(i.body.scope.withdrawn_reason, "drift");
    assert.equal(i.body.scope.promoted_by, ADMIN_ID);
    assert.deepEqual(i.body.scope.evidence, EVIDENCE);
    assert.equal(i.body.scope.promoted_via, "service");
  });

  it("inspect: unknown key ⇒ 404; a key without the bar ⇒ 400 (not a 404 that hides a typo)", async () => {
    use(fakeDb({ flags: OPEN, rows }));
    const u = await request("GET", `/admin/intel/live-scopes/${encodeURIComponent("zz|c")}`, ADMIN_TOKEN);
    assert.deepEqual([u.status, u.body.error], [404, "not_found"]);
    const b = await request("GET", "/admin/intel/live-scopes/justaclaim", ADMIN_TOKEN);
    assert.deepEqual([b.status, b.body.error], [400, "invalid_payload"]);
  });
});

// ── 8. Resolved errors are never success ──────────────────────────────────────

describe("live-scope surface — a RESOLVED database error is never a success", () => {
  it("an rpc that resolves with a non-schema error ⇒ 500 db_error, no action, no row", async () => {
    const db = use(fakeDb({ flags: OPEN, rpcError: { code: "XX000", message: "deadlock detected" } }));
    const p = await request("POST", "/admin/intel/live-scopes/promote", ADMIN_TOKEN, promoteBody());
    const w = await request("POST", "/admin/intel/live-scopes/withdraw", ADMIN_TOKEN, withdrawBody());
    for (const x of [p, w]) {
      assert.deepEqual([x.status, x.body.error], [500, "db_error"], JSON.stringify(x.body));
      assert.match(x.body.message, /XX000/, "the code is exposed to the operator (not the sanitised generic)");
      assert.doesNotMatch(x.body.message, /2430/, "a non-schema error is not blamed on the migration");
      assert.equal(x.body.action, undefined);
    }
    assert.equal(db.scopes.size, 0);
  });
  it("a scope read that resolves with a non-schema error ⇒ 500, not an empty list and not a 404", async () => {
    use(fakeDb({ flags: OPEN, scopeReadError: { code: "57014", message: "canceling statement due to statement timeout" } }));
    const l = await request("GET", "/admin/intel/live-scopes", ADMIN_TOKEN);
    const i = await request("GET", KEY_PATH, ADMIN_TOKEN);
    assert.deepEqual([l.status, l.body.error, l.body.scopes], [500, "db_error", undefined]);
    assert.deepEqual([i.status, i.body.error], [500, "db_error"]);
  });
});
