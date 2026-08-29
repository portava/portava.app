/**
 * Degraded-badge disappears after admin resolves a review_required entry
 *
 * The GET /admin/stamps/catalog handler only attaches last_error to catalog
 * entries that have a queue row in review_required status. The "degraded"
 * badge in both queue screens is only rendered when:
 *
 *   item.status === 'review_required'
 *     && typeof item.last_error === 'string'
 *     && item.last_error.startsWith('candidate_shortfall')
 *
 * This test file covers the two admin actions that remove the condition:
 *
 *   1. POST /admin/stamps/catalog/:id/regenerate
 *      Archives the review_required queue row.  Subsequent GET /catalog must
 *      return the entry without last_error → badge is gone.
 *
 *   2. POST /admin/stamps/queue/:jobId/requeue
 *      Moves a permanently_failed job to queued (clears last_error in DB).
 *      The queue row is no longer review_required so the enrichment join
 *      produces no match → badge is gone.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRequeueBadge.test.ts
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
const REGEN_ID    = "cccccccc-0000-4000-8000-000000000010"; // catalog entry for regenerate test
const REQUEUE_ID  = "cccccccc-0000-4000-8000-000000000011"; // catalog entry for requeue test
const REGEN_JOB   = "eeeeeeee-0000-4000-8000-000000000010"; // review_required queue row
const REQUEUE_JOB = "eeeeeeee-0000-4000-8000-000000000011"; // permanently_failed queue row

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
          authorization:   "Bearer fake-admin-token",
          "content-type":  "application/json",
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
//
// Extends the read-only chain used by stampCatalogListEnrichment with
// mutable update() and insert() so the route handlers can mutate state
// and the subsequent GET reflects those mutations.

type DB = Record<string, any[]>;

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
        if (opts?.head === true)     _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()    { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow   = row;   return b; },

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
          return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)));
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
              // Return copies so caller mutations don't pollute the stored rows
              return { data: matched.map((r) => ({ ...r })), error: null };
            }
            const matched = rows.filter((r) => filters.every((f) => f(r)));
            if (_headOnly) return { data: null, error: null, count: matched.length };
            // Return shallow copies — the GET handler sets last_error on entries
            // in-place; without copies those writes would permanently corrupt the
            // stored catalog rows across multiple requests in the same test.
            return {
              data: matched.map((r) => ({ ...r })),
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
        id:                     REGEN_ID,
        canonical_location_key: "city:tokyo:japan",
        stamp_type:             "location",
        display_name:           "Tokyo",
        country:                "Japan",
        country_code:           "JP",
        status:                 "review_required",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
      {
        id:                     REQUEUE_ID,
        canonical_location_key: "city:berlin:germany",
        stamp_type:             "location",
        display_name:           "Berlin",
        country:                "Germany",
        country_code:           "DE",
        status:                 "review_required",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-02T00:00:00Z",
        updated_at:             "2024-01-02T00:00:00Z",
      },
    ],
    stamp_generation_queue: [
      // Regenerate scenario: review_required row that will be archived
      {
        id:         REGEN_JOB,
        catalog_id: REGEN_ID,
        status:     "review_required",
        last_error: "candidate_shortfall: only 1 of 3 required",
        attempts:   3,
        requeue_count: 0,
      },
      // Requeue scenario: permanently_failed row that will be moved to queued
      {
        id:         REQUEUE_JOB,
        catalog_id: REQUEUE_ID,
        status:     "permanently_failed",
        last_error: "candidate_shortfall: exhausted retries",
        attempts:   5,
        requeue_count: 1,
      },
    ],
    stamp_artwork_versions: [],
    stamp_admin_audit_log:  [],
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

// ── Helper: badge condition ───────────────────────────────────────────────────
//
// Mirrors the condition in both queue.tsx screens:
//   item.status === 'review_required'
//     && typeof item.last_error === 'string'
//     && item.last_error.startsWith('candidate_shortfall')

function hasDegradedBadge(entry: any): boolean {
  return (
    entry.status === "review_required" &&
    typeof entry.last_error === "string" &&
    (entry.last_error as string).startsWith("candidate_shortfall")
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Degraded badge disappears after admin resolves review_required entry", () => {

  it("badge is present before any admin action — baseline", async () => {
    const { status, body } = await get("/admin/stamps/catalog");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const entry = body.entries.find((e: any) => e.id === REGEN_ID);
    assert.ok(entry, "REGEN_ID entry must be in the list");
    assert.equal(
      hasDegradedBadge(entry),
      true,
      `degraded badge must be present before regenerate: entry=${JSON.stringify(entry)}`,
    );
  });

  it("after POST regenerate the review_required queue row is archived and last_error is absent", async () => {
    // ── Pre-condition: badge is visible ──────────────────────────────────────
    const before = await get("/admin/stamps/catalog");
    assert.equal(before.status, 200);
    const entryBefore = before.body.entries.find((e: any) => e.id === REGEN_ID);
    assert.ok(entryBefore);
    assert.equal(
      hasDegradedBadge(entryBefore),
      true,
      "degraded badge must be present before the regenerate action",
    );

    // ── Action ────────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${REGEN_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── Queue row must now be archived ────────────────────────────────────────
    const jobRow = db.stamp_generation_queue.find((r) => r.id === REGEN_JOB);
    assert.ok(jobRow, "REGEN_JOB row must still exist in the DB");
    assert.equal(
      jobRow.status,
      "archived",
      "regenerate must archive the review_required queue row",
    );

    // ── Subsequent GET must not carry last_error (no badge) ───────────────────
    const after = await get("/admin/stamps/catalog");
    assert.equal(after.status, 200);

    const entryAfter = after.body.entries.find((e: any) => e.id === REGEN_ID);
    assert.ok(entryAfter, "REGEN_ID entry must still appear in catalog list after regenerate");

    assert.equal(
      Object.prototype.hasOwnProperty.call(entryAfter, "last_error"),
      false,
      "last_error must be absent from the catalog entry after the review_required row is archived",
    );
    assert.equal(
      hasDegradedBadge(entryAfter),
      false,
      "degraded badge must not be rendered when last_error is absent — both queue screens are clear",
    );
  });

  it("after POST requeue the permanently_failed row moves to queued and catalog entry has no last_error", async () => {
    // The requeue endpoint handles retryable_failed / permanently_failed jobs.
    // After it runs, the queue row status becomes 'queued' (not 'review_required'),
    // so the enrichment join on GET /catalog produces no match for that catalog_id
    // and last_error is absent — the badge condition fails.

    // ── Pre-condition: no badge (permanently_failed row not enriched) ─────────
    const before = await get("/admin/stamps/catalog");
    assert.equal(before.status, 200);
    const entryBefore = before.body.entries.find((e: any) => e.id === REQUEUE_ID);
    assert.ok(entryBefore);
    assert.equal(
      Object.prototype.hasOwnProperty.call(entryBefore, "last_error"),
      false,
      "permanently_failed queue row must not enrich the catalog entry with last_error",
    );

    // ── Action ────────────────────────────────────────────────────────────────
    const requeue = await post(`/admin/stamps/queue/${REQUEUE_JOB}/requeue`);
    assert.equal(
      requeue.status, 200,
      `requeue must return 200, got ${requeue.status}: ${JSON.stringify(requeue.body)}`,
    );
    assert.ok(requeue.body.job, "response must include updated job row");
    assert.equal(requeue.body.job.status, "queued");

    // ── Queue row must be cleared in-memory ───────────────────────────────────
    const jobRow = db.stamp_generation_queue.find((r) => r.id === REQUEUE_JOB);
    assert.ok(jobRow);
    assert.equal(jobRow.status,     "queued", "requeue must set status to queued");
    assert.equal(jobRow.last_error,  null,    "requeue must clear last_error in the queue row");
    assert.equal(jobRow.attempts,    0,       "requeue must reset attempts to 0");
    assert.equal(jobRow.requeue_count, 0,     "requeue must reset requeue_count to 0");

    // ── Subsequent GET must not carry last_error (no badge) ───────────────────
    const after = await get("/admin/stamps/catalog");
    assert.equal(after.status, 200);

    const entryAfter = after.body.entries.find((e: any) => e.id === REQUEUE_ID);
    assert.ok(entryAfter, "REQUEUE_ID entry must still appear in catalog list after requeue");

    assert.equal(
      Object.prototype.hasOwnProperty.call(entryAfter, "last_error"),
      false,
      "last_error must be absent after requeue moves the job out of review_required status",
    );
    assert.equal(
      hasDegradedBadge(entryAfter),
      false,
      "degraded badge must not appear — both queue screens render no badge when last_error is absent",
    );
  });
});
