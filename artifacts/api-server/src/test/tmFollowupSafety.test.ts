/**
 * Testing-mode follow-ups (lane tm-followups), part A — four safety and
 * honesty defects other lanes found in passing. Each case below was seen RED
 * against main 978d886bf before its fix.
 *
 * A1. POST /api/moderation/report filed `message` reports without asking
 *     whether the reporter can see the message. It now applies the same rule
 *     as lib/reportTargetAccess.ts (PR #537): an active membership in the
 *     message's thread, bound-aware; a non-member gets 404 (not an oracle), an
 *     unreadable membership read gets 503 and nothing is filed. A supplied
 *     `threadId` is held to the same membership rule, so a report cannot point
 *     moderators at a conversation the reporter is not in.
 * A2. The hidden-gem admin operations `markSensitive` and `mergeDuplicate`
 *     awaited their UPDATE and dropped the result, so a missing gem and a
 *     refused write both answered `{ ok: true }`. They now answer 404 for a
 *     missing gem (and, for a merge, a missing canonical gem) and db_error for
 *     a refused write — the pattern the fixed `recordAdminVerification` uses.
 * A3. The stamp revoke / restore admin routes answered 404 `not_found` for a
 *     database error and for a failed audit write. A database failure is now a
 *     `db_error`; only "no such stamp in that state" is 404.
 * A4. POST /admin/circle/kill-switch upserted `feature_flags` directly, so a
 *     flip of the Find Your Circle kill switch left no feature_flag_audit_log
 *     row. It now goes through `toggle_feature_flag_with_audit`, the audited
 *     path PATCH /admin/feature-flags/:flag uses.
 *
 * Run: node --import tsx/esm --test src/test/tmFollowupSafety.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import moderationRouter from "../routes/moderation.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import adminStampsRouter from "../routes/adminStamps.js";
import circleRouter from "../routes/circle.js";

const ADMIN = "adadadad-0000-4000-8000-000000000001";
const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // message sender, member
const BOB   = "bbbbbbbb-0000-4000-8000-0000000000b2"; // member
const EVE   = "eeeeeeee-0000-4000-8000-0000000000e3"; // not a member
const THREAD = "00000000-0000-4000-8000-0000000000f1";
const OTHER_THREAD = "00000000-0000-4000-8000-0000000000f9";
const MSG    = "22222222-0000-4000-8000-0000000000f2";
const GEM    = "33333333-0000-4000-8000-000000000001";
const GEM2   = "33333333-0000-4000-8000-000000000002";
const NOGEM  = "33333333-0000-4000-8000-0000000000ff";
const STAMP  = "44444444-0000-4000-8000-000000000001";

type Op = "select" | "insert" | "update" | "upsert" | "delete";
interface Fail { table: string; op?: Op; code?: string }

/** A small in-memory PostgREST double: filters, maybeSingle/single, per-table failures, rpc. */
function makeClient(seed: Record<string, any[]>, opts: {
  fail?: Fail[];
  rpc?: (name: string, args: any) => { data: any; error: any };
} = {}) {
  const db: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) db[k] = v.map((r) => ({ ...r }));
  const writes: Array<{ table: string; op: Op; payload: any }> = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let op: Op = "select";
    let payload: any = null;
    const failing = () => (opts.fail ?? []).find((f) => f.table === table && (!f.op || f.op === op));
    const run = () => {
      const f = failing();
      if (f) return { data: null, error: { message: `${table} ${op} refused`, code: f.code ?? "XX000" } };
      if (op !== "select") writes.push({ table, op, payload });
      if (op === "insert" || op === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any, i: number) => ({ id: `${table}-${(db[table] ?? []).length + i + 1}`, ...r }));
        (db[table] ??= []).push(...rows);
        return { data: rows, error: null };
      }
      const rows = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (op === "update") rows.forEach((r) => Object.assign(r, payload));
      if (op === "delete") db[table] = (db[table] ?? []).filter((r) => !rows.includes(r));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const q: any = {
      select() { return q; },
      insert(p: any) { op = "insert"; payload = p; return q; },
      upsert(p: any) { op = "upsert"; payload = p; return q; },
      update(p: any) { op = "update"; payload = p; return q; },
      delete() { op = "delete"; return q; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return q; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return q; },
      is(c: string, v: any) { preds.push((r) => (r[c] ?? null) === v); return q; },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return q; },
      gt() { return q; }, gte() { return q; }, lt() { return q; }, lte() { return q; },
      or() { return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
      maybeSingle() {
        const r = run();
        return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
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
    db, writes, rpcCalls,
    from,
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return opts.rpc ? opts.rpc(name, args) : { data: null, error: null };
    },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: Server | null = null;

async function boot(client: any, router: any): Promise<string> {
  _setTestClient(client, true);
  _setTestServiceClient(client);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as any).port}`;
}

afterEach(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null);
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function call(base: string, method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

// ── A1 ──────────────────────────────────────────────────────────────────────
function conversationSeed() {
  return {
    profiles: [ALICE, BOB, EVE].map((id) => ({ id, account_status: "active", role: "user" })),
    message_threads: [{ id: THREAD, created_by: ALICE }, { id: OTHER_THREAD, created_by: EVE }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null, visible_from_at: null },
      { thread_id: OTHER_THREAD, user_id: EVE, left_at: null, visible_from_at: null },
    ],
    messages: [{ id: MSG, thread_id: THREAD, sender_id: ALICE, created_at: "2026-05-01T00:00:00.000Z" }],
    feature_flags: [],
    moderation_reports: [],
  };
}

describe("A1 — POST /moderation/report: a message report needs a reporter who can see it", () => {
  afterEach(() => _resetRateLimit());

  it("a non-member reporting a message gets 404 and NOTHING is filed", async () => {
    const client = makeClient(conversationSeed());
    const base = await boot(client, moderationRouter);
    const r = await call(base, "POST", "/api/moderation/report", EVE, { subjectType: "message", subjectId: MSG, category: "harassment" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(client.db.moderation_reports!.length, 0, "no report row for a message the reporter cannot see");
  });

  it("a member reporting the message is filed (201), with the thread they are in", async () => {
    const client = makeClient(conversationSeed());
    const base = await boot(client, moderationRouter);
    const r = await call(base, "POST", "/api/moderation/report", BOB, { subjectType: "message", subjectId: MSG, category: "harassment", threadId: THREAD });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(client.db.moderation_reports!.length, 1);
    assert.equal(client.db.moderation_reports![0].thread_id, THREAD);
  });

  it("a member cannot attach a thread they are NOT in to the report (404, nothing filed)", async () => {
    const client = makeClient(conversationSeed());
    const base = await boot(client, moderationRouter);
    const r = await call(base, "POST", "/api/moderation/report", BOB, { subjectType: "message", subjectId: MSG, category: "harassment", threadId: OTHER_THREAD });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(client.db.moderation_reports!.length, 0);
  });

  it("an unreadable membership read is a 503, never a filed report and never a 404", async () => {
    const client = makeClient(conversationSeed(), { fail: [{ table: "message_thread_members" }] });
    const base = await boot(client, moderationRouter);
    const r = await call(base, "POST", "/api/moderation/report", BOB, { subjectType: "message", subjectId: MSG, category: "harassment" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(client.db.moderation_reports!.length, 0);
  });

  it("control: a non-conversation subject (post) is untouched by the guard", async () => {
    const seed = { ...conversationSeed(), posts: [{ id: GEM, user_id: ALICE }] };
    const client = makeClient(seed, { fail: [{ table: "message_thread_members" }] });
    const base = await boot(client, moderationRouter);
    const r = await call(base, "POST", "/api/moderation/report", EVE, { subjectType: "post", subjectId: GEM, category: "spam" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

// ── A2 ──────────────────────────────────────────────────────────────────────
function gemSeed() {
  return {
    profiles: [{ id: ADMIN, role: "admin", account_status: "active" }],
    hidden_gems: [
      { id: GEM, status: "active", sensitivity_level: "normal", merged_into: null },
      { id: GEM2, status: "active", sensitivity_level: "normal", merged_into: null },
    ],
    feature_flags: [],
  };
}

describe("A2 — hidden-gem admin writes are checked", () => {
  it("sensitive: a missing gem is 404, not { ok: true }", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${NOGEM}/sensitive`, ADMIN, { sensitivityLevel: "protected" });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.notEqual(r.body.ok, true);
  });

  it("sensitive: a refused write is db_error, not { ok: true }", async () => {
    const client = makeClient(gemSeed(), { fail: [{ table: "hidden_gems", op: "update" }] });
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM}/sensitive`, ADMIN, { sensitivityLevel: "protected" });
    assert.equal(r.body.error, "db_error", JSON.stringify(r.body));
    assert.notEqual(r.status, 200);
  });

  it("sensitive: a real gem is updated and answers ok (control)", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM}/sensitive`, ADMIN, { sensitivityLevel: "protected" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(client.db.hidden_gems!.find((g) => g.id === GEM)!.sensitivity_level, "protected");
  });

  it("merge: a missing duplicate is 404, not { ok: true }", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${NOGEM}/merge`, ADMIN, { canonicalGemId: GEM });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it("merge: a missing canonical gem is 404 and the duplicate is left alone", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM2}/merge`, ADMIN, { canonicalGemId: NOGEM });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(client.db.hidden_gems!.find((g) => g.id === GEM2)!.status, "active");
  });

  it("merge: a refused write is db_error, not { ok: true }", async () => {
    const client = makeClient(gemSeed(), { fail: [{ table: "hidden_gems", op: "update" }] });
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM2}/merge`, ADMIN, { canonicalGemId: GEM });
    assert.equal(r.body.error, "db_error", JSON.stringify(r.body));
    assert.notEqual(r.status, 200);
  });

  it("merge: a gem cannot be merged into itself (400)", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM}/merge`, ADMIN, { canonicalGemId: GEM });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(client.db.hidden_gems!.find((g) => g.id === GEM)!.status, "active");
  });

  it("merge: a real pair merges (control)", async () => {
    const client = makeClient(gemSeed());
    const base = await boot(client, hiddenGemsRouter);
    const r = await call(base, "POST", `/api/admin/hidden-gems/${GEM2}/merge`, ADMIN, { canonicalGemId: GEM });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const dup = client.db.hidden_gems!.find((g) => g.id === GEM2)!;
    assert.equal(dup.status, "merged");
    assert.equal(dup.merged_into, GEM);
  });
});

