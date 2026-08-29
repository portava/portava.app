/**
 * Confirm the artwork-version archive step during regenerate is observable
 * when it fails — not silently dropped.
 *
 * The POST /admin/stamps/catalog/:id/regenerate handler archives candidate
 * artwork versions before queueing a new job. That failure is non-fatal (the
 * regenerate proceeds), but it must be logged via console.error so operators
 * can see that stale candidate versions may still be visible to the worker.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogRegenArchiveObservability.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";

// ── Fixed IDs ─────────────────────────────────────────────────────────────────

const ADMIN_ID   = "aaaaaaaa-0000-4000-8000-000000000001";
const CATALOG_ID = "cccccccc-0000-4000-8000-000000000099";

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
    const url     = new URL(path, base);
    const payload = JSON.stringify({});
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

// ── Fake client where the stamp_artwork_versions archive update errors ───────

type DB = Record<string, any[]>;

function makeClient(db: DB, opts: { versionArchiveFails: boolean }) {
  function chain(tableName: string) {
    let updateValues: Record<string, any> | null = null;
    let insertRow: Record<string, any> | null    = null;
    const filters: Array<(r: any) => boolean>    = [];

    const b: any = {
      select() { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => (vals as any[]).includes(r[col])); return b; },
      not()    { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      update(vals: Record<string, any>) { updateValues = vals; return b; },
      insert(row: Record<string, any>)  { insertRow   = row;   return b; },

      maybeSingle() {
        const rows    = db[tableName] ?? [];
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (updateValues !== null) {
          matched.forEach((r) => Object.assign(r, updateValues));
        }
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

            if (updateValues !== null) {
              // Inject an error only for the candidate-version archive update.
              if (tableName === "stamp_artwork_versions" && opts.versionArchiveFails) {
                return {
                  data:  null,
                  error: { message: "version archive boom", code: "PGRST000" },
                };
              }
              const matched = rows.filter((r) => filters.every((f) => f(r)));
              matched.forEach((r) => Object.assign(r, updateValues));
              return { data: matched.map((r) => ({ ...r })), error: null };
            }

            if (insertRow !== null) {
              rows.push(insertRow);
              db[tableName] = rows;
              return { data: { ...insertRow }, error: null };
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
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
  };
}

function makeDb(): DB {
  return {
    profiles: [{ id: ADMIN_ID, role: "admin" }],
    universal_stamp_catalog: [
      {
        id:                     CATALOG_ID,
        canonical_location_key: "city:paris:france",
        stamp_type:             "location",
        display_name:           "Paris",
        country:                "France",
        country_code:           "FR",
        status:                 "active",
        active_version_id:      null,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
    ],
    stamp_generation_queue: [],
    stamp_artwork_versions: [
      { id: "dddddddd-0000-4000-8000-000000000001", catalog_id: CATALOG_ID, status: "candidate" },
    ],
    stamp_admin_audit_log: [],
  };
}

// ── console.error capture ─────────────────────────────────────────────────────

let db: DB;
let errorCalls: any[][];
const originalConsoleError = console.error;

beforeEach(() => {
  errorCalls = [];
  console.error = (...args: any[]) => { errorCalls.push(args); };
});

afterEach(() => {
  console.error = originalConsoleError;
});

function setClient(versionArchiveFails: boolean) {
  db = makeDb();
  const client = makeClient(db, { versionArchiveFails });
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("regenerate — artwork-version archive failure is observable", () => {

  it("logs a console.error when the candidate-version archive update errors", async () => {
    setClient(true);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, { ok: true });

    const archiveLogs = errorCalls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("failed to archive candidate artwork versions"),
    );
    assert.equal(
      archiveLogs.length,
      1,
      `expected exactly 1 archive-failure console.error, found ${archiveLogs.length}: ${JSON.stringify(errorCalls)}`,
    );

    // The structured payload must identify the catalog and carry the error message
    const payload = JSON.parse(archiveLogs[0][1]);
    assert.equal(payload.catalog_id, CATALOG_ID);
    assert.match(payload.error, /version archive boom/);
  });

  it("archive failure is non-fatal — the regenerate still queues a job", async () => {
    setClient(true);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200);

    const queued = db.stamp_generation_queue.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "queued",
    );
    assert.equal(queued.length, 1, "regenerate must still enqueue a job despite archive failure");
  });

  it("does not log the archive error when the archive update succeeds", async () => {
    setClient(false);

    const res = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(res.status, 200);

    const archiveLogs = errorCalls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("failed to archive candidate artwork versions"),
    );
    assert.equal(archiveLogs.length, 0, `unexpected archive-failure logs: ${JSON.stringify(archiveLogs)}`);

    // And the candidate row actually got archived
    const candidates = db.stamp_artwork_versions.filter(
      (r) => r.catalog_id === CATALOG_ID && r.status === "candidate",
    );
    assert.equal(candidates.length, 0, "candidate versions must be archived on success");
  });

});
