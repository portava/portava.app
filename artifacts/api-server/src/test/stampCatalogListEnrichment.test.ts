/**
 * GET /admin/stamps/catalog — last_error enrichment for review_required entries
 *
 * The handler joins stamp_generation_queue to attach last_error onto any
 * catalog entry whose status is review_required. This lets the queue list
 * show a "degraded" badge (e.g. candidate_shortfall) without opening each row.
 *
 * Invariants tested:
 *  1. review_required entries carry last_error from the queue row
 *  2. Non-review entries (approved, pending_artwork …) do NOT get last_error
 *  3. When the queue row has no last_error the field is absent on non-review entries
 *     and null on the review entry (queue row exists but last_error is null)
 *  4. review_required entry with NO matching queue row at all does NOT get a
 *     last_error key — the enrichment block only sets it when a queue row exists
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogListEnrichment.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID       = "aaaaaaaa-0000-4000-8000-000000000001";
const REVIEW_ID      = "cccccccc-0000-4000-8000-000000000001"; // review_required
const APPROVED_ID    = "cccccccc-0000-4000-8000-000000000002"; // approved
const NULL_ERROR_ID  = "cccccccc-0000-4000-8000-000000000003"; // review_required, last_error null
const NO_QUEUE_ID    = "cccccccc-0000-4000-8000-000000000004"; // review_required, no queue row

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
        headers: {
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
    r.end();
  });
}

// ── Fake in-memory client ─────────────────────────────────────────────────────
//
// Must handle the call sequence the handler makes:
//   1. profiles  .select("role").eq(id).maybeSingle()      → admin guard
//   2. universal_stamp_catalog .select(fields, {count:"exact"}).order().range()
//   3. stamp_generation_queue  .select(…).in(ids).eq("status","review_required")
//   4. universal_stamp_catalog .select("status").then()    → status counts
//   5. stamp_generation_queue  .select("id",{count,head}).eq("status","review_required")
//   6. stamp_generation_queue  .select("id",{count,head}).in("status",[…])

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

// ── Shared catalog rows ───────────────────────────────────────────────────────

function makeRows() {
  return [
    {
      id:                    REVIEW_ID,
      canonical_location_key: "city:tokyo:japan",
      stamp_type:            "location",
      display_name:          "Tokyo",
      country:               "Japan",
      country_code:          "JP",
      status:                "review_required",
      active_version_id:     null,
      earn_count:            0,
      created_at:            "2024-01-01T00:00:00Z",
      updated_at:            "2024-01-01T00:00:00Z",
    },
    {
      id:                    APPROVED_ID,
      canonical_location_key: "city:paris:france",
      stamp_type:            "location",
      display_name:          "Paris",
      country:               "France",
      country_code:          "FR",
      status:                "approved",
      active_version_id:     "vvvvvvvv-0000-4000-8000-000000000001",
      earn_count:            5,
      created_at:            "2024-01-02T00:00:00Z",
      updated_at:            "2024-01-02T00:00:00Z",
    },
    {
      id:                    NULL_ERROR_ID,
      canonical_location_key: "city:berlin:germany",
      stamp_type:            "location",
      display_name:          "Berlin",
      country:               "Germany",
      country_code:          "DE",
      status:                "review_required",
      active_version_id:     null,
      earn_count:            0,
      created_at:            "2024-01-03T00:00:00Z",
      updated_at:            "2024-01-03T00:00:00Z",
    },
    {
      id:                    NO_QUEUE_ID,
      canonical_location_key: "city:rome:italy",
      stamp_type:            "location",
      display_name:          "Rome",
      country:               "Italy",
      country_code:          "IT",
      status:                "review_required",
      active_version_id:     null,
      earn_count:            0,
      created_at:            "2024-01-04T00:00:00Z",
      updated_at:            "2024-01-04T00:00:00Z",
    },
  ];
}

// ── beforeEach: install fresh fake client ─────────────────────────────────────

let currentClient: ReturnType<typeof makeClient>;

beforeEach(() => {
  const catalogRows = makeRows();
  const queueRows = [
    {
      id:         "eeeeeeee-0000-4000-8000-000000000001",
      catalog_id: REVIEW_ID,
      status:     "review_required",
      last_error: "candidate_shortfall: only 1 of 3 required",
    },
    // Berlin queue row exists but last_error is null
    {
      id:         "eeeeeeee-0000-4000-8000-000000000002",
      catalog_id: NULL_ERROR_ID,
      status:     "review_required",
      last_error: null,
    },
  ];
  currentClient = makeClient(catalogRows, queueRows);
  _setTestClient(currentClient as any, true);
  _setTestServiceClient(currentClient as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/stamps/catalog — last_error enrichment", () => {
  it("review_required entry carries last_error from the queue row", async () => {
    const { status, body } = await get("/admin/stamps/catalog");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const reviewEntry = body.entries.find((e: any) => e.id === REVIEW_ID);
    assert.ok(reviewEntry, "review_required entry must be present in the response");
    assert.equal(
      reviewEntry.last_error,
      "candidate_shortfall: only 1 of 3 required",
      "last_error must be attached from the queue row",
    );
  });

  it("non-review entries (approved) do not receive last_error", async () => {
    const { status, body } = await get("/admin/stamps/catalog");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const approvedEntry = body.entries.find((e: any) => e.id === APPROVED_ID);
    assert.ok(approvedEntry, "approved entry must be present in the response");
    assert.equal(
      Object.prototype.hasOwnProperty.call(approvedEntry, "last_error"),
      false,
      "approved entries must not have a last_error property",
    );
  });

  it("review_required entry with null queue last_error gets last_error: null (not missing)", async () => {
    const { status, body } = await get("/admin/stamps/catalog");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const nullErrorEntry = body.entries.find((e: any) => e.id === NULL_ERROR_ID);
    assert.ok(nullErrorEntry, "second review_required entry must be present");
    assert.equal(
      Object.prototype.hasOwnProperty.call(nullErrorEntry, "last_error"),
      true,
      "review_required entry matched in queue must always have the last_error key set",
    );
    assert.equal(nullErrorEntry.last_error, null);
  });

  it("review_required entry with no matching queue row does NOT get a last_error key", async () => {
    const { status, body } = await get("/admin/stamps/catalog");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);

    const noQueueEntry = body.entries.find((e: any) => e.id === NO_QUEUE_ID);
    assert.ok(noQueueEntry, "review_required entry without a queue row must be present in the response");
    assert.equal(
      Object.prototype.hasOwnProperty.call(noQueueEntry, "last_error"),
      false,
      "review_required entry with no matching queue row must not have a last_error key — the degraded badge must not appear",
    );
  });
});
