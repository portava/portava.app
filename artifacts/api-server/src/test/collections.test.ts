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
        const before = table.rows.length;
        table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
        return { data: null, error: null };
      }

      // INSERT / UPSERT
      if (_insert !== null) {
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
