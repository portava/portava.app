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
 * - OSM save-count deduplication (trackOsmPlaceSave / trackOsmPlaceUnsave)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { trackOsmPlaceSave, trackOsmPlaceUnsave } from "../routes/wishlist.js";

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
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe("GET /api/wishlist", () => {
  let server: Server;
  beforeEach(async () => {
    _setTestClient(makeFakeClient([
      { id: "r1", user_id: USER_ID,  place_id: "p1", place_data: { id: "p1", name: "Cafe" },  list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID,  place_id: "p2", place_data: { id: "p2", name: "Beach" }, list_id: "global", saved_at: "2026-06-02T00:00:00Z" },
      { id: "r3", user_id: OTHER_ID, place_id: "p3", place_data: { id: "p3", name: "Park" },  list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
    ]), true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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
  beforeEach(async () => {
    _setTestClient(makeFakeClient([
      { id: "r1", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "global",   saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID, place_id: "p2", place_data: { id: "p2" }, list_id: "trip-abc", saved_at: "2026-06-01T00:00:00Z" },
    ]), true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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

  beforeEach(async () => {
    fakeClient = makeFakeClient();
    _setTestClient(fakeClient, true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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

  beforeEach(async () => {
    fakeClient = makeFakeClient([
      { id: "r1", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "global",   saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID, place_id: "p1", place_data: { id: "p1" }, list_id: "trip-abc", saved_at: "2026-06-01T00:00:00Z" },
    ]);
    _setTestClient(fakeClient, true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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

  beforeEach(async () => {
    fakeClient = makeFakeClient([
      { id: "r1", user_id: USER_ID,  place_id: "p1", place_data: {}, list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
      { id: "r2", user_id: USER_ID,  place_id: "p2", place_data: {}, list_id: "global", saved_at: "2026-06-02T00:00:00Z" },
      { id: "r3", user_id: OTHER_ID, place_id: "p3", place_data: {}, list_id: "global", saved_at: "2026-06-01T00:00:00Z" },
    ]);
    _setTestClient(fakeClient, true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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

  beforeEach(async () => {
    _setTestClient(makeFakeClient([], { dbError: "simulated DB failure" }), true);
    await new Promise<void>((r) => {
      server = createServer(app).listen(0, "127.0.0.1", r);
    });
  });
  afterEach(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

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

// ---------------------------------------------------------------------------
// OSM save-count deduplication
// ---------------------------------------------------------------------------
// These tests call trackOsmPlaceSave / trackOsmPlaceUnsave directly so they
// can inspect the discovery_places / discovery_place_saves state without
// needing to encode slashes in HTTP route params.
// ---------------------------------------------------------------------------

const OSM_ID   = "node/12345678";
const DP_UUID  = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const PLACE_DATA: Record<string, unknown> = { name: "Test Café", category: "food", lat: 51.5, lng: -0.1 };

/**
 * Minimal fake Supabase client that tracks discovery_places (dp),
 * discovery_place_saves (dps), and wishlist_places (wl) in memory.
 *
 * Each table is a live JS array; mutations (upsert / update / delete) are
 * applied in-place so callers can inspect state after each operation.
 */
function makeOsmFakeClient(opts: {
  dpRows?:  Row[];
  dpsRows?: Row[];
  wlRows?:  Row[];
  supportOtherUser?: boolean;
} = {}) {
  const dp:  Row[] = opts.dpRows  ? [...opts.dpRows]  : [];
  const dps: Row[] = opts.dpsRows ? [...opts.dpsRows] : [];
  const wl:  Row[] = opts.wlRows  ? [...opts.wlRows]  : [];

  function tableChain(tableRows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let _op: "select" | "upsert" | "update" | "delete" | null = null;
    let _data: Row | null = null;
    let _upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};

    let _selectAfterWrite = false;
    const obj: any = {
      select()  {
        // When chained after upsert/update/delete, select() requests the
        // affected rows back rather than switching the operation to a plain
        // SELECT.
        if (_op === "upsert" || _op === "update" || _op === "delete") { _selectAfterWrite = true; }
        else { _op = "select"; }
        return obj;
      },
      upsert(d: Row, o?: any) { _op = "upsert"; _data = d; _upsertOpts = o ?? {}; return obj; },
      update(d: Row)          { _op = "update"; _data = d; return obj; },
      delete()                { _op = "delete"; return obj; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val);   return obj; },
      order()  { return obj; },
      limit()  { return obj; },
      maybeSingle() {
        const matched = tableRows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      then(resolve: any) {
        if (_op === "upsert" && _data) {
          const conflictCols = (_upsertOpts.onConflict ?? "id").split(",").map((s) => s.trim());
          const idx = tableRows.findIndex((r) =>
            conflictCols.every((col) => r[col] !== undefined && r[col] === _data![col]),
          );
          if (idx >= 0) {
            if (!_upsertOpts.ignoreDuplicates) {
              tableRows[idx] = { ...tableRows[idx], ..._data };
            }
            // Conflict was hit — return empty so caller knows no new row was inserted.
            return resolve({ data: _selectAfterWrite ? [] : null, error: null });
          } else {
            const newRow = { id: DP_UUID, ..._data };
            tableRows.push(newRow);
            // New row inserted — return it when .select() was chained.
            return resolve({ data: _selectAfterWrite ? [newRow] : null, error: null });
          }
        }
        if (_op === "update" && _data) {
          tableRows
            .filter((r) => filters.every((f) => f(r)))
            .forEach((r) => Object.assign(r, _data));
          return resolve({ data: null, error: null });
        }
        if (_op === "delete") {
          const toRemove = tableRows.filter((r) => filters.every((f) => f(r)));
          const toRemoveSet = new Set(toRemove);
          tableRows.splice(0, tableRows.length, ...tableRows.filter((r) => !toRemoveSet.has(r)));
          // Return deleted rows when .select() was chained (mirrors .delete().select() PostgREST behaviour)
          return resolve({ data: _selectAfterWrite ? toRemove : null, error: null });
        }
        const matched = tableRows.filter((r) => filters.every((f) => f(r)));
        return resolve({ data: matched, error: null });
      },
    };
    return obj;
  }

  return {
    getDp:  () => dp,
    getDps: () => dps,
    from(table: string) {
      if (table === "discovery_places")      return tableChain(dp);
      if (table === "discovery_place_saves") return tableChain(dps);
      if (table === "wishlist_places")       return tableChain(wl);
      return tableChain([]);
    },
    rpc(fn: string, args: Record<string, any>) {
      if (fn === "decrement_discovery_place_saved_count") {
        // Mirrors GREATEST(0, saved_count - 1) evaluated against the current
        // in-memory row — each call sees the state left by any prior call, so
        // Promise.all with two concurrent unsaves correctly lands at 0.
        const row = dp.find((r) => r.id === args.p_id);
        if (row) {
          row.saved_count = Math.max(0, (row.saved_count ?? 0) - 1);
        }
        return Promise.resolve({ data: row?.saved_count ?? 0, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
    },
    auth: {
      getUser(token: string) {
        if (token === "valid-token") return Promise.resolve({ data: { user: { id: USER_ID } }, error: null });
        if (token === "other-token" && opts.supportOtherUser)
          return Promise.resolve({ data: { user: { id: OTHER_ID } }, error: null });
        return Promise.resolve({ data: { user: null }, error: { message: "invalid" } });
      },
    },
  };
}

describe("OSM save-count deduplication — trackOsmPlaceSave", () => {
  afterEach(() => { _clearTestClient(); });

  it("first save: creates a discovery_places row with saved_count=1", async () => {
    const fake = makeOsmFakeClient();
    _setTestClient(fake, true);

    await trackOsmPlaceSave(USER_ID, OSM_ID, PLACE_DATA);

    const dpRows = fake.getDp();
    assert.equal(dpRows.length, 1, "discovery_places should have one row");
    assert.equal(dpRows[0].saved_count, 1, "saved_count should be 1 after first save");
    assert.equal(dpRows[0].osm_id, OSM_ID, "osm_id should match");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 1, "discovery_place_saves should record the user");
    assert.equal(dpsRows[0].user_id, USER_ID);
  });

  it("same user saves same OSM place to a second trip: saved_count stays at 1", async () => {
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 1, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: USER_ID, place_id: DP_UUID }],
    });
    _setTestClient(fake, true);

    await trackOsmPlaceSave(USER_ID, OSM_ID, PLACE_DATA);

    const dpRows = fake.getDp();
    assert.equal(dpRows.length, 1, "no duplicate discovery_places row should be created");
    assert.equal(dpRows[0].saved_count, 1, "saved_count must not increase for the same user");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 1, "no duplicate discovery_place_saves row should be created");
  });

  it("different user saves same OSM place: saved_count becomes 2", async () => {
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 1, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: USER_ID, place_id: DP_UUID }],
    });
    _setTestClient(fake, true);

    await trackOsmPlaceSave(OTHER_ID, OSM_ID, PLACE_DATA);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 2, "saved_count should increment for a new unique user");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 2, "both users should have discovery_place_saves records");
    const userIds = dpsRows.map((r) => r.user_id);
    assert.ok(userIds.includes(USER_ID));
    assert.ok(userIds.includes(OTHER_ID));
  });
});

describe("OSM save-count deduplication — trackOsmPlaceUnsave", () => {
  afterEach(() => { _clearTestClient(); });

  it("unsave when no other lists remain: saved_count decrements to previous value", async () => {
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 1, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: USER_ID, place_id: DP_UUID }],
      wlRows:  [],
    });
    _setTestClient(fake, true);

    await trackOsmPlaceUnsave(USER_ID, OSM_ID);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 0, "saved_count should decrement to 0");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 0, "discovery_place_saves record should be removed");
  });

  it("unsave when other lists still hold the place: saved_count unchanged", async () => {
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 1, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: USER_ID, place_id: DP_UUID }],
      wlRows:  [{ user_id: USER_ID, place_id: OSM_ID, list_id: "trip-abc", place_data: {} }],
    });
    _setTestClient(fake, true);

    await trackOsmPlaceUnsave(USER_ID, OSM_ID);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 1, "saved_count must not change while another list still holds the place");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 1, "discovery_place_saves record should remain");
  });

  it("unsave by a user who never saved the place: saved_count unchanged", async () => {
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 2, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: OTHER_ID, place_id: DP_UUID }],
      wlRows:  [],
    });
    _setTestClient(fake, true);

    await trackOsmPlaceUnsave(USER_ID, OSM_ID);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 2, "saved_count must not change when user has no save record");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 1, "other user's discovery_place_saves record should be untouched");
  });

  it("same user sends two concurrent unsave calls: saved_count decrements exactly once (no double-decrement, no negative)", async () => {
    // This test simulates the race where two concurrent requests from the
    // same user both reach Step 3 before either DELETE commits.  With the
    // atomic .delete().select() pattern, exactly one call sees a non-empty
    // deleted-rows array and decrements; the other sees [] and skips.
    //
    // We run both calls via Promise.all so their awaits interleave on the
    // shared fake client — the in-memory DELETE is non-reentrant: the first
    // call to resolve removes the row; the second call finds no matching row
    // and returns an empty array, skipping the UPDATE.
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 1, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [{ user_id: USER_ID, place_id: DP_UUID }],
      wlRows:  [],
    });
    _setTestClient(fake, true);

    await Promise.all([
      trackOsmPlaceUnsave(USER_ID, OSM_ID),
      trackOsmPlaceUnsave(USER_ID, OSM_ID),
    ]);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 0, "saved_count must decrement exactly once — not double-decrement");
    assert.ok(dpRows[0].saved_count >= 0, "saved_count must never go negative");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 0, "discovery_place_saves record should be removed exactly once");
  });

  it("two different users unsave the same place concurrently: saved_count decrements to exactly 0", async () => {
    // Both users have a save record; saved_count=2.  Two concurrent unsaves
    // should each decrement by exactly 1 so the count lands at 0.
    //
    // Each DELETE targets a different (user_id, place_id) row so both succeed
    // and both enter the RPC branch.  The fake rpc() shim evaluates
    // GREATEST(0, saved_count - 1) against the current in-memory state — just
    // as the real Postgres function would evaluate it against the committed row
    // — so the two micro-task-interleaved calls each see the state left by the
    // previous call: 2→1→0.  This test verifies the atomic-decrement RPC
    // approach fixes the stale-snapshot race that previously landed at 1.
    const fake = makeOsmFakeClient({
      dpRows:  [{ id: DP_UUID, osm_id: OSM_ID, saved_count: 2, name: "Test Café", city: "", place_type: "place", category: "food", source: "osm", status: "active" }],
      dpsRows: [
        { user_id: USER_ID,  place_id: DP_UUID },
        { user_id: OTHER_ID, place_id: DP_UUID },
      ],
      wlRows: [],
    });
    _setTestClient(fake, true);

    await Promise.all([
      trackOsmPlaceUnsave(USER_ID,  OSM_ID),
      trackOsmPlaceUnsave(OTHER_ID, OSM_ID),
    ]);

    const dpRows = fake.getDp();
    assert.equal(dpRows[0].saved_count, 0, "saved_count must decrement to 0 after both users unsave");

    const dpsRows = fake.getDps();
    assert.equal(dpsRows.length, 0, "both users' discovery_place_saves records should be removed");
  });
});
