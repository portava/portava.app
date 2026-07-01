/**
 * Wishlist API — backend tests
 *
 * Covers:
 * - GET /api/wishlist returns places ordered by saved_at DESC
 * - GET /api/wishlist?list=<id> filters by list_id
 * - POST /api/wishlist upserts a place (idempotent)
 * - POST /api/wishlist rejects missing placeId / placeData
 * - DELETE /api/wishlist/:placeId removes a specific place
 * - DELETE /api/wishlist/:placeId?list=<id> scopes the delete to a list
 * - DELETE /api/wishlist clears all places for the user
 * - Unauthenticated requests return 401
 * - DB errors surface as 500
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";

type Row = Record<string, any>;

const USER_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeFakeClient(initialRows: Row[] = [], opts: { dbError?: string } = {}) {
  let rows: Row[] = [...initialRows];
  let lastUpsert: Row | null = null;
  let lastDelete: { placeId?: string; listId?: string; all?: boolean } | null = null;

  function chain(sourceRows: Row[]) {
    let filtered = [...sourceRows];
    let _delete = false;
    let _upsert: Row | null = null;
    let _ascending = true;
    let _orderCol: string | null = null;

    const obj: any = {
      select()     { return obj; },
      insert(d: Row) { return obj; },
      upsert(d: Row, _opts?: any) {
        _upsert = d;
        lastUpsert = d;
        return obj;
      },
      update(d: Row) { return obj; },
      delete()     { _delete = true; return obj; },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return obj;
      },
      order(col: string, o?: { ascending?: boolean }) {
        _orderCol = col;
        _ascending = o?.ascending ?? true;
        return obj;
      },
      limit(n: number) { filtered = filtered.slice(0, n); return obj; },
      single()      { return Promise.resolve({ data: filtered[0] ?? null, error: opts.dbError ? { message: opts.dbError } : null }); },
      maybeSingle() { return Promise.resolve({ data: filtered[0] ?? null, error: opts.dbError ? { message: opts.dbError } : null }); },
      then(resolve: any) {
        if (opts.dbError) {
          return resolve({ data: null, error: { message: opts.dbError } });
        }
        if (_delete) {
          lastDelete = { all: filtered.length === rows.length };
          rows = rows.filter((r) => !filtered.includes(r));
          return resolve({ data: null, error: null });
        }
        if (_upsert) {
          const existing = rows.findIndex(
            (r) => r.user_id === _upsert!.user_id &&
                   r.place_id === _upsert!.place_id &&
                   r.list_id === _upsert!.list_id,
          );
          if (existing >= 0) {
            rows[existing] = { ...rows[existing], ..._upsert };
          } else {
            rows.push({ id: `id-${rows.length}`, ..._upsert });
          }
          return resolve({ data: null, error: null });
        }
        if (_orderCol) {
          filtered.sort((a, b) => {
            const av = a[_orderCol!];
            const bv = b[_orderCol!];
            return _ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
          });
        }
        return resolve({ data: filtered, error: null });
      },
    };
    return obj;
  }

  return {
    getRows: () => rows,
    from(table: string) {
      return chain(table === "wishlist_places" ? rows : []);
    },
    auth: {
      getUser(_token: string) {
        if (_token === "valid-token") {
          return Promise.resolve({ data: { user: { id: USER_ID } }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "invalid token" } });
      },
    },
  };
}

async function req(
  server: Server,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const port = (server.address() as any).port as number;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/wishlist", () => {
  let server: Server;
  beforeEach((done) => {
    _setTestClient(makeFakeClient([
      { id: "r1", user_id: USER_ID,  place_id: "p1", place_data: { id: "p1", name: "Cafe" },  list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID,  place_id: "p2", place_data: { id: "p2", name: "Beach" }, list_id: "global", saved_at: "2026-06-02T00:00:00Z" },
      { id: "r3", user_id: OTHER_ID, place_id: "p3", place_data: { id: "p3", name: "Park" },  list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
    ]), true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("returns only the authenticated user's places", async () => {
    const { status, body } = await req(server, "GET", "/api/wishlist", { token: "valid-token" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.places));
    assert.equal(body.places.length, 2);
    assert.ok(body.places.every((p: any) => p.id !== "p3"));
  });

  it("includes savedAt derived from saved_at column", async () => {
    const { body } = await req(server, "GET", "/api/wishlist", { token: "valid-token" });
    assert.ok(body.places.every((p: any) => typeof p.savedAt === "number"));
  });

  it("returns 401 without a token", async () => {
    const { status } = await req(server, "GET", "/api/wishlist");
    assert.equal(status, 401);
  });
});

describe("GET /api/wishlist?list=<id>", () => {
  let server: Server;
  beforeEach((done) => {
    _setTestClient(makeFakeClient([
      { id: "r1", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "global",   saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID, place_id: "p2", place_data: { id: "p2" }, list_id: "trip-abc", saved_at: "2026-06-01T00:00:00Z" },
    ]), true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("filters by list_id", async () => {
    const { status, body } = await req(server, "GET", "/api/wishlist?list=trip-abc", { token: "valid-token" });
    assert.equal(status, 200);
    assert.equal(body.places.length, 1);
    assert.equal(body.places[0].id, "p2");
  });
});

describe("POST /api/wishlist", () => {
  let server: Server;
  let fakeClient: ReturnType<typeof makeFakeClient>;

  beforeEach((done) => {
    fakeClient = makeFakeClient();
    _setTestClient(fakeClient, true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("saves a new place and returns 201", async () => {
    const { status, body } = await req(server, "POST", "/api/wishlist", {
      token: "valid-token",
      body: { placeId: "p1", placeData: { id: "p1", name: "Cafe" }, listId: "global" },
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(fakeClient.getRows().length, 1);
  });

  it("defaults listId to 'global' when omitted", async () => {
    await req(server, "POST", "/api/wishlist", {
      token: "valid-token",
      body: { placeId: "p1", placeData: { id: "p1", name: "Cafe" } },
    });
    assert.equal(fakeClient.getRows()[0].list_id, "global");
  });

  it("is idempotent — upsert does not create a duplicate", async () => {
    const payload = { placeId: "p1", placeData: { id: "p1" }, listId: "global" };
    await req(server, "POST", "/api/wishlist", { token: "valid-token", body: payload });
    await req(server, "POST", "/api/wishlist", { token: "valid-token", body: payload });
    assert.equal(fakeClient.getRows().length, 1);
  });

  it("returns 400 when placeId is missing", async () => {
    const { status } = await req(server, "POST", "/api/wishlist", {
      token: "valid-token",
      body: { placeData: { id: "p1" } },
    });
    assert.equal(status, 400);
  });

  it("returns 400 when placeData is missing", async () => {
    const { status } = await req(server, "POST", "/api/wishlist", {
      token: "valid-token",
      body: { placeId: "p1" },
    });
    assert.equal(status, 400);
  });

  it("returns 401 without a token", async () => {
    const { status } = await req(server, "POST", "/api/wishlist", {
      body: { placeId: "p1", placeData: { id: "p1" } },
    });
    assert.equal(status, 401);
  });
});

describe("DELETE /api/wishlist/:placeId", () => {
  let server: Server;
  let fakeClient: ReturnType<typeof makeFakeClient>;

  beforeEach((done) => {
    fakeClient = makeFakeClient([
      { id: "r1", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "global",   saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "trip-abc", saved_at: "2026-06-01T00:00:00Z" },
    ]);
    _setTestClient(fakeClient, true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("removes all list entries for the place when no ?list param", async () => {
    const { status, body } = await req(server, "DELETE", "/api/wishlist/p1", { token: "valid-token" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(fakeClient.getRows().length, 0);
  });

  it("removes only the specified list entry when ?list is provided", async () => {
    const { status } = await req(server, "DELETE", "/api/wishlist/p1?list=global", { token: "valid-token" });
    assert.equal(status, 200);
    assert.equal(fakeClient.getRows().length, 1);
    assert.equal(fakeClient.getRows()[0].list_id, "trip-abc");
  });

  it("returns 401 without a token", async () => {
    const { status } = await req(server, "DELETE", "/api/wishlist/p1");
    assert.equal(status, 401);
  });
});

describe("DELETE /api/wishlist (clear all)", () => {
  let server: Server;
  let fakeClient: ReturnType<typeof makeFakeClient>;

  beforeEach((done) => {
    fakeClient = makeFakeClient([
      { id: "r1", user_id: USER_ID,  place_id: "p1", place_data: {}, list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID,  place_id: "p2", place_data: {}, list_id: "global", saved_at: "2026-06-02T00:00:00Z" },
      { id: "r3", user_id: OTHER_ID, place_id: "p3", place_data: {}, list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
    ]);
    _setTestClient(fakeClient, true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("clears all places for the authenticated user only", async () => {
    const { status, body } = await req(server, "DELETE", "/api/wishlist", { token: "valid-token" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(fakeClient.getRows().length, 1);
    assert.equal(fakeClient.getRows()[0].user_id, OTHER_ID);
  });

  it("returns 401 without a token", async () => {
    const { status } = await req(server, "DELETE", "/api/wishlist");
    assert.equal(status, 401);
  });
});

describe("DB error propagation", () => {
  let server: Server;

  beforeEach((done) => {
    _setTestClient(makeFakeClient([], { dbError: "simulated DB failure" }), true);
    server = createServer(app).listen(0, done);
  });
  afterEach((done) => { _clearTestClient(); server.close(done); });

  it("GET returns 500 on DB error", async () => {
    const { status } = await req(server, "GET", "/api/wishlist", { token: "valid-token" });
    assert.equal(status, 500);
  });

  it("POST returns 500 on DB error", async () => {
    const { status } = await req(server, "POST", "/api/wishlist", {
      token: "valid-token",
      body: { placeId: "p1", placeData: { id: "p1" } },
    });
    assert.equal(status, 500);
  });

  it("DELETE /:placeId returns 500 on DB error", async () => {
    const { status } = await req(server, "DELETE", "/api/wishlist/p1", { token: "valid-token" });
    assert.equal(status, 500);
  });
});
