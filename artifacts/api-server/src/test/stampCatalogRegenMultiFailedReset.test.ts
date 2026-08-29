/**
 * Confirm both failed statuses are cleared in a single regenerate when one
 * catalog entry has both a retryable_failed and a permanently_failed row.
 *
 * The partial unique index uix_queue_catalog_active permits only ONE row per
 * catalog_id whose status is outside ('archived', 'retryable_failed'). A
 * single UPDATE promoting both failed rows to "queued" would therefore raise
 * 23505 and roll back entirely — leaving both rows still failed while the
 * handler reports ok. The handler instead archives the older failed row(s)
 * first, then resets the most recent failed row to queued, so one POST
 * regenerate clears every failed row.
 *
 * The fake client simulates the unique index via wouldCreateDuplicateQueued:
 * if the handler ever regressed to a single bulk "set all failed → queued"
 * update, the fake returns 23505 and these tests fail.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenMultiFailedReset.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";
import { wouldCreateDuplicateQueued, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID       = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID     = "cccccccc-0000-4000-8000-000000000042";
const RETRYABLE_ID   = "dddddddd-0000-4000-8000-000000000001";
const PERMANENT_ID   = "dddddddd-0000-4000-8000-000000000002";

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

function post(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method:   "POST",
        headers: {
          authorization:    "Bearer fake-admin-token",
          "content-type":   "application/json",
          "content-length": 2,
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
    r.write("{}");
    r.end();
  });
}

// ── Mutable in-memory fake client (constraint-aware) ─────────────────────────

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
              // Simulate the unique constraint on (catalog_id, status='queued').
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

// ── DB factory: one entry with BOTH failed statuses ──────────────────────────

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:lyon:france",
        stamp_type:             "location",
        display_name:           "Lyon",
        country:                "France",
        country_code:           "FR",
        status:                 "pending_artwork",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_generation_queue: [
      {
        id:            RETRYABLE_ID,
        catalog_id:    CATALOG_ID,
        status:        "retryable_failed",
        attempts:      3,
        requeue_count: 2,
        last_error:    "transient network error",
        priority:      5,
        created_at:    "2024-02-01T00:00:00Z",
        updated_at:    "2024-02-01T01:00:00Z",
      },
      {
        id:            PERMANENT_ID,
        catalog_id:    CATALOG_ID,
        status:        "permanently_failed",
        attempts:      5,
        requeue_count: 3,
        last_error:    "unsupported location",
        priority:      5,
        created_at:    "2024-02-02T00:00:00Z", // more recent than the retryable row
        updated_at:    "2024-02-02T01:00:00Z",
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
  };
}

let db: DB;

beforeEach(() => {
  db = makeDb();
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST regenerate — entry with both retryable_failed and permanently_failed rows", () => {

  it("returns 200 and clears BOTH failed statuses in a single call", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 200,
      `regenerate must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true });

    const stillFailed = db.stamp_generation_queue.filter(
      (r) =>
        r.catalog_id === CATALOG_ID &&
        (r.status === "retryable_failed" || r.status === "permanently_failed"),
    );
    assert.equal(
      stillFailed.length,
      0,
      `no failed rows may remain after one regenerate, found: ${JSON.stringify(stillFailed)}`,
    );
  });

  it("the most recent failed row is reset to queued with counters cleared", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const survivor = db.stamp_generation_queue.find((r) => r.id === PERMANENT_ID);
    assert.equal(
      survivor?.status, "queued",
      `most recent failed row must be reset to queued, got '${survivor?.status}'`,
    );
    assert.equal(survivor?.attempts, 0, "attempts must be reset to 0");
    assert.equal(survivor?.requeue_count, 0, "requeue_count must be reset to 0");
    assert.equal(survivor?.last_error, null, "last_error must be cleared");
  });

  it("the older failed row is archived — two active rows would violate uix_queue_catalog_active", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const older = db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID);
    assert.equal(
      older?.status, "archived",
      `older failed row must be archived, got '${older?.status}'`,
    );
  });

  it("exactly one queued row exists for the catalog entry afterward", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length,
      1,
      `expected exactly 1 queued row (unique index allows only one), found ${queued.length}: ${JSON.stringify(queued)}`,
    );
  });

  it("writes exactly one audit log entry — the failed reset counts as a state change", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "regenerate",
    );
    assert.equal(
      auditEntries.length,
      1,
      `expected exactly 1 audit entry, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("also works when the retryable_failed row is the more recent one", async () => {
    // Swap recency: retryable row is newer than the permanent row.
    const retryable = db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID)!;
    const permanent = db.stamp_generation_queue.find((r) => r.id === PERMANENT_ID)!;
    retryable.created_at = "2024-02-03T00:00:00Z";
    permanent.created_at = "2024-02-01T00:00:00Z";

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `regenerate failed: ${JSON.stringify(res.body)}`);

    assert.equal(
      db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID)?.status,
      "queued",
      "newer retryable_failed row must be reset to queued",
    );
    assert.equal(
      db.stamp_generation_queue.find((r) => r.id === PERMANENT_ID)?.status,
      "archived",
      "older permanently_failed row must be archived",
    );

    const stillFailed = db.stamp_generation_queue.filter(
      (r) =>
        r.catalog_id === CATALOG_ID &&
        (r.status === "retryable_failed" || r.status === "permanently_failed"),
    );
    assert.equal(stillFailed.length, 0, "no failed rows may remain");
  });

  it("single-failed-row entries still reset exactly as before (no archive step)", async () => {
    // Remove the permanent row — only one retryable_failed row remains.
    db.stamp_generation_queue = db.stamp_generation_queue.filter(
      (r) => r.id !== PERMANENT_ID,
    );

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `regenerate failed: ${JSON.stringify(res.body)}`);

    const row = db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID);
    assert.equal(row?.status, "queued", "single failed row must be reset to queued");
    assert.equal(row?.attempts, 0, "attempts must be reset");
    assert.equal(
      db.stamp_generation_queue.filter(
        (r) => r.catalog_id === CATALOG_ID && r.status === "archived",
      ).length,
      0,
      "no row should be archived when there is only one failed row",
    );
  });

});
