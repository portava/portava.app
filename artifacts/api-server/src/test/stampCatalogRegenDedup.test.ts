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
import { wouldCreateDuplicateQueued, insertWouldViolateQueuedUnique, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";

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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
          if (
            tableName === "stamp_generation_queue" &&
            wouldCreateDuplicateQueued(rows, matched, updateValues)
          ) {
            return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
          }
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
              // Simulate the partial unique index on (catalog_id) WHERE status = 'queued'.
              if (
                tableName === "stamp_generation_queue" &&
                insertWouldViolateQueuedUnique(rows, insertRow)
              ) {
                return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
              }
              rows.push(insertRow);
              db[tableName] = rows;
              return { data: { ...insertRow }, error: null };
            }

            if (updateValues !== null) {
              const matched = rows.filter((r) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
              }
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
          if (
            tableName === "stamp_generation_queue" &&
            wouldCreateDuplicateQueued(rows, matched, updateValues)
          ) {
            return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
          }
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
              // Simulate the partial unique index on (catalog_id) WHERE status = 'queued'.
              if (
                tableName === "stamp_generation_queue" &&
                insertWouldViolateQueuedUnique(rows, insertRow)
              ) {
                return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
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
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
              }
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

  it("writes a supplementary audit entry when the catalog status reset fails", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const failEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "regenerate_catalog_reset_failed",
    );

    assert.equal(
      failEntries.length,
      1,
      `expected exactly 1 regenerate_catalog_reset_failed audit entry, found ${failEntries.length}: ${JSON.stringify(db.stamp_admin_audit_log)}`,
    );
    assert.equal(failEntries[0].admin_id, ADMIN_ID);
    assert.ok(
      typeof failEntries[0].notes === "string" && failEntries[0].notes.includes("network error"),
      `expected the failure audit entry notes to include the reset error message, got: ${JSON.stringify(failEntries[0].notes)}`,
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

// ── Double failure: catalog reset fails AND the failure-audit insert fails ───
//
// The regenerate handler writes a "regenerate_catalog_reset_failed" audit row
// when the catalog status reset errors. If that audit insert itself fails
// (e.g. DB unreachable), writeAuditLog falls back to console.error so the
// double failure is never fully silent. This client injects errors on both
// the universal_stamp_catalog update and the stamp_admin_audit_log insert.

function makeClientWithCatalogUpdateAndAuditInsertError(db: DB) {
  const inner = makeClientWithCatalogUpdateError(db);
  return {
    ...inner,
    from(tableName: string) {
      const chain = inner.from(tableName);
      if (tableName === "stamp_admin_audit_log") {
        const origInsert = chain.insert.bind(chain);
        chain.insert = (row: Record<string, any>) => {
          origInsert(row);
          // Override the thenable resolution: audit inserts always fail.
          chain.then = (resolve: any, reject: any) =>
            Promise.resolve({
              data:  null,
              error: { message: "audit db unreachable", code: "PGRST000" },
            }).then(resolve, reject);
          return chain;
        };
      }
      return chain;
    },
  };
}

describe("POST regenerate — audit insert for the reset-failure entry also fails", () => {

  beforeEach(() => {
    db = makeDb();
    const client = makeClientWithCatalogUpdateAndAuditInsertError(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("logs a console.error mentioning the failed audit write for regenerate_catalog_reset_failed, and still returns 200 { ok: true }", async () => {
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let res: { status: number; body: any };
    try {
      res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    } finally {
      console.error = origError;
    }

    // The double failure must not break the response.
    assert.equal(
      res.status,
      200,
      `expected 200 even when both the catalog reset and the audit insert fail, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });

    // writeAuditLog's console.error fallback must fire for the new action.
    const auditFailureLogs = errors
      .map((args) => args.map(String).join(" "))
      .filter(
        (msg) =>
          msg.includes("failed to write audit log entry") &&
          msg.includes("regenerate_catalog_reset_failed"),
      );
    assert.equal(
      auditFailureLogs.length,
      1,
      `expected exactly 1 console.error for the failed regenerate_catalog_reset_failed audit write, found ${auditFailureLogs.length}. All errors: ${errors.map((a) => a.map(String).join(" ")).join("\n")}`,
    );

    // The fallback log must carry enough context to act on.
    const msg = auditFailureLogs[0];
    assert.ok(msg.includes(CATALOG_ID), `expected the fallback log to include the catalog_id, got: ${msg}`);
    assert.ok(msg.includes("audit db unreachable"), `expected the fallback log to include the insert error message, got: ${msg}`);

    // Nothing was actually written to the audit table.
    assert.equal(
      db.stamp_admin_audit_log.length,
      0,
      `expected no audit rows when every audit insert fails, found ${db.stamp_admin_audit_log.length}: ${JSON.stringify(db.stamp_admin_audit_log)}`,
    );
  });

});

// ── Catalog-status scoping: only "rejected" is reset ─────────────────────────
//
// The regenerate handler resets the catalog status to "pending_artwork" only
// when the current status is "rejected" (via .eq("status", "rejected")). An
// entry that is already "pending_artwork" or "active" must not be touched by
// this update — the filter correctly scopes it out.

function makeDbWithStatus(status: string): DB {
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
        status,
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_generation_queue: [],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

describe("POST regenerate — catalog status is not reset when entry is not 'rejected'", () => {

  it("a 'pending_artwork' entry stays 'pending_artwork' after regenerate", async () => {
    db = makeDbWithStatus("pending_artwork");
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status,
      200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });

    const catalogEntry = db.universal_stamp_catalog.find((r) => r.id === CATALOG_ID);
    assert.equal(
      catalogEntry?.status,
      "pending_artwork",
      `catalog status must remain 'pending_artwork', got '${catalogEntry?.status}'`,
    );
  });

  it("an 'active' entry stays 'active' after regenerate", async () => {
    db = makeDbWithStatus("active");
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status,
      200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });

    const catalogEntry = db.universal_stamp_catalog.find((r) => r.id === CATALOG_ID);
    assert.equal(
      catalogEntry?.status,
      "active",
      `catalog status must remain 'active', got '${catalogEntry?.status}'`,
    );
  });

  it("a 'rejected' entry IS reset to 'pending_artwork' after regenerate", async () => {
    // Sanity-check the positive case: the filter does fire when status is 'rejected'.
    db = makeDbWithStatus("rejected");
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status,
      200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const catalogEntry = db.universal_stamp_catalog.find((r) => r.id === CATALOG_ID);
    assert.equal(
      catalogEntry?.status,
      "pending_artwork",
      `catalog status must be reset to 'pending_artwork' for a rejected entry, got '${catalogEntry?.status}'`,
    );
  });

  it("regenerate still queues a job and returns 200 even when catalog status is 'pending_artwork'", async () => {
    db = makeDbWithStatus("pending_artwork");
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length,
      1,
      `expected 1 queued row even when catalog is pending_artwork, found ${queued.length}`,
    );
  });

});
