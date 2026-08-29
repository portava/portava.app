/**
 * Degraded badge disappears on the stamp detail page after an admin re-queues
 *
 * GET /admin/stamps/catalog/:id fetches its own queue row independently of the
 * list enrichment path.  If the fetch forgets to exclude archived rows, the
 * detail view can continue showing last_error / status=review_required even
 * after the list is clean.
 *
 * The handler filters queue rows with:
 *   .not("status", "in", '("archived")')
 *
 * After POST /regenerate archives the review_required row, that filter must
 * produce no match → queue: null → no badge on the detail screen.
 *
 * Tests:
 *   1. Baseline: detail returns queue with last_error before any admin action.
 *   2. After POST regenerate: detail returns queue: null (badge gone).
 *   3. After POST requeue:    detail returns a queued row without last_error
 *      (the row is no longer review_required → badge condition fails).
 *   4. Both list and detail agree on badge state after regenerate.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogDetailBadge.test.ts
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
const REGEN_ID    = "cccccccc-0000-4000-8000-000000000020";
const REQUEUE_ID  = "cccccccc-0000-4000-8000-000000000021";
const REGEN_JOB   = "eeeeeeee-0000-4000-8000-000000000020";
const REQUEUE_JOB = "eeeeeeee-0000-4000-8000-000000000021";

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
//
// Extends the pattern from stampCatalogRequeueBadge.test.ts with proper
// .not(col, op, val) support so the detail handler's
//   .not("status", "in", '("archived")')
// actually excludes archived rows after regenerate.

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
      /**
       * Supports .not(col, "in", '("archived")')  — the form used by
       * GET /admin/stamps/catalog/:id to exclude archived queue rows.
       * Other operator forms fall through as no-ops (permissive for unrelated
       * calls like .not("lat", "is", null) in the duplicates handler).
       */
      not(col: string, op: string, val: any) {
        if (op === "in") {
          const excluded = parseInList(String(val));
          filters.push((r) => !excluded.includes(r[col]));
        }
        // "is" and other operators used elsewhere are not needed here; skip.
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
        id:            REGEN_JOB,
        catalog_id:    REGEN_ID,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 1 of 3 required",
        attempts:      3,
        requeue_count: 0,
      },
      // Requeue scenario: permanently_failed row that will be moved to queued
      {
        id:            REQUEUE_JOB,
        catalog_id:    REQUEUE_ID,
        status:        "permanently_failed",
        last_error:    "candidate_shortfall: exhausted retries",
        attempts:      5,
        requeue_count: 1,
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

// ── Helper: badge condition ───────────────────────────────────────────────────
//
// Mirrors the condition checked on both queue.tsx screens:
//   item.status === 'review_required'
//     && typeof item.last_error === 'string'
//     && item.last_error.startsWith('candidate_shortfall')

function hasDegradedBadge(queue: any): boolean {
  if (!queue) return false;
  return (
    queue.status === "review_required" &&
    typeof queue.last_error === "string" &&
    (queue.last_error as string).startsWith("candidate_shortfall")
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Detail page badge disappears after admin resolves review_required entry", () => {

  it("baseline: detail returns a queue row with last_error before any admin action", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${REGEN_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(body.queue, "queue must be present before any admin action");
    assert.equal(
      hasDegradedBadge(body.queue),
      true,
      `degraded badge must be visible before regenerate: queue=${JSON.stringify(body.queue)}`,
    );
  });

  it("after POST regenerate: detail returns queue: null — badge is gone", async () => {
    // ── Pre-condition: badge is visible on detail ─────────────────────────────
    const before = await get(`/admin/stamps/catalog/${REGEN_ID}`);
    assert.equal(before.status, 200);
    assert.ok(before.body.queue, "queue must be present before regenerate");
    assert.equal(
      hasDegradedBadge(before.body.queue),
      true,
      "degraded badge must be present on detail before the regenerate action",
    );

    // ── Action ────────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${REGEN_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── Queue row must now be archived in the DB ───────────────────────────────
    const jobRow = db.stamp_generation_queue.find((r) => r.id === REGEN_JOB);
    assert.ok(jobRow, "REGEN_JOB row must still exist in the DB");
    assert.equal(jobRow.status, "archived", "regenerate must archive the review_required row");

    // ── Detail must return the new queued row — not the archived one ─────────
    // regenerate() archives the review_required row AND inserts a fresh queued
    // row.  The detail handler's .not("status","in",'("archived")') excludes
    // the archived row, so it finds the new queued row instead.
    const after = await get(`/admin/stamps/catalog/${REGEN_ID}`);
    assert.equal(after.status, 200, `detail GET must return 200 after regenerate`);

    assert.ok(
      after.body.queue,
      "detail queue must be present after regenerate — a fresh queued row was inserted",
    );
    assert.equal(
      after.body.queue.status,
      "queued",
      "detail queue status must be 'queued' — regenerate inserts a new queued job",
    );
    // last_error must be absent on the new row — it was not copied from the archived one
    assert.ok(
      !after.body.queue.last_error,
      "detail queue must have no last_error after regenerate",
    );
    assert.equal(
      hasDegradedBadge(after.body.queue),
      false,
      "degraded badge must not appear — the new queue row is 'queued', not 'review_required'",
    );
  });

  it("after POST requeue: detail returns the queued row without last_error — badge is gone", async () => {
    // The REQUEUE_ID catalog entry has a permanently_failed row.
    // Permanently_failed rows are NOT filtered by the detail handler's
    // .not("status","in",'("archived")') — they still appear in queue.
    // But their status !== 'review_required' so the badge condition fails.
    // After requeue moves the row to 'queued' and clears last_error,
    // the badge condition still fails.

    // ── Pre-condition: no badge (permanently_failed ≠ review_required) ────────
    const before = await get(`/admin/stamps/catalog/${REQUEUE_ID}`);
    assert.equal(before.status, 200);
    assert.ok(before.body.queue, "queue must be present (permanently_failed row)");
    assert.equal(
      hasDegradedBadge(before.body.queue),
      false,
      "permanently_failed row must not trigger the degraded badge (wrong status)",
    );

    // ── Action ────────────────────────────────────────────────────────────────
    const requeue = await post(`/admin/stamps/queue/${REQUEUE_JOB}/requeue`);
    assert.equal(
      requeue.status, 200,
      `requeue must return 200, got ${requeue.status}: ${JSON.stringify(requeue.body)}`,
    );
    assert.ok(requeue.body.job, "response must include updated job row");
    assert.equal(requeue.body.job.status, "queued");

    // ── Queue row is now 'queued' with cleared last_error ─────────────────────
    const jobRow = db.stamp_generation_queue.find((r) => r.id === REQUEUE_JOB);
    assert.ok(jobRow);
    assert.equal(jobRow.status,     "queued");
    assert.equal(jobRow.last_error,  null);

    // ── Detail must show queued row without last_error — no badge ─────────────
    const after = await get(`/admin/stamps/catalog/${REQUEUE_ID}`);
    assert.equal(after.status, 200);
    assert.ok(after.body.queue, "queue must still be present (queued row is not archived)");
    assert.equal(
      after.body.queue.status,
      "queued",
      "detail queue status must be 'queued' after requeue",
    );
    assert.equal(
      after.body.queue.last_error,
      null,
      "detail queue last_error must be null after requeue clears it",
    );
    assert.equal(
      hasDegradedBadge(after.body.queue),
      false,
      "degraded badge must not appear — queued status fails the review_required check",
    );
  });

  it("list and detail agree on badge state after regenerate", async () => {
    // Confirm the two fetch paths produce consistent badge state so the UI
    // cannot show a badge on one screen and hide it on the other.

    // ── Action ────────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${REGEN_ID}/regenerate`);
    assert.equal(regen.status, 200);

    // ── List view ─────────────────────────────────────────────────────────────
    const list = await get("/admin/stamps/catalog");
    assert.equal(list.status, 200);
    const listEntry = list.body.entries.find((e: any) => e.id === REGEN_ID);
    assert.ok(listEntry, "REGEN_ID must still appear in the catalog list");

    const listBadge = listEntry.status === "review_required" &&
      typeof listEntry.last_error === "string" &&
      listEntry.last_error.startsWith("candidate_shortfall");

    // ── Detail view ───────────────────────────────────────────────────────────
    const detail = await get(`/admin/stamps/catalog/${REGEN_ID}`);
    assert.equal(detail.status, 200);
    const detailBadge = hasDegradedBadge(detail.body.queue);

    // ── Both must agree: no badge ─────────────────────────────────────────────
    assert.equal(
      listBadge,
      false,
      `list view must not show badge after regenerate: entry=${JSON.stringify(listEntry)}`,
    );
    assert.equal(
      detailBadge,
      false,
      `detail view must not show badge after regenerate: queue=${JSON.stringify(detail.body.queue)}`,
    );
    assert.equal(
      listBadge,
      detailBadge,
      "list and detail must agree on badge state — both must be clear after regenerate",
    );
  });
});
