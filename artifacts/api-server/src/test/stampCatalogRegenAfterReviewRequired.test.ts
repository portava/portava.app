/**
 * Confirm regenerate after a review_required job archives it and queues a fresh row
 *
 * The regenerate handler has a separate archive step for review_required rows
 * (before the standard failed-reset and insert). If the archive step silently
 * fails or the insert is blocked, the admin gets a false 200 with no new work
 * queued. This test confirms the happy path: the review_required row is
 * archived and a new queued row is inserted.
 *
 * Scenarios covered:
 *  1. The review_required row is archived (status → "archived")
 *  2. A new queued row exists for the same catalog_id after regenerate
 *  3. Returns 200 { ok: true }
 *  4. Writes exactly one audit log entry (fresh insert → state changed)
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenAfterReviewRequired.test.ts
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
const CATALOG_ID = "cccccccc-0000-4000-8000-000000000088";

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
// The archive step targets rows where status = 'review_required'. The unique
// constraint on (catalog_id, status='queued') is simulated: an insert of a
// 'queued' row returns 23505 only if a row with that catalog_id and
// status='queued' already exists. A 'review_required' row does NOT block a
// fresh insert because the constraint only covers 'queued'.

type DB = Record<string, any[]>;

interface ClientOptions {
  /**
   * When set, the update of stamp_generation_queue rows with
   * status = "review_required" will return this error instead of
   * mutating the DB — simulating a silent DB failure on the archive step.
   */
  archiveReviewRequiredError?: { code: string; message: string };
}

function makeClient(db: DB, clientOpts: ClientOptions = {}) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];
    // Track raw eq values so we can detect the review_required archive call
    const eqValues: Record<string, any>          = {};
    let _headOnly          = false;
    let _selectCount       = false;
    let _selectAfterUpdate = false;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        if (updateValues !== null)   _selectAfterUpdate = true;
        return b;
      },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        eqValues[col] = val;
        return b;
      },
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
              // Inject error for the review_required archive step if requested.
              // The archive update is identified by:
              //   table = stamp_generation_queue, eq status = "review_required"
              if (
                clientOpts.archiveReviewRequiredError &&
                tableName === "stamp_generation_queue" &&
                eqValues["status"] === "review_required"
              ) {
                return { data: null, error: clientOpts.archiveReviewRequiredError };
              }

              const matched = rows.filter((r) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
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
    canonical_location_key: "city:rome:italy",
    stamp_type:             "location",
    display_name:           "Rome",
    country:                "Italy",
    country_code:           "IT",
    status:                 "active",
    active_version_id:      null,
    earn_count:             0,
    created_at:             "2024-01-01T00:00:00Z",
    updated_at:             "2024-01-01T00:00:00Z",
  };
}

function makeReviewRequiredQueueRow(): Record<string, any> {
  return {
    id:                  "rrrrrrrr-0000-4000-8000-000000000001",
    catalog_id:          CATALOG_ID,
    status:              "review_required",
    attempts:            1,
    requeue_count:       0,
    last_error:          null,
    triggered_by_action: "worker",
    priority:            0,
    created_at:          "2024-01-01T00:00:00Z",
    updated_at:          "2024-01-01T00:00:00Z",
  };
}

function makeDb(): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [makeCatalogRow()],
    stamp_generation_queue:  [makeReviewRequiredQueueRow()],
    stamp_artwork_versions:  [],
    stamp_admin_audit_log:   [],
  };
}

// ── Per-test fresh DB + client ────────────────────────────────────────────────

let db: DB;

