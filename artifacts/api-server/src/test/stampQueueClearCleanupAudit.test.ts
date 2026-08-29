/**
 * POST /admin/stamps/queue/:jobId/clear-cleanup-error — audit-log trail.
 *
 * Invariants tested:
 *  1. Clearing a job with a non-null cleanup_error writes a
 *     stamp_admin_audit_log row with action = 'clear_cleanup_error' for that
 *     job's catalog, attributed to the acting admin.
 *  2. A second call (already cleared) is an idempotent 200 and does NOT write
 *     a duplicate audit entry.
 *
 * Run: node --import tsx/esm --test src/test/stampQueueClearCleanupAudit.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { insertWouldViolateQueuedUnique, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_USER_ID     = "aaaaaaaa-0000-0000-0002-000000000001";
const CATALOG_ID        = "00000000-0000-0000-0003-000000000001";
const JOB_WITH_ERROR    = "00000000-0000-0000-0004-000000000001";
const JOB_WITHOUT_ERROR = "00000000-0000-0000-0004-000000000002";

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
// In-memory rows. Unlike simpler fakes, `.not(col, "is", null)` actually
// filters, so the endpoint's "only rows with a cleanup_error" guard is real:
// on the second call the update matches nothing and the idempotent path runs.

function makeClient() {
  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_USER_ID, role: "admin" }],
    stamp_generation_queue: [
      {
        id: JOB_WITH_ERROR,
        catalog_id: CATALOG_ID,
        status: "completed",
        cleanup_error: "delete failed: storage timeout",
        cleanup_error_paths: ["stamps/a.png", "stamps/b.png"],
      },
      {
        id: JOB_WITHOUT_ERROR,
        catalog_id: CATALOG_ID,
        status: "completed",
        cleanup_error: null,
        cleanup_error_paths: null,
      },
    ],
    stamp_admin_audit_log: [],
  };

  function chain(tableName: string) {
    // updates mutate the live rows; reads work on the live array too
    let filtered: any[] = db[tableName] ?? [];
    let pendingUpdate: Record<string, any> | null = null;
    let insertError: { code: string; message: string } | null = null;

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
        if (
          tableName === "stamp_generation_queue" &&
          insertWouldViolateQueuedUnique(db[tableName] ?? [], newRows)
        ) {
          insertError = { ...DUPLICATE_QUEUED_ERROR };
          return b;
        }
        db[tableName] = [...(db[tableName] ?? []), ...newRows];
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => {
        pendingUpdate = data;
        return b;
      },
      eq: (col: string, val: any) => {
        filtered = filtered.filter((r: any) => r[col] === val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        filtered = filtered.filter((r: any) => vals.includes(r[col]));
        return b;
      },
      not: (col: string, op: string, val: any) => {
        if (op === "is" && val === null) {
          filtered = filtered.filter((r: any) => r[col] !== null && r[col] !== undefined);
        }
        return b;
      },
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => {
        if (insertError) return Promise.resolve({ data: null, error: insertError });
        applyUpdate();
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => {
        if (insertError) return Promise.resolve({ data: null, error: insertError });
        applyUpdate();
        return Promise.resolve(
          filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } },
        );
      },
      then: (resolve: any, reject: any) => {
        if (insertError) return Promise.resolve({ data: null, error: insertError }).then(resolve, reject);
        applyUpdate();
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN_USER_ID } }, error: null }),
    },
    _db: db,
  };
}

let client: ReturnType<typeof makeClient>;

beforeEach(() => {
  client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /admin/stamps/queue/:jobId/clear-cleanup-error — audit trail", () => {
  it("writes a clear_cleanup_error audit entry when clearing an orphaned-files warning", async () => {
    const { status, body } = await req(
      "POST",
      `/admin/stamps/queue/${JOB_WITH_ERROR}/clear-cleanup-error`,
    );

    assert.equal(status, 200);
    assert.equal(body.job.id, JOB_WITH_ERROR);
    assert.equal(body.job.cleanup_error, null);
    assert.equal(body.job.cleanup_error_paths, null);

    const audits = client._db.stamp_admin_audit_log.filter(
      (a) => a.action === "clear_cleanup_error",
    );
    assert.equal(audits.length, 1, "exactly one clear_cleanup_error audit entry must be written");
    assert.equal(audits[0].catalog_id, CATALOG_ID, "audit entry must reference the job's catalog");
    assert.equal(audits[0].admin_id, ADMIN_USER_ID, "audit entry must record which admin dismissed the warning");
    assert.ok(
      String(audits[0].notes ?? "").includes(JOB_WITH_ERROR),
      "audit notes must reference the job id",
    );

    // Row actually cleared in the fake db
    const row = client._db.stamp_generation_queue.find((r) => r.id === JOB_WITH_ERROR)!;
    assert.equal(row.cleanup_error, null);
    assert.equal(row.cleanup_error_paths, null);
  });

  it("second call on an already-cleared job is an idempotent 200 with NO duplicate audit entry", async () => {
    const first = await req("POST", `/admin/stamps/queue/${JOB_WITH_ERROR}/clear-cleanup-error`);
    assert.equal(first.status, 200);

    const second = await req("POST", `/admin/stamps/queue/${JOB_WITH_ERROR}/clear-cleanup-error`);
    assert.equal(second.status, 200, "already-cleared job must still return 200");
    assert.equal(second.body.job.id, JOB_WITH_ERROR);
    assert.equal(second.body.job.cleanup_error, null);

    const audits = client._db.stamp_admin_audit_log.filter(
      (a) => a.action === "clear_cleanup_error",
    );
    assert.equal(audits.length, 1, "idempotent repeat must NOT write a duplicate audit entry");
  });

  it("clearing a job that never had a cleanup_error returns 200 and writes no audit entry", async () => {
    const { status, body } = await req(
      "POST",
      `/admin/stamps/queue/${JOB_WITHOUT_ERROR}/clear-cleanup-error`,
    );

    assert.equal(status, 200);
    assert.equal(body.job.id, JOB_WITHOUT_ERROR);
    assert.equal(client._db.stamp_admin_audit_log.length, 0, "no audit entry for a no-op clear");
  });
});
