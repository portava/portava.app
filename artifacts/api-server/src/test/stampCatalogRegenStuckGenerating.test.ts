/**
 * Regenerate must reclaim a stuck `generating` job (audit STAMP·H4).
 *
 * A generation job left in `generating` by a crashed worker keeps the catalog
 * entry's only active-job slot: the partial unique index uix_queue_catalog_active
 * treats `generating` as active (it excludes only archived / retryable_failed /
 * permanently_failed). Before the fix, the regenerate handler never touched
 * `generating` rows, so the fresh queued insert hit 23505 — which the handler
 * swallows — and the entry stayed wedged forever with no queued row and no way
 * to generate artwork.
 *
 * The fix archives `generating` rows whose lock has expired before inserting, so
 * the fresh queued row lands. A row a worker is still actively generating (lock
 * in the future) is deliberately left alone so in-flight work is never orphaned.
 *
 * The fake client models the production unique index on the *active* status set
 * (via isActiveQueueStatus) rather than the default queued-only helper — so a
 * `generating` row really does block a `queued` insert here. If the reclaim step
 * were reverted, scenario 1 would find the generating row un-archived and zero
 * queued rows, and this suite would fail.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenStuckGenerating.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";
import {
  wouldCreateDuplicateQueued,
  isActiveQueueStatus,
  DUPLICATE_QUEUED_ERROR,
} from "./stampQueueConstraint.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID    = "aaaaaaaa-0000-4000-8000-000000000010";
const CATALOG_ID  = "cccccccc-0000-4000-8000-000000000010";
const STUCK_JOB_ID = "qqqqqqqq-0000-4000-8000-000000000010";

// A lock stamp far in the past (crashed worker) vs. far in the future (a live
// worker still holding the lock). The handler compares against Date.now().
const EXPIRED_LOCK = "2000-01-01T00:00:00.000Z";
const FUTURE_LOCK  = "2999-01-01T00:00:00.000Z";

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
        headers:  { authorization: "Bearer fake-admin-token", "content-type": "application/json" },
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

// ── Mutable in-memory fake client ────────────────────────────────────────────
//
// The partial unique index is modelled over the *active* status set: an insert
// or update that would leave two active rows (any status not in the excluded
// terminal set) for the same catalog_id returns 23505. This is what makes a
// lingering `generating` row block a fresh `queued` insert, exactly as in prod.

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>     = [];
    let _selectAfterUpdate = false;

    const b: any = {
      select(_cols?: any) {
        if (updateValues !== null) _selectAfterUpdate = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()   { return b; },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow    = row;  return b; },

      maybeSingle() {
        const rows = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (updateValues !== null) {
          if (
            tableName === "stamp_generation_queue" &&
            wouldCreateDuplicateQueued(rows, matched, updateValues)
          ) {
            return Promise.resolve({ data: null, error: { ...DUPLICATE_QUEUED_ERROR } });
          }
          matched.forEach((r) => Object.assign(r, updateValues));
          return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
        }
        return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
      },

      single() {
        const rows    = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (matched.length === 1) return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({ data: null, error: { message: "No rows" } });
      },

      then(resolve: any, reject: any) {
        return Promise.resolve()
          .then(() => {
            const rows = db[tableName] ?? [];

            if (insertRow !== null) {
              // Active-status-aware insert conflict: any existing active row for
              // this catalog_id blocks a new active insert (models uix_queue_catalog_active).
              if (
                tableName === "stamp_generation_queue" &&
                isActiveQueueStatus(insertRow.status) &&
                rows.some((r) => r.catalog_id === insertRow.catalog_id && isActiveQueueStatus(r.status))
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
              const data = _selectAfterUpdate ? matched.map((r) => ({ ...r })) : null;
              return { data, error: null };
            }

            const matched = rows.filter((r) => filters.every((f) => f(r)));
            return { data: matched.map((r) => ({ ...r })), error: null };
          })
          .then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }) },
  };
}

// ── DB factory ────────────────────────────────────────────────────────────────

function makeGeneratingRow(lockedUntil: string): Record<string, any> {
  return {
    id:                  STUCK_JOB_ID,
    catalog_id:          CATALOG_ID,
    status:              "generating",
    attempts:            1,
    requeue_count:       0,
    last_error:          null,
    locked_until:        lockedUntil,
    locked_by:           "worker-dead",
    triggered_by_action: "worker",
    priority:            5,
    created_at:          "2024-01-01T00:00:00Z",
    updated_at:          "2024-01-01T00:00:00Z",
  };
}

function makeDb(lockedUntil: string): DB {
  return {
    profiles:                [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [{
      id: CATALOG_ID, canonical_location_key: "city:paris:france", stamp_type: "location",
      display_name: "Paris", country: "France", country_code: "FR",
      status: "pending_artwork", active_version_id: null, earn_count: 0,
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    }],
    stamp_generation_queue:  [makeGeneratingRow(lockedUntil)],
    stamp_artwork_versions:  [],
    stamp_admin_audit_log:   [],
  };
}

let db: DB;
function setupDb(lockedUntil: string) {
  db = makeDb(lockedUntil);
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Tests: stuck (crashed) generating job — lock expired ──────────────────────

describe("POST regenerate with a stuck 'generating' job (expired lock)", () => {
  beforeEach(() => setupDb(EXPIRED_LOCK));

  it("returns 200 { ok: true }", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true });
  });

  it("archives the stuck generating row, freeing the catalog's active-job slot", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    const stuck = db.stamp_generation_queue.find((r) => r.id === STUCK_JOB_ID);
    assert.ok(stuck, "the original job row must still exist");
    assert.equal(
      stuck!.status, "archived",
      `stuck generating row must be archived, still: ${stuck!.status}`,
    );
  });

  it("inserts a fresh queued row instead of swallowing 23505", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(
      queued.length, 1,
      `expected exactly 1 fresh queued row, found ${queued.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
    assert.notEqual(queued[0].id, STUCK_JOB_ID, "the queued row must be the freshly inserted job");
  });

  it("writes an audit entry (state changed — fresh job enqueued)", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    const audits = db.stamp_admin_audit_log.filter((r) => r.action === "regenerate");
    assert.equal(audits.length, 1, `expected one regenerate audit row, found ${audits.length}`);
  });
});

// ── Tests: actively generating job — lock still valid (must be left alone) ─────

describe("POST regenerate with an actively 'generating' job (valid lock)", () => {
  beforeEach(() => setupDb(FUTURE_LOCK));

  it("leaves the in-flight generating row untouched (no orphaned work)", async () => {
    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    const row = db.stamp_generation_queue.find((r) => r.id === STUCK_JOB_ID);
    assert.ok(row, "the in-flight job row must still exist");
    assert.equal(
      row!.status, "generating",
      `an actively-locked generating row must NOT be archived, got: ${row!.status}`,
    );
  });

  it("does not create a second active row while a worker holds the lock", async () => {
    await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    const active = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && isActiveQueueStatus(r.status),
    );
    assert.equal(
      active.length, 1,
      `only the in-flight row may be active, found ${active.length}: ${JSON.stringify(db.stamp_generation_queue)}`,
    );
  });
});