function setupDb() {
  db = makeDb();
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST regenerate after a review_required job", () => {

  beforeEach(() => setupDb());

  it("returns 200 with { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status, 200,
      `regenerate after review_required must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("archives the review_required row (status → 'archived')", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const reviewRequiredRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "review_required",
    );
    assert.equal(
      reviewRequiredRows.length,
      0,
      `expected no review_required rows to remain after regenerate, found ${reviewRequiredRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );

    const archivedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "archived",
    );
    assert.equal(
      archivedRows.length,
      1,
      `expected exactly 1 archived row after regenerate, found ${archivedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("produces exactly one new queued row after regenerate", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row after regenerate, found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the new queued row has higher priority (admin-triggered)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queuedRows.length, 1, "expected exactly 1 queued row");

    const row = queuedRows[0];
    assert.equal(
      row.priority, 1,
      `expected priority 1 (admin-triggered), got ${row.priority}`,
    );
    assert.ok(
      typeof row.triggered_by_action === "string" &&
        row.triggered_by_action.startsWith("admin_regenerate:"),
      `expected triggered_by_action to start with 'admin_regenerate:', got ${row.triggered_by_action}`,
    );
  });

  it("the archived row and the new queued row are distinct rows", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const allRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    // There should be 2 rows: the original (now archived) and the new queued one
    assert.equal(
      allRows.length,
      2,
      `expected 2 rows total (archived + queued), found ${allRows.length}: ${JSON.stringify(allRows)}`,
    );

    const archivedRows = allRows.filter((r) => r.status === "archived");
    const queuedRows   = allRows.filter((r) => r.status === "queued");
    assert.equal(archivedRows.length, 1, "expected exactly 1 archived row");
    assert.equal(queuedRows.length,   1, "expected exactly 1 queued row");
  });

  it("writes exactly one audit log entry (fresh insert → state changed)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit log entry after regenerate from review_required, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

});

// ── Tests: duplicate click after review_required is archived ──────────────────
//
// When the first regenerate call archives the review_required row and inserts a
// new queued row, a rapid second click finds no review_required row to archive
// (the archive step is a no-op) and then hits the 23505 dedup guard on insert.
// The net result must still be exactly 1 queued row, 1 archived row, and the
// second call must NOT write a second audit log entry.

describe("POST regenerate duplicate click after review_required is archived", () => {

  beforeEach(() => setupDb());

  it("first call returns 200 and writes exactly one audit entry", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `first call must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected 1 audit entry after first call, got ${auditEntries.length}`,
    );
  });

  it("second call (queued row already exists) returns 200 but does NOT write a second audit entry", async () => {
    // First call — archives review_required, inserts queued row, writes audit entry
    const first = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(first.status, 200, "first call must return 200");

    // Second call — archive step finds no review_required row (no-op), insert
    // hits 23505; must NOT add a second audit entry
    const second = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(second.status, 200, "second call must still return 200");
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

  it("DB contains exactly 1 queued row and 1 archived row after duplicate click", async () => {
    // First call
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    // Second call (duplicate)
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const allRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      allRows.length,
      2,
      `expected exactly 2 rows total after duplicate click, found ${allRows.length}: ${JSON.stringify(allRows)}`,
    );

    const archivedRows = allRows.filter((r) => r.status === "archived");
    const queuedRows   = allRows.filter((r) => r.status === "queued");
    assert.equal(
      archivedRows.length,
      1,
      `expected exactly 1 archived row, found ${archivedRows.length}: ${JSON.stringify(allRows)}`,
    );
    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row (no third row created), found ${queuedRows.length}: ${JSON.stringify(allRows)}`,
    );
  });

});

// ── Silent archive failure: safe behavior ─────────────────────────────────────
//
// The route now inspects the error returned by the review_required archive
// update. If archiving fails, the route returns a db_error response and does
// NOT proceed to insert a new queued row. This prevents two active rows from
// existing simultaneously for the same catalog (which would let a worker pick
// up both and generate duplicate artwork).

describe("POST regenerate — review_required archive step silently fails", () => {

  const ARCHIVE_ERROR = { code: "57014", message: "canceling statement due to statement timeout" };

  beforeEach(() => {
    db = makeDb();
    const client = makeClient(db, { archiveReviewRequiredError: ARCHIVE_ERROR });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  });

  it("returns a non-200 error response when the archive step fails", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.notEqual(
      res.status, 200,
      `expected a non-200 error response when archive fails, got 200: ${JSON.stringify(res.body)}`,
    );
    assert.ok(
      res.body && typeof res.body.error === "string",
      `expected an error body, got: ${JSON.stringify(res.body)}`,
    );
  });

  it("does NOT insert a new queued row when the archive step fails", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queuedRows.length,
      0,
      `expected no queued row to be inserted when archive fails, ` +
        `found ${queuedRows.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("leaves only one active row (the original review_required row, still unarchived)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const allQueueRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID,
    );
    assert.equal(
      allQueueRows.length,
      1,
      `expected exactly 1 queue row (original review_required), ` +
        `found ${allQueueRows.length}: ${JSON.stringify(allQueueRows)}`,
    );
    assert.equal(
      allQueueRows[0].status,
      "review_required",
      `expected the sole row to still be review_required (archive failed), ` +
        `got: ${allQueueRows[0].status}`,
    );
  });

});
