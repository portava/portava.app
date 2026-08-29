/**
 * Confirm regenerate reports a db_error when archiving the OLDER stuck failed
 * queue rows fails — instead of silently leaving them stuck.
 *
 * The regenerate handler archives all-but-the-most-recent failed rows before
 * resetting the survivor to queued (respecting uix_queue_catalog_active). If
 * that archive-extras UPDATE errors, the handler must return db_error and
 * stop: no audit entry, no reset, both failed rows keep their statuses. A
 * regression that swallowed the error would report ok while both rows remain
 * failed.
 *
 * The fake client injects a DB error specifically on the archive-extras
 * update: stamp_generation_queue, status → archived, filtered by an id list.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenArchiveExtrasDbError.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID     = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID   = "cccccccc-0000-4000-8000-000000000042";
const RETRYABLE_ID = "dddddddd-0000-4000-8000-000000000001";
const PERMANENT_ID = "dddddddd-0000-4000-8000-000000000002";

const ARCHIVE_EXTRAS_ERROR_MESSAGE = "injected archive-extras failure";

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

// ── Mutable in-memory fake client with archive-extras error injection ────────

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];
    let _inIdFilter = false; // set when .in("id", [...]) is used
    let _headOnly    = false;
    let _selectCount = false;

    // The archive-extras step is uniquely identified by:
    //   stamp_generation_queue UPDATE {status: "archived"} filtered by .in("id", [...])
    // (the review_required archive uses .eq filters, not an id list).
    function isArchiveExtras(): boolean {
      return (
        tableName === "stamp_generation_queue" &&
        updateValues !== null &&
        updateValues.status === "archived" &&
        _inIdFilter
      );
    }

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) {
        if (col === "id") _inIdFilter = true;
        filters.push((r) => (vals as any[]).includes(r[col]));
        return b;
      },
      not()    { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow   = row;   return b; },

      maybeSingle() {
        const rows    = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (updateValues !== null) {
          matched.forEach((r) => Object.assign(r, updateValues));
          return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
        }
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
              rows.push(insertRow);
              db[tableName] = rows;
              return { data: { ...insertRow }, error: null };
            }

            if (updateValues !== null) {
              if (isArchiveExtras()) {
                // Inject the DB failure — no rows are modified.
                return { data: null, error: { message: ARCHIVE_EXTRAS_ERROR_MESSAGE } };
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
        created_at:    "2024-02-01T00:00:00Z", // older — the archive-extras target
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
        created_at:    "2024-02-02T00:00:00Z", // most recent — the would-be survivor
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

describe("POST regenerate — archive-extras UPDATE fails with a DB error", () => {

  it("returns a db_error response — not a silent ok", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      res.status, 500,
      `expected 500 db_error, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.equal(res.body?.error, "db_error", `body: ${JSON.stringify(res.body)}`);
    assert.ok(
      String(res.body?.message ?? "").includes(ARCHIVE_EXTRAS_ERROR_MESSAGE),
      `db_error message must surface the underlying failure, got: ${JSON.stringify(res.body)}`,
    );
  });

  it("both failed rows keep their original statuses — nothing is reset or archived", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const retryable = db.stamp_generation_queue.find((r) => r.id === RETRYABLE_ID);
    const permanent = db.stamp_generation_queue.find((r) => r.id === PERMANENT_ID);
    assert.equal(
      retryable?.status, "retryable_failed",
      `older failed row must stay retryable_failed, got '${retryable?.status}'`,
    );
    assert.equal(
      permanent?.status, "permanently_failed",
      `most recent failed row must stay permanently_failed, got '${permanent?.status}'`,
    );
    assert.equal(retryable?.attempts, 3, "attempts must not be reset");
    assert.equal(permanent?.attempts, 5, "attempts must not be reset");
  });

  it("no new queued row is inserted — the handler stops before the enqueue step", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length, 0,
      `no queued row may exist after the archive failure, found: ${JSON.stringify(queued)}`,
    );
  });

  it("no audit log entry is written", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(
      db.stamp_admin_audit_log.length, 0,
      `no audit entries may be written, found: ${JSON.stringify(db.stamp_admin_audit_log)}`,
    );
  });

});
