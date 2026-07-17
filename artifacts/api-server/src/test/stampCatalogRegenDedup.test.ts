/**
 * Confirm clicking Regenerate twice doesn't queue the same stamp twice
 *
 * The POST /admin/stamps/catalog/:id/regenerate handler silently ignores a
 * 23505 unique-constraint error on the insert, which prevents duplicate queued
 * jobs. This test verifies that guard works: after two POST regenerate calls on
 * the same catalog entry, the stamp_generation_queue contains exactly one
 * queued row for that catalog_id, and both calls return 200.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenDedup.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID  = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID = "cccccccc-0000-4000-8000-000000000099";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(stampCatalogRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

function post(
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname:  url.hostname,
        port:      Number(url.port),
        path:      url.pathname,
        method:    "POST",
        headers: {
          authorization:    "Bearer fake-admin-token",
          "content-type":   "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

// ── Mutable in-memory fake client ────────────────────────────────────────────
//
// The insert() implementation checks for an existing queued row with the same
// catalog_id. If one exists it returns a synthetic 23505 error (unique
// constraint violation) instead of inserting — exactly what the real Postgres
// unique index would do. The route handler silently ignores 23505, so the
// second POST must still return 200 and must NOT push a second row.

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];
    let _headOnly    = false;
    let _selectCount = false;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()    { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow   = row;   return b; },

      maybeSingle() {
        const rows = db[tableName] ?? [];
        if (updateValues !== null) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          matched.forEach((r) => Object.assign(r, updateValues));
          return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      },

      single() {
        const rows    = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (matched.length === 1)
          return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({ data: null, error: { message: "No rows" } });
      },

      then(resolve: any, reject: any) {
        return Promise.resolve()
          .then(() => {
            const rows = db[tableName] ?? [];

            if (insertRow !== null) {
              // Simulate the unique constraint on (catalog_id, status='queued').
              // If a queued row already exists for this catalog_id, return a
              // 23505 conflict error instead of inserting a duplicate.
              if (
                tableName === "stamp_generation_queue" &&
                insertRow.status === "queued"
              ) {
                const duplicate = rows.find(
                  (r) => r.catalog_id === insertRow!.catalog_id && r.status === "queued",
                );
                if (duplicate) {
                  return {
                    data:  null,
                    error: {
                      code:    "23505",
                      message: "duplicate key value violates unique constraint",
                    },
                  };
                }
              }
              rows.push(insertRow);
              db[tableName] = rows;
              return { data: { ...insertRow }, error: null };
            }

            if (updateValues !== null) {
              const matched = rows.filter((r) => filters.every((f) => f(r)));
              matched.forEach((r) => Object.assign(r, updateValues));
              return { data: matched.map((r) => ({ ...r })), error: null };
            }

            const matched = rows.filter((r) => filters.every((f) => f(r)));
            if (_headOnly) return { data: null, error: null, count: matched.length };
            return {
              data:  matched.map((r) => ({ ...r })),
              error: null,
              count: _selectCount ? matched.length : undefined,
            };
          })
          .then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
  };
}

// ── DB factory ────────────────────────────────────────────────────────────────

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:paris:france",
        stamp_type:             "location",
        display_name:           "Paris",
        country:                "France",
        country_code:           "FR",
        status:                 "active",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_generation_queue: [],   // starts empty — no existing queued row
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

// ── Per-test fresh DB + client ────────────────────────────────────────────────

let db: DB;

beforeEach(() => {
  db = makeDb();
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST regenerate called twice does not queue the same stamp twice", () => {

  it("first POST regenerate returns 200 and queues one row", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status, 200,
      `first regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length,
      1,
      `expected exactly 1 queued row after first regenerate, found ${queued.length}`,
    );
  });

  it("second POST regenerate also returns 200 — 23505 is silently ignored", async () => {
    // First call — seeds the queued row
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      first.status, 200,
      `first regenerate must return 200, got ${first.status}: ${JSON.stringify(first.body)}`,
    );

    // Second call — hits the unique-constraint guard
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      second.status, 200,
      `second regenerate must also return 200 (23505 must be silently ignored), got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.deepEqual(second.body, { ok: true });
  });

  it("after two POST regenerate calls the queue has exactly one queued row for this catalog_id", async () => {
    // First call
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, `first regenerate failed: ${JSON.stringify(first.body)}`);

    // Second call
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(second.status, 200, `second regenerate failed: ${JSON.stringify(second.body)}`);

    // Queue must have exactly one queued row — no duplicates
    const allQueueRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    const queuedRows = allQueueRows.filter((r) => r.status === "queued");

    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row after two regenerate calls, found ${queuedRows.length}: ${JSON.stringify(allQueueRows)}`,
    );
  });

  it("audit log has exactly one entry for this catalog_id after two regenerate calls", async () => {
    // First call — successfully enqueues; audit log should be written
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, `first regenerate failed: ${JSON.stringify(first.body)}`);

    // Second call — hits the 23505 guard; audit log must NOT be written again
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(second.status, 200, `second regenerate failed: ${JSON.stringify(second.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "regenerate",
    );

    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry after two regenerate calls, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("first regenerate writes the audit log entry; second call (23505) writes none", async () => {
    // Before any call — log must be empty
    assert.equal(
      db.stamp_admin_audit_log.length,
      0,
      "audit log must start empty",
    );

    // After first call — exactly one entry
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      db.stamp_admin_audit_log.length,
      1,
      `expected 1 audit entry after first regenerate, found ${db.stamp_admin_audit_log.length}`,
    );

    // After second call — still exactly one entry (no duplicate)
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      db.stamp_admin_audit_log.length,
      1,
      `expected 1 audit entry after second regenerate (23505 guard), found ${db.stamp_admin_audit_log.length}`,
    );
  });

});

// ── Catalog status reset failure ──────────────────────────────────────────────
//
// The regenerate handler does NOT check the result of the
// universal_stamp_catalog status reset — the await is fire-and-forget in terms
// of error handling. The audit log is written AFTER that update, gated only on
// the queue insert result. This means:
//
//   queue insert succeeds → catalog reset fails (silently) → audit log IS written
//
// That is intentional: the audit entry records that the regeneration job was
// queued, not that the catalog status was reset. Operators can observe the
// catalog status separately. Skipping the log on catalog-reset failure would
// make the queue action invisible to operators, which is worse.

function makeClientWithCatalogUpdateError(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];
    let _headOnly    = false;
    let _selectCount = false;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()    { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow   = row;   return b; },

      maybeSingle() {
        const rows = db[tableName] ?? [];
        if (updateValues !== null) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          matched.forEach((r) => Object.assign(r, updateValues));
          return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      },

      single() {
        const rows    = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (matched.length === 1)
          return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({ data: null, error: { message: "No rows" } });
      },

      then(resolve: any, reject: any) {
        return Promise.resolve()
          .then(() => {
            const rows = db[tableName] ?? [];

            if (insertRow !== null) {
              // Simulate unique constraint on (catalog_id, status='queued')
              if (
                tableName === "stamp_generation_queue" &&
                insertRow.status === "queued"
              ) {
                const duplicate = rows.find(
                  (r) => r.catalog_id === insertRow!.catalog_id && r.status === "queued",
                );
                if (duplicate) {
                  return {
                    data:  null,
                    error: {
                      code:    "23505",
                      message: "duplicate key value violates unique constraint",
                    },
                  };
                }
              }
              rows.push(insertRow);
              db[tableName] = rows;
              return { data: { ...insertRow }, error: null };
            }

            if (updateValues !== null) {
              // Inject a network-style error for universal_stamp_catalog updates
              // to simulate RLS or transient failures on the status reset.
              if (tableName === "universal_stamp_catalog") {
                return {
                  data:  null,
                  error: { message: "network error", code: "PGRST000" },
                };
              }

              const matched = rows.filter((r) => filters.every((f) => f(r)));
              matched.forEach((r) => Object.assign(r, updateValues));
              return { data: matched.map((r) => ({ ...r })), error: null };
            }

            const matched = rows.filter((r) => filters.every((f) => f(r)));
            if (_headOnly) return { data: null, error: null, count: matched.length };
            return {
              data:  matched.map((r) => ({ ...r })),
              error: null,
              count: _selectCount ? matched.length : undefined,
            };
          })
          .then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
  };
}

describe("POST regenerate — catalog status reset fails after queue insert succeeds", () => {

  beforeEach(() => {
    db = makeDb();
    // Swap in the error-injecting client
    const client = makeClientWithCatalogUpdateError(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("still returns { ok: true } — catalog reset failure does not abort the response", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status,
      200,
      `expected 200 even when catalog update fails, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("logs a console.error when the catalog status reset fails — operators can observe the partial failure", async () => {
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    } finally {
      console.error = origError;
    }

    assert.ok(
      errors.length > 0,
      "expected at least one console.error call when catalog status reset fails, got none",
    );

    const allMessages = errors.map((args) => args.join(" ")).join("\n");
    assert.ok(
      allMessages.includes(CATALOG_ID),
      `expected console.error to include the catalog_id (${CATALOG_ID}), got: ${allMessages}`,
    );
    assert.ok(
      allMessages.includes("catalog status reset failed") || allMessages.includes("stampCatalog"),
      `expected console.error to mention catalog reset failure, got: ${allMessages}`,
    );
  });

  it("queue row is still inserted when catalog reset fails", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length,
      1,
      `expected 1 queued row even when catalog update fails, found ${queued.length}`,
    );
  });

  it("audit log is written exactly once — not skipped — when catalog reset fails (partial-success auditing)", async () => {
    // The audit log records that the regeneration job was queued successfully.
    // It does NOT depend on the catalog status reset succeeding. Skipping the
    // log on catalog-reset failure would make the queue action invisible to
    // operators, so partial-success auditing is intentional here.
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "regenerate",
    );

    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit entry when catalog reset fails (partial-success auditing is intentional), found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("audit log is not doubled when catalog reset fails and a second regenerate is called", async () => {
    // First call: queue insert succeeds, catalog reset fails, audit log written
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, `first regenerate failed: ${JSON.stringify(first.body)}`);

    // Second call: queue insert hits 23505, catalog reset still fails, audit log must NOT be written again
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(second.status, 200, `second regenerate failed: ${JSON.stringify(second.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "regenerate",
    );

    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit entry after two calls with catalog reset failing, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});
