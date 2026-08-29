/**
 * POST /api/posts/:postId/save and DELETE /api/posts/:postId/save — backend route tests
 *
 * Tests cover:
 * - Save: upserts into post_saves, returns { savedByMe: true, saveCount: N }
 * - Save is idempotent (duplicate calls do not error)
 * - Unsave: removes from post_saves, returns { savedByMe: false, saveCount: N }
 * - Unsave when already unsaved is idempotent (safe no-op)
 * - Post not found returns 404
 * - Private post returns 403 (cannot engage with private post)
 * - Unauthenticated request returns 401
 * - DB error on upsert returns 500 with db_error code
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextUpsertError?: string; nextDeleteError?: string; }

const CALLER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const POST_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    posts:      tables.posts      ?? { rows: [{ id: POST_ID, visibility: "public", trip_id: null, status: "active", save_count: 0 }] },
    post_saves: tables.post_saves ?? { rows: [] },
    profiles:   tables.profiles   ?? { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    ...tables,
  };

  function chain(tableName: string) {
    const t = db[tableName] ?? { rows: [] };
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | null = null;
    let _upsert: Row | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _countMode = false;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count === "exact") _countMode = true;
        return obj;
      },
      insert(data: Row) { _insert = data; return obj; },
      upsert(data: Row, _opts?: any) { _upsert = data; return obj; },
      update(data: Row) { _update = data; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        if (op === "in") {
          const ids = String(val).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim());
          filters.push((r) => !ids.includes(String(r[col])));
        }
        return obj;
      },
      is(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      order() { return obj; },
      limit() { return obj; },
      single() { _single = true; return obj; },
      maybeSingle() { _maybeSingle = true; return obj; },
      ilike(col: string, pat: string) {
        const re = new RegExp(pat.replace(/%/g, ".*"), "i");
        filters.push((r) => re.test(String(r[col] ?? "")));
        return obj;
      },
      then(resolve: (v: any) => any) {
        const match = (r: Row) => filters.every((f) => f(r));

        // delete
        if (_delete) {
          if (t.nextDeleteError) {
            const err = t.nextDeleteError;
            t.nextDeleteError = undefined;
            return resolve({ data: null, error: { message: err } });
          }
          t.rows = t.rows.filter((r) => !match(r));
          return resolve({ data: null, error: null });
        }

        // upsert / insert
        if (_upsert !== null || _insert !== null) {
          if (t.nextUpsertError) {
            const err = t.nextUpsertError;
            t.nextUpsertError = undefined;
            return resolve({ data: null, error: { message: err } });
          }
          const incoming = _upsert ?? _insert!;
          const idx = t.rows.findIndex(match);
          if (idx >= 0) {
            t.rows[idx] = { ...t.rows[idx], ...incoming };
          } else {
            t.rows.push({ ...incoming });
          }
          return resolve({ data: { ...incoming }, error: null });
        }

        // update
        if (_update !== null) {
          t.rows = t.rows.map((r) => match(r) ? { ...r, ..._update } : r);
          return resolve({ data: null, error: null });
        }

        // count mode
        if (_countMode) {
          const count = t.rows.filter(match).length;
          return resolve({ data: null, count, error: null });
        }

        // select
        const results = t.rows.filter(match);
        if (_single || _maybeSingle) {
          return resolve({ data: results[0] ?? null, error: null });
        }
        return resolve({ data: [...results], error: null });
      },
    };
    return obj;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: {
      getUser: async (token: string) => {
        if (!token || token === "bad") return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: CALLER_ID } }, error: null };
      },
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

async function apiReq(
  server: Server,
  method: string,
  path: string,
  { token }: { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const port = (server.address() as any).port as number;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("POST /api/posts/:postId/save — save a post", () => {
  let server: Server;
  let fakeDb: Record<string, FakeTable>;

  beforeEach(async () => {
    fakeDb = {
      posts:      { rows: [{ id: POST_ID, visibility: "public", trip_id: null, status: "active", save_count: 0 }] },
      post_saves: { rows: [] },
      profiles:   { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    };
    _setTestClient(makeFakeClient(fakeDb) as any, true);
    server = createServer(app).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setTestClient(null as any, false);
  });

  it("saves a post and returns { savedByMe: true }", async () => {
    const { status, body } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.savedByMe, true);
    const row = fakeDb.post_saves!.rows.find((r) => r.post_id === POST_ID && r.user_id === CALLER_ID);
    assert.ok(row, "row should be inserted into post_saves");
  });

  it("save is idempotent: second call does not error", async () => {
    fakeDb.post_saves!.rows.push({ post_id: POST_ID, user_id: CALLER_ID });
    const { status, body } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.savedByMe, true);
  });

  it("returns 404 when post does not exist", async () => {
    fakeDb.posts!.rows = [];
    const { status } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 404);
  });

  it("returns 403 when post is private", async () => {
    fakeDb.posts!.rows = [{ id: POST_ID, visibility: "private", trip_id: null, status: "active", save_count: 0 }];
    const { status } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 403);
  });

  it("returns 401 when unauthenticated", async () => {
    const { status } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`);
    assert.equal(status, 401);
  });

  it("returns 500 db_error when upsert fails", async () => {
    fakeDb.post_saves!.nextUpsertError = "connection error";
    const { status, body } = await apiReq(server, "POST", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 500);
    assert.equal(body.error, "db_error");
  });
});

describe("DELETE /api/posts/:postId/save — unsave a post", () => {
  let server: Server;
  let fakeDb: Record<string, FakeTable>;

  beforeEach(async () => {
    fakeDb = {
      posts:      { rows: [{ id: POST_ID, visibility: "public", trip_id: null, status: "active", save_count: 1 }] },
      post_saves: { rows: [{ post_id: POST_ID, user_id: CALLER_ID }] },
      profiles:   { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    };
    _setTestClient(makeFakeClient(fakeDb) as any, true);
    server = createServer(app).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setTestClient(null as any, false);
  });

  it("unsaves a post and returns { savedByMe: false }", async () => {
    const { status, body } = await apiReq(server, "DELETE", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.savedByMe, false);
    const row = fakeDb.post_saves!.rows.find((r) => r.post_id === POST_ID && r.user_id === CALLER_ID);
    assert.equal(row, undefined, "row should be removed from post_saves");
  });

  it("unsave when not saved is idempotent (no error)", async () => {
    fakeDb.post_saves!.rows = [];
    const { status, body } = await apiReq(server, "DELETE", `/api/posts/${POST_ID}/save`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.savedByMe, false);
  });

  it("returns 401 when unauthenticated", async () => {
    const { status } = await apiReq(server, "DELETE", `/api/posts/${POST_ID}/save`);
    assert.equal(status, 401);
  });
});
