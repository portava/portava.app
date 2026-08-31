/**
 * POST /admin/stamps/catalog/:id/merge-into/:targetId — earner re-point safety
 * and earn_count accounting (audit STAMP·H5).
 *
 * The merge re-points every earner (user_stamps + passport_stamps) from the
 * duplicate source entry onto the survivor, then archives the source. Two bugs
 * this suite pins:
 *
 *  1. Re-point writes were UNCHECKED and the source was archived unconditionally.
 *     On a re-point failure the earners it left behind still point at the now-
 *     archived source, whose artwork the passport read path filters out
 *     (buildCatalogArtworkMap requires status='approved') — so their stamp
 *     artwork silently disappears. The fix checks the writes and skips the
 *     archive on failure. → "does NOT archive the source when a re-point fails".
 *
 *  2. earn_count was dropped: the source's earns were never carried onto the
 *     survivor. The fix transfers them. → "transfers earn_count to the survivor".
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogMergeIntoRepoint.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const ADMIN_ID  = "aaaaaaaa-0000-0000-0009-000000000001";
const SOURCE_ID = "00000000-0000-0000-0009-000000000001";
const TARGET_ID = "00000000-0000-0000-0009-000000000002";

// ── Test server ───────────────────────────────────────────────────────────────
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

// ── Fake client ───────────────────────────────────────────────────────────────
// In-memory DB with a chainable query builder. `failRepoint` forces the UPDATE
// on the named ownership table to return an error (models a transient DB fault
// mid-merge); the update is NOT applied when it "fails".

type DB = Record<string, any[]>;

function makeClient(
  db: DB,
  opts: { failRepoint?: "user_stamps" | "passport_stamps"; repointErrorMsg?: string } = {},
) {
  function chain(tableName: string) {
    let filtered: any[] = db[tableName] ?? [];
    let pendingUpdate: Record<string, any> | null = null;

    const b: any = {
      select: () => b,
      insert: (data: any) => {
        const newRows = Array.isArray(data) ? data : [data];
        db[tableName] = [...(db[tableName] ?? []), ...newRows];
        filtered = newRows;
        return b;
      },
      update: (data: Record<string, any>) => { pendingUpdate = data; return b; },
      eq: (col: string, val: any) => { filtered = filtered.filter((r: any) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r: any) => r[col] !== val); return b; },
      in: (col: string, vals: any[]) => { filtered = filtered.filter((r: any) => vals.includes(r[col])); return b; },
      order: () => b,
      limit: () => b,
      range: () => b,
      maybeSingle: () => {
        if (pendingUpdate !== null) { for (const r of filtered) Object.assign(r, pendingUpdate); pendingUpdate = null; }
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single: () => {
        if (pendingUpdate !== null) { for (const r of filtered) Object.assign(r, pendingUpdate); pendingUpdate = null; }
        return Promise.resolve(filtered[0] ? { data: filtered[0], error: null } : { data: null, error: { message: "No rows" } });
      },
      then: (resolve: any, reject: any) => {
        if (pendingUpdate !== null) {
          if (opts.failRepoint === tableName) {
            // Simulate a DB fault: the update does NOT land.
            pendingUpdate = null;
            return Promise.resolve({ data: null, error: { message: opts.repointErrorMsg ?? "repoint failed" } })
              .then(resolve, reject);
          }
          for (const r of filtered) Object.assign(r, pendingUpdate);
          pendingUpdate = null;
        }
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (tableName: string) => chain(tableName),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }) },
    _db: db,
  };
}

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      { id: SOURCE_ID, canonical_location_key: "paris-fr",     stamp_type: "city", status: "approved", earn_count: 7 },
      { id: TARGET_ID, canonical_location_key: "paris-france", stamp_type: "city", status: "approved", earn_count: 5 },
    ],
    user_stamps: [
      { id: "us-1", catalog_id: SOURCE_ID },
      { id: "us-2", catalog_id: SOURCE_ID },
    ],
    passport_stamps: [
      { id: "ps-1", catalog_id: SOURCE_ID },
    ],
    stamp_admin_audit_log: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("merge-into — successful merge", () => {
  it("re-points every earner, transfers earn_count to the survivor, and archives the source", async () => {
    const db = makeDb();
    const client = makeClient(db);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status, body } = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(body.mergedIntoId, TARGET_ID);

    // Earners moved onto the survivor
    assert.ok(db.user_stamps.every((r) => r.catalog_id === TARGET_ID), "all user_stamps must point at target");
    assert.ok(db.passport_stamps.every((r) => r.catalog_id === TARGET_ID), "all passport_stamps must point at target");

    // earn_count carried over (5 + 7), not dropped
    const target = db.universal_stamp_catalog.find((r) => r.id === TARGET_ID);
    assert.equal(target!.earn_count, 12, "survivor earn_count must be target(5) + source(7)");

    // Source archived only after the above succeeded
    const source = db.universal_stamp_catalog.find((r) => r.id === SOURCE_ID);
    assert.equal(source!.status, "archived");
  });
});

describe("merge-into — re-point failure must not orphan earners", () => {
  it("does NOT archive the source when the user_stamps re-point fails", async () => {
    const db = makeDb();
    const client = makeClient(db, { failRepoint: "user_stamps", repointErrorMsg: "deadlock detected" });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status, body } = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);

    // Surfaces the failure instead of a misleading ok
    assert.equal(status, 500, `expected 500 db_error, got ${status}: ${JSON.stringify(body)}`);

    // The source stays active — its artwork keeps rendering for any earner still
    // pointing at it. Archiving here is exactly the STAMP·H5 data-loss bug.
    const source = db.universal_stamp_catalog.find((r) => r.id === SOURCE_ID);
    assert.equal(source!.status, "approved", "source must NOT be archived when a re-point failed");

    // earn_count untouched (we aborted before the transfer)
    const target = db.universal_stamp_catalog.find((r) => r.id === TARGET_ID);
    assert.equal(target!.earn_count, 5, "earn_count must not transfer on an aborted merge");
  });

  it("tolerates a missing passport_stamps relation and still completes the merge", async () => {
    const db = makeDb();
    const client = makeClient(db, {
      failRepoint: "passport_stamps",
      repointErrorMsg: 'relation "passport_stamps" does not exist',
    });
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);

    const { status, body } = await post(`/admin/stamps/catalog/${SOURCE_ID}/merge-into/${TARGET_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    // user_stamps still re-pointed, source archived, earn_count carried over
    assert.ok(db.user_stamps.every((r) => r.catalog_id === TARGET_ID));
    const source = db.universal_stamp_catalog.find((r) => r.id === SOURCE_ID);
    assert.equal(source!.status, "archived");
    const target = db.universal_stamp_catalog.find((r) => r.id === TARGET_ID);
    assert.equal(target!.earn_count, 12);
  });
});
