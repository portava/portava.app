/**
 * Audit log is filtered to the correct catalog — not shared across entries
 *
 * GET /admin/stamps/catalog/:id fetches audit rows with .eq("catalog_id", id).
 * If that filter is accidentally dropped, regenerating catalog A would make its
 * audit entry appear on catalog B's detail page — polluting the admin trail.
 *
 * Tests:
 *   1. After POST regenerate on catalog A:
 *      - GET detail for catalog A returns audit.length === 1 with action === "regenerate"
 *      - GET detail for catalog B returns audit.length === 0
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogAuditLogFilter.test.ts
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

const ADMIN_ID    = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_A   = "cccccccc-0000-4000-8000-000000000041";
const CATALOG_B   = "cccccccc-0000-4000-8000-000000000042";
const JOB_A       = "eeeeeeee-0000-4000-8000-000000000041";
const JOB_B       = "eeeeeeee-0000-4000-8000-000000000042";

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
        id:                     CATALOG_A,
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
      {
        id:                     CATALOG_B,
        canonical_location_key: "city:kyoto:japan",
        stamp_type:             "location",
        display_name:           "Kyoto",
        country:                "Japan",
        country_code:           "JP",
        status:                 "review_required",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-02T00:00:00Z",
        updated_at:             "2024-01-02T00:00:00Z",
      },
    ],
    stamp_generation_queue: [
      {
        id:            JOB_A,
        catalog_id:    CATALOG_A,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 1 of 3 required",
        attempts:      3,
        requeue_count: 0,
      },
      {
        id:            JOB_B,
        catalog_id:    CATALOG_B,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 1 of 3 required",
        attempts:      2,
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

describe("Audit log is filtered to the correct catalog — not shared across entries", () => {

  it("concurrent regenerate on both catalogs: each catalog's audit is scoped to its own catalog_id", async () => {
    // ── Fire both regenerations simultaneously ────────────────────────────────
    const [regenA, regenB] = await Promise.all([
      post(`/admin/stamps/catalog/${CATALOG_A}/regenerate`),
      post(`/admin/stamps/catalog/${CATALOG_B}/regenerate`),
    ]);

    assert.equal(
      regenA.status, 200,
      `regenerate catalog A must return 200, got ${regenA.status}: ${JSON.stringify(regenA.body)}`,
    );
    assert.deepEqual(regenA.body, { ok: true });

    assert.equal(
      regenB.status, 200,
      `regenerate catalog B must return 200, got ${regenB.status}: ${JSON.stringify(regenB.body)}`,
    );
    assert.deepEqual(regenB.body, { ok: true });

    // ── Exactly two audit rows in DB, one per catalog ─────────────────────────
    assert.equal(
      db.stamp_admin_audit_log.length,
      2,
      `exactly two audit rows must exist after concurrent regeneration, got ${db.stamp_admin_audit_log.length}: ${JSON.stringify(db.stamp_admin_audit_log)}`,
    );

    const rowForA = db.stamp_admin_audit_log.find((r: any) => r.catalog_id === CATALOG_A);
    const rowForB = db.stamp_admin_audit_log.find((r: any) => r.catalog_id === CATALOG_B);

    assert.ok(
      rowForA !== undefined,
      `an audit row with catalog_id === CATALOG_A must exist in the DB`,
    );
    assert.ok(
      rowForB !== undefined,
      `an audit row with catalog_id === CATALOG_B must exist in the DB`,
    );
    assert.equal(rowForA!.action, "regenerate", "catalog A audit row must have action 'regenerate'");
    assert.equal(rowForB!.action, "regenerate", "catalog B audit row must have action 'regenerate'");

    // ── GET detail for catalog A: exactly one audit entry, scoped to A ────────
    const detailA = await get(`/admin/stamps/catalog/${CATALOG_A}`);
    assert.equal(
      detailA.status, 200,
      `catalog A detail must return 200, got ${detailA.status}: ${JSON.stringify(detailA.body)}`,
    );
    assert.ok(Array.isArray(detailA.body.audit), "catalog A audit must be an array");
    assert.equal(
      detailA.body.audit.length,
      1,
      `catalog A detail must have exactly one audit entry, got ${detailA.body.audit.length}: ${JSON.stringify(detailA.body.audit)}`,
    );
    assert.equal(
      detailA.body.audit[0].action,
      "regenerate",
      `catalog A audit entry action must be 'regenerate', got '${detailA.body.audit[0].action}'`,
    );

    // No catalog B row leaked into catalog A's audit
    const leakInA = detailA.body.audit.filter((r: any) => r.catalog_id === CATALOG_B);
    assert.equal(
      leakInA.length,
      0,
      `catalog A detail must not contain audit rows belonging to catalog B, got: ${JSON.stringify(leakInA)}`,
    );

    // ── GET detail for catalog B: exactly one audit entry, scoped to B ────────
    const detailB = await get(`/admin/stamps/catalog/${CATALOG_B}`);
    assert.equal(
      detailB.status, 200,
      `catalog B detail must return 200, got ${detailB.status}: ${JSON.stringify(detailB.body)}`,
    );
    assert.ok(Array.isArray(detailB.body.audit), "catalog B audit must be an array");
    assert.equal(
      detailB.body.audit.length,
      1,
      `catalog B detail must have exactly one audit entry, got ${detailB.body.audit.length}: ${JSON.stringify(detailB.body.audit)}`,
    );
    assert.equal(
      detailB.body.audit[0].action,
      "regenerate",
      `catalog B audit entry action must be 'regenerate', got '${detailB.body.audit[0].action}'`,
    );

    // No catalog A row leaked into catalog B's audit
    const leakInB = detailB.body.audit.filter((r: any) => r.catalog_id === CATALOG_A);
    assert.equal(
      leakInB.length,
      0,
      `catalog B detail must not contain audit rows belonging to catalog A, got: ${JSON.stringify(leakInB)}`,
    );
  });

  it("regenerating catalog A: catalog A detail has one audit entry; catalog B detail has none", async () => {
    // ── Pre-condition: both catalogs start with empty audit arrays ────────────
    const beforeA = await get(`/admin/stamps/catalog/${CATALOG_A}`);
    assert.equal(beforeA.status, 200, `catalog A detail must return 200, got ${beforeA.status}: ${JSON.stringify(beforeA.body)}`);
    assert.ok(Array.isArray(beforeA.body.audit), "catalog A audit must be an array");
    assert.equal(beforeA.body.audit.length, 0, "catalog A audit must be empty before any action");

    const beforeB = await get(`/admin/stamps/catalog/${CATALOG_B}`);
    assert.equal(beforeB.status, 200, `catalog B detail must return 200, got ${beforeB.status}: ${JSON.stringify(beforeB.body)}`);
    assert.ok(Array.isArray(beforeB.body.audit), "catalog B audit must be an array");
    assert.equal(beforeB.body.audit.length, 0, "catalog B audit must be empty before any action");

    // ── Action: regenerate only catalog A ─────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${CATALOG_A}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── Verify exactly one audit row was written, scoped to catalog A ─────────
    assert.equal(
      db.stamp_admin_audit_log.length,
      1,
      `exactly one row must be in stamp_admin_audit_log after regenerate, got ${db.stamp_admin_audit_log.length}`,
    );
    const dbRow = db.stamp_admin_audit_log[0];
    assert.equal(dbRow.catalog_id, CATALOG_A, "audit row catalog_id must be catalog A");
    assert.equal(dbRow.action,     "regenerate", "audit row action must be 'regenerate'");

    // ── Catalog A detail: audit.length === 1, action === "regenerate" ─────────
    const afterA = await get(`/admin/stamps/catalog/${CATALOG_A}`);
    assert.equal(
      afterA.status, 200,
      `catalog A detail must return 200 after regenerate, got ${afterA.status}: ${JSON.stringify(afterA.body)}`,
    );
    assert.ok(Array.isArray(afterA.body.audit), "catalog A audit must be an array after regenerate");
    assert.equal(
      afterA.body.audit.length,
      1,
      `catalog A audit must have exactly one entry, got ${afterA.body.audit.length}: ${JSON.stringify(afterA.body.audit)}`,
    );
    assert.equal(
      afterA.body.audit[0].action,
      "regenerate",
      `catalog A audit entry action must be 'regenerate', got '${afterA.body.audit[0].action}'`,
    );

    // ── Catalog B detail: audit.length === 0 (filter must not leak across) ────
    const afterB = await get(`/admin/stamps/catalog/${CATALOG_B}`);
    assert.equal(
      afterB.status, 200,
      `catalog B detail must return 200 after catalog A was regenerated, got ${afterB.status}: ${JSON.stringify(afterB.body)}`,
    );
    assert.ok(Array.isArray(afterB.body.audit), "catalog B audit must be an array");
    assert.equal(
      afterB.body.audit.length,
      0,
      `catalog B audit must remain empty — the .eq("catalog_id") filter must not leak catalog A's audit row, got ${afterB.body.audit.length}: ${JSON.stringify(afterB.body.audit)}`,
    );
  });
});