// ── A3 ──────────────────────────────────────────────────────────────────────
function stampSeed(isRevoked: boolean) {
  return {
    profiles: [{ id: ADMIN, role: "admin", account_status: "active" }],
    user_stamps: [{ id: STAMP, user_id: ALICE, stamp_definition_id: "def-1", is_revoked: isRevoked }],
    stamp_award_events: [],
    feature_flags: [],
  };
}

describe("A3 — stamp revoke / restore: a database error is not 'not found'", () => {
  for (const action of ["revoke", "restore"] as const) {
    const revokedBefore = action === "restore";

    it(`${action}: an UPDATE error is db_error, never 404`, async () => {
      const client = makeClient(stampSeed(revokedBefore), { fail: [{ table: "user_stamps", op: "update" }] });
      const base = await boot(client, adminStampsRouter);
      const r = await call(base, "POST", `/api/admin/stamps/${STAMP}/${action}`, ADMIN, { reason: "test" });
      assert.notEqual(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "db_error");
    });

    it(`${action}: a failed audit write is db_error, never 404`, async () => {
      const client = makeClient(stampSeed(revokedBefore), { fail: [{ table: "stamp_award_events", op: "insert" }] });
      const base = await boot(client, adminStampsRouter);
      const r = await call(base, "POST", `/api/admin/stamps/${STAMP}/${action}`, ADMIN, { reason: "test" });
      assert.notEqual(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body.error, "db_error");
    });

    it(`${action}: a stamp not in the right state is still 404 (control)`, async () => {
      const client = makeClient(stampSeed(!revokedBefore));
      const base = await boot(client, adminStampsRouter);
      const r = await call(base, "POST", `/api/admin/stamps/${STAMP}/${action}`, ADMIN, { reason: "test" });
      assert.equal(r.status, 404, JSON.stringify(r.body));
    });
  }
});

