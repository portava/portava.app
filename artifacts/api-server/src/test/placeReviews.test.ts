/**
 * Place reviews — backend route tests
 *
 * Tests cover:
 * - POST /api/reviews with entityType='place': allowed for any authed user when place is active
 * - POST /api/reviews with entityType='place': blocked when place does not exist
 * - POST /api/reviews with entityType='place': duplicate blocked (23505)
 * - GET  /api/places/:id/reviews: returns reviews and aggregate
 * - GET  /api/places/:id/reviews: empty state (no reviews)
 * - GET  /api/places/:id/reviews: 400 for invalid UUID
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable {
  rows: Row[];
  nextInsertError?: { code?: string; message: string };
}

const USER_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_ID  = "11111111-1111-1111-1111-111111111111";
const REVIEW_ID = "22222222-2222-2222-2222-222222222222";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    reviews:             tables.reviews             ?? { rows: [] },
    discovery_places:    tables.discovery_places    ?? { rows: [] },
    profiles:            tables.profiles            ?? { rows: [] },
    trust_events:        tables.trust_events        ?? { rows: [] },
    trust_profiles:      tables.trust_profiles      ?? { rows: [] },
    trust_settings:      tables.trust_settings      ?? { rows: [] },
    trust_caps:          tables.trust_caps          ?? { rows: [] },
    feature_flags:       tables.feature_flags       ?? { rows: [] },
    notifications:       tables.notifications       ?? { rows: [] },
    ...tables,
  };

  let idCounter = 0;
  function newId() {
    const n = String(++idCounter).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string) {
    const table = db[tableName] ?? { rows: [] };
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _update: Row | null = null;
    let _rangeStart = 0;
    let _rangeEnd = 999;
    let _singleMode = false;

    const obj: any = {
      select(_cols: string) { return obj; },
      insert(row: Row | Row[]) { _insert = row; return obj; },
      update(row: Row) { _update = row; return obj; },
      upsert(row: Row | Row[], _opts?: any) { _insert = row; return obj; },
      delete() { return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      or(_cond: string) { return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      not(_col: string, _op: string, _val: any) { return obj; },
      ilike(_col: string, _pat: string) { return obj; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return obj; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return obj; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return obj; },
      is(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      order(_col: string, _opts?: any) { return obj; },
      limit(_n: number) { return obj; },
      range(from: number, to: number) { _rangeStart = from; _rangeEnd = to; return obj; },
      single() { _singleMode = true; return obj; },
      maybeSingle() { _singleMode = true; return obj; },
      then(resolve: any, reject: any) {
        try {
          if (_insert !== null) {
            if (table.nextInsertError) {
              const err = table.nextInsertError;
              table.nextInsertError = undefined;
              return resolve({ data: null, error: err });
            }
            const rows = Array.isArray(_insert) ? _insert : [_insert];
            const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
            table.rows.push(...inserted);
            // Respect .single() chained after .insert().select()
            return resolve({ data: _singleMode ? (inserted[0] ?? null) : inserted, error: null });
          }
          if (_update !== null) {
            const matched = table.rows.filter((r) => filters.every((f) => f(r)));
            matched.forEach((r) => Object.assign(r, _update));
            return resolve({ data: matched, error: null });
          }
          let matched = table.rows.filter((r) => filters.every((f) => f(r)));
          matched = matched.slice(_rangeStart, _rangeEnd + 1);
          if (_singleMode) {
            return resolve({ data: matched[0] ?? null, error: null });
          }
          return resolve({ data: matched, error: null });
        } catch (e) {
          return reject ? reject(e) : resolve({ data: null, error: e });
        }
      },
    };
    return obj;
  }

  return {
    auth: {
      getUser: (token: string) =>
        token === "valid-token"
          ? Promise.resolve({ data: { user: { id: USER_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "invalid" } }),
    },
    from: (t: string) => chain(t),
  };
}

function startServer(tables: Record<string, FakeTable> = {}): Promise<{
  url: string; close: () => Promise<void>; client: any;
}> {
  const client = makeFakeClient(tables);
  _setTestClient(client, true);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        url: `http://127.0.0.1:${port}`,
        client,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections?.();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function fetchGet(url: string, path: string, token: string) {
  const res = await fetch(`${url}${path}`, { headers: authHeader(token) });
  return { status: res.status, body: await res.json() };
}

async function fetchPost(url: string, path: string, token: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: authHeader(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/reviews — place entity", () => {
  it("allows authenticated user to review an active place", async () => {
    const { url, close } = await startServer({
      discovery_places: { rows: [{ id: PLACE_ID, status: "active" }] },
      reviews: { rows: [] },
    });
    try {
      const res = await fetchPost(url, "/api/reviews", "valid-token", {
        entityType: "place",
        entityId:   PLACE_ID,
        rating:     5,
        body:       "Amazing spot!",
        tags:       ["friendly"],
        anonymous:  false,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.rating, 5);
    } finally { await close(); }
  });

  it("blocks review when place does not exist", async () => {
    const { url, close } = await startServer({
      discovery_places: { rows: [] },
    });
    try {
      const res = await fetchPost(url, "/api/reviews", "valid-token", {
        entityType: "place",
        entityId:   PLACE_ID,
        rating:     4,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, "review_not_eligible");
    } finally { await close(); }
  });

  it("blocks review when place status is not active", async () => {
    const { url, close } = await startServer({
      discovery_places: { rows: [{ id: PLACE_ID, status: "pending" }] },
    });
    try {
      const res = await fetchPost(url, "/api/reviews", "valid-token", {
        entityType: "place",
        entityId:   PLACE_ID,
        rating:     3,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, "review_not_eligible");
    } finally { await close(); }
  });

  it("blocks duplicate review (23505 unique constraint)", async () => {
    const { url, close } = await startServer({
      discovery_places: { rows: [{ id: PLACE_ID, status: "active" }] },
      reviews: {
        rows: [],
        nextInsertError: { code: "23505", message: "duplicate key value violates unique constraint" },
      },
    });
    try {
      const res = await fetchPost(url, "/api/reviews", "valid-token", {
        entityType: "place",
        entityId:   PLACE_ID,
        rating:     4,
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "duplicate_review");
    } finally { await close(); }
  });

  it("requires authentication", async () => {
    const { url, close } = await startServer();
    try {
      const res = await fetchPost(url, "/api/reviews", "", {
        entityType: "place", entityId: PLACE_ID, rating: 4,
      });
      assert.equal(res.status, 401);
    } finally { await close(); }
  });
});

describe("GET /api/places/:id/reviews", () => {
  it("returns reviews and aggregate for a place with reviews", async () => {
    const { url, close } = await startServer({
      reviews: {
        rows: [
          {
            id: REVIEW_ID, entity_type: "place", entity_id: PLACE_ID, rating: 5,
            body: "Great place!", tags: ["friendly"], visibility: "public",
            state: "published", reviewer_id: USER_ID, created_at: new Date().toISOString(),
            profiles: { handle: "alice", display_name: "Alice", avatar_url: null },
          },
          {
            id: "33333333-3333-3333-3333-333333333333", entity_type: "place",
            entity_id: PLACE_ID, rating: 3, body: null, tags: [],
            visibility: "public", state: "published",
            reviewer_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            created_at: new Date().toISOString(),
            profiles: { handle: "bob", display_name: "Bob", avatar_url: null },
          },
        ],
      },
    });
    try {
      const res = await fetchGet(url, `/api/places/${PLACE_ID}/reviews`, "valid-token");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.reviews.length, 2);
      assert.equal(typeof res.body.avgRating, "number");
      assert.equal(res.body.total, 2);
      assert.equal(res.body.page, 1);
    } finally { await close(); }
  });

  it("returns empty list and null avgRating when no reviews exist", async () => {
    const { url, close } = await startServer({ reviews: { rows: [] } });
    try {
      const res = await fetchGet(url, `/api/places/${PLACE_ID}/reviews`, "valid-token");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.reviews, []);
      assert.equal(res.body.avgRating, null);
      assert.equal(res.body.total, 0);
    } finally { await close(); }
  });

  it("anonymises reviewer when visibility=anonymous", async () => {
    const { url, close } = await startServer({
      reviews: {
        rows: [{
          id: REVIEW_ID, entity_type: "place", entity_id: PLACE_ID, rating: 4,
          body: "Nice", tags: [], visibility: "anonymous", state: "published",
          reviewer_id: USER_ID, created_at: new Date().toISOString(),
          profiles: { handle: "alice", display_name: "Alice", avatar_url: null },
        }],
      },
    });
    try {
      const res = await fetchGet(url, `/api/places/${PLACE_ID}/reviews`, "valid-token");
      assert.equal(res.status, 200);
      assert.equal(res.body.reviews[0].anonymous, true);
      assert.equal(res.body.reviews[0].reviewer, null);
    } finally { await close(); }
  });

  it("returns 400 for invalid UUID", async () => {
    const { url, close } = await startServer();
    try {
      const res = await fetchGet(url, "/api/places/not-a-uuid/reviews", "valid-token");
      assert.equal(res.status, 400);
    } finally { await close(); }
  });

  it("allows public read without authentication", async () => {
    const { url, close } = await startServer({ reviews: { rows: [] } });
    try {
      // GET place reviews is a public endpoint — no token required
      const res = await fetchGet(url, `/api/places/${PLACE_ID}/reviews`, "");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.reviews, []);
    } finally { await close(); }
  });
});
