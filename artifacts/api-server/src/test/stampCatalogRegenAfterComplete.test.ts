/**
 * Confirm a second regenerate after the first job completes doesn't silently fail
 *
 * The 23505 dedup guard only fires when a 'queued' row already exists. If the
 * first job moved to 'completed' or 'permanently_failed', the unique constraint
 * no longer blocks a second insert. A second admin regenerate after completion
 * should queue a fresh row, not be silently swallowed.
 *
 * Scenarios covered:
 *  1. Existing row is 'completed'  → insert creates a new 'queued' row
 *  2. Existing row is 'permanently_failed' → update resets it to 'queued';
 *     insert hits 23505 (silently ignored), leaving the reset row as 'queued'
 *  3. All three terminal statuses coexist (completed + retryable_failed +
 *     permanently_failed) → the .in() update targets both failed rows; the
 *     partial unique index prevents a second queued row from being written;
 *     the insert hits 23505 — net result is exactly one queued row.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenAfterComplete.test.ts
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

const ADMIN_ID   = "aaaaaaaa-0000-4000-8000-000000000001";
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
// The unique constraint on (catalog_id, status='queued') is simulated: an
// insert of a 'queued' row returns 23505 only if a row with that catalog_id
// and status='queued' already exists. Rows in 'completed' or
// 'permanently_failed' state do NOT block a fresh insert.

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];
    let _headOnly      = false;
    let _selectCount   = false;
    // Tracks whether .select() was chained after .update() — Supabase only
    // returns updated rows when .select() is explicitly requested; without it
    // the data field is null even when rows were modified.
    let _selectAfterUpdate = false;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        // If .update() was already called, this .select() is chained after it
        if (updateValues !== null)   _selectAfterUpdate = true;
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
              // Simulate the DB's partial unique index on (catalog_id) WHERE
              // status = 'queued'. If this UPDATE would produce more than one
              // 'queued' row for the same catalog_id, reject the whole statement
              // (PostgreSQL raises 23505 and rolls back every updated row).
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return {
                  data:  null,
                  error: {
                    code:    "23505",
                    message: "duplicate key value violates unique constraint",
                  },
                };
              }
              matched.forEach((r) => Object.assign(r, updateValues));
              // Match Supabase semantics: data is null unless .select() was chained
              const data = _selectAfterUpdate ? matched.map((r) => ({ ...r })) : null;
              return { data, error: null };
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

function makeCatalogRow() {
  return {
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
  };
}

function makeQueueRow(status: string): Record<string, any> {
  return {
    id:                  "qqqqqqqq-0000-4000-8000-000000000001",
    catalog_id:          CATALOG_ID,
    status,
    attempts:            3,
    requeue_count:       1,
    last_error:          status === "archived" ? null : "generation failed",
    triggered_by_action: "worker",
    priority:            0,
    created_at:          "2024-01-01T00:00:00Z",
    updated_at:          "2024-01-01T00:00:00Z",
  };
}

function makeDb(existingQueueStatus: string): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [makeCatalogRow()],
    // Pre-seed with a row in the given terminal status (not 'queued')
    stamp_generation_queue:  [makeQueueRow(existingQueueStatus)],
    stamp_artwork_versions:  [],
    stamp_admin_audit_log:   [],
  };
}

// ── Per-test fresh DB + client ────────────────────────────────────────────────

let db: DB;

function setupDb(existingStatus: string) {
  db = makeDb(existingStatus);
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Tests: existing row is 'completed' ────────────────────────────────────────

describe("POST regenerate after a completed job", () => {

  beforeEach(() => setupDb("archived"));

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status, 200,
      `regenerate after completed must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("produces exactly one queued row after regenerate", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate after completed must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row after regenerate, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the original completed row is still present alongside the new queued row", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const completedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "archived",
    );
    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );

    assert.equal(
      completedRows.length,
      1,
      `expected the completed row to remain, found ${completedRows.length}`,
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 new queued row, found ${queuedRows.length}`,
    );
  });

  it("writes exactly one audit log entry (fresh insert → state changed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry after regenerate from completed, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: existing row is 'permanently_failed' ───────────────────────────────

describe("POST regenerate after a permanently_failed job", () => {

  beforeEach(() => setupDb("permanently_failed"));

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status, 200,
      `regenerate after permanently_failed must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("produces exactly one queued row (reset from permanently_failed)", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate after permanently_failed must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row after regenerate, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the reset queued row has attempts and requeue_count zeroed out", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queuedRows.length, 1, "expected exactly 1 queued row");

    const row = queuedRows[0];
    assert.equal(
      row.attempts, 0,
      `expected attempts to be reset to 0, got ${row.attempts}`,
    );
    assert.equal(
      row.requeue_count, 0,
      `expected requeue_count to be reset to 0, got ${row.requeue_count}`,
    );
    assert.equal(
      row.last_error, null,
      `expected last_error to be cleared, got ${row.last_error}`,
    );
  });

  it("no permanently_failed rows remain after regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const failedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "permanently_failed",
    );
    assert.equal(
      failedRows.length,
      0,
      `expected no permanently_failed rows to remain, found ${failedRows.length}`,
    );
  });

  it("writes exactly one audit log entry (failed reset → state changed, 23505 notwithstanding)", async () => {
    // The route resets the permanently_failed row to queued, then the insert
    // hits 23505. The audit log must still fire because state did change.
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry after regenerate from permanently_failed, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: both a completed and a permanently_failed row exist ────────────────
//
// This is the multi-row scenario: a prior successful run left a 'completed' row
// and a subsequent run ended in 'permanently_failed' — both rows coexist. The
// reset step updates the permanently_failed row to 'queued', then the insert
// hits 23505 (the reset row now occupies the queued slot). The net result must
// be exactly one queued row and the completed row untouched.

function makeDbBothRows(): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [makeCatalogRow()],
    stamp_generation_queue: [
      {
        id:                  "qqqqqqqq-0000-4000-8000-000000000010",
        catalog_id:          CATALOG_ID,
        status:              "archived",
        attempts:            3,
        requeue_count:       1,
        last_error:          null,
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-01-01T00:00:00Z",
        updated_at:          "2024-02-01T00:00:00Z",
      },
      {
        id:                  "qqqqqqqq-0000-4000-8000-000000000011",
        catalog_id:          CATALOG_ID,
        status:              "permanently_failed",
        attempts:            5,
        requeue_count:       2,
        last_error:          "generation failed permanently",
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-03-01T00:00:00Z",
        updated_at:          "2024-03-01T00:00:00Z",
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

describe("POST regenerate when both a completed and a permanently_failed row exist", () => {

  beforeEach(() => {
    db = makeDbBothRows();
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("produces exactly one queued row afterwards", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the original completed row is untouched", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const completedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "archived",
    );
    assert.equal(
      completedRows.length,
      1,
      `expected the completed row to remain untouched, found ${completedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
    assert.equal(
      completedRows[0].id,
      "qqqqqqqq-0000-4000-8000-000000000010",
      "completed row id must not change",
    );
  });

  it("no permanently_failed rows remain after regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const failedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "permanently_failed",
    );
    assert.equal(
      failedRows.length,
      0,
      `expected no permanently_failed rows to remain, found ${failedRows.length}`,
    );
  });

  it("the queued row has attempts and requeue_count zeroed out (reset from permanently_failed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queuedRows.length, 1, "expected exactly 1 queued row");

    const row = queuedRows[0];
    assert.equal(row.attempts,      0,    `expected attempts reset to 0, got ${row.attempts}`);
    assert.equal(row.requeue_count, 0,    `expected requeue_count reset to 0, got ${row.requeue_count}`);
    assert.equal(row.last_error,    null, `expected last_error cleared, got ${row.last_error}`);
  });

  it("total queue row count for this catalog_id is exactly two (completed + queued)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const allRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      allRows.length,
      2,
      `expected 2 total rows (completed + queued), found ${allRows.length}: ${JSON.stringify(allRows)}`,
    );
  });

  it("writes exactly one audit log entry (failed reset → state changed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: both a completed and a retryable_failed row exist ─────────────────
//
// A prior successful run left a 'completed' row; a later run entered the
// retryable_failed state and was never manually retried. The reset step targets
// .in("status", ["retryable_failed", "permanently_failed"]), so it resets the
// retryable_failed row to 'queued'. The insert then hits 23505 (the reset row
// already occupies the queued slot). Net result must be exactly one queued row
// and the completed row untouched.

function makeDbCompletedAndRetryableFailed(): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [makeCatalogRow()],
    stamp_generation_queue: [
      {
        id:                  "qqqqqqqq-0000-4000-8000-000000000020",
        catalog_id:          CATALOG_ID,
        status:              "archived",
        attempts:            2,
        requeue_count:       0,
        last_error:          null,
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-01-01T00:00:00Z",
        updated_at:          "2024-02-01T00:00:00Z",
      },
      {
        id:                  "qqqqqqqq-0000-4000-8000-000000000021",
        catalog_id:          CATALOG_ID,
        status:              "retryable_failed",
        attempts:            4,
        requeue_count:       3,
        last_error:          "transient generation error",
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-03-01T00:00:00Z",
        updated_at:          "2024-03-15T00:00:00Z",
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

describe("POST regenerate when both a completed and a retryable_failed row exist", () => {

  beforeEach(() => {
    db = makeDbCompletedAndRetryableFailed();
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("produces exactly one queued row afterwards", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the original completed row is untouched", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const completedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "archived",
    );
    assert.equal(
      completedRows.length,
      1,
      `expected the completed row to remain untouched, found ${completedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
    assert.equal(
      completedRows[0].id,
      "qqqqqqqq-0000-4000-8000-000000000020",
      "completed row id must not change",
    );
  });

  it("no retryable_failed rows remain after regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const retryableRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "retryable_failed",
    );
    assert.equal(
      retryableRows.length,
      0,
      `expected no retryable_failed rows to remain, found ${retryableRows.length}`,
    );
  });

  it("the queued row has attempts and requeue_count zeroed out (reset from retryable_failed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queuedRows.length, 1, "expected exactly 1 queued row");

    const row = queuedRows[0];
    assert.equal(row.attempts,      0,    `expected attempts reset to 0, got ${row.attempts}`);
    assert.equal(row.requeue_count, 0,    `expected requeue_count reset to 0, got ${row.requeue_count}`);
    assert.equal(row.last_error,    null, `expected last_error cleared, got ${row.last_error}`);
  });

  it("total queue row count for this catalog_id is exactly two (completed + queued)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const allRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      allRows.length,
      2,
      `expected 2 total rows (completed + queued), found ${allRows.length}: ${JSON.stringify(allRows)}`,
    );
  });

  it("writes exactly one audit log entry (retryable_failed reset → state changed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: true duplicate click — queued row already exists ───────────────────
//
// When the first call already enqueued a job and a second rapid click arrives,
// the route must NOT write a second audit log entry (the first call already
// logged the action and the insert hits 23505 with no prior failed reset).

describe("POST regenerate duplicate click — queued row already present", () => {

  beforeEach(() => {
    db = makeDb("archived");   // start with completed (so first call succeeds)
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("first call returns 200 and writes one audit entry", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `first call must return 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(auditEntries.length, 1, `expected 1 audit entry after first call, got ${auditEntries.length}`);
  });

  it("second call (queued row already exists) returns 200 but does NOT write a second audit entry", async () => {
    // First call — seeds the queued row and writes audit entry
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, `first call must return 200`);

    // Second call — hits 23505 with no failed reset; must NOT add another audit row
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(second.status, 200, `second call must still return 200`);
    assert.deepEqual(second.body, { ok: true });

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit entry after duplicate click, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: all three terminal statuses coexist ────────────────────────────────
//
// The most complex edge case: completed + retryable_failed + permanently_failed
// all exist for the same catalog_id.
//
// TWO failed rows exist simultaneously. A single batch UPDATE promoting both
// to 'queued' would violate the partial unique index (PostgreSQL raises 23505
// and rolls the whole statement back), so the route archives the older failed
// row first, then resets the most recent one to queued. The subsequent INSERT
// hits 23505 (a queued row now exists) and is silently swallowed. The
// completed row is left untouched.
//
// The fake client's wouldCreateDuplicateQueued helper reproduces this
// constraint so the in-process tests match real DB behaviour.

const RETRYABLE_ID     = "qqqqqqqq-0000-4000-8000-000000000020";
const PERM_FAILED_ID   = "qqqqqqqq-0000-4000-8000-000000000021";
const COMPLETED_ID_3   = "qqqqqqqq-0000-4000-8000-000000000022";

function makeDbThreeRows(): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [makeCatalogRow()],
    stamp_generation_queue: [
      {
        id:                  COMPLETED_ID_3,
        catalog_id:          CATALOG_ID,
        status:              "archived",
        attempts:            3,
        requeue_count:       1,
        last_error:          null,
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-01-01T00:00:00Z",
        updated_at:          "2024-02-01T00:00:00Z",
      },
      {
        id:                  RETRYABLE_ID,
        catalog_id:          CATALOG_ID,
        status:              "retryable_failed",
        attempts:            3,
        requeue_count:       2,
        last_error:          "transient error",
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-03-01T00:00:00Z",
        updated_at:          "2024-03-15T00:00:00Z",
      },
      {
        id:                  PERM_FAILED_ID,
        catalog_id:          CATALOG_ID,
        status:              "permanently_failed",
        attempts:            5,
        requeue_count:       3,
        last_error:          "generation failed permanently",
        triggered_by_action: "worker",
        priority:            0,
        created_at:          "2024-04-01T00:00:00Z",
        updated_at:          "2024-04-01T00:00:00Z",
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

describe("POST regenerate when completed, retryable_failed, and permanently_failed all coexist", () => {

  beforeEach(() => {
    db = makeDbThreeRows();
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("produces exactly one queued row afterwards", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the original completed row is untouched", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    // The original archived row must still be present by its known ID.
    // We look it up by ID rather than by status because the regen also
    // archives the older failed rows, so there will be multiple 'archived' rows.
    const originalRow = db.stamp_generation_queue.find(
      (r) => r.id === COMPLETED_ID_3,
    );
    assert.ok(
      originalRow !== undefined,
      `expected the original row (${COMPLETED_ID_3}) to still be present: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
    assert.equal(originalRow.status, "archived", "original row status must remain 'archived'");
  });

  it("writes exactly one audit log entry", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: second regenerate after the three-status case ─────────────────────
//
// Chained-call edge case. After the first regenerate in the three-status
// scenario, the older failed row was archived and the most recent failed row
// was reset to queued — no failed rows remain.
//
// State before the SECOND regenerate: completed + archived + queued. There is
// nothing left to reset (hadFailedReset false) and the INSERT hits 23505.
// Net result must be exactly one queued row, and NO second audit entry
// (duplicate-click guard: queueErr set + no failed reset → skip the write).

describe("second POST regenerate after the three-status case (failed rows already cleared)", () => {

  beforeEach(() => {
    db = makeDbThreeRows();
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("first regenerate clears BOTH failed rows (older archived, newest reset to queued)", async () => {
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      first.status, 200,
      `first regenerate must return 200, got ${first.status}: ${JSON.stringify(first.body)}`,
    );

    // The handler archives the older failed row and resets the most recent
    // failed row (the permanently_failed one, created later) to queued.
    const stillFailed = db.stamp_generation_queue.filter(
      (r) =>
        r.catalog_id === CATALOG_ID &&
        (r.status === "retryable_failed" || r.status === "permanently_failed"),
    );
    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(stillFailed.length, 0, `no failed rows may remain after first call, found: ${JSON.stringify(stillFailed)}`);
    assert.equal(queued.length,      1, `expected exactly 1 queued row after first call, found ${queued.length}`);
    assert.equal(queued[0].id, PERM_FAILED_ID, "the most recent failed row must be the one reset to queued");
    assert.equal(
      db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID)?.status,
      "archived",
      "the older failed row must be archived",
    );
  });

  it("second regenerate returns 200 with { ok: true }", async () => {
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, `first regenerate must return 200`);

    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      second.status, 200,
      `second regenerate must return 200, got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.deepEqual(second.body, { ok: true });
  });

  it("still exactly one queued row after the second regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length,
      1,
      `expected exactly 1 queued row after second regenerate, found ${queued.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the completed row is still untouched after the second regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    // Look up by ID: after two regens there will be multiple 'archived' rows
    // (the original one + failed rows archived during the first regen).
    const originalRow = db.stamp_generation_queue.find(
      (r) => r.id === COMPLETED_ID_3,
    );
    assert.ok(originalRow !== undefined, `expected the original row (${COMPLETED_ID_3}) to still be present`);
    assert.equal(originalRow.status, "archived", "original row status must remain 'archived'");
  });

  it("does NOT write a second audit log entry (duplicate-click guard)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit entry after two regenerates, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});
