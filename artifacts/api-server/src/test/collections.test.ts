/**
 * Collections & Saves — backend tests
 *
 * Tests cover:
 * - Default collection auto-created on first save
 * - Duplicate save is idempotent (no error, no duplicate row)
 * - Delete removes item from all user's collections
 * - Owner-only collection access (different user gets not_found)
 * - GET /users/me/saves correctly reports saved state
 * - Hashtag save round-trip via GET /users/me/saved-hashtags
 * - Cannot delete default collection
 * - Collection CRUD: create, rename, delete
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextInsertError?: string; }

const OWNER_ID   = "11111111-1111-1111-1111-111111111111";
const OTHER_ID   = "22222222-2222-2222-2222-222222222222";
const ENTITY_ID  = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COL_ID     = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const HASHTAG_ID = "hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh";

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    collections:     tables.collections     ?? { rows: [] },
    collection_items: tables.collection_items ?? { rows: [] },
    hashtags:        tables.hashtags        ?? { rows: [] },
    profiles:        tables.profiles        ?? { rows: [] },
    user_saves:      tables.user_saves      ?? { rows: [] },
    ...tables,
  };

  let idCounter = 0;
  function newId() {
    const n = String(++idCounter).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string, sourceRows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _upsert: { data: Row | Row[]; opts: any } | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _selectCols: string | null = null;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select(cols?: string) { _selectCols = cols ?? null; return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      upsert(data: Row | Row[], opts?: any) {
        _upsert = { data, opts: opts ?? {} };
        _insert = Array.isArray(data) ? data[0] : data;
        return obj;
      },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return obj;
      },
      lt(col: string, val: any) {
        filters.push((r) => r[col] < val);
        return obj;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return obj;
      },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return obj;
      },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      limit(n: number) { _limitN = n; return obj; },
      order(col: string, opts?: any) {
        _orderCol = col;
        _orderAsc = opts?.ascending !== false;
        return obj;
      },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function filteredRows(): Row[] {
      return getTable().rows.filter((r) => filters.every((f) => f(r)));
    }

    async function resolve(): Promise<{ data: any; error: any }> {
      const table = getTable();

      // DELETE
      if (_delete) {
        table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }

      // INSERT / UPSERT
      if (_insert !== null) {
        // Simulate a forced insert error (consumed once)
        if (table.nextInsertError) {
          const msg = table.nextInsertError;
          delete table.nextInsertError;
          return { data: null, error: { message: msg } };
        }

        const rows = Array.isArray(_insert) ? _insert : [_insert];
        const inserted: Row[] = [];

        for (const row of rows) {
          if (_upsert && _upsert.opts.onConflict) {
            const conflictCols = (_upsert.opts.onConflict as string).split(",").map((s: string) => s.trim());
            const existing = table.rows.find((r) =>
              conflictCols.every((col: string) => r[col] === row[col]),
            );
            if (existing) {
              if (_upsert.opts.ignoreDuplicates) {
                inserted.push(existing);
                continue;
              }
              Object.assign(existing, row);
              inserted.push(existing);
              continue;
            }
          }
          const newRow = { id: newId(), created_at: new Date().toISOString(), ...row };
          table.rows.push(newRow);
          inserted.push(newRow);
        }

        const result = _single || _maybeSingle ? (inserted[0] ?? null) : inserted;
        return { data: result, error: null };
      }

      // UPDATE
      if (_update !== null) {
        const matched = filteredRows();
        for (const r of matched) Object.assign(r, _update);
        const result = _single || _maybeSingle ? (matched[0] ?? null) : matched;
        return { data: result, error: null };
      }

      // SELECT
      let rows = filteredRows();
      if (_orderCol) {
        rows = [...rows].sort((a, b) => {
          if (a[_orderCol!] < b[_orderCol!]) return _orderAsc ? -1 : 1;
          if (a[_orderCol!] > b[_orderCol!]) return _orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (_limitN !== null) rows = rows.slice(0, _limitN);
      if (_single)      return { data: rows[0] ?? null, error: null };
      if (_maybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return obj;
  }

  const client: any = {
    from(table: string) {
      return chain(table, db[table]?.rows ?? []);
    },
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")  return { data: { user: { id: OWNER_ID } }, error: null };
        if (token === "other-token")  return { data: { user: { id: OTHER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
  return client;
}

function startServer(tables: Record<string, FakeTable> = {}): Promise<{
  url: string; close: () => Promise<void>;
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
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections?.();
            srv.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    srv.on("error", reject);
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Collections & Saves", () => {
  let url = "";
  let close: () => Promise<void> = async () => {};

  afterEach(async () => { await close(); });

  // ── Default collection auto-created on first save ──────────────────────────
  it("auto-creates default collection on first save", async () => {
    ({ url, close } = await startServer());

    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.equal(res.status, 200, "save should succeed");
    const body = await res.json();
    assert.equal(body.saved, true, "saved flag should be true");
    assert.ok(body.collectionId, "should return a collectionId");
  });

  // ── Duplicate save is idempotent ──────────────────────────────────────────
  it("duplicate save is idempotent — no duplicate row", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [{
          id: "item-1", collection_id: COL_ID, entity_type: "post",
          entity_id: ENTITY_ID, saved_at: new Date().toISOString(),
        }],
      },
    }));

    // Save same item again
    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.equal(res.status, 200, "idempotent save should succeed");
    const body = await res.json();
    assert.equal(body.saved, true);
  });

  // ── Delete removes item ───────────────────────────────────────────────────
  it("DELETE /saves removes item from user collections", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [{
          id: "item-1", collection_id: COL_ID, entity_type: "post",
          entity_id: ENTITY_ID, saved_at: new Date().toISOString(),
        }],
      },
    }));

    const res = await fetch(`${url}/api/saves`, {
      method: "DELETE",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, false);
  });

  // ── Owner-only collection access ──────────────────────────────────────────
  it("different user cannot access another user's collections", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
    }));

    // other-user tries to PATCH owner's collection
    const res = await fetch(`${url}/api/users/me/collections/${COL_ID}`, {
      method: "PATCH",
      headers: auth("other-token"),
      body: JSON.stringify({ name: "Hacked" }),
    });
    assert.equal(res.status, 404, "other user should get 404");
  });

  // ── GET /users/me/saves reports saved state correctly ────────────────────
  it("GET /users/me/saves returns saved=true when item is saved", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [{
          id: "item-1", collection_id: COL_ID, entity_type: "trip",
          entity_id: ENTITY_ID, saved_at: new Date().toISOString(),
        }],
      },
    }));

    const res = await fetch(
      `${url}/api/users/me/saves?entity_type=trip&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, true);
    assert.ok(body.collectionIds.includes(COL_ID));
  });

  it("GET /users/me/saves returns saved=false when not saved", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: { rows: [] },
    }));

    const res = await fetch(
      `${url}/api/users/me/saves?entity_type=trip&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, false);
    assert.deepEqual(body.collectionIds, []);
  });

  // ── Hashtag save round-trip ───────────────────────────────────────────────
  it("hashtag save round-trip — GET /users/me/saved-hashtags returns saved hashtag", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [{
          id: "item-ht", collection_id: COL_ID, entity_type: "hashtag",
          entity_id: HASHTAG_ID, saved_at: new Date().toISOString(),
        }],
      },
      hashtags: {
        rows: [{
          id: HASHTAG_ID, slug: "travel", name: "travel",
          usage_count: 42, is_blocked: false,
        }],
      },
    }));

    const res = await fetch(`${url}/api/users/me/saved-hashtags`, {
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.hashtags));
    assert.equal(body.hashtags.length, 1);
    assert.equal(body.hashtags[0].slug, "travel");
  });

  // ── Cannot delete default collection ─────────────────────────────────────
  it("cannot delete default collection", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
    }));

    const res = await fetch(`${url}/api/users/me/collections/${COL_ID}`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 403, "default collection delete should be forbidden");
  });

  // ── Collection CRUD: create and rename ────────────────────────────────────
  it("creates a collection and renames it", async () => {
    ({ url, close } = await startServer());

    const createRes = await fetch(`${url}/api/users/me/collections`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ name: "Beaches" }),
    });
    assert.equal(createRes.status, 201, "create should return 201");
    const { collection } = await createRes.json();
    assert.equal(collection.name, "Beaches");
    const newId = collection.id;

    const patchRes = await fetch(`${url}/api/users/me/collections/${newId}`, {
      method: "PATCH",
      headers: auth("owner-token"),
      body: JSON.stringify({ name: "My Beaches" }),
    });
    assert.equal(patchRes.status, 200);
    const { collection: patched } = await patchRes.json();
    assert.equal(patched.name, "My Beaches");
  });

  // ── Invalid entity_type rejected ──────────────────────────────────────────
  it("POST /saves rejects invalid entity_type", async () => {
    ({ url, close } = await startServer());
    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "banana", entity_id: ENTITY_ID }),
    });
    assert.equal(res.status, 400);
  });

  // ── isSaved hydration: GET /users/me/saves returns saved:true after save ─────
  it("GET /users/me/saves returns saved:true for a just-saved entity", async () => {
    ({ url, close } = await startServer());

    const saveRes = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.equal(saveRes.status, 200, "save should succeed");

    const checkRes = await fetch(
      `${url}/api/users/me/saves?entity_type=post&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(checkRes.status, 200);
    const { saved } = await checkRes.json();
    assert.ok(saved, "GET /users/me/saves should report saved:true after POST /saves");
  });

  // ── isSaved hydration: GET /users/me/saves returns saved:false after unsave ─
  it("GET /users/me/saves returns saved:false after DELETE /saves", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [{
          id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          collection_id: COL_ID, owner_id: OWNER_ID,
          entity_type: "event", entity_id: ENTITY_ID,
          added_at: new Date().toISOString(),
        }],
      },
    }));

    const delRes = await fetch(`${url}/api/saves`, {
      method: "DELETE",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "event", entity_id: ENTITY_ID }),
    });
    assert.equal(delRes.status, 200, "unsave should succeed");

    const checkRes = await fetch(
      `${url}/api/users/me/saves?entity_type=event&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(checkRes.status, 200);
    const { saved } = await checkRes.json();
    assert.ok(!saved, "GET /users/me/saves should report saved:false after DELETE /saves");
  });

  // ── Default collection insert failure → clear error, no partial save ─────
  it("POST /saves returns collection_create_failed when default collection insert fails", async () => {
    ({ url, close } = await startServer({
      collections: {
        rows: [],
        nextInsertError: "new row violates row-level security policy",
      },
    }));

    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.notEqual(res.status, 200, "should not succeed when collection cannot be created");
    const body = await res.json();
    assert.equal(body.error, "collection_create_failed", "error code should be collection_create_failed");
    assert.ok(
      typeof body.message === "string" && body.message.length > 0,
      "should include a message explaining the failure",
    );
  });

  it("item is not saved after collection_create_failed — GET /users/me/saves returns saved:false", async () => {
    // Shared in-memory tables so the save attempt and the check query the same state
    const tables: Record<string, FakeTable> = {
      collections: {
        rows: [],
        nextInsertError: "new row violates row-level security policy",
      },
      collection_items: { rows: [] },
    };
    ({ url, close } = await startServer(tables));

    // Attempt to save — expect failure
    const saveRes = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.notEqual(saveRes.status, 200, "save should fail");

    // Confirm nothing was written to collection_items
    assert.equal(tables.collection_items.rows.length, 0, "collection_items should remain empty");

    // GET /users/me/saves must also report saved:false (no collections means no items)
    const checkRes = await fetch(
      `${url}/api/users/me/saves?entity_type=post&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(checkRes.status, 200);
    const { saved } = await checkRes.json();
    assert.ok(!saved, "GET /users/me/saves should report saved:false after a failed POST /saves");
  });

  // ── collection_id not found → retryWithDefault hint + fallback succeeds ─────
  it("POST /saves with unknown collection_id returns retryWithDefault:true", async () => {
    const UNKNOWN_COL = "99999999-9999-9999-9999-999999999999";
    ({ url, close } = await startServer());

    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID, collection_id: UNKNOWN_COL }),
    });
    assert.equal(res.status, 404, "unknown collection should be 404");
    const body = await res.json();
    assert.equal(body.error, "not_found");
    assert.equal(body.retryWithDefault, true, "hint should be present so client can retry");
  });

  it("POST /saves fallback — retryWithDefault round-trip saves to default collection", async () => {
    const UNKNOWN_COL = "99999999-9999-9999-9999-999999999999";
    ({ url, close } = await startServer());

    // First request: unknown collection → 404 with retryWithDefault
    const firstRes = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "trip", entity_id: ENTITY_ID, collection_id: UNKNOWN_COL }),
    });
    assert.equal(firstRes.status, 404);
    const firstBody = await firstRes.json();
    assert.equal(firstBody.retryWithDefault, true);

    // Retry without collection_id (simulating what the mobile client does)
    const retryRes = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "trip", entity_id: ENTITY_ID }),
    });
    assert.equal(retryRes.status, 200, "retry to default collection should succeed");
    const retryBody = await retryRes.json();
    assert.equal(retryBody.saved, true, "item should be saved after fallback");
    assert.ok(retryBody.collectionId, "should return a collectionId from default collection");

    // Confirm the item is now findable
    const checkRes = await fetch(
      `${url}/api/users/me/saves?entity_type=trip&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(checkRes.status, 200);
    const { saved } = await checkRes.json();
    assert.ok(saved, "GET /users/me/saves should report saved:true after fallback save");
  });

  // ── Transient DB hiccup on collection_items upsert → db_error, not collection_create_failed ──
  it("POST /saves returns db_error (not collection_create_failed) when collection_items upsert fails", async () => {
    // Phase 1 (ensureDefaultCollection) will succeed because the collection already exists.
    // Phase 2 (collection_items upsert) will fail due to a simulated transient DB timeout.
    const tables: Record<string, FakeTable> = {
      collections: {
        rows: [{
          id: COL_ID, owner_id: OWNER_ID, name: "Saved",
          is_default: true, position: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      },
      collection_items: {
        rows: [],
        nextInsertError: "connection timeout — please retry",
      },
    };
    ({ url, close } = await startServer(tables));

    const res = await fetch(`${url}/api/saves`, {
      method: "POST",
      headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: ENTITY_ID }),
    });
    assert.notEqual(res.status, 200, "should not succeed when collection_items upsert fails");
    const body = await res.json();
    assert.equal(body.error, "db_error",
      "error code must be db_error (phase 2), not collection_create_failed (phase 1)");
    assert.ok(
      typeof body.message === "string" && body.message.length > 0,
      "should include a human-readable message",
    );

    // Follow-up check: item must not appear as saved
    assert.equal(tables.collection_items.rows.length, 0, "collection_items should remain empty after failed upsert");

    const checkRes = await fetch(
      `${url}/api/users/me/saves?entity_type=post&entity_id=${ENTITY_ID}`,
      { headers: auth("owner-token") },
    );
    assert.equal(checkRes.status, 200);
    const { saved } = await checkRes.json();
    assert.ok(!saved, "GET /users/me/saves should report saved:false after a failed collection_items upsert");
  });

  // ── DELETE: DB error fetching items → db_error (not silent proceed) ────────
  it("DELETE /collections/:id returns db_error when collection_items read fails before delete", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    // Inject an error on the collection_items table so the pre-delete item count query fails
    const tables: Record<string, FakeTable> = {
      collections: {
        rows: [
          {
            id: COL_ID, owner_id: OWNER_ID, name: "Saved",
            is_default: true, position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Asia Trip",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      collection_items: {
        rows: [],
        nextInsertError: "connection timeout",
      },
    };

    // Override: make the fake client return a query error for collection_items selects
    // by wrapping the standard client with a patched .from() that injects an error on
    // collection_items SELECT. We do this by creating a client whose collection_items
    // table has a select-time error injected via a custom fake.
    const selectErrClient: any = {
      from(table: string) {
        if (table === "collection_items") {
          const obj: any = {
            select() { return obj; },
            eq()     { return obj; },
            in()     { return obj; },
            order()  { return obj; },
            limit()  { return obj; },
            lt()     { return obj; },
            maybeSingle() { return Promise.resolve({ data: null, error: { message: "connection timeout" } }); },
            single()      { return Promise.resolve({ data: null, error: { message: "connection timeout" } }); },
            then(onF: any, onR: any) { return Promise.resolve({ data: null, error: { message: "connection timeout" } }).then(onF, onR); },
          };
          return obj;
        }
        // Fall through to a real fake for collections (ownership check must succeed)
        const collectionRows = tables.collections.rows;
        const filters: Array<(r: any) => boolean> = [];
        const obj: any = {
          select() { return obj; },
          eq(col: string, val: any) { filters.push((r) => r[col] === val); return obj; },
          maybeSingle() {
            const row = collectionRows.find((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: row ?? null, error: null });
          },
          then(onF: any, onR: any) {
            const rows = collectionRows.filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: rows, error: null }).then(onF, onR);
          },
        };
        return obj;
      },
      auth: {
        getUser: async (token: string) => {
          if (token === "owner-token") return { data: { user: { id: OWNER_ID } }, error: null };
          return { data: { user: null }, error: { message: "invalid" } };
        },
      },
    };

    _setTestClient(selectErrClient, true);
    const srv = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      const s = createServer(app);
      s.listen(0, "127.0.0.1", () => {
        const { port } = (s.address() as { port: number });
        s.unref();
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((res, rej) => {
            s.closeAllConnections?.();
            s.close((e?: Error) => (e ? rej(e) : res()));
          }),
        });
      });
      s.on("error", reject);
    });
    url = srv.url; close = srv.close;

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 500, "should return db_error when item count query fails");
    const body = await res.json();
    assert.equal(body.error, "db_error", "error code should be db_error not a silent proceed");
  });

  // ── DELETE non-empty collection without flag → 409 with itemCount ─────────
  it("DELETE /collections/:id with items returns 409 collection_has_items when moveItemsToDefault is absent", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    ({ url, close } = await startServer({
      collections: {
        rows: [
          {
            id: COL_ID, owner_id: OWNER_ID, name: "Saved",
            is_default: true, position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Asia Trip",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      collection_items: {
        rows: [
          { id: "item-1", collection_id: NAMED_COL, entity_type: "post", entity_id: ENTITY_ID, saved_at: new Date().toISOString() },
          { id: "item-2", collection_id: NAMED_COL, entity_type: "trip", entity_id: HASHTAG_ID, saved_at: new Date().toISOString() },
        ],
      },
    }));

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 409, "should return 409 when collection has items and no migration flag");
    const body = await res.json();
    assert.equal(body.error, "collection_has_items");
    assert.equal(body.itemCount, 2, "itemCount should reflect the number of saved items");
  });

  // ── DELETE empty collection without flag → 200 ───────────────────────────
  it("DELETE /collections/:id on an empty collection succeeds without moveItemsToDefault", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    ({ url, close } = await startServer({
      collections: {
        rows: [
          {
            id: COL_ID, owner_id: OWNER_ID, name: "Saved",
            is_default: true, position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Empty",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
    }));

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 200, "empty collection should delete without confirmation");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.itemCount, 0);
  });

  // ── DELETE with moveItemsToDefault=true → items migrated, collection gone ─
  it("DELETE /collections/:id?moveItemsToDefault=true migrates items to default collection", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const tables: Record<string, FakeTable> = {
      collections: {
        rows: [
          {
            id: COL_ID, owner_id: OWNER_ID, name: "Saved",
            is_default: true, position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Asia Trip",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      collection_items: {
        rows: [
          { id: "item-1", collection_id: NAMED_COL, entity_type: "post", entity_id: ENTITY_ID, saved_at: new Date().toISOString() },
        ],
      },
    };
    ({ url, close } = await startServer(tables));

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}?moveItemsToDefault=true`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 200, "deletion with migration should succeed");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.itemCount, 1, "itemCount should report how many items were migrated");

    // Named collection should be gone
    const remainingCols = tables.collections.rows.map((r: any) => r.id);
    assert.ok(!remainingCols.includes(NAMED_COL), "named collection should be deleted");

    // Item should now belong to the default collection
    const movedItem = tables.collection_items.rows.find(
      (r: any) => r.entity_type === "post" && r.entity_id === ENTITY_ID && r.collection_id === COL_ID,
    );
    assert.ok(movedItem, "item should be in the default collection after migration");
  });

  // ── DELETE with moveItemsToDefault=true creates default if it doesn't exist ─
  it("DELETE with moveItemsToDefault=true auto-creates default collection if absent", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const tables: Record<string, FakeTable> = {
      collections: {
        rows: [
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Asia Trip",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      collection_items: {
        rows: [
          { id: "item-1", collection_id: NAMED_COL, entity_type: "trip", entity_id: ENTITY_ID, saved_at: new Date().toISOString() },
        ],
      },
    };
    ({ url, close } = await startServer(tables));

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}?moveItemsToDefault=true`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 200, "should succeed even when default collection did not exist");
    const body = await res.json();
    assert.equal(body.ok, true);

    // A default collection should have been created
    const defaultCol = tables.collections.rows.find((r: any) => r.is_default === true && r.owner_id === OWNER_ID);
    assert.ok(defaultCol, "default collection should have been auto-created");

    // Item should be in the new default collection
    const migratedItem = tables.collection_items.rows.find(
      (r: any) => r.collection_id === defaultCol!.id && r.entity_type === "trip" && r.entity_id === ENTITY_ID,
    );
    assert.ok(migratedItem, "item should be migrated to the newly created default collection");
  });

  // ── Duplicate item already in default → idempotent migration (no error) ───
  it("DELETE with moveItemsToDefault=true is idempotent when item already exists in default", async () => {
    const NAMED_COL = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    ({ url, close } = await startServer({
      collections: {
        rows: [
          {
            id: COL_ID, owner_id: OWNER_ID, name: "Saved",
            is_default: true, position: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            id: NAMED_COL, owner_id: OWNER_ID, name: "Asia Trip",
            is_default: false, position: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      },
      collection_items: {
        rows: [
          { id: "item-named", collection_id: NAMED_COL, entity_type: "post", entity_id: ENTITY_ID, saved_at: new Date().toISOString() },
          { id: "item-default", collection_id: COL_ID, entity_type: "post", entity_id: ENTITY_ID, saved_at: new Date().toISOString() },
        ],
      },
    }));

    const res = await fetch(`${url}/api/users/me/collections/${NAMED_COL}?moveItemsToDefault=true`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    assert.equal(res.status, 200, "should succeed even when item already in default collection");
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  // ── isSaved hydration: check is scoped by entity_type ────────────────────
  it("saved:true for post entity does not bleed into event check", async () => {
    const POST_ID = "bbbbbbb1-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    ({ url, close } = await startServer());

    await fetch(`${url}/api/saves`, {
      method: "POST", headers: auth("owner-token"),
      body: JSON.stringify({ entity_type: "post", entity_id: POST_ID }),
    });

    const postCheck = await fetch(
      `${url}/api/users/me/saves?entity_type=post&entity_id=${POST_ID}`,
      { headers: auth("owner-token") },
    );
    const { saved: postSaved } = await postCheck.json();
    assert.ok(postSaved, "saved post should report saved:true");

    const eventCheck = await fetch(
      `${url}/api/users/me/saves?entity_type=event&entity_id=${POST_ID}`,
      { headers: auth("owner-token") },
    );
    const { saved: eventSaved } = await eventCheck.json();
    assert.ok(!eventSaved, "same entity_id under different entity_type should report saved:false");
  });
});
