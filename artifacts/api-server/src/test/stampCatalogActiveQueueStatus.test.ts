/**
 * GET /admin/stamps/catalog — active queue status enrichment
 *
 * When a catalog status reset fails during regenerate, the entry can be left
 * in a stale "rejected" state while a live (queued/processing) queue job
 * exists. The list endpoint attaches `queue_status` to any entry that has an
 * active queue row, regardless of catalog status, so the partial-failure
 * state is detectable from the admin list.
 *
 * Invariants tested:
 *  1. A "rejected" entry with a queued job carries queue_status: "queued"
 *  2. A "rejected" entry with a processing job carries queue_status: "processing"
 *  3. Entries without an active queue row get NO queue_status key
 *  4. An entry whose queue row is in a non-active status (e.g. review_required)
 *     does not get queue_status
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogActiveQueueStatus.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID          = "aaaaaaaa-0000-4000-8000-000000000001";
const REJECTED_QUEUED   = "dddddddd-0000-4000-8000-000000000001"; // rejected + queued job
const REJECTED_PROCESS  = "dddddddd-0000-4000-8000-000000000002"; // rejected + generating job
const APPROVED_NO_QUEUE = "dddddddd-0000-4000-8000-000000000003"; // approved, no queue row
const REVIEW_INACTIVE   = "dddddddd-0000-4000-8000-000000000004"; // review_required, inactive queue row

// ── HTTP test server ──────────────────────────────────────────────────────────

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
        headers:  { "authorization": "Bearer fake-admin-token" },
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

// ── Fake in-memory client ─────────────────────────────────────────────────────

function makeClient(catalogRows: any[], queueRows: any[]) {
  const db: Record<string, any[]> = {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: catalogRows,
    stamp_generation_queue:  queueRows,
  };

  function chain(tableName: string) {
    const rows = () => db[tableName] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    let _headOnly = false;
    let _selectCount = false;

    const b: any = {
      select(_cols: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head === true)     _headOnly = true;
        return b;
      },
      eq(col: string, val: any)     { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[])  { filters.push((r) => vals.includes(r[col])); return b; },
      not()  { return b; },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      maybeSingle() {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },
      single() {
        const matched = rows().filter((r) => filters.every((f) => f(r)));
        if (matched.length === 1) return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({ data: null, error: { message: "No rows" } });
      },
      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          const matched = rows().filter((r) => filters.every((f) => f(r)));
          if (_headOnly) return { data: null, error: null, count: matched.length };
          return { data: matched, error: null, count: _selectCount ? matched.length : undefined };
        }).then(resolve, reject);
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

// ── Catalog rows ──────────────────────────────────────────────────────────────

function makeRows() {
  const base = {
    canonical_location_key: "x",
    stamp_type:   "location",
    country:      "Japan",
    country_code: "JP",
    active_version_id: null,
    earn_count:   0,
    created_at:   "2024-01-01T00:00:00Z",
    updated_at:   "2024-01-01T00:00:00Z",
  };
  return [
    { ...base, id: REJECTED_QUEUED,   display_name: "Tokyo",  status: "rejected" },
    { ...base, id: REJECTED_PROCESS,  display_name: "Osaka",  status: "rejected" },
    { ...base, id: APPROVED_NO_QUEUE, display_name: "Paris",  status: "approved" },
    { ...base, id: REVIEW_INACTIVE,   display_name: "Berlin", status: "review_required" },
  ];
}

let currentClient: ReturnType<typeof makeClient>;

beforeEach(() => {
  const queueRows = [
    { id: "eeeeeeee-0000-4000-8000-000000000001", catalog_id: REJECTED_QUEUED,  status: "queued",          last_error: null },
    // FIXTURE REPAIRED. This row said `status: "processing"`, which
    // stamp_generation_queue_status_check does not permit — the real in-flight
    // status the worker writes is `generating` (queued | generating |
    // review_required | retryable_failed | permanently_failed | archived). The
    // route filtered on the same impossible value, so the test proved the code
    // matched the fixture and nothing about the database: an operator saw the
    // "regenerating" badge for a job sitting in the QUEUE and never for one
    // actively generating.
    { id: "eeeeeeee-0000-4000-8000-000000000002", catalog_id: REJECTED_PROCESS, status: "generating",     last_error: null },
    { id: "eeeeeeee-0000-4000-8000-000000000003", catalog_id: REVIEW_INACTIVE,  status: "review_required", last_error: "candidate_shortfall" },
  ];
  currentClient = makeClient(makeRows(), queueRows);
  _setTestClient(currentClient as any, true);
  _setTestServiceClient(currentClient as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/stamps/catalog — active queue status enrichment", () => {
  it("rejected entry with a queued job carries queue_status 'queued'", async () => {
    const { status, body } = await get("/admin/stamps/catalog");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const entry = body.entries.find((e: any) => e.id === REJECTED_QUEUED);
    assert.ok(entry, "rejected entry must be present in the response");
    assert.equal(entry.status, "rejected");
    assert.equal(
      entry.queue_status,
      "queued",
      "a live queued job must be surfaced on the stale rejected entry",
    );
  });

  it("rejected entry with a generating job carries queue_status 'generating'", async () => {
    const { status, body } = await get("/admin/stamps/catalog");
    assert.equal(status, 200);

    const entry = body.entries.find((e: any) => e.id === REJECTED_PROCESS);
    assert.ok(entry);
    assert.equal(entry.queue_status, "generating");
  });

  it("entry with no queue row gets no queue_status key", async () => {
    const { status, body } = await get("/admin/stamps/catalog");
    assert.equal(status, 200);

    const entry = body.entries.find((e: any) => e.id === APPROVED_NO_QUEUE);
    assert.ok(entry);
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, "queue_status"),
      false,
      "entries without an active queue row must not have a queue_status key",
    );
  });

  it("entry whose queue row is inactive (review_required) gets no queue_status", async () => {
    const { status, body } = await get("/admin/stamps/catalog");
    assert.equal(status, 200);

    const entry = body.entries.find((e: any) => e.id === REVIEW_INACTIVE);
    assert.ok(entry);
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, "queue_status"),
      false,
      "non-active queue statuses must not be attached as queue_status",
    );
    // The existing last_error enrichment still applies for review_required
    assert.equal(entry.last_error, "candidate_shortfall");
  });
});
