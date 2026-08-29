/**
 * writeAuditLog failure surfacing — a failed stamp_admin_audit_log insert must
 * be logged (structured: action, catalog_id, admin_id) instead of silently
 * swallowed, while the primary admin action still succeeds with 200.
 *
 * Exercised through POST /admin/stamps/queue/:jobId/clear-cleanup-error.
 *
 * Run: node --import tsx/esm --test src/test/stampAuditWriteFailure.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_USER_ID  = "aaaaaaaa-0000-0000-0002-000000000001";
const CATALOG_ID     = "00000000-0000-0000-0003-000000000001";
const JOB_WITH_ERROR = "00000000-0000-0000-0004-000000000001";
const AUDIT_ERROR_MSG = "transient audit insert failure";

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
// Same shape as the clear-cleanup-error audit test fake, except inserts into
// stamp_admin_audit_log fail with an error (simulating a transient DB failure).

function makeClient({ auditInsertFails }: { auditInsertFails: boolean }) {
  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_USER_ID, role: "admin" }],
    stamp_generation_queue: [
      {
        id: JOB_WITH_ERROR,
        catalog_id: CATALOG_ID,
        status: "completed",
        cleanup_error: "delete failed: storage timeout",
        cleanup_error_paths: ["stamps/a.png"],
      },
    ],
    stamp_admin_audit_log: [],
  };

  function chain(tableName: string) {
    let filtered: any[] = db[tableName] ?? [];
    let pendingUpdate: Record<string, any> | null = null;
    let insertFailed = false;

    const applyUpdate = () => {
      if (pendingUpdate !== null) {
        for (const row of filtered) Object.assign(row, pendingUpdate);
        pendingUpdate = null;
      }
    };

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        if (tableName === "stamp_admin_audit_log" && auditInsertFails) {
          insertFailed = true;
          filtered = [];
          return b;
        }
        const newRows = Array.isArray(data) ? data : [data];
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
        const error = insertFailed ? { message: AUDIT_ERROR_MSG } : null;
        return Promise.resolve({ data: insertFailed ? null : filtered, error, count: filtered.length }).then(resolve, reject);
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

// ── console.error capture ─────────────────────────────────────────────────────
let errorCalls: any[][] = [];
const origConsoleError = console.error;

beforeEach(() => {
  errorCalls = [];
  console.error = (...args: any[]) => { errorCalls.push(args); };
});

afterEach(() => {
  console.error = origConsoleError;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("writeAuditLog failure surfacing", () => {
  it("logs a structured error (action, catalog_id, admin_id) when the audit insert fails, and the primary action still succeeds", async () => {
    const client = makeClient({ auditInsertFails: true });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status, body } = await req(
      "POST",
      `/admin/stamps/queue/${JOB_WITH_ERROR}/clear-cleanup-error`,
    );

    // Primary action still succeeds
    assert.equal(status, 200, "clear-cleanup-error must still succeed when audit write fails");
    assert.equal(body.job.id, JOB_WITH_ERROR);
    assert.equal(body.job.cleanup_error, null);

    // No audit row was written (the insert failed)…
    assert.equal(client._db.stamp_admin_audit_log.length, 0);

    // …but the failure was surfaced via a structured error log
    const auditFailureLogs = errorCalls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("failed to write audit log")),
    );
    assert.equal(auditFailureLogs.length, 1, "exactly one audit-write-failure error log expected");

    const joined = auditFailureLogs[0].map(String).join(" ");
    assert.ok(joined.includes("clear_cleanup_error"), "log must include the action");
    assert.ok(joined.includes(CATALOG_ID), "log must include the catalog_id");
    assert.ok(joined.includes(ADMIN_USER_ID), "log must include the admin_id");
    assert.ok(joined.includes(AUDIT_ERROR_MSG), "log must include the underlying DB error");
  });

  it("does not log an audit-failure error when the audit insert succeeds", async () => {
    const client = makeClient({ auditInsertFails: false });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status } = await req(
      "POST",
      `/admin/stamps/queue/${JOB_WITH_ERROR}/clear-cleanup-error`,
    );
    assert.equal(status, 200);
    assert.equal(client._db.stamp_admin_audit_log.length, 1, "audit row written on success");

    const auditFailureLogs = errorCalls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("failed to write audit log")),
    );
    assert.equal(auditFailureLogs.length, 0, "no spurious failure log on a successful audit write");
  });
});
