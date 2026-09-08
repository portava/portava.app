/**
 * Zero matched rows reported as success — the admin and Rent-A-Buddy sites
 * (routes/admin.ts PATCH /admin/users/:userId/moderation-action,
 *  routes/admin.ts POST /admin/reports/:id/hide-content,
 *  routes/rentABuddy.ts PATCH /rent-a-buddy/admin/users/:userId/limits)
 *
 * THE CLASS
 * =========
 * An UPDATE that matches no row is not an error. PostgREST answers 204 and
 * supabase-js resolves `{ data: null, error: null }` — the same shape a
 * successful update returns. A handler that reads only `error` therefore cannot
 * tell "applied" from "matched nothing", and three high-consequence sites were
 * reporting the second as the first:
 *
 *   report_resolved   `target_ref_id` is validated as a uuid and nothing else.
 *                     An id naming no report answered sideEffects.reportStatus
 *                     = "resolved".
 *   hide-content      a report can name content that has since been
 *                     hard-deleted. `contentHidden = true` was unconditional,
 *                     and it also GATES an adjudicated content_removed Trust
 *                     penalty — so a phantom removal charged a real user.
 *   buddy limits      rent_buddy_user_limits rows are created by the sibling
 *                     POST (an upsert). PATCHing a user who has no row matched
 *                     nothing, answered {ok:true} and wrote a "limits_updated"
 *                     admin-action row while the user stayed unrestricted.
 *                     These columns ARE the restriction.
 *
 * THE FAKE
 * ========
 * Rows are real, filters are really applied, and an UPDATE resolves to the rows
 * it MATCHED — `[]` when it matched none, and `null` when `.select()` was not
 * chained. A fake that echoed the update payload back, or that only ever
 * produced `error: null`, could not express the failure under test.
 *
 * The `req.log` shim is installed on the express app below. Without it these
 * routes CRASH on `req.log.error(...)` and a 500-from-crash would masquerade as
 * a deliberate refusal, which is how a vacuous version of this test passes.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mutationAffectedRows.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import rentBuddyRouter from "../routes/rentABuddy.js";

const ADMIN_ID  = "bbbbbbbb-0000-0000-0000-000000000002";
const TARGET_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const REPORT_ID = "cccccccc-0000-0000-0000-000000000003";
const POST_ID   = "dddddddd-0000-0000-0000-000000000004";

type Row = Record<string, any>;

interface Db { tables: Record<string, Row[]>; inserts: Array<{ table: string; row: Row }> }

function makeClient(tables: Record<string, Row[]>): { db: Db; client: any } {
  const db: Db = { tables, inserts: [] };
  const src = (t: string) => (db.tables[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not() { return b; }, ilike() { return b; }, or() { return b; }, gt() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => src(table).filter((r) => preds.every((p) => p(r)));
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      if (verb === "select") { const m = match(); return { data: single ? (m[0] ?? null) : m, error: null, count: m.length }; }
      if (verb === "insert" || verb === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        for (const r of rows) { src(table).push(r); db.inserts.push({ table, row: r }); }
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      const m = match();
      if (verb === "update") for (const r of m) Object.assign(r, payload);
      else db.tables[table] = src(table).filter((r) => !m.includes(r));
      return { data: returning ? (single ? (m[0] ?? null) : m) : null, error: null, count: m.length };
    }
    return b;
  }

  return {
    db,
    client: {
      from,
      rpc: async () => ({ data: null, error: null }),
      auth: { getUser: async () => ({ data: { user: { id: ADMIN_ID } }, error: null }) },
      storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    },
  };
}

function install(tables: Record<string, Row[]>): Db {
  const { db, client } = makeClient({
    profiles: [{ id: ADMIN_ID, role: "admin", handle: "adm", display_name: "Adm" }],
    feature_flags: [],
    ...tables,
  });
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return db;
}

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The req.log shim the real server installs. Omitting it makes every route
  // that logs CRASH, and a 500-from-crash reads exactly like a refusal.
  app.use((r: any, _res: any, next: any) => {
    r.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => r.log };
    next();
  });
  app.use(adminRouter);
  app.use(rentBuddyRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed };
}

// ── report_resolved ─────────────────────────────────────────────────────────

describe("PATCH /admin/users/:userId/moderation-action — report_resolved", () => {
  it("a target_ref_id naming no report reports not_found, never resolved", async () => {
    install({ reports: [], moderation_actions: [] });

    const { status, body } = await call("PATCH", `/admin/users/${TARGET_ID}/moderation-action`, {
      action_type: "report_resolved",
      target_ref_id: REPORT_ID,
      reason: "handled",
    });

    // The request reached the handler — this is not a validation rejection.
    assert.equal(status, 200, `expected the handler to run; got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.sideEffects.reportStatus, "not_found");
    assert.notEqual(body.sideEffects.reportStatus, "resolved");
  });

  it("an existing report really is resolved", async () => {
    const db = install({
      reports: [{ id: REPORT_ID, status: "pending", reviewed_by: null }],
      moderation_actions: [],
    });

    const { status, body } = await call("PATCH", `/admin/users/${TARGET_ID}/moderation-action`, {
      action_type: "report_resolved",
      target_ref_id: REPORT_ID,
      reason: "handled",
    });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.sideEffects.reportStatus, "resolved");
    assert.equal(db.tables.reports[0].status, "resolved");
    assert.equal(db.tables.reports[0].reviewed_by, ADMIN_ID);
  });
});

// ── hide-content ────────────────────────────────────────────────────────────

describe("POST /admin/reports/:id/hide-content", () => {
  it("a report whose post no longer exists reports contentHidden:false", async () => {
    install({
      reports: [{ id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "pending" }],
      posts: [], // hard-deleted since the report was filed
      moderation_actions: [],
    });

    const { status, body } = await call("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "spam" });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(
      body.contentHidden,
      false,
      "nothing was hidden, so the admin must not be told it was — and no Trust charge may ride on it",
    );
  });

  it("an existing post is hidden and reported as hidden", async () => {
    const db = install({
      reports: [{ id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "pending" }],
      posts: [{ id: POST_ID, author_id: TARGET_ID, post_status: "active" }],
      moderation_actions: [],
      trust_events: [],
    });

    const { status, body } = await call("POST", `/admin/reports/${REPORT_ID}/hide-content`, { reason: "spam" });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.contentHidden, true);
    assert.equal(db.tables.posts[0].post_status, "removed");
  });
});

// ── Rent-A-Buddy admin limits ───────────────────────────────────────────────

describe("PATCH /rent-a-buddy/admin/users/:userId/limits", () => {
  it("a user with no limits row is refused, not silently reported restricted", async () => {
    const db = install({
      rent_buddy_user_limits: [],
      rent_buddy_admin_actions: [],
      feature_flags: [{ flag: "rent_a_buddy_enabled", enabled: true }],
    });

    const { status, body } = await call("PATCH", `/rent-a-buddy/admin/users/${TARGET_ID}/limits`, {
      rentBuddyDisabled: true,
      reason: "policy violation",
    });

    assert.equal(status, 404, `expected a refusal, got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.error, "not_found");
    assert.notEqual(body.ok, true);
    // And no audit row claiming a restriction that was never applied.
    assert.equal(
      db.tables.rent_buddy_admin_actions.length,
      0,
      "a limits_updated audit row must not record a restriction that did not happen",
    );
  });

  it("an existing limits row is updated and the restriction really lands", async () => {
    const db = install({
      rent_buddy_user_limits: [{ user_id: TARGET_ID, rent_buddy_disabled: false, reason: null }],
      rent_buddy_admin_actions: [],
      feature_flags: [{ flag: "rent_a_buddy_enabled", enabled: true }],
    });

    const { status, body } = await call("PATCH", `/rent-a-buddy/admin/users/${TARGET_ID}/limits`, {
      rentBuddyDisabled: true,
      reason: "policy violation",
    });

    assert.equal(status, 200, `got ${status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(db.tables.rent_buddy_user_limits[0].rent_buddy_disabled, true);
    assert.equal(db.tables.rent_buddy_admin_actions.length, 1);
  });
});
