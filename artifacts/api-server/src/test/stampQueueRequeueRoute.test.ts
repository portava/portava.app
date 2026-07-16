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

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_USER_ID   = "aaaaaaaa-0000-0000-0002-000000000001";
const CATALOG_ID      = "00000000-0000-0000-0003-000000000001";
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
  await new Promise<void>((resolve) => server.listen(0, resolve));
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
      { id: JOB_RETRYABLE, catalog_id: CATALOG_ID, status: "retryable_failed",   attempts: 3, requeue_count: 2, last_error: "boom" },
      { id: JOB_PERMANENT, catalog_id: CATALOG_ID, status: "permanently_failed", attempts: 3, requeue_count: 3, last_error: "boom" },
      { id: JOB_QUEUED,    catalog_id: CATALOG_ID, status: "queued",             attempts: 0, requeue_count: 0, last_error: null },
    ],
    stamp_artwork_versions: [],
    universal_stamp_catalog: [{ id: CATALOG_ID, status: "approved" }],
    stamp_admin_audit_log: [],
  };

  const updateCalls: UpdateCall[] = [];

  function chain(tableName: string, rows: any[]) {
    let filtered = rows;
    let pendingUpdate: Record<string, any> | null = null;
    let call: UpdateCall | null = null;

    const applyUpdate = () => {
      if (pendingUpdate !== null) {
        for (const row of filtered) Object.assign(row, pendingUpdate);
        pendingUpdate = null;
      }
    };

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
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
        applyUpdate();
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => {
        applyUpdate();
        return Promise.resolve(
          filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } },
        );
      },
      then: (resolve: any, reject: any) => {
        applyUpdate();
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

  it("writes an audit log entry on successful requeue", async () => {
    await req("POST", `/admin/stamps/queue/${JOB_PERMANENT}/requeue`);
    const audit = client._db.stamp_admin_audit_log;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "requeue_failed_job");
    assert.equal(audit[0].catalog_id, CATALOG_ID);
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
    assert.deepEqual(resetCall!.eqFilters, [["catalog_id", CATALOG_ID]]);

    // Both failed rows actually reset in the fake db
    for (const id of [JOB_RETRYABLE, JOB_PERMANENT]) {
      const row = client._db.stamp_generation_queue.find((r) => r.id === id)!;
      assert.equal(row.status, "queued", `${id} must be re-queued`);
      assert.equal(row.requeue_count, 0, `${id} requeue_count must reset`);
    }
  });
});
