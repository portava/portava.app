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
  await new Promise<void>((resolve) => server.listen(0, resolve));
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
              rows.push(insertRow);
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
