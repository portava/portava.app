/**
 * Testing-mode admin console (WP-21) — the server half of the screens.
 *
 * The admin screens only wire routes that already exist; these are the three
 * places where the route itself would have made a screen lie:
 *
 *  1. POST /api/admin/local-guides/:userId/status (PLAT-F38). `setGuideStatus`
 *     awaited its UPDATE and dropped the result, so a refused write and a user
 *     with no guide profile both answered `{ ok: true }` — the admin is told
 *     "approved" and the applicant is still an applicant. The change also had
 *     no audit record at all; it now logs one, as the live-scope admin routes do.
 *
 *  2. POST /api/admin/hidden-gems/:id/verify (PLAT-F39). The same shape in
 *     `recordAdminVerification`: the gem's status UPDATE was unchecked, so a
 *     failed approve answered `{ ok: true }` and a gem id that matches nothing
 *     "approved" nothing.
 *
 *  3. GET /api/admin/stamps/users/:userId/stamps (PASS-F23) — NEW. Revoke and
 *     restore take a `user_stamps.id`, and no admin route listed a person's
 *     stamps with ids (the public stamp routes hide revoked rows, so a revoked
 *     stamp could never be found again to restore). Admin-only, audited through
 *     `admin_access_log` like GET /admin/stamps/audit, and a failed read is an
 *     error, never an empty list.
 *
 * Run: node --import tsx/esm --test src/test/tmAdminConsole.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import adminStampsRouter from "../routes/adminStamps.js";

const ADMIN = "aaaaaaaa-0000-4000-8000-00000000ad01";
const USER  = "bbbbbbbb-0000-4000-8000-00000000b002";
const APPLICANT = "cccccccc-0000-4000-8000-0000000000c3";
const NOBODY    = "dddddddd-0000-4000-8000-0000000000d4";
const GEM       = "eeeeeeee-0000-4000-8000-0000000000e5";
const MISSING_GEM = "ffffffff-0000-4000-8000-0000000000f6";
const STAMP_A   = "11111111-0000-4000-8000-000000000001";
const STAMP_B   = "11111111-0000-4000-8000-000000000002";

interface Opts {
  /** Tables whose UPDATE resolves with an error. */
  failUpdate?: string[];
  /** Tables whose SELECT resolves with an error. */
  failSelect?: string[];
}

function makeClient(opts: Opts = {}) {
  const db: Record<string, any[]> = {
    profiles: [
      { id: ADMIN, role: "admin", account_status: "active" },
      { id: USER, role: "user", account_status: "active" },
      { id: APPLICANT, role: "user", account_status: "active" },
    ],
    local_guide_profiles: [
      { user_id: APPLICANT, status: "applicant", guide_level: 0, verified_at: null },
    ],
    hidden_gems: [
      { id: GEM, name: "Quiet courtyard", status: "pending", submitted_by: USER, city: "Lisbon", country: "PT" },
    ],
    hidden_gem_verifications: [],
    user_stamps: [
      { id: STAMP_A, user_id: USER, stamp_definition_id: "def-1", earned_at: "2026-05-02T00:00:00.000Z", is_revoked: false, revoked_at: null, revoked_reason: null,
        stamp_definitions: { slug: "lisbon", name: "Lisbon", stamp_type: "city" } },
      { id: STAMP_B, user_id: USER, stamp_definition_id: "def-2", earned_at: "2026-05-01T00:00:00.000Z", is_revoked: true, revoked_at: "2026-05-03T00:00:00.000Z", revoked_reason: "test",
        stamp_definitions: { slug: "porto", name: "Porto", stamp_type: "city" } },
      { id: "11111111-0000-4000-8000-000000000009", user_id: APPLICANT, stamp_definition_id: "def-1", earned_at: "2026-05-01T00:00:00.000Z", is_revoked: false },
    ],
    admin_access_log: [],
    feature_flags: [],
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let count = false;
    let head = false;

    const run = () => {
      if (mode === "update" && opts.failUpdate?.includes(table)) return { data: null, error: { message: `${table} update refused`, code: "42501" } };
      if (mode === "select" && opts.failSelect?.includes(table)) return { data: null, error: { message: `${table} unreadable`, code: "XX000" }, count: null };
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: `${table}-${(db[table] ??= []).length + 1}`, ...r }));
        db[table]!.push(...rows);
        return { data: rows, error: null };
      }
      const rows = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (mode === "update") rows.forEach((r) => Object.assign(r, payload));
      if (mode === "delete") db[table] = (db[table] ?? []).filter((r) => !rows.includes(r));
      return { data: head ? null : rows, error: null, count: count ? rows.length : null };
    };

    const q: any = {
      select(_c?: string, o?: { count?: string; head?: boolean }) {
        if (o?.count) count = true;
        if (o?.head) head = true;
        return q;
      },
      insert(p: any) { mode = "insert"; payload = p; return q; },
      upsert(p: any) { mode = "upsert"; payload = p; return q; },
      update(p: any) { mode = "update"; payload = p; return q; },
      delete() { mode = "delete"; return q; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return q; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return q; },
      is(c: string, v: any) { preds.push((r) => (r[c] ?? null) === v); return q; },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return q; },
      gt() { return q; }, gte() { return q; }, lte() { return q; },
      or() { return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
      maybeSingle() {
        const r = run();
        return Promise.resolve(r.error ? r : { data: (r.data as any[] | null)?.[0] ?? null, error: null });
      },
      single() {
        const r = run();
        if (r.error) return Promise.resolve(r);
        const row = (r.data as any[])[0];
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } });
      },
      then(ok: any, bad: any) { return Promise.resolve(run()).then(ok, bad); },
    };
    return q;
  }

  return {
    db,
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: any = null;
const infoLog: Array<{ obj: any; msg: string }> = [];

async function boot(client: any): Promise<string> {
  _setTestClient(client, true);
  infoLog.length = 0;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info(obj: any, msg: string) { infoLog.push({ obj, msg }); }, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", hiddenGemsRouter);
  app.use("/api", adminStampsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}/api`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  server = null;
  _setTestClient(null, false);
});

async function call(base: string, method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

describe("POST /api/admin/local-guides/:userId/status (PLAT-F38)", () => {
  it("is admin-only", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/local-guides/${APPLICANT}/status`, USER, { status: "active" });
    assert.equal(r.status, 403);
    assert.equal(c.db.local_guide_profiles[0].status, "applicant");
  });

  it("approves an applicant, stamps verified_at, and writes an audit log line", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/local-guides/${APPLICANT}/status`, ADMIN, { status: "active" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(c.db.local_guide_profiles[0].status, "active");
    assert.ok(c.db.local_guide_profiles[0].verified_at, "verified_at not set on approval");
    const audit = infoLog.find((l) => l.obj?.guideUserId === APPLICANT);
    assert.ok(audit, "the status change left no audit record");
    assert.equal(audit!.obj.adminId, ADMIN);
    assert.equal(audit!.obj.status, "active");
  });

  it("a user with NO guide profile is 404, not a silent ok", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/local-guides/${NOBODY}/status`, ADMIN, { status: "active" });
    assert.equal(r.status, 404, `approving nobody answered ${r.status} ${JSON.stringify(r.body)}`);
  });

  it("a refused UPDATE is an error, not ok", async () => {
    const c = makeClient({ failUpdate: ["local_guide_profiles"] });
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/local-guides/${APPLICANT}/status`, ADMIN, { status: "active" });
    assert.equal(r.status, 500, `a failed approval answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "db_error");
  });
});

