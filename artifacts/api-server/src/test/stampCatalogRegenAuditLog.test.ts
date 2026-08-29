/**
 * Audit log entry appears on the detail page after admin regenerates a stamp
 *
 * POST /admin/stamps/catalog/:id/regenerate calls writeAuditLog before
 * returning.  GET /admin/stamps/catalog/:id includes the audit array from
 * stamp_admin_audit_log.
 *
 * If the audit write fails silently, or the detail handler misses the row,
 * admins have no trail of who triggered regeneration.
 *
 * Tests:
 *   1. Baseline: detail returns an empty audit array before any admin action.
 *   2. After POST regenerate: detail audit contains exactly one entry with
 *      action === "regenerate" and admin_id === ADMIN_ID.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenAuditLog.test.ts
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
const CATALOG_ID = "cccccccc-0000-4000-8000-000000000030";
const JOB_ID     = "eeeeeeee-0000-4000-8000-000000000030";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base:   string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(stampCatalogRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method:   "GET",
        headers: { authorization: "Bearer fake-admin-token" },
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
    r.end();
  });
}

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

type DB = Record<string, any[]>;

/** Parse Supabase's parenthesised CSV value list, e.g. '("archived","queued")' */
function parseInList(raw: string): string[] {
  return raw
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""));
}

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
        if (opts?.head  === true)    _headOnly    = true;
        return b;
      },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => (vals as any[]).includes(r[col]));
        return b;
      },
      not(col: string, op: string, val: any) {
        if (op === "in") {
          const excluded = parseInList(String(val));
          filters.push((r) => !excluded.includes(r[col]));
        }
        return b;
      },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow    = row;  return b; },

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

