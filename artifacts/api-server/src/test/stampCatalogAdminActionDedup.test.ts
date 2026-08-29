/**
 * Confirm reject, merge, and requeue_failed_job don't write duplicate audit
 * entries when the same admin action is called twice.
 *
 * reject  — guard: .neq("status","rejected") on the update; second call
 *           returns the existing row without re-writing the audit log.
 * merge   — guard: early return when source status is already "archived".
 * requeue — guard: .in("status",["retryable_failed","permanently_failed"]);
 *           second call finds no matching row and returns not_found before
 *           reaching writeAuditLog.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogAdminActionDedup.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";
import { wouldCreateDuplicateQueued, insertWouldViolateQueuedUnique, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";

// ── Fixed IDs ──────────────────────────────────────────────────────────────────

const ADMIN_ID    = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID  = "cccccccc-0000-4000-8000-000000000010";
const SOURCE_ID   = "cccccccc-0000-4000-8000-000000000020";
const TARGET_ID   = "cccccccc-0000-4000-8000-000000000021";
const JOB_ID      = "dddddddd-0000-4000-8000-000000000030";
const VERSION_ID  = "eeeeeeee-0000-4000-8000-000000000040";

// ── HTTP helpers ───────────────────────────────────────────────────────────────

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

function request(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
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

const patch = (path: string, body: Record<string, unknown> = {}) =>
  request("PATCH", path, body);
const post  = (path: string, body: Record<string, unknown> = {}) =>
  request("POST",  path, body);

// ── Fake in-memory Supabase client ─────────────────────────────────────────────

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow:    Record<string, any> | null  = null;
    const filters: Array<(r: any) => boolean>    = [];
    let _headOnly    = false;
    let _selectCount = false;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)     { filters.push((r) => r[col] === val);            return b; },
      neq(col: string, val: any)    { filters.push((r) => r[col] !== val);            return b; },
      in(col: string, vals: any[])  { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()   { return b; },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>) { insertRow   = row;   return b; },

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
          return Promise.resolve({
            data:  matched[0] ? { ...matched[0] } : null,
            error: null,
          });
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({
          data:  matched[0] ? { ...matched[0] } : null,
          error: null,
        });
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

// ── DB factory ─────────────────────────────────────────────────────────────────

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],

    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:london:uk",
        stamp_type:             "location",
        display_name:           "London",
        country:                "United Kingdom",
        country_code:           "GB",
        status:                 "pending_artwork",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
      {
        id:                     SOURCE_ID,
        canonical_location_key: "city:berlin:germany",
        stamp_type:             "location",
        display_name:           "Berlin (duplicate)",
        country:                "Germany",
        country_code:           "DE",
        status:                 "active",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
      {
        id:                     TARGET_ID,
        canonical_location_key: "city:berlin:germany",
        stamp_type:             "location",
        display_name:           "Berlin",
        country:                "Germany",
        country_code:           "DE",
        status:                 "active",
        active_version_id:      null,
        earn_count:             5,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],

    stamp_generation_queue: [
      {
        id:           JOB_ID,
        catalog_id:   CATALOG_ID,
        status:       "retryable_failed",
        attempts:     3,
        requeue_count: 0,
        last_error:   "timeout",
        cleanup_error: null,
        cleanup_error_paths: null,
        locked_until: null,
        locked_by:    null,
        updated_at:   "2024-01-01T00:00:00Z",
      },
    ],

    stamp_artwork_versions: [
      {
        id:         VERSION_ID,
        catalog_id: CATALOG_ID,
        status:     "candidate",
        public_url: "https://cdn.example.com/stamp.png",
        reviewed_by_admin_id: null,
        reviewed_at: null,
      },
    ],

    passport_stamps: [],
    user_stamps:     [],
    stamp_admin_audit_log: [],
  };
}

// ── Per-test fresh DB + client ─────────────────────────────────────────────────

let db: DB;

beforeEach(() => {
  db = makeDb();
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ══════════════════════════════════════════════════════════════════════════════
// REJECT
// ══════════════════════════════════════════════════════════════════════════════

describe("PATCH reject called twice does not write duplicate audit entries", () => {

  it("first reject call returns 200 and writes exactly one audit entry", async () => {
    const res = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/reject`,
      { reason: "Low quality artwork" },
    );

    assert.equal(
      res.status, 200,
      `first reject must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.ok(res.body.entry, "response must include entry");

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "reject",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected 1 audit entry after first reject, found ${auditEntries.length}`,
    );
  });

  it("second reject call also returns 200 — idempotent, no error", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/reject`,
      { reason: "Low quality artwork" },
    );
    assert.equal(first.status, 200, `first reject failed: ${JSON.stringify(first.body)}`);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/reject`,
      { reason: "Low quality artwork" },
    );
    assert.equal(
      second.status, 200,
      `second reject must also return 200 (idempotent), got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.ok(second.body.entry, "second response must still include entry");
  });

  it("after two reject calls audit log has exactly one reject entry", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/reject`,
      { reason: "Low quality artwork" },
    );
    assert.equal(first.status, 200, `first reject failed: ${JSON.stringify(first.body)}`);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/reject`,
      { reason: "Low quality artwork" },
    );
    assert.equal(second.status, 200, `second reject failed: ${JSON.stringify(second.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "reject",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected exactly 1 audit entry after two reject calls, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("first reject writes the audit entry; second call (already rejected) writes none", async () => {
    assert.equal(db.stamp_admin_audit_log.length, 0, "audit log must start empty");

    await patch(`/admin/stamps/catalog/${CATALOG_ID}/reject`, { reason: "bad" });
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected 1 audit entry after first reject, found ${db.stamp_admin_audit_log.length}`,
    );

    await patch(`/admin/stamps/catalog/${CATALOG_ID}/reject`, { reason: "bad" });
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected still 1 audit entry after second reject, found ${db.stamp_admin_audit_log.length}`,
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// MERGE
// ══════════════════════════════════════════════════════════════════════════════

describe("POST merge called twice does not write duplicate audit entries", () => {

  it("first merge call returns 200 and writes exactly one audit entry", async () => {
    const res = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);

    assert.equal(
      res.status, 200,
      `first merge must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.deepEqual(res.body, { ok: true, mergedIntoId: TARGET_ID });

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === SOURCE_ID && r.action === "merge",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected 1 audit entry after first merge, found ${auditEntries.length}`,
    );
  });

  it("second merge call also returns 200 — idempotent, no error", async () => {
    const first = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(first.status, 200, `first merge failed: ${JSON.stringify(first.body)}`);

    const second = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(
      second.status, 200,
      `second merge must also return 200 (idempotent), got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.deepEqual(second.body, { ok: true, mergedIntoId: TARGET_ID });
  });

  it("after two merge calls audit log has exactly one merge entry", async () => {
    const first = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(first.status, 200, `first merge failed: ${JSON.stringify(first.body)}`);

    const second = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(second.status, 200, `second merge failed: ${JSON.stringify(second.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === SOURCE_ID && r.action === "merge",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected exactly 1 audit entry after two merge calls, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("first merge writes the audit entry; second call (source already archived) writes none", async () => {
    assert.equal(db.stamp_admin_audit_log.length, 0, "audit log must start empty");

    await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected 1 audit entry after first merge, found ${db.stamp_admin_audit_log.length}`,
    );

    await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected still 1 audit entry after second merge, found ${db.stamp_admin_audit_log.length}`,
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// REQUEUE
// ══════════════════════════════════════════════════════════════════════════════

describe("POST requeue called twice does not write duplicate audit entries", () => {

  it("first requeue call returns 200 and writes exactly one audit entry", async () => {
    const res = await post(`/admin/stamps/queue/${JOB_ID}/requeue`);

    assert.equal(
      res.status, 200,
      `first requeue must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.ok(res.body.job, "response must include job");

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.action === "requeue_failed_job",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected 1 audit entry after first requeue, found ${auditEntries.length}`,
    );
  });

  it("second requeue call returns 404 — job is no longer in a failed status", async () => {
    const first = await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(first.status, 200, `first requeue failed: ${JSON.stringify(first.body)}`);

    const second = await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(
      second.status, 404,
      `second requeue must return 404 (job already queued), got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.equal(
      second.body?.error, "not_found",
      `second requeue must return not_found error code, got ${JSON.stringify(second.body)}`,
    );
  });

  it("after two requeue calls audit log has exactly one requeue entry — second call is blocked before writeAuditLog", async () => {
    const first = await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(first.status, 200, `first requeue failed: ${JSON.stringify(first.body)}`);

    const second = await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(second.status, 404, `second requeue should return 404`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.action === "requeue_failed_job",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected exactly 1 audit entry after two requeue calls, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("first requeue writes the audit entry; second call writes none", async () => {
    assert.equal(db.stamp_admin_audit_log.length, 0, "audit log must start empty");

    await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected 1 audit entry after first requeue, found ${db.stamp_admin_audit_log.length}`,
    );

    await post(`/admin/stamps/queue/${JOB_ID}/requeue`);
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected still 1 audit entry after second requeue, found ${db.stamp_admin_audit_log.length}`,
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVATE-VERSION
// ══════════════════════════════════════════════════════════════════════════════

describe("PATCH activate-version called twice does not double-write the audit log", () => {

  it("first activate-version call returns 200 and writes exactly one audit entry", async () => {
    const res = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );

    assert.equal(
      res.status, 200,
      `first activate-version must return 200, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
    assert.ok(res.body.entry,   "response must include entry");
    assert.ok(res.body.version, "response must include version");

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "activate_version",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected 1 audit entry after first activate-version, found ${auditEntries.length}`,
    );
  });

  it("second activate-version call also returns 200 — idempotent, no error", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(first.status, 200, `first activate-version failed: ${JSON.stringify(first.body)}`);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(
      second.status, 200,
      `second activate-version must also return 200 (idempotent), got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.ok(second.body.entry,   "second response must still include entry");
    assert.ok(second.body.version, "second response must still include version");
  });

  it("idempotent second call returns current catalog and version data — not null or stale values", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(first.status, 200, `first activate-version failed: ${JSON.stringify(first.body)}`);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(second.status, 200, `second activate-version failed: ${JSON.stringify(second.body)}`);

    assert.notEqual(second.body.entry,   null, "idempotent response entry must not be null");
    assert.notEqual(second.body.version, null, "idempotent response version must not be null");

    assert.equal(
      second.body.entry.status, "approved",
      `idempotent entry.status must reflect live DB state 'approved', got ${JSON.stringify(second.body.entry.status)}`,
    );
    assert.equal(
      second.body.entry.active_version_id, VERSION_ID,
      `idempotent entry.active_version_id must be the activated version, got ${JSON.stringify(second.body.entry.active_version_id)}`,
    );
    assert.equal(
      second.body.version.public_url, "https://cdn.example.com/stamp.png",
      `idempotent version.public_url must match the seeded value, got ${JSON.stringify(second.body.version.public_url)}`,
    );
    assert.equal(second.body.version.id, VERSION_ID, "idempotent version.id must match the requested versionId");
  });

  it("after two activate-version calls audit log has exactly one activate_version entry", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(first.status, 200, `first activate-version failed: ${JSON.stringify(first.body)}`);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(second.status, 200, `second activate-version failed: ${JSON.stringify(second.body)}`);

    const auditEntries = db.stamp_admin_audit_log.filter(
      (r) => r.catalog_id === CATALOG_ID && r.action === "activate_version",
    );
    assert.equal(
      auditEntries.length, 1,
      `expected exactly 1 audit entry after two activate-version calls, found ${auditEntries.length}: ${JSON.stringify(auditEntries)}`,
    );
  });

  it("first activate-version writes the audit entry; second call (already approved) writes none", async () => {
    assert.equal(db.stamp_admin_audit_log.length, 0, "audit log must start empty");

    await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected 1 audit entry after first activate-version, found ${db.stamp_admin_audit_log.length}`,
    );

    await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(
      db.stamp_admin_audit_log.length, 1,
      `expected still 1 audit entry after second activate-version, found ${db.stamp_admin_audit_log.length}`,
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVATE-VERSION — idempotent path never returns 200 with entry === null
// ══════════════════════════════════════════════════════════════════════════════

describe("PATCH activate-version idempotent path guards the catalog re-fetch", () => {

  it("returns 404 (not 200 with entry null) when the catalog row is missing on the already-approved path", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(first.status, 200, `first activate-version failed: ${JSON.stringify(first.body)}`);

    // Simulate the catalog row disappearing (e.g. merged/deleted) while the
    // version row remains approved.
    db.universal_stamp_catalog = db.universal_stamp_catalog.filter(
      (r) => r.id !== CATALOG_ID,
    );

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );

    assert.notEqual(
      second.status, 200,
      `must not return 200 when the catalog row is missing, got body ${JSON.stringify(second.body)}`,
    );
    assert.equal(
      second.status, 404,
      `expected 404 for a missing catalog row, got ${second.status}: ${JSON.stringify(second.body)}`,
    );
    assert.equal(second.body?.error, "not_found");
    assert.notEqual(second.body?.entry, null, "response must never carry entry === null");
  });

  it("returns a db_error (not 200 with entry null) when the catalog re-fetch errors on the already-approved path", async () => {
    const first = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );
    assert.equal(first.status, 200, `first activate-version failed: ${JSON.stringify(first.body)}`);

    // Wrap the client so any read of universal_stamp_catalog errors, while
    // stamp_artwork_versions reads keep working (already-approved path).
    const failingClient = makeClient(db) as any;
    const realFrom = failingClient.from.bind(failingClient);
    failingClient.from = (table: string) => {
      const b = realFrom(table);
      if (table === "universal_stamp_catalog") {
        const realMaybeSingle = b.maybeSingle.bind(b);
        b.maybeSingle = () =>
          realMaybeSingle().then(() => ({
            data:  null,
            error: { message: "connection reset" },
          }));
      }
      return b;
    };
    _setTestClient(failingClient, true);
    _setTestServiceClient(failingClient);

    const second = await patch(
      `/admin/stamps/catalog/${CATALOG_ID}/activate-version`,
      { versionId: VERSION_ID },
    );

    assert.notEqual(
      second.status, 200,
      `must not return 200 when the catalog re-fetch errors, got body ${JSON.stringify(second.body)}`,
    );
    assert.equal(
      second.body?.error, "db_error",
      `expected db_error, got ${JSON.stringify(second.body)}`,
    );
    assert.notEqual(second.body?.entry, null, "response must never carry entry === null");
  });

});
