/**
 * Admin stamp queue re-queue routes — route-level guards for the retry cap reset.
 *
 * Routes under test (src/routes/stampCatalog.ts):
 *   POST /admin/stamps/queue/:jobId/requeue
 *   POST /admin/stamps/catalog/:id/regenerate
 *
 * Invariants tested:
 *  1. Manual requeue update payload resets requeue_count to 0 (and attempts,
 *     last_error, locks) — the admin rescue must clear the auto-requeue cap.
 *  2. The requeue status guard accepts BOTH retryable_failed and
 *     permanently_failed jobs (permanently failed jobs stay rescuable).
 *  3. A job not in a failed status is rejected (404, no audit write).
 *  4. The regenerate route's failed-job reset also sets requeue_count: 0 and
 *     covers both failed statuses.
 *
 * Run: node --import tsx/esm --test src/test/stampQueueRequeueRoute.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";
import { wouldCreateDuplicateQueued, insertWouldViolateQueuedUnique, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_USER_ID   = "aaaaaaaa-0000-0000-0002-000000000001";
const CATALOG_ID      = "00000000-0000-0000-0003-000000000001";
// Separate catalog for the already-queued fixture row: the partial unique
// index on stamp_generation_queue(catalog_id) WHERE status='queued' means a
// queued row for CATALOG_ID would block any requeue of its failed jobs.
const CATALOG_ID_B    = "00000000-0000-0000-0003-000000000002";
const JOB_RETRYABLE   = "00000000-0000-0000-0004-000000000001";
const JOB_PERMANENT   = "00000000-0000-0000-0004-000000000002";
const JOB_QUEUED      = "00000000-0000-0000-0004-000000000003";

// ── Test server ───────────────────────────────────────────────────────────────
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

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": "Bearer fake-admin-token",
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
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client ───────────────────────────────────────────────────────────────
// In-memory rows with real .eq()/.in() filtering; every update() call is
// recorded (table, payload, filters) so payloads/guards can be asserted.

type UpdateCall = {
  table: string;
  payload: Record<string, any>;
  eqFilters: Array<[string, any]>;
  inFilter?: [string, any[]];
};

function makeStampQueueClient() {
  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_USER_ID, role: "admin" }],
    stamp_generation_queue: [
      { id: JOB_RETRYABLE, catalog_id: CATALOG_ID, status: "retryable_failed",   attempts: 3, requeue_count: 2, last_error: "boom", priority: 0, triggered_by_action: "system_auto" },
      { id: JOB_PERMANENT, catalog_id: CATALOG_ID, status: "permanently_failed", attempts: 3, requeue_count: 3, last_error: "boom" },
      { id: JOB_QUEUED,    catalog_id: CATALOG_ID_B, status: "queued",           attempts: 0, requeue_count: 0, last_error: null },
    ],
    stamp_artwork_versions: [],
    universal_stamp_catalog: [{ id: CATALOG_ID, status: "approved" }],
    stamp_admin_audit_log: [],
  };

  const updateCalls: UpdateCall[] = [];

  function chain(tableName: string, rows: any[]) {
    let filtered = rows;
    let pendingUpdate: Record<string, any> | null = null;
    let insertError: { code: string; message: string } | null = null;
    let call: UpdateCall | null = null;

    const applyUpdate = () => {
      if (pendingUpdate !== null) {
        // Partial unique index: one queued row per catalog_id — reject the
        // whole UPDATE with 23505 instead of committing a duplicate.
        if (
          tableName === "stamp_generation_queue" &&
          wouldCreateDuplicateQueued(db[tableName] ?? [], filtered, pendingUpdate)
        ) {
          pendingUpdate = null;
          filtered = [];
          return { ...DUPLICATE_QUEUED_ERROR };
        }
        for (const row of filtered) Object.assign(row, pendingUpdate);
        pendingUpdate = null;
      }
      return null;
    };

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
        // Partial unique index: an insert of a 'queued' row hits 23505 when a
        // queued row for the same catalog_id already exists.
        if (
          tableName === "stamp_generation_queue" &&
          insertWouldViolateQueuedUnique(db[tableName] ?? [], newRows)
        ) {
          insertError = { ...DUPLICATE_QUEUED_ERROR };
          filtered = [];
          return b;
        }
        db[tableName] = [...(db[tableName] ?? []), ...newRows];
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => {
        pendingUpdate = data;
        call = { table: tableName, payload: data, eqFilters: [] };
        updateCalls.push(call);
        return b;
      },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        call?.eqFilters.push([col, val]);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r: any) => vals.includes(r[col]));
        if (call) call.inFilter = [col, vals];
        return b;
      },
      not:   () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve(
          filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } },
        );
      },
      then: (resolve: any, reject: any) => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
    _db: db,
    _updateCalls: updateCalls,
  };
}

let client: ReturnType<typeof makeStampQueueClient>;

beforeEach(() => {
  client = makeStampQueueClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── POST /admin/stamps/queue/:jobId/requeue ───────────────────────────────────

describe("POST /admin/stamps/queue/:jobId/requeue — retry-cap reset", () => {
  it("resets requeue_count to 0 (with attempts, last_error, locks) for a retryable_failed job", async () => {
    const { status, body } = await req("POST", `/admin/stamps/queue/${JOB_RETRYABLE}/requeue`);

    assert.equal(status, 200);
    assert.equal(body.job.id, JOB_RETRYABLE);

    const call = client._updateCalls.find((c) => c.table === "stamp_generation_queue");
    assert.ok(call, "must update stamp_generation_queue");
    assert.equal(call!.payload.status, "queued");
    assert.equal(call!.payload.attempts, 0);
    assert.equal(call!.payload.requeue_count, 0, "manual admin requeue must reset the auto-requeue cap");
    assert.equal(call!.payload.last_error, null);
    assert.equal(call!.payload.locked_until, null);
    assert.equal(call!.payload.locked_by, null);

    // Row actually mutated in the fake db
    const row = client._db.stamp_generation_queue.find((r) => r.id === JOB_RETRYABLE)!;
    assert.equal(row.status, "queued");
    assert.equal(row.requeue_count, 0);
  });

  it("status guard covers BOTH failed statuses — permanently_failed jobs are rescuable", async () => {
    const { status, body } = await req("POST", `/admin/stamps/queue/${JOB_PERMANENT}/requeue`);

    assert.equal(status, 200);
    assert.equal(body.job.id, JOB_PERMANENT);

    const call = client._updateCalls.find((c) => c.table === "stamp_generation_queue")!;
    assert.deepEqual(call.inFilter, ["status", ["retryable_failed", "permanently_failed"]],
      "guard must accept retryable_failed AND permanently_failed");
    assert.equal(call.payload.requeue_count, 0);

    const row = client._db.stamp_generation_queue.find((r) => r.id === JOB_PERMANENT)!;
    assert.equal(row.status, "queued");
    assert.equal(row.requeue_count, 0);
  });

  it("rejects a job that is not in a failed status (404) and writes no audit log", async () => {
    const { status } = await req("POST", `/admin/stamps/queue/${JOB_QUEUED}/requeue`);
    assert.equal(status, 404);
    assert.equal(client._db.stamp_admin_audit_log.length, 0);
    const row = client._db.stamp_generation_queue.find((r) => r.id === JOB_QUEUED)!;
    assert.equal(row.status, "queued");
  });

  it("applies priority=1 and an admin triggered_by_action — the re-queued job jumps the queue like admin regenerate", async () => {
    // Seed sanity: the failed job starts at auto-queue priority 0.
    const before = client._db.stamp_generation_queue.find((r) => r.id === JOB_RETRYABLE)!;
    assert.equal(before.priority, 0, "test setup: failed job must start with priority=0");

    const { status } = await req("POST", `/admin/stamps/queue/${JOB_RETRYABLE}/requeue`);
    assert.equal(status, 200);

    const call = client._updateCalls.find((c) => c.table === "stamp_generation_queue")!;
    assert.equal(call.payload.priority, 1,
      "admin requeue must set priority=1 so the job jumps ahead of auto-queued work");
    assert.equal(call.payload.triggered_by_action, `admin_requeue:${ADMIN_USER_ID}`,
      "requeue must record the admin trigger");

    const row = client._db.stamp_generation_queue.find((r) => r.id === JOB_RETRYABLE)!;
    assert.equal(row.status, "queued");
    assert.equal(row.priority, 1, "re-queued row must carry priority=1");
    assert.equal(row.triggered_by_action, `admin_requeue:${ADMIN_USER_ID}`);
  });

  it("writes an audit log entry on successful requeue", async () => {
    await req("POST", `/admin/stamps/queue/${JOB_PERMANENT}/requeue`);
    const audit = client._db.stamp_admin_audit_log;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "requeue_failed_job");
    assert.equal(audit[0].catalog_id, CATALOG_ID);
  });
});

// ── cleanup_error clearing ────────────────────────────────────────────────────

const JOB_WITH_CLEANUP_ERROR = "00000000-0000-0000-0004-000000000004";

function makeStampQueueClientWithCleanupError() {
  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_USER_ID, role: "admin" }],
    stamp_generation_queue: [
      {
        id: JOB_WITH_CLEANUP_ERROR,
        catalog_id: CATALOG_ID,
        status: "retryable_failed",
        attempts: 2,
        requeue_count: 1,
        last_error: "storage_upload_failed: timeout",
        cleanup_error: "remove() returned unexpected error: 503",
        cleanup_error_paths: ["stamps/abc/v1.webp", "stamps/abc/v2.webp"],
      },
    ],
    stamp_artwork_versions: [],
    universal_stamp_catalog: [{ id: CATALOG_ID, status: "approved" }],
    stamp_admin_audit_log: [],
  };

  const updateCalls: UpdateCall[] = [];

  function chain(tableName: string, rows: any[]) {
    let filtered = rows;
    let pendingUpdate: Record<string, any> | null = null;
    let insertError: { code: string; message: string } | null = null;
    let call: UpdateCall | null = null;

    const applyUpdate = () => {
      if (pendingUpdate !== null) {
        // Partial unique index: one queued row per catalog_id — reject the
        // whole UPDATE with 23505 instead of committing a duplicate.
        if (
          tableName === "stamp_generation_queue" &&
          wouldCreateDuplicateQueued(db[tableName] ?? [], filtered, pendingUpdate)
        ) {
          pendingUpdate = null;
          filtered = [];
          return { ...DUPLICATE_QUEUED_ERROR };
        }
        for (const row of filtered) Object.assign(row, pendingUpdate);
        pendingUpdate = null;
      }
      return null;
    };

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
        // Partial unique index: an insert of a 'queued' row hits 23505 when a
        // queued row for the same catalog_id already exists.
        if (
          tableName === "stamp_generation_queue" &&
          insertWouldViolateQueuedUnique(db[tableName] ?? [], newRows)
        ) {
          insertError = { ...DUPLICATE_QUEUED_ERROR };
          filtered = [];
          return b;
        }
        db[tableName] = [...(db[tableName] ?? []), ...newRows];
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => {
        pendingUpdate = data;
        call = { table: tableName, payload: data, eqFilters: [] };
        updateCalls.push(call);
        return b;
      },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        call?.eqFilters.push([col, val]);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r: any) => vals.includes(r[col]));
        if (call) call.inFilter = [col, vals];
        return b;
      },
      not:   () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve(
          filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } },
        );
      },
      then: (resolve: any, reject: any) => {
        const err = insertError ?? applyUpdate();
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName, [...(db[tableName] ?? [])]),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
    _db: db,
    _updateCalls: updateCalls,
  };
}

describe("POST /admin/stamps/queue/:jobId/requeue — cleanup_error clearing", () => {
  let cleanupClient: ReturnType<typeof makeStampQueueClientWithCleanupError>;

  beforeEach(() => {
    cleanupClient = makeStampQueueClientWithCleanupError();
    _setTestClient(cleanupClient as any, true);
    _setTestServiceClient(cleanupClient as any);
  });

  it("sets cleanup_error: null and cleanup_error_paths: null in the update payload", async () => {
    const { status } = await req("POST", `/admin/stamps/queue/${JOB_WITH_CLEANUP_ERROR}/requeue`);

    assert.equal(status, 200);

    const call = cleanupClient._updateCalls.find((c) => c.table === "stamp_generation_queue");
    assert.ok(call, "must update stamp_generation_queue");
    assert.equal(call!.payload.cleanup_error, null,
      "cleanup_error must be null so the orphaned-files badge disappears");
    assert.equal(call!.payload.cleanup_error_paths, null,
      "cleanup_error_paths must be null so the orphaned-files badge disappears");
  });

  it("the row reflects cleanup_error: null and cleanup_error_paths: null after requeue", async () => {
    const { status, body } = await req("POST", `/admin/stamps/queue/${JOB_WITH_CLEANUP_ERROR}/requeue`);

    assert.equal(status, 200);
    assert.equal(body.job.id, JOB_WITH_CLEANUP_ERROR);

    const row = cleanupClient._db.stamp_generation_queue.find(
      (r) => r.id === JOB_WITH_CLEANUP_ERROR,
    )!;
    assert.equal(row.status, "queued");
    assert.equal(row.cleanup_error, null,
      "in-memory row must have cleanup_error cleared after requeue");
    assert.equal(row.cleanup_error_paths, null,
      "in-memory row must have cleanup_error_paths cleared after requeue");
  });

  it("also clears last_error and resets attempts alongside cleanup_error", async () => {
    const { status } = await req("POST", `/admin/stamps/queue/${JOB_WITH_CLEANUP_ERROR}/requeue`);

    assert.equal(status, 200);

    const call = cleanupClient._updateCalls.find((c) => c.table === "stamp_generation_queue")!;
    assert.equal(call.payload.last_error, null);
    assert.equal(call.payload.attempts, 0);
    assert.equal(call.payload.requeue_count, 0);
  });
});

// ── POST /admin/stamps/catalog/:id/regenerate ─────────────────────────────────

describe("POST /admin/stamps/catalog/:id/regenerate — failed-job reset", () => {
  it("resets failed jobs with requeue_count: 0 and a guard covering both failed statuses", async () => {
    const { status, body } = await req("POST", `/admin/stamps/catalog/${CATALOG_ID}/regenerate`);

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const resetCall = client._updateCalls.find(
      (c) => c.table === "stamp_generation_queue" && c.payload.status === "queued",
    );
    assert.ok(resetCall, "regenerate must reset failed queue jobs to queued");
    assert.equal(resetCall!.payload.attempts, 0);
    assert.equal(resetCall!.payload.requeue_count, 0, "regenerate must also reset the auto-requeue cap");
    assert.equal(resetCall!.payload.last_error, null);
    assert.deepEqual(resetCall!.inFilter, ["status", ["retryable_failed", "permanently_failed"]],
      "reset guard must cover retryable_failed AND permanently_failed");
    assert.deepEqual(resetCall!.eqFilters, [["id", JOB_PERMANENT]],
      "reset must target the most recent failed row by id (a batch update would trip the unique index)");

    // Real-DB semantics: a single UPDATE promoting BOTH failed rows to
    // 'queued' would violate the partial unique index (23505, full rollback).
    // The handler therefore archives the older failed row first, then resets
    // the most recent failed row to queued — clearing both failed statuses in
    // one regenerate while keeping exactly one active row.
    const retryRow = client._db.stamp_generation_queue.find((r) => r.id === JOB_RETRYABLE)!;
    const permRow  = client._db.stamp_generation_queue.find((r) => r.id === JOB_PERMANENT)!;
    assert.equal(retryRow.status, "archived", "older failed row must be archived");
    assert.equal(permRow.status, "queued", "most recent failed row must be reset to queued");

    const queuedRows = client._db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queuedRows.length, 1, "exactly one queued row must exist after regenerate");
    assert.equal(queuedRows[0].id, JOB_PERMANENT,
      "the queued row is the reset survivor (the fresh insert hits 23505 and is swallowed)");
  });
});
