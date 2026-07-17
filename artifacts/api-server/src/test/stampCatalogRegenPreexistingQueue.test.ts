/**
 * Confirm regenerate does not insert a new queue job when one is already queued
 *
 * The POST /admin/stamps/catalog/:id/regenerate handler always tries to insert a
 * new stamp_generation_queue row. If there is already a "queued" (or
 * "processing") job for the same catalog entry, this could create duplicate jobs.
 * The handler guards against this via a 23505 unique-constraint check and silently
 * ignores it.
 *
 * This test pre-seeds a "queued" row in the DB (simulating a job already in
 * flight from a prior trigger), then calls POST regenerate once, and confirms:
 *   1. The call returns 200 (not an error)
 *   2. The queue has at most one active job for this catalog entry
 *   3. The existing queued row is not replaced/modified
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenPreexistingQueue.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID   = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID = "cccccccc-0000-4000-8000-000000000077";
const EXISTING_JOB_ID = "eeeeeeee-0000-4000-8000-000000000001";

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
// The insert() implementation checks for an existing active (queued or
// processing) row with the same catalog_id. If one exists it returns a
// synthetic 23505 error — exactly what a real Postgres partial unique index
// on (catalog_id) WHERE status IN ('queued','processing') would do.
// The route handler silently ignores 23505, so the call must still return 200
// and must NOT push a second row.

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
              // Simulate the unique constraint on (catalog_id) for active jobs.
              // A real DB partial unique index covers status IN ('queued','processing').
              // Any attempt to insert another queued row for the same catalog_id
              // returns 23505.
              if (tableName === "stamp_generation_queue" && insertRow.status === "queued") {
                const duplicate = rows.find(
                  (r) =>
                    r.catalog_id === insertRow!.catalog_id &&
                    (r.status === "queued" || r.status === "processing"),
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

// ── DB factory — pre-seeds an existing "queued" job ──────────────────────────

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:tokyo:japan",
        stamp_type:             "location",
        display_name:           "Tokyo",
        country:                "Japan",
        country_code:           "JP",
        status:                 "active",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    // Pre-seed: a "queued" job already exists for this catalog entry.
    // This simulates a prior admin action or automated trigger that has already
    // enqueued artwork generation and the worker hasn't picked it up yet.
    stamp_generation_queue: [
      {
        id:                  EXISTING_JOB_ID,
        catalog_id:          CATALOG_ID,
        status:              "queued",
        priority:            0,
        attempts:            0,
        requeue_count:       0,
        triggered_by_action: "system_auto",
        last_error:          null,
        cleanup_error:       null,
        cleanup_error_paths: null,
        created_at:          "2024-01-01T00:00:00Z",
        updated_at:          "2024-01-01T00:00:00Z",
      },
    ],
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

describe("POST regenerate when a 'queued' job already exists", () => {

  it("returns 200 even when a queued job is already present", async () => {
    // Confirm baseline: one pre-seeded queued row
    const preExisting = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(preExisting.length, 1, "test setup: expected 1 pre-seeded queued row");

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status,
      200,
      `regenerate must return 200 even when a queued job exists, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });
  });

  it("queue has at most one active job after regenerate — no duplicate inserted", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `regenerate failed: ${JSON.stringify(res.body)}`);

    const activeRows = db.stamp_generation_queue.filter(
      (r) =>
        r.catalog_id === CATALOG_ID &&
        (r.status === "queued" || r.status === "processing"),
    );

    assert.equal(
      activeRows.length,
      1,
      `expected at most 1 active queue row after regenerate with a pre-existing queued job, found ${activeRows.length}: ${JSON.stringify(activeRows)}`,
    );
  });

  it("the existing queued row is preserved — its ID is unchanged", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queuedRows = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );

    assert.equal(
      queuedRows.length,
      1,
      `expected exactly 1 queued row, found ${queuedRows.length}: ${JSON.stringify(queuedRows)}`,
    );

    // The surviving row must be the original pre-seeded job, not a new one
    // inserted by the regenerate call.
    assert.equal(
      queuedRows[0].id,
      EXISTING_JOB_ID,
      `expected the pre-seeded job (id=${EXISTING_JOB_ID}) to survive unchanged, ` +
      `but found id=${queuedRows[0].id}`,
    );
  });

  it("total queue row count stays at 1 — no extra rows of any status", async () => {
    // The handler archives review_required rows and resets failed rows before
    // inserting. None of those apply here (only a queued row exists), so the
    // total count must remain exactly 1.
    assert.equal(
      db.stamp_generation_queue.length,
      1,
      "test setup: expected 1 pre-seeded row",
    );

    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      db.stamp_generation_queue.length,
      1,
      `expected queue to stay at 1 row (insert blocked by 23505), found ${db.stamp_generation_queue.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });

  it("the 23505 guard also applies when the pre-existing job is in 'processing' status", async () => {
    // Advance the pre-seeded job to processing (simulates the worker having
    // picked it up), then call regenerate.  The unique-constraint guard covers
    // both 'queued' and 'processing', so no duplicate must be inserted.
    db.stamp_generation_queue[0].status = "processing";

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      res.status,
      200,
      `regenerate must return 200 when job is processing, got ${res.status}: ${JSON.stringify(res.body)}`,
    );

    const activeRows = db.stamp_generation_queue.filter(
      (r) =>
        r.catalog_id === CATALOG_ID &&
        (r.status === "queued" || r.status === "processing"),
    );

    assert.equal(
      activeRows.length,
      1,
      `expected at most 1 active row when pre-existing job is processing, found ${activeRows.length}: ${JSON.stringify(activeRows)}`,
    );
  });

});