// ── A4 ──────────────────────────────────────────────────────────────────────
function killSwitchRpc(result: "ok" | "missing_fn" | "no_flag" | "db") {
  return (name: string, args: any) => {
    if (name !== "toggle_feature_flag_with_audit") return { data: null, error: null };
    if (result === "missing_fn") return { data: null, error: { message: "function does not exist", code: "42883" } };
    if (result === "no_flag") return { data: null, error: { message: "Flag not found", code: "P0002" } };
    if (result === "db") return { data: null, error: { message: "connection reset", code: "08006" } };
    return { data: [{ flag: args.p_flag, enabled: args.p_new_enabled, old_enabled: !args.p_new_enabled, changed_at: "2026-09-29T00:00:00Z" }], error: null };
  };
}

describe("A4 — the circle kill switch goes through the audited flag toggle", () => {
  const seed = () => ({
    profiles: [{ id: ADMIN, role: "admin", account_status: "active" }],
    feature_flags: [{ flag: "find_your_circle_disabled", enabled: false }],
    circle_audit_events: [],
  });

  it("a flip calls toggle_feature_flag_with_audit with the admin as the actor, and writes feature_flags NOWHERE else", async () => {
    const client = makeClient(seed(), { rpc: killSwitchRpc("ok") });
    const base = await boot(client, circleRouter);
    const r = await call(base, "POST", "/api/admin/circle/kill-switch", ADMIN, { enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.killSwitchEnabled, true);
    const toggles = client.rpcCalls.filter((c) => c.name === "toggle_feature_flag_with_audit");
    assert.equal(toggles.length, 1, "exactly one audited toggle");
    assert.deepEqual(toggles[0]!.args, { p_flag: "find_your_circle_disabled", p_new_enabled: true, p_changed_by_id: ADMIN });
    assert.equal(client.writes.filter((w) => w.table === "feature_flags").length, 0, "no unaudited feature_flags write");
  });

  it("a toggle failure is db_error, not 200", async () => {
    const client = makeClient(seed(), { rpc: killSwitchRpc("db") });
    const base = await boot(client, circleRouter);
    const r = await call(base, "POST", "/api/admin/circle/kill-switch", ADMIN, { enabled: true });
    assert.notEqual(r.status, 200);
    assert.equal(r.body.error, "db_error", JSON.stringify(r.body));
  });

  it("a missing audited function is a 503 naming the migration, not a silent direct write", async () => {
    const client = makeClient(seed(), { rpc: killSwitchRpc("missing_fn") });
    const base = await boot(client, circleRouter);
    const r = await call(base, "POST", "/api/admin/circle/kill-switch", ADMIN, { enabled: false });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(String(r.body.message), /0119/);
    assert.equal(client.writes.filter((w) => w.table === "feature_flags").length, 0);
  });

  it("an absent flag row is 404 (0108 seeds it; a missing row is drift, not something to invent)", async () => {
    const client = makeClient(seed(), { rpc: killSwitchRpc("no_flag") });
    const base = await boot(client, circleRouter);
    const r = await call(base, "POST", "/api/admin/circle/kill-switch", ADMIN, { enabled: true });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});
