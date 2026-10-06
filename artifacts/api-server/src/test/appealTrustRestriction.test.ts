/**
 * A restricted person can see what is restricted, for how long, and appeal it
 * (OD-TRUST-4, OD-TRUST-5, lead ruling D-24; migration 3933).
 *
 * Under test:
 *   GET  /appeals/me/restrictions           routes/appeals.ts (foot)
 *   POST /appeals  { targetType: "trust_restriction" }
 *   PATCH /appeals/:id approved             services/appeals/resolveAppeal.ts case "trust_restriction"
 *
 * The fake below APPLIES the filters these routes send (eq, is, the expiry
 * `or`, order, limit) and applies UPDATEs to its rows, so a test can assert the
 * resulting STATE: which restriction rows are lifted afterwards, and which
 * appeal rows exist. Failures arrive RESOLVED as `{ data: null, error }`, the
 * way supabase-js delivers them.
 *
 * Run: node --import tsx/esm --test src/test/appealTrustRestriction.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { restrictionSentence } from "../services/trust/TrustPrivacyGuard.js";
import { resolveAppeal } from "../services/appeals/resolveAppeal.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const R_HOST = "aaaaaaaa-0000-4000-8000-000000000001";
const R_MSG = "aaaaaaaa-0000-4000-8000-000000000002";
const R_LIFTED = "aaaaaaaa-0000-4000-8000-000000000003";
const R_EXPIRED = "aaaaaaaa-0000-4000-8000-000000000004";
const R_OTHER = "aaaaaaaa-0000-4000-8000-000000000005";
const APPEAL_ID = "bbbbbbbb-0000-4000-8000-000000000001";

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

type Row = Record<string, any>;
interface World {
  caller: string;
  trust_restrictions: Row[];
  appeals: Row[];
  failRead?: string;            // table whose reads fail
  failInsert?: { code: string; message: string } | null; // appeals insert failure
  failUpdate?: string;          // table whose updates fail
}

let world: World;

function seed(): World {
  return {
    caller: USER,
    trust_restrictions: [
      { id: R_HOST, user_id: USER, restriction_type: "hosting", reason: "reported by @someone", created_at: "2026-10-01T00:00:00Z", expires_at: FUTURE, lifted_at: null },
      { id: R_MSG, user_id: USER, restriction_type: "messaging", reason: "spam", created_at: "2026-10-02T00:00:00Z", expires_at: null, lifted_at: null },
      { id: R_LIFTED, user_id: USER, restriction_type: "private_plan_access", reason: "x", created_at: "2026-09-01T00:00:00Z", expires_at: null, lifted_at: "2026-09-02T00:00:00Z" },
      { id: R_EXPIRED, user_id: USER, restriction_type: "location_plan_join", reason: "x", created_at: "2026-09-01T00:00:00Z", expires_at: PAST, lifted_at: null },
      { id: R_OTHER, user_id: OTHER, restriction_type: "hosting", reason: "x", created_at: "2026-10-01T00:00:00Z", expires_at: null, lifted_at: null },
    ],
    appeals: [],
  };
}

function makeClient() {
  const builder = (table: string): any => {
    let op: "select" | "insert" | "update" = "select";
    let payload: any = null;
    let returning = false;
    let orExpr: string | null = null;
    let limitN: number | null = null;
    const filters: Array<{ col: string; kind: "eq" | "is"; val: any }> = [];
    const match = (r: Row) => filters.every((f) => (f.kind === "is" ? (f.val === null ? r[f.col] == null : r[f.col] === f.val) : r[f.col] === f.val))
      && (orExpr === null || (() => {
        const m = /^expires_at\.is\.null,expires_at\.gt\.(.+)$/.exec(orExpr!);
        if (!m) throw new Error(`fake: unmodelled or() ${orExpr}`);
        return r.expires_at == null || r.expires_at > m[1];
      })());
    const settle = (single: boolean): { data: any; error: any } => {
      if (table === "profiles") {
        const id = world.caller;
        const row = { id, account_status: "active", role: id === ADMIN ? "admin" : "user", display_name: "X", username: "x", handle: "x" };
        return { data: single ? row : [row], error: null };
      }
      if (op === "select") {
        if (world.failRead === table) return { data: null, error: { code: "57P01", message: "terminating connection" } };
        if (table === "appeals") {
          const rows = world.appeals.filter(match);
          return { data: single ? rows[0] ?? null : rows, error: null };
        }
        if (table === "trust_restrictions") {
          let rows = world.trust_restrictions.filter(match).map((r) => ({ ...r }));
          rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          if (limitN !== null) rows = rows.slice(0, limitN);
          return { data: single ? rows[0] ?? null : rows, error: null };
        }
        return { data: single ? null : [], error: null };
      }
      if (op === "insert") {
        if (table === "appeals") {
          if (world.failInsert) return { data: null, error: world.failInsert };
          const row = { id: APPEAL_ID, created_at: "2026-10-06T00:00:00Z", ...payload };
          world.appeals.push(row);
          return { data: single ? row : [row], error: null };
        }
        return { data: null, error: null };
      }
      // update
      if (world.failUpdate === table) return { data: null, error: { code: "57P01", message: "terminating connection" } };
      const rows = (table === "trust_restrictions" ? world.trust_restrictions : table === "appeals" ? world.appeals : []).filter(match);
      for (const r of rows) Object.assign(r, payload);
      const out = rows.map((r) => ({ ...r }));
      if (single) return { data: out[0] ?? null, error: null };
      return { data: returning ? out : null, error: null };
    };
    const b: any = {
      select: () => { if (op !== "select") returning = true; return b; },
      insert: (p: any) => { op = "insert"; payload = p; return b; },
      update: (p: any) => { op = "update"; payload = p; return b; },
      eq: (col: string, val: any) => { filters.push({ col, kind: "eq", val }); return b; },
      is: (col: string, val: any) => { filters.push({ col, kind: "is", val }); return b; },
      or: (expr: string) => { orExpr = expr; return b; },
      order: () => b,
      limit: (n: number) => { limitN = n; return b; },
      range: () => b,
      in: () => b,
      maybeSingle: () => Promise.resolve(settle(true)),
      single: () => Promise.resolve(settle(true)),
      then: (res: any, rej: any) => Promise.resolve(settle(false)).then(res, rej),
    };
    return b;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: world.caller } }, error: null }) },
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
  } as any;
}

let server: http.Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  const { default: appealsRouter } = await import("../routes/appeals.js");
  app.use(appealsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => { server.close(); _clearTestClient(); _setTestServiceClient(null); });
beforeEach(() => {
  world = seed();
  const c = makeClient();
  _setTestClient(c, true);
  _setTestServiceClient(c);
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET /appeals/me/restrictions — what is restricted, for how long, and how to appeal", () => {
  it("lists the caller's ACTIVE restrictions with the D-24 sentence, the end date and the appeal path; nothing lifted, expired or someone else's", async () => {
    const r = await call("GET", "/appeals/me/restrictions");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.restrictions.map((x: any) => x.id);
    assert.deepEqual(ids.sort(), [R_HOST, R_MSG].sort());
    const host = r.body.restrictions.find((x: any) => x.id === R_HOST);
    assert.equal(host.summary, restrictionSentence("hosting"));
    assert.equal(host.until, FUTURE);
    assert.deepEqual(host.appeal, { method: "POST", path: "/api/appeals", targetType: "trust_restriction", targetId: R_HOST });
    const msg = r.body.restrictions.find((x: any) => x.id === R_MSG);
    assert.equal(msg.summary, restrictionSentence("messaging"));
    assert.equal(msg.until, null, "no end date: until it is reviewed or lifted");
  });

  it("never sends the moderator's free-text reason (it may name a reporter)", async () => {
    const r = await call("GET", "/appeals/me/restrictions");
    assert.doesNotMatch(JSON.stringify(r.body), /@someone|spam/);
    for (const x of r.body.restrictions) assert.deepEqual(x.why, { shared: false });
  });

  it("an UNREADABLE table is 503, never an empty list", async () => {
    world.failRead = "trust_restrictions";
    const r = await call("GET", "/appeals/me/restrictions");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.restrictions, undefined);
  });
});

describe("POST /appeals { targetType: trust_restriction } — only the caller's own active restriction", () => {
  const body = (targetId: string) => ({ targetType: "trust_restriction", targetId, reason: "This restriction was applied in error, please review." });

  it("own active restriction -> 201, one appeal row targeting it", async () => {
    const r = await call("POST", "/appeals", body(R_HOST));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(world.appeals.length, 1);
    assert.equal(world.appeals[0].target_type, "trust_restriction");
    assert.equal(world.appeals[0].target_id, R_HOST);
    assert.equal(world.appeals[0].appellant_id, USER);
  });

  for (const [why, id] of [["someone else's", R_OTHER], ["an already-lifted", R_LIFTED], ["an expired", R_EXPIRED]] as const) {
    it(`${why} restriction -> 404, nothing filed`, async () => {
      const r = await call("POST", "/appeals", body(id));
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(world.appeals.length, 0);
    });
  }

  it("the restriction table UNREADABLE -> 503, nothing filed", async () => {
    world.failRead = "trust_restrictions";
    const r = await call("POST", "/appeals", body(R_HOST));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(world.appeals.length, 0);
  });

  it("before 3933 is applied (22P02 on the enum) -> 503 appeal_target_unavailable, never db_error", async () => {
    world.failInsert = { code: "22P02", message: 'invalid input value for enum appeal_target_type: "trust_restriction"' };
    const r = await call("POST", "/appeals", body(R_HOST));
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "appeal_target_unavailable");
  });
});

describe("approving the appeal lifts exactly that restriction", () => {
  const appeal = (target: string, appellant = USER, moderator: string | null = ADMIN) => ({ id: APPEAL_ID, appellant_id: appellant, target_type: "trust_restriction", target_id: target, resolution_note: null, moderator_id: moderator });

  it("resolveAppeal lifts the appealed restriction and no other", async () => {
    const r = await resolveAppeal(makeClient(), appeal(R_HOST));
    assert.deepEqual(r, { ok: true, action: "trust_restriction_lifted" });
    const byId = Object.fromEntries(world.trust_restrictions.map((x) => [x.id, x.lifted_at]));
    assert.ok(byId[R_HOST], "the appealed restriction is lifted");
    assert.equal(world.trust_restrictions.find((x) => x.id === R_HOST)!.lifted_by, ADMIN, "F6: the lift names the approving moderator");
    assert.equal(byId[R_MSG], null, "the person's other restriction stays");
    assert.equal(byId[R_OTHER], null, "nobody else's restriction moves");
  });

  it("F6: a lift with no approving moderator is refused, nothing lifted (every lift is attributed)", async () => {
    const r = await resolveAppeal(makeClient(), appeal(R_HOST, USER, null));
    assert.equal(r.ok, false);
    assert.equal(world.trust_restrictions.find((x) => x.id === R_HOST)!.lifted_at, null);
  });

  it("someone else's restriction id matches nothing: noop, nothing lifted", async () => {
    const r = await resolveAppeal(makeClient(), appeal(R_OTHER));
    assert.equal(r.ok, false);
    assert.equal(world.trust_restrictions.find((x) => x.id === R_OTHER)!.lifted_at, null);
  });

  it("a FAILED lift is not reported as done", async () => {
    world.failUpdate = "trust_restrictions";
    const r = await resolveAppeal(makeClient(), appeal(R_HOST));
    assert.equal(r.ok, false);
    assert.equal(world.trust_restrictions.find((x) => x.id === R_HOST)!.lifted_at, null);
  });

  it("PATCH /appeals/:id approved: the restriction is lifted and the appeal is approved", async () => {
    world.appeals.push({ id: APPEAL_ID, appellant_id: USER, target_type: "trust_restriction", target_id: R_HOST, state: "under_review", resolution_note: null });
    world.caller = ADMIN;
    const r = await call("PATCH", `/appeals/${APPEAL_ID}`, { state: "approved", resolutionNote: "Upheld." });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reversalAction, "trust_restriction_lifted");
    assert.ok(world.trust_restrictions.find((x) => x.id === R_HOST)!.lifted_at, "lifted");
    assert.equal(world.trust_restrictions.find((x) => x.id === R_HOST)!.lifted_by, ADMIN, "F6: lifted_by is the admin who approved");
    assert.equal(world.appeals[0].state, "approved");
  });
});
