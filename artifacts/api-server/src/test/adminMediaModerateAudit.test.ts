/**
 * adminMedia moderate — audit-trail coverage (AUDIT-1)
 *
 * POST /admin/media/:id/moderate flips content/report status. Every branch must
 * write an owner-scoped moderation_actions row (the same audit the admin.ts
 * report resolve/dismiss paths write), and the report branch must refuse to
 * re-moderate a terminal (resolved/dismissed) report.
 *
 * Pattern: node:test + _setTestClient / _setTestServiceClient (no live DB).
 * Run: node --import tsx/esm --test src/test/adminMediaModerateAudit.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminMediaRouter from "../routes/adminMedia.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[] }

const ADMIN_ID  = "a0000000-0000-0000-0000-000000000001";
const AUTHOR_ID  = "b0000000-0000-0000-0000-000000000002";
const MEDIA_OWNER = "c0000000-0000-0000-0000-000000000003";
const GEM_OWNER  = "d0000000-0000-0000-0000-000000000004";
const POST_ID    = "10000000-0000-0000-0000-000000000010";
const MEDIA_ID   = "20000000-0000-0000-0000-000000000020";
const GEM_ID     = "30000000-0000-0000-0000-000000000030";
const REPORT_ID  = "40000000-0000-0000-0000-000000000040";

function makeFakeClient(tables: Record<string, FakeTable>) {
  const db: Record<string, FakeTable> = {
    profiles:          tables.profiles          ?? { rows: [] },
    posts:             tables.posts             ?? { rows: [] },
    post_media:        tables.post_media        ?? { rows: [] },
    hidden_gems:       tables.hidden_gems       ?? { rows: [] },
    reports:           tables.reports           ?? { rows: [] },
    moderation_actions: tables.moderation_actions ?? { rows: [] },
    ...tables,
  };

  let idc = 0;
  const newId = () => `f0000000-0000-0000-0000-${String(++idc).padStart(12, "0")}`;

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | null = null;
    let _update: Row | null = null;
    let _single = false;
    let _maybe = false;

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }
    const filtered = () => getTable().rows.filter((r) => filters.every((f) => f(r)));

    async function resolve(): Promise<{ data: any; error: any }> {
      const t = getTable();
      if (_insert !== null) {
        const nr = { id: newId(), ...(_insert as Row) };
        t.rows.push(nr);
        return { data: _single || _maybe ? nr : [nr], error: null };
      }
      if (_update !== null) {
        const matched = filtered();
        for (const r of matched) Object.assign(r, _update);
        return { data: _single || _maybe ? (matched[0] ?? null) : matched, error: null };
      }
      const rows = filtered();
      if (_single || _maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const obj: any = {
      select() { return obj; },
      insert(d: Row) { _insert = d; return obj; },
      update(d: Row) { _update = d; return obj; },
      delete() { return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      order() { return obj; },
      limit() { return obj; },
      range() { return obj; },
      maybeSingle() { _maybe = true; return resolve(); },
      single() { _single = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };
    return obj;
  }

  return {
    from(t: string) { return chain(t); },
    auth: {
      getUser: async (token: string) =>
        token === "admin-token"
          ? { data: { user: { id: ADMIN_ID } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  } as any;
}

function startServer(tables: Record<string, FakeTable>): Promise<{ url: string; close: () => Promise<void> }> {
  const client = makeFakeClient(tables);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/", adminMediaRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections?.(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function moderate(url: string, id: string, body: unknown) {
  const res = await fetch(`${url}/admin/media/${id}/moderate`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function baseTables(extra: Record<string, FakeTable> = {}): Record<string, FakeTable> {
  return {
    profiles: { rows: [{ id: ADMIN_ID, role: "admin" }] },
    moderation_actions: { rows: [] },
    ...extra,
  };
}

describe("POST /admin/media/:id/moderate — audit trail", () => {
  let server: { url: string; close: () => Promise<void> };
  afterEach(async () => { await server?.close(); });

  it("post reject writes an owner-scoped moderation_actions row", async () => {
    const tables = baseTables({ posts: { rows: [{ id: POST_ID, author_id: AUTHOR_ID, post_status: "published" }] } });
    server = await startServer(tables);
    const { status } = await moderate(server.url, POST_ID, { action: "reject", target: "post", reason: "spam" });
    assert.equal(status, 200);
    const audits = tables.moderation_actions.rows;
    assert.equal(audits.length, 1, "exactly one audit row for a moderated post");
    assert.equal(audits[0].target_user_id, AUTHOR_ID, "audit names the post author");
    assert.equal(audits[0].action_type, "content_removed");
    assert.equal(audits[0].performed_by, ADMIN_ID);
    assert.equal(audits[0].metadata.target_type, "post");
    assert.equal(audits[0].metadata.target_id, POST_ID);
  });

  it("post_media reject (status flip) writes an owner-scoped audit row", async () => {
    const tables = baseTables({ post_media: { rows: [{ id: MEDIA_ID, user_id: MEDIA_OWNER, moderation_status: "approved" }] } });
    server = await startServer(tables);
    const { status } = await moderate(server.url, MEDIA_ID, { action: "reject", target: "post_media" });
    assert.equal(status, 200);
    const audits = tables.moderation_actions.rows;
    assert.equal(audits.length, 1, "status-flip post_media moderation must audit");
    assert.equal(audits[0].target_user_id, MEDIA_OWNER);
    assert.equal(audits[0].metadata.target_type, "post_media");
  });

  it("hidden_gem approve writes an audit row against the submitter", async () => {
    const tables = baseTables({ hidden_gems: { rows: [{ id: GEM_ID, submitted_by: GEM_OWNER, status: "pending" }] } });
    server = await startServer(tables);
    const { status } = await moderate(server.url, GEM_ID, { action: "approve", target: "hidden_gem" });
    assert.equal(status, 200);
    const audits = tables.moderation_actions.rows;
    assert.equal(audits.length, 1, "hidden_gem moderation must audit");
    assert.equal(audits[0].target_user_id, GEM_OWNER);
    assert.equal(audits[0].action_type, "content_approved");
    assert.equal(audits[0].metadata.target_type, "hidden_gem");
  });

  it("report approve audits against the reported content owner and resolves", async () => {
    const tables = baseTables({
      reports: { rows: [{ id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "open" }] },
      posts:   { rows: [{ id: POST_ID, author_id: AUTHOR_ID }] },
    });
    server = await startServer(tables);
    const { status } = await moderate(server.url, REPORT_ID, { action: "approve", target: "report" });
    assert.equal(status, 200);
    assert.equal(tables.reports.rows[0].status, "resolved");
    const audits = tables.moderation_actions.rows;
    assert.equal(audits.length, 1, "moderating a report must audit");
    assert.equal(audits[0].target_user_id, AUTHOR_ID, "audit names the reported post's author");
    assert.equal(audits[0].action_type, "report_resolved");
    assert.equal(audits[0].metadata.report_id, REPORT_ID);
  });

  it("report status guard: a resolved report cannot be re-moderated back to reviewed", async () => {
    const tables = baseTables({
      reports: { rows: [{ id: REPORT_ID, target_type: "post", target_id: POST_ID, status: "resolved" }] },
      posts:   { rows: [{ id: POST_ID, author_id: AUTHOR_ID }] },
    });
    server = await startServer(tables);
    const { status, body } = await moderate(server.url, REPORT_ID, { action: "flag", target: "report" });
    assert.equal(status, 409, "terminal report must not be re-moderated");
    assert.equal(body.error, "conflict");
    assert.equal(tables.reports.rows[0].status, "resolved", "status must be unchanged");
    assert.equal(tables.moderation_actions.rows.length, 0, "no audit row for a rejected transition");
  });
});
