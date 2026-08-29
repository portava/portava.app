/**
 * POST /api/posts/:postId/hide — backend route tests
 *
 * Tests cover:
 * - Authenticated user can hide a post (upserts into post_hides, returns { hidden: true })
 * - Hiding the same post twice is idempotent (no duplicate error)
 * - Unauthenticated request returns 401
 * - DB error returns 500 with db_error code
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextUpsertError?: string; }

const CALLER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const POST_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    post_hides: tables.post_hides ?? { rows: [] },
    profiles:   tables.profiles   ?? { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    ...tables,
  };

  function chain(tableName: string) {
    const t = db[tableName] ?? { rows: [] };
    const filters: Array<(r: Row) => boolean> = [];
    let _upsert: Row | null = null;
    let _single = false;

    const obj: any = {
      select()         { return obj; },
      insert(data: Row){ _upsert = data; return obj; },
      upsert(data: Row){ _upsert = data; return obj; },
      update(data: Row){ _upsert = data; return obj; },
      delete()         { return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any){ filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]){ filters.push((r) => vals.includes(r[col])); return obj; },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return obj;
      },
      is(col: string, val: any){ filters.push((r) => r[col] === val); return obj; },
      order()          { return obj; },
      limit()          { return obj; },
      single()         { _single = true; return obj; },
      maybeSingle()    { _single = true; return obj; },
      ilike(col: string, pat: string) {
        const re = new RegExp(pat.replace(/%/g, ".*"), "i");
        filters.push((r) => re.test(String(r[col] ?? "")));
        return obj;
      },
      then(resolve: (v: any) => any) {
        // upsert
        if (_upsert !== null) {
          if (t.nextUpsertError) {
            const err = t.nextUpsertError;
            t.nextUpsertError = undefined;
            return resolve({ data: null, error: { message: err } });
          }
          const row = { ..._upsert };
          const idx = t.rows.findIndex((r) =>
            filters.every((f) => f(r))
          );
          if (idx >= 0) {
            t.rows[idx] = { ...t.rows[idx], ...row };
          } else {
            t.rows.push(row);
          }
          return resolve({ data: row, error: null });
        }
        // select
        let results = t.rows.filter((r) => filters.every((f) => f(r)));
        if (_single) {
          return resolve({ data: results[0] ?? null, error: null });
        }
        return resolve({ data: results, error: null });
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

async function req(
  server: Server,
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const port = (server.address() as any).port as number;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("POST /api/posts/:postId/hide", () => {
  let server: Server;
  let fakeDb: Record<string, FakeTable>;

  beforeEach(async () => {
    fakeDb = {
      post_hides: { rows: [] },
      profiles:   { rows: [{ id: CALLER_ID, handle: "caller", name: "Caller", role: "user" }] },
    };
    const client = makeFakeClient(fakeDb);
    _setTestClient(client as any, true);
    server = createServer(app).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    _setTestClient(null as any, false);
  });

  it("hides a post and returns { hidden: true }", async () => {
    const { status, body } = await req(server, "POST", `/api/posts/${POST_ID}/hide`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.hidden, true);
    const row = fakeDb.post_hides!.rows.find((r) => r.post_id === POST_ID && r.user_id === CALLER_ID);
    assert.ok(row, "row should be inserted into post_hides");
  });

  it("is idempotent: hiding twice does not error", async () => {
    // Pre-seed an existing hide row
    fakeDb.post_hides!.rows.push({ user_id: CALLER_ID, post_id: POST_ID, hidden_at: new Date().toISOString() });

    const { status, body } = await req(server, "POST", `/api/posts/${POST_ID}/hide`, { token: "valid" });
    assert.equal(status, 200);
    assert.equal(body.hidden, true);
  });

  it("returns 401 when no Authorization header", async () => {
    const { status } = await req(server, "POST", `/api/posts/${POST_ID}/hide`);
    assert.equal(status, 401);
  });

  it("returns 500 db_error when upsert fails", async () => {
    fakeDb.post_hides!.nextUpsertError = "duplicate key value violates unique constraint";
    const { status, body } = await req(server, "POST", `/api/posts/${POST_ID}/hide`, { token: "valid" });
    assert.equal(status, 500);
    assert.equal(body.error, "db_error");
  });
});