describe("POST /api/admin/hidden-gems/:id/verify (PLAT-F39)", () => {
  it("is admin-only", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/hidden-gems/${GEM}/verify`, USER, { result: "approved" });
    assert.equal(r.status, 403);
    assert.equal(c.db.hidden_gems[0].status, "pending");
  });

  it("approving makes the gem active and records the admin verification row", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/hidden-gems/${GEM}/verify`, ADMIN, { result: "approved" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(c.db.hidden_gems[0].status, "active");
    assert.equal(c.db.hidden_gem_verifications.length, 1);
    assert.equal(c.db.hidden_gem_verifications[0].user_id, ADMIN);
  });

  it("rejecting hides it", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/hidden-gems/${GEM}/verify`, ADMIN, { result: "rejected", notes: "not a real place" });
    assert.equal(r.status, 200);
    assert.equal(c.db.hidden_gems[0].status, "hidden");
  });

  it("a gem id that matches nothing is 404, not ok", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/hidden-gems/${MISSING_GEM}/verify`, ADMIN, { result: "approved" });
    assert.equal(r.status, 404, `approving a missing gem answered ${r.status} ${JSON.stringify(r.body)}`);
  });

  it("a refused status UPDATE is an error, not ok", async () => {
    const c = makeClient({ failUpdate: ["hidden_gems"] });
    const base = await boot(c);
    const r = await call(base, "POST", `/admin/hidden-gems/${GEM}/verify`, ADMIN, { result: "approved" });
    assert.equal(r.status, 500, `a failed approve answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(c.db.hidden_gems[0].status, "pending");
  });
});

describe("GET /api/admin/stamps/users/:userId/stamps (PASS-F23)", () => {
  it("is admin-only", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "GET", `/admin/stamps/users/${USER}/stamps`, USER);
    assert.equal(r.status, 403);
  });

  it("lists that person's stamps WITH ids, revoked ones included, and audits the read", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "GET", `/admin/stamps/users/${USER}/stamps`, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body.stamps as any[]).map((s) => s.id).sort();
    assert.deepEqual(ids, [STAMP_A, STAMP_B], "the list must be exactly this user's stamps, revoked one included");
    assert.equal(r.body.total, 2);
    assert.ok((r.body.stamps as any[]).some((s) => s.is_revoked === true));
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(c.db.admin_access_log.some((row) => row.admin_id === ADMIN && row.record_id === USER),
      "the admin read of a person's stamps was not written to admin_access_log");
  });

  it("an unreadable user_stamps is an error, never an empty list", async () => {
    const c = makeClient({ failSelect: ["user_stamps"] });
    const base = await boot(c);
    const r = await call(base, "GET", `/admin/stamps/users/${USER}/stamps`, ADMIN);
    assert.equal(r.status, 500, `an outage answered ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.stamps, undefined);
  });

  it("a malformed user id is a 400", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await call(base, "GET", `/admin/stamps/users/not-a-uuid/stamps`, ADMIN);
    assert.equal(r.status, 400);
  });
});
