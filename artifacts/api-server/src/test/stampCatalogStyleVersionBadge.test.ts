/**
 * Admin review screen surfaces stale-style-version badge.
 *
 * GET /admin/stamps/catalog/:id returns all artwork version rows via
 * select("*") which includes prompt_template_version.  The mobile admin
 * screen compares that field against CURRENT_STYLE_VERSION to decide whether
 * to show a "Stale style" badge on a candidate card.
 *
 * Tests:
 *   1. Version rows with a stale prompt_template_version are returned with
 *      that field intact so the UI can detect and badge them.
 *   2. Version rows whose prompt_template_version matches STYLE_VERSION are
 *      returned without triggering the stale condition.
 *   3. Version rows with a null prompt_template_version (pre-versioning rows)
 *      are also treated as stale by isArtworkStale().
 *   4. Both stale and current candidates co-exist in a single response — the
 *      caller can distinguish them row-by-row.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogStyleVersionBadge.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { insertWouldViolateQueuedUnique, DUPLICATE_QUEUED_ERROR } from "./stampQueueConstraint.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { STYLE_VERSION, isArtworkStale } from "../lib/stamps/artDirection.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID  = "aaaaaaaa-0000-4000-8000-000000000001";
const CAT_ID    = "bbbbbbbb-0000-4000-8000-000000000001";
const VER_STALE = "cccccccc-0000-4000-8000-000000000001"; // prompt_template_version = "v0.9"
const VER_NULL  = "cccccccc-0000-4000-8000-000000000002"; // prompt_template_version = null
const VER_CURR  = "cccccccc-0000-4000-8000-000000000003"; // prompt_template_version = STYLE_VERSION

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

// ── Fake client ───────────────────────────────────────────────────────────────

type DB = Record<string, any[]>;

function makeClient(db: DB) {
  function chain(tableName: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _headOnly    = false;
    let _selectCount = false;
    let _insertError: { code: string; message: string } | null = null;

    const b: any = {
      select(_cols?: any, opts?: any) {
        if (opts?.count === "exact") _selectCount = true;
        if (opts?.head  === true)    _headOnly    = true;
        return b;
      },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      not(col: string, op: string, val: any) {
        if (op === "in") {
          const excluded = String(val)
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((s) => s.trim().replace(/^"|"$/g, ""));
          filters.push((r) => !excluded.includes(r[col]));
        }
        return b;
      },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      update() { return b; },
      insert(row: any) {
        if (
          tableName === "stamp_generation_queue" &&
          insertWouldViolateQueuedUnique(db[tableName] ?? [], row)
        ) {
          _insertError = { ...DUPLICATE_QUEUED_ERROR };
          return b;
        }
        (db[tableName] ??= []).push(row);
        return b;
      },

      maybeSingle() {
        if (_insertError) return Promise.resolve({ data: null, error: _insertError });
        const matched = (db[tableName] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] ?? null, error: null });
      },

      single() {
        if (_insertError) return Promise.resolve({ data: null, error: _insertError });
        const matched = (db[tableName] ?? []).filter((r) => filters.every((f) => f(r)));
        if (matched.length === 1) return Promise.resolve({ data: matched[0], error: null });
        return Promise.resolve({ data: null, error: { message: "No rows" } });
      },

      then(resolve: any, reject: any) {
        return Promise.resolve()
          .then(() => {
            if (_insertError) return { data: null, error: _insertError };
            const rows    = db[tableName] ?? [];
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
        id:                     CAT_ID,
        canonical_location_key: "city:paris:france",
        stamp_type:             "city",
        display_name:           "Paris",
        country:                "France",
        country_code:           "FR",
        status:                 "pending_artwork",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_artwork_versions: [
      {
        id:                      VER_STALE,
        catalog_id:              CAT_ID,
        status:                  "candidate",
        public_url:              "https://example.com/stale.png",
        generation_source:       "ai_generated",
        provider:                "openai",
        prompt_used:             "old prompt",
        prompt_template_version: "v0.9",  // older than current STYLE_VERSION
        rejection_reason:        null,
        created_at:              "2024-01-01T00:00:00Z",
      },
      {
        id:                      VER_NULL,
        catalog_id:              CAT_ID,
        status:                  "candidate",
        public_url:              "https://example.com/legacy.png",
        generation_source:       "ai_generated",
        provider:                "openai",
        prompt_used:             "legacy prompt",
        prompt_template_version: null,    // pre-versioning row
        rejection_reason:        null,
        created_at:              "2024-01-02T00:00:00Z",
      },
      {
        id:                      VER_CURR,
        catalog_id:              CAT_ID,
        status:                  "candidate",
        public_url:              "https://example.com/current.png",
        generation_source:       "ai_generated",
        provider:                "openai",
        prompt_used:             "current prompt",
        prompt_template_version: STYLE_VERSION,  // matches current version
        rejection_reason:        null,
        created_at:              "2024-01-03T00:00:00Z",
      },
    ],
    stamp_generation_queue:  [],
    stamp_admin_audit_log:   [],
    user_stamps:             [],
  };
}

let db: DB;

beforeEach(() => {
  db = makeDb();
  const client = makeClient(db);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Admin review screen surfaces stale-style-version badge", () => {

  it("detail response includes prompt_template_version on every version row", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CAT_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.versions), "versions must be an array");
    assert.equal(body.versions.length, 3, "all three seeded version rows must be returned");

    for (const v of body.versions) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(v, "prompt_template_version"),
        `version ${v.id} must expose prompt_template_version — got: ${JSON.stringify(v)}`,
      );
    }
  });

  it("stale version (older prompt_template_version) is detected by isArtworkStale()", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CAT_ID}`);
    assert.equal(status, 200);

    const staleRow = body.versions.find((v: any) => v.id === VER_STALE);
    assert.ok(staleRow, "stale version row must be present in the response");
    assert.equal(staleRow.prompt_template_version, "v0.9", "stale version must carry the old version string");

    assert.equal(
      isArtworkStale(staleRow),
      true,
      `isArtworkStale must return true for prompt_template_version='v0.9' (current is '${STYLE_VERSION}')`,
    );
  });

  it("null prompt_template_version (pre-versioning row) is also treated as stale", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CAT_ID}`);
    assert.equal(status, 200);

    const nullRow = body.versions.find((v: any) => v.id === VER_NULL);
    assert.ok(nullRow, "null-version row must be present in the response");
    assert.equal(nullRow.prompt_template_version, null, "null version must remain null in the response");

    assert.equal(
      isArtworkStale(nullRow),
      true,
      "isArtworkStale must return true when prompt_template_version is null",
    );
  });

  it("current version (matching STYLE_VERSION) is not stale", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CAT_ID}`);
    assert.equal(status, 200);

    const currentRow = body.versions.find((v: any) => v.id === VER_CURR);
    assert.ok(currentRow, "current version row must be present in the response");
    assert.equal(
      currentRow.prompt_template_version,
      STYLE_VERSION,
      `current version must carry STYLE_VERSION ('${STYLE_VERSION}')`,
    );

    assert.equal(
      isArtworkStale(currentRow),
      false,
      `isArtworkStale must return false when prompt_template_version matches current ('${STYLE_VERSION}')`,
    );
  });

  it("stale and current candidates co-exist — caller can distinguish them row-by-row", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CAT_ID}`);
    assert.equal(status, 200);

    const staleCount   = body.versions.filter((v: any) => isArtworkStale(v)).length;
    const currentCount = body.versions.filter((v: any) => !isArtworkStale(v)).length;

    // VER_STALE ("v0.9") and VER_NULL (null) are stale; VER_CURR is current
    assert.equal(
      staleCount, 2,
      `expected 2 stale rows (v0.9 + null), got ${staleCount}: ${JSON.stringify(body.versions)}`,
    );
    assert.equal(
      currentCount, 1,
      `expected 1 current row (${STYLE_VERSION}), got ${currentCount}: ${JSON.stringify(body.versions)}`,
    );
  });
});