// ── DB factory ────────────────────────────────────────────────────────────────

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:osaka:japan",
        stamp_type:             "location",
        display_name:           "Osaka",
        country:                "Japan",
        country_code:           "JP",
        status:                 "review_required",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_generation_queue: [
      {
        id:            JOB_ID,
        catalog_id:    CATALOG_ID,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 1 of 3 required",
        attempts:      3,
        requeue_count: 0,
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
    user_stamps:            [],
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

describe("Audit log entry appears on detail page after admin regenerates a stamp", () => {

  it("baseline: detail returns an empty audit array before any admin action", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CATALOG_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.audit), "detail response must include an audit array");
    assert.equal(
      body.audit.length,
      0,
      `audit array must be empty before any admin action, got: ${JSON.stringify(body.audit)}`,
    );
  });

  it("double regenerate: second call returns 200 and does not add a second audit entry", async () => {
    // Build a client where the second insert into stamp_generation_queue returns 23505.
    // The first insert succeeds and a job row is appended; the second insert
    // (rapid duplicate click) finds the unique constraint already satisfied and
    // returns the 23505 code — the handler must skip writeAuditLog in that branch.
    const localDb = makeDb();

    function makeClientWithDup(dbArg: DB) {
      function chain(tableName: string) {
        let updateValues: Record<string, any> | null = null;
        let insertRow: Record<string, any> | null    = null;
        const filters: Array<(r: any) => boolean>    = [];
        let _headOnly    = false;
        let _selectCount = false;

        const b: any = {
          select(_cols?: any, opts?: any) {
            if (opts?.count === "exact") _selectCount = true;
            if (opts?.head  === true)    _headOnly    = true;
            return b;
          },
          eq(col: string, val: any)   { filters.push((r) => r[col] === val); return b; },
          in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
          not(col: string, op: string, val: any) {
            if (op === "in") {
              const excluded = val.replace(/^\(|\)$/g, "").split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
              filters.push((r) => !excluded.includes(r[col]));
            }
            return b;
          },
          order()  { return b; },
          range()  { return b; },
          limit()  { return b; },
          update(vals: Record<string, any>) { updateValues = vals; return b; },
          insert(row: Record<string, any>)  { insertRow    = row;  return b; },

          maybeSingle() {
            const rows = dbArg[tableName] ?? [];
            if (updateValues !== null) {
              const matched = rows.filter((r: any) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
              }
              matched.forEach((r: any) => Object.assign(r, updateValues));
              return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
            }
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
          },

          single() {
            const rows    = dbArg[tableName] ?? [];
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            if (matched.length === 1)
              return Promise.resolve({ data: matched[0], error: null });
            return Promise.resolve({ data: null, error: { message: "No rows" } });
          },

          then(resolve: any, reject: any) {
            return Promise.resolve()
              .then(() => {
                const rows = dbArg[tableName] ?? [];
                if (insertRow !== null) {
                  // Simulate the partial unique index on (catalog_id) WHERE status = 'queued'.
                  if (
                    tableName === "stamp_generation_queue" &&
                    insertWouldViolateQueuedUnique(rows, insertRow)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  rows.push(insertRow);
                  return { data: { ...insertRow }, error: null };
                }
                if (updateValues !== null) {
                  const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                  if (
                    tableName === "stamp_generation_queue" &&
                    wouldCreateDuplicateQueued(rows, matched, updateValues)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  matched.forEach((r: any) => Object.assign(r, updateValues));
                  return { data: matched.map((r: any) => ({ ...r })), error: null };
                }
                const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                if (_headOnly) return { data: null, error: null, count: matched.length };
                return {
                  data:  matched.map((r: any) => ({ ...r })),
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

    const dupClient = makeClientWithDup(localDb);
    _setTestClient(dupClient as any, true);
    _setTestServiceClient(dupClient as any);

    // ── First call — should succeed and write one audit entry ────────────────
    const regen1 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen1.status, 200,
      `first regenerate must return 200, got ${regen1.status}: ${JSON.stringify(regen1.body)}`,
    );
    assert.deepEqual(regen1.body, { ok: true });

    // ── Second call — 23505 fires; must still return 200 ────────────────────
    const regen2 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen2.status, 200,
      `second regenerate must return 200 (not an error), got ${regen2.status}: ${JSON.stringify(regen2.body)}`,
    );
    assert.deepEqual(regen2.body, { ok: true });

    // ── Exactly one audit row — the second call must have been skipped ──────
    assert.equal(
      localDb.stamp_admin_audit_log.length,
      1,
      `stamp_admin_audit_log must have exactly one row after two regenerates, got ${localDb.stamp_admin_audit_log.length}: ${JSON.stringify(localDb.stamp_admin_audit_log)}`,
    );
    const logRow = localDb.stamp_admin_audit_log[0];
    assert.equal(logRow.action,     "regenerate", "audit row action must be 'regenerate'");
    assert.equal(logRow.admin_id,   ADMIN_ID,     "audit row admin_id must match the acting admin");
    assert.equal(logRow.catalog_id, CATALOG_ID,   "audit row catalog_id must match the regenerated catalog");

    // ── Detail endpoint must also surface exactly one entry ──────────────────
    const detail = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.audit), "detail response must include an audit array");
    assert.equal(
      detail.body.audit.length,
      1,
      `detail audit must have exactly one entry after two regenerates, got ${detail.body.audit.length}: ${JSON.stringify(detail.body.audit)}`,
    );
    assert.equal(detail.body.audit[0].action,   "regenerate");
    assert.equal(detail.body.audit[0].admin_id, ADMIN_ID);
  });

  it("triple regenerate: only one audit entry written even when all three calls return 200", async () => {
    // Scenario: three rapid POSTs land before any 23505 is observed by the first
    // caller.  In practice the DB unique constraint ensures at most one insert
    // succeeds; this test verifies the audit-log guard follows that same
    // constraint — i.e. the second and third calls receive 23505 and must NOT
    // write a duplicate audit row.
    const localDb = makeDb();

    function makeClientWithTripleDup(dbArg: DB) {
      function chain(tableName: string) {
        let updateValues: Record<string, any> | null = null;
        let insertRow: Record<string, any> | null    = null;
        const filters: Array<(r: any) => boolean>    = [];
        let _headOnly    = false;
        let _selectCount = false;

        const b: any = {
          select(_cols?: any, opts?: any) {
            if (opts?.count === "exact") _selectCount = true;
            if (opts?.head  === true)    _headOnly    = true;
            return b;
          },
          eq(col: string, val: any)   { filters.push((r) => r[col] === val); return b; },
          in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
          not(col: string, op: string, val: any) {
            if (op === "in") {
              const excluded = val.replace(/^\(|\)$/g, "").split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
              filters.push((r) => !excluded.includes(r[col]));
            }
            return b;
          },
          order()  { return b; },
          range()  { return b; },
          limit()  { return b; },
          update(vals: Record<string, any>) { updateValues = vals; return b; },
          insert(row: Record<string, any>)  { insertRow    = row;  return b; },

          maybeSingle() {
            const rows = dbArg[tableName] ?? [];
            if (updateValues !== null) {
              const matched = rows.filter((r: any) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
              }
              matched.forEach((r: any) => Object.assign(r, updateValues));
              return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
            }
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
          },

          single() {
            const rows    = dbArg[tableName] ?? [];
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            if (matched.length === 1)
              return Promise.resolve({ data: matched[0], error: null });
            return Promise.resolve({ data: null, error: { message: "No rows" } });
          },

          then(resolve: any, reject: any) {
            return Promise.resolve()
              .then(() => {
                const rows = dbArg[tableName] ?? [];
                if (insertRow !== null) {
                  // Simulate the partial unique index on (catalog_id) WHERE status = 'queued'.
                  if (
                    tableName === "stamp_generation_queue" &&
                    insertWouldViolateQueuedUnique(rows, insertRow)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  rows.push(insertRow);
                  return { data: { ...insertRow }, error: null };
                }
                if (updateValues !== null) {
                  const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                  if (
                    tableName === "stamp_generation_queue" &&
                    wouldCreateDuplicateQueued(rows, matched, updateValues)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  matched.forEach((r: any) => Object.assign(r, updateValues));
                  return { data: matched.map((r: any) => ({ ...r })), error: null };
                }
                const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                if (_headOnly) return { data: null, error: null, count: matched.length };
                return {
                  data:  matched.map((r: any) => ({ ...r })),
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

    const tripleClient = makeClientWithTripleDup(localDb);
    _setTestClient(tripleClient as any, true);
    _setTestServiceClient(tripleClient as any);

    // ── First call — must succeed and write exactly one audit entry ──────────
    const regen1 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen1.status, 200,
      `first regenerate must return 200, got ${regen1.status}: ${JSON.stringify(regen1.body)}`,
    );
    assert.deepEqual(regen1.body, { ok: true });

    // ── Second call — 23505; must still return 200 but not add another row ──
    const regen2 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen2.status, 200,
      `second regenerate must return 200, got ${regen2.status}: ${JSON.stringify(regen2.body)}`,
    );
    assert.deepEqual(regen2.body, { ok: true });

    // ── Third call — also 23505; must also return 200 with no new audit row ─
    const regen3 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen3.status, 200,
      `third regenerate must return 200, got ${regen3.status}: ${JSON.stringify(regen3.body)}`,
    );
    assert.deepEqual(regen3.body, { ok: true });

    // ── Exactly one audit row after all three calls ──────────────────────────
    assert.equal(
      localDb.stamp_admin_audit_log.length,
      1,
      `stamp_admin_audit_log must have exactly one row after three regenerates, got ${localDb.stamp_admin_audit_log.length}: ${JSON.stringify(localDb.stamp_admin_audit_log)}`,
    );
    const logRow = localDb.stamp_admin_audit_log[0];
    assert.equal(logRow.action,     "regenerate", "audit row action must be 'regenerate'");
    assert.equal(logRow.admin_id,   ADMIN_ID,     "audit row admin_id must match the acting admin");
    assert.equal(logRow.catalog_id, CATALOG_ID,   "audit row catalog_id must match the regenerated catalog");

    // ── Detail endpoint must also surface exactly one entry ──────────────────
    const detail = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.audit), "detail response must include an audit array");
    assert.equal(
      detail.body.audit.length,
      1,
      `detail audit must have exactly one entry after three regenerates, got ${detail.body.audit.length}: ${JSON.stringify(detail.body.audit)}`,
    );
    assert.equal(detail.body.audit[0].action,   "regenerate");
    assert.equal(detail.body.audit[0].admin_id, ADMIN_ID);
  });

  it("regenerate clears cleanup_error and cleanup_error_paths on previously-failed jobs", async () => {
    // Seed the queue job with orphaned-file metadata so the badge would show.
    const queueRow = db.stamp_generation_queue[0];
    queueRow.status               = "retryable_failed";
    queueRow.cleanup_error        = "storage.remove failed: bucket not found";
    queueRow.cleanup_error_paths  = ["stamps/abc.png", "stamps/abc_thumb.png"];

    // Trigger regenerate — should reset the failed job including cleanup columns.
    const regen = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );

    // The in-memory row must have cleanup_error and cleanup_error_paths nulled out.
    const updatedJob = db.stamp_generation_queue.find((j: any) => j.id === JOB_ID);
    assert.ok(updatedJob, "queue row must still exist after regenerate");
    assert.equal(
      updatedJob.cleanup_error,
      null,
      `cleanup_error must be null after regenerate, got: ${JSON.stringify(updatedJob.cleanup_error)}`,
    );
    assert.equal(
      updatedJob.cleanup_error_paths,
      null,
      `cleanup_error_paths must be null after regenerate, got: ${JSON.stringify(updatedJob.cleanup_error_paths)}`,
    );
  });

  it("cross-admin: second admin triggering regenerate on the same entry does not add a second audit entry", async () => {
    // ADMIN_A triggers first; ADMIN_B triggers second on the same catalog_id.
    // The queue unique constraint (catalog_id) fires 23505 on ADMIN_B's insert.
    // The guard must rely on the 23505 + hadFailedReset, NOT on admin_id equality,
    // so exactly one audit row (from ADMIN_A) must exist after both calls.

    const ADMIN_A = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    const ADMIN_B = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";

    const localDb: DB = {
      profiles: [
        { id: ADMIN_A, role: "admin" },
        { id: ADMIN_B, role: "admin" },
      ],
      universal_stamp_catalog: [
        {
          id:                     CATALOG_ID,
          canonical_location_key: "city:osaka:japan",
          stamp_type:             "location",
          display_name:           "Osaka",
          country:                "Japan",
          country_code:           "JP",
          status:                 "review_required",
          active_version_id:      null,
          earn_count:             0,
          created_at:             "2024-01-01T00:00:00Z",
          updated_at:             "2024-01-01T00:00:00Z",
        },
      ],
      stamp_generation_queue: [
        {
          id:            JOB_ID,
          catalog_id:    CATALOG_ID,
          status:        "review_required",
          last_error:    "candidate_shortfall: only 1 of 3 required",
          attempts:      3,
          requeue_count: 0,
        },
      ],
      stamp_artwork_versions: [],
      stamp_admin_audit_log:  [],
      user_stamps:            [],
    };

    // Track how many times getUser has been called to alternate admin IDs.
    let getUserCallCount = 0;
    // Track queue inserts to simulate 23505 on the second attempt.

    function makeCrossAdminClient(dbArg: DB) {
      function chain(tableName: string) {
        let updateValues: Record<string, any> | null = null;
        let insertRow: Record<string, any> | null    = null;
        const filters: Array<(r: any) => boolean>    = [];
        let _headOnly    = false;
        let _selectCount = false;

        const b: any = {
          select(_cols?: any, opts?: any) {
            if (opts?.count === "exact") _selectCount = true;
            if (opts?.head  === true)    _headOnly    = true;
            return b;
          },
          eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
          in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
          not(col: string, op: string, val: any) {
            if (op === "in") {
              const excluded = val.replace(/^\(|\)$/g, "").split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
              filters.push((r) => !excluded.includes(r[col]));
            }
            return b;
          },
          order()  { return b; },
          range()  { return b; },
          limit()  { return b; },
          update(vals: Record<string, any>) { updateValues = vals; return b; },
          insert(row: Record<string, any>)  { insertRow    = row;  return b; },

          maybeSingle() {
            const rows = dbArg[tableName] ?? [];
            if (updateValues !== null) {
              const matched = rows.filter((r: any) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
              }
              matched.forEach((r: any) => Object.assign(r, updateValues));
              return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
            }
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
          },

          single() {
            const rows    = dbArg[tableName] ?? [];
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            if (matched.length === 1)
              return Promise.resolve({ data: matched[0], error: null });
            return Promise.resolve({ data: null, error: { message: "No rows" } });
          },

          then(resolve: any, reject: any) {
            return Promise.resolve()
              .then(() => {
                const rows = dbArg[tableName] ?? [];
                if (insertRow !== null) {
                  // Simulate the partial unique index on (catalog_id) WHERE status = 'queued'.
                  if (
                    tableName === "stamp_generation_queue" &&
                    insertWouldViolateQueuedUnique(rows, insertRow)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  rows.push(insertRow);
                  return { data: { ...insertRow }, error: null };
                }
                if (updateValues !== null) {
                  const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                  if (
                    tableName === "stamp_generation_queue" &&
                    wouldCreateDuplicateQueued(rows, matched, updateValues)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  matched.forEach((r: any) => Object.assign(r, updateValues));
                  return { data: matched.map((r: any) => ({ ...r })), error: null };
                }
                const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                if (_headOnly) return { data: null, error: null, count: matched.length };
                return {
                  data:  matched.map((r: any) => ({ ...r })),
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
          getUser: () => {
            // First request → ADMIN_A; second request → ADMIN_B.
            getUserCallCount++;
            const userId = getUserCallCount <= 1 ? ADMIN_A : ADMIN_B;
            return Promise.resolve({ data: { user: { id: userId } }, error: null });
          },
        },
      };
    }

    const crossClient = makeCrossAdminClient(localDb);
    _setTestClient(crossClient as any, true);
    _setTestServiceClient(crossClient as any);

    // ── ADMIN_A triggers regenerate first ────────────────────────────────────
    const regen1 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen1.status, 200,
      `ADMIN_A regenerate must return 200, got ${regen1.status}: ${JSON.stringify(regen1.body)}`,
    );
    assert.deepEqual(regen1.body, { ok: true });

    // ── ADMIN_B triggers regenerate on the same catalog entry ────────────────
    const regen2 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen2.status, 200,
      `ADMIN_B regenerate must return 200 (not an error), got ${regen2.status}: ${JSON.stringify(regen2.body)}`,
    );
    assert.deepEqual(regen2.body, { ok: true });

    // ── Exactly one audit row — from ADMIN_A; ADMIN_B's call was a no-op ─────
    assert.equal(
      localDb.stamp_admin_audit_log.length,
      1,
      `stamp_admin_audit_log must have exactly one row after cross-admin regenerates, got ${localDb.stamp_admin_audit_log.length}: ${JSON.stringify(localDb.stamp_admin_audit_log)}`,
    );
    const logRow = localDb.stamp_admin_audit_log[0];
    assert.equal(logRow.action,     "regenerate", "audit row action must be 'regenerate'");
    assert.equal(logRow.admin_id,   ADMIN_A,      "audit row admin_id must be ADMIN_A — the first caller");
    assert.equal(logRow.catalog_id, CATALOG_ID,   "audit row catalog_id must match the regenerated catalog");
    assert.notEqual(
      logRow.admin_id,
      ADMIN_B,
      "ADMIN_B must NOT have written an audit row — guard must rely on 23505, not admin_id equality",
    );
  });

  it("cross-admin failed reset: ADMIN_B's audit entry is written when it resets a re-failed job — 23505 guard must not silence it", async () => {
    // ADMIN_A regenerates (fresh insert succeeds, audit written for A). A worker
    // then runs the job and fails, flipping it back to retryable_failed. ADMIN_B
    // regenerates: its reset update flips the failed row back to queued
    // (hadFailedReset=true), the new insert hits 23505, but state DID change —
    // ADMIN_B's audit entry must be written. Exactly two rows: one per admin.

    const ADMIN_A = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
    const ADMIN_B = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";

    const localDb: DB = {
      profiles: [
        { id: ADMIN_A, role: "admin" },
        { id: ADMIN_B, role: "admin" },
      ],
      universal_stamp_catalog: [
        {
          id:                     CATALOG_ID,
          canonical_location_key: "city:osaka:japan",
          stamp_type:             "location",
          display_name:           "Osaka",
          country:                "Japan",
          country_code:           "JP",
          status:                 "review_required",
          active_version_id:      null,
          earn_count:             0,
          created_at:             "2024-01-01T00:00:00Z",
          updated_at:             "2024-01-01T00:00:00Z",
        },
      ],
      stamp_generation_queue: [
        {
          id:            JOB_ID,
          catalog_id:    CATALOG_ID,
          status:        "review_required",
          last_error:    "candidate_shortfall: only 1 of 3 required",
          attempts:      3,
          requeue_count: 0,
        },
      ],
      stamp_artwork_versions: [],
      stamp_admin_audit_log:  [],
      user_stamps:            [],
    };

    // First request → ADMIN_A; subsequent requests → ADMIN_B.
    let getUserCallCount = 0;
    // First queue insert succeeds; later inserts hit the unique constraint.
    let queueInsertCount = 0;

    function makeFailedResetClient(dbArg: DB) {
      function chain(tableName: string) {
        let updateValues: Record<string, any> | null = null;
        let insertRow: Record<string, any> | null    = null;
        const filters: Array<(r: any) => boolean>    = [];
        let _headOnly    = false;
        let _selectCount = false;

        const b: any = {
          select(_cols?: any, opts?: any) {
            if (opts?.count === "exact") _selectCount = true;
            if (opts?.head  === true)    _headOnly    = true;
            return b;
          },
          eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
          in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
          not(col: string, op: string, val: any) {
            if (op === "in") {
              const excluded = val.replace(/^\(|\)$/g, "").split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
              filters.push((r) => !excluded.includes(r[col]));
            }
            return b;
          },
          order()  { return b; },
          range()  { return b; },
          limit()  { return b; },
          update(vals: Record<string, any>) { updateValues = vals; return b; },
          insert(row: Record<string, any>)  { insertRow    = row;  return b; },

          maybeSingle() {
            const rows = dbArg[tableName] ?? [];
            if (updateValues !== null) {
              const matched = rows.filter((r: any) => filters.every((f) => f(r)));
              if (
                tableName === "stamp_generation_queue" &&
                wouldCreateDuplicateQueued(rows, matched, updateValues)
              ) {
                return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
              }
              matched.forEach((r: any) => Object.assign(r, updateValues));
              return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
            }
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
          },

          single() {
            const rows    = dbArg[tableName] ?? [];
            const matched = rows.filter((r: any) => filters.every((f) => f(r)));
            if (matched.length === 1)
              return Promise.resolve({ data: matched[0], error: null });
            return Promise.resolve({ data: null, error: { message: "No rows" } });
          },

          then(resolve: any, reject: any) {
            return Promise.resolve()
              .then(() => {
                const rows = dbArg[tableName] ?? [];
                if (insertRow !== null) {
                  if (tableName === "stamp_generation_queue") {
                    queueInsertCount++;
                    if (queueInsertCount > 1) {
                      // ADMIN_B's fresh insert hits the unique constraint —
                      // its reset already produced the single queued row.
                      return { data: null, error: { code: "23505", message: "duplicate key value" } };
                    }
                  }
                  rows.push(insertRow);
                  return { data: { ...insertRow }, error: null };
                }
                if (updateValues !== null) {
                  const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                  if (
                    tableName === "stamp_generation_queue" &&
                    wouldCreateDuplicateQueued(rows, matched, updateValues)
                  ) {
                    return { data: null, error: { ...DUPLICATE_QUEUED_ERROR } };
                  }
                  matched.forEach((r: any) => Object.assign(r, updateValues));
                  return { data: matched.map((r: any) => ({ ...r })), error: null };
                }
                const matched = rows.filter((r: any) => filters.every((f) => f(r)));
                if (_headOnly) return { data: null, error: null, count: matched.length };
                return {
                  data:  matched.map((r: any) => ({ ...r })),
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
          getUser: () => {
            getUserCallCount++;
            const userId = getUserCallCount <= 1 ? ADMIN_A : ADMIN_B;
            return Promise.resolve({ data: { user: { id: userId } }, error: null });
          },
        },
      };
    }

    const client = makeFailedResetClient(localDb);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    // ── ADMIN_A regenerates: fresh insert succeeds, audit written for A ──────
    const regen1 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen1.status, 200,
      `ADMIN_A regenerate must return 200, got ${regen1.status}: ${JSON.stringify(regen1.body)}`,
    );
    assert.deepEqual(regen1.body, { ok: true });
    assert.equal(
      localDb.stamp_admin_audit_log.length, 1,
      "exactly one audit row must exist after ADMIN_A's regenerate",
    );
    assert.equal(localDb.stamp_admin_audit_log[0].admin_id, ADMIN_A);

    // ── A worker picks up the queued job and fails it ─────────────────────────
    const queuedJob = localDb.stamp_generation_queue.find(
      (j: any) => j.catalog_id === CATALOG_ID && j.status === "queued",
    );
    assert.ok(queuedJob, "ADMIN_A's regenerate must have produced a queued job row");
    queuedJob.status     = "retryable_failed";
    queuedJob.attempts   = 1;
    queuedJob.last_error = "generation failed: upstream timeout";

    // ── ADMIN_B regenerates: hadFailedReset=true, insert hits 23505 ──────────
    const regen2 = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen2.status, 200,
      `ADMIN_B regenerate must return 200, got ${regen2.status}: ${JSON.stringify(regen2.body)}`,
    );
    assert.deepEqual(regen2.body, { ok: true });

    // ── The failed row must have been reset back to queued by ADMIN_B ────────
    assert.equal(
      queuedJob.status, "queued",
      `ADMIN_B's regenerate must reset the failed job to queued, got '${queuedJob.status}'`,
    );

    // ── Exactly two audit rows — one per admin ────────────────────────────────
    assert.equal(
      localDb.stamp_admin_audit_log.length,
      2,
      `stamp_admin_audit_log must have exactly two rows (one per admin), got ${localDb.stamp_admin_audit_log.length}: ${JSON.stringify(localDb.stamp_admin_audit_log)}`,
    );
    const [rowA, rowB] = localDb.stamp_admin_audit_log;
    assert.equal(rowA.action,     "regenerate", "first audit row action must be 'regenerate'");
    assert.equal(rowA.admin_id,   ADMIN_A,      "first audit row must belong to ADMIN_A");
    assert.equal(rowA.catalog_id, CATALOG_ID);
    assert.equal(rowB.action,     "regenerate", "second audit row action must be 'regenerate'");
    assert.equal(
      rowB.admin_id, ADMIN_B,
      "second audit row must belong to ADMIN_B — the 23505 guard must not silence a reset that changed state",
    );
    assert.equal(rowB.catalog_id, CATALOG_ID);
  });

  it("after POST regenerate: detail audit has exactly one entry — action=regenerate, admin_id=ADMIN_ID", async () => {
    // ── Pre-condition: audit is empty ────────────────────────────────────────
    const before = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(before.status, 200);
    assert.ok(Array.isArray(before.body.audit), "audit must be an array");
    assert.equal(
      before.body.audit.length,
      0,
      "audit array must be empty before regenerate",
    );

    // ── Action ───────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── Verify writeAuditLog flushed the row to the DB table directly ─────────
    assert.equal(
      db.stamp_admin_audit_log.length,
      1,
      `exactly one row must be in stamp_admin_audit_log after regenerate, got ${db.stamp_admin_audit_log.length}`,
    );
    const dbRow = db.stamp_admin_audit_log[0];
    assert.equal(dbRow.action,     "regenerate", "DB row action must be 'regenerate'");
    assert.equal(dbRow.admin_id,   ADMIN_ID,     "DB row admin_id must match the acting admin");
    assert.equal(dbRow.catalog_id, CATALOG_ID,   "DB row catalog_id must match the regenerated catalog");

    // ── Detail fetch must return the audit row ────────────────────────────────
    const after = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(
      after.status, 200,
      `detail GET must return 200 after regenerate, got ${after.status}: ${JSON.stringify(after.body)}`,
    );

    assert.ok(
      Array.isArray(after.body.audit),
      "detail response must include an audit array after regenerate",
    );
    assert.equal(
      after.body.audit.length,
      1,
      `audit array must have exactly one entry after regenerate, got ${after.body.audit.length}: ${JSON.stringify(after.body.audit)}`,
    );

    const entry = after.body.audit[0];
    assert.equal(
      entry.action,
      "regenerate",
      `audit entry action must be 'regenerate', got '${entry.action}'`,
    );
    assert.equal(
      entry.admin_id,
      ADMIN_ID,
      `audit entry admin_id must be the acting admin (${ADMIN_ID}), got '${entry.admin_id}'`,
    );
  });
});
