/**
 * Candidate artwork versions disappear after regenerate archives them
 *
 * POST /admin/stamps/catalog/:id/regenerate archives any candidate
 * stamp_artwork_versions rows before re-queuing.
 * GET /admin/stamps/catalog/:id returns the versions array without a
 * status filter — so the now-archived rows are still returned, but
 * their status must be "archived", meaning the UI can safely hide them.
 *
 * Tests:
 *   1. Baseline: detail returns candidate version before any admin action.
 *   2. After POST regenerate: candidate version has status "archived".
 *   3. A version whose status is not "candidate" is left untouched by regenerate.
 *   4. Multiple candidate versions are all archived in one regenerate call.
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogVersionArchive.test.ts
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
const CATALOG_ID     = "cccccccc-0000-4000-8000-000000000030";
const MULTI_ID       = "cccccccc-0000-4000-8000-000000000031";

const CANDIDATE_VER  = "dddddddd-0000-4000-8000-000000000030";
const ACTIVE_VER     = "dddddddd-0000-4000-8000-000000000031";
const CANDIDATE_VER2 = "dddddddd-0000-4000-8000-000000000032";
const CANDIDATE_VER3 = "dddddddd-0000-4000-8000-000000000033";

const QUEUE_JOB      = "eeeeeeee-0000-4000-8000-000000000030";
const MULTI_JOB      = "eeeeeeee-0000-4000-8000-000000000031";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

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
//
// Mirrors the fake client in stampCatalogDetailBadge.test.ts, extended with
// support for .in(col, vals) on the update path so that regenerate's
//   .in("status", ["retryable_failed", "permanently_failed"])
// works correctly and doesn't accidentally clobber unrelated rows.

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
        active_version_id:      ACTIVE_VER,
        earn_count:             0,
        created_at:             "2024-01-01T00:00:00Z",
        updated_at:             "2024-01-01T00:00:00Z",
      },
      {
        id:                     MULTI_ID,
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
        id:            QUEUE_JOB,
        catalog_id:    CATALOG_ID,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 1 of 3 required",
        attempts:      3,
        requeue_count: 0,
      },
      {
        id:            MULTI_JOB,
        catalog_id:    MULTI_ID,
        status:        "review_required",
        last_error:    "candidate_shortfall: only 0 of 3 required",
        attempts:      2,
        requeue_count: 0,
      },
    ],
    stamp_artwork_versions: [
      // CATALOG_ID: one active version (should NOT be archived by regenerate)
      {
        id:         ACTIVE_VER,
        catalog_id: CATALOG_ID,
        status:     "active",
        public_url: "https://cdn.example.com/active.png",
        created_at: "2024-01-01T00:00:00Z",
      },
      // CATALOG_ID: one candidate version (should be archived by regenerate)
      {
        id:         CANDIDATE_VER,
        catalog_id: CATALOG_ID,
        status:     "candidate",
        public_url: "https://cdn.example.com/candidate.png",
        created_at: "2024-01-02T00:00:00Z",
      },
      // MULTI_ID: two candidate versions (both should be archived)
      {
        id:         CANDIDATE_VER2,
        catalog_id: MULTI_ID,
        status:     "candidate",
        public_url: "https://cdn.example.com/candidate2.png",
        created_at: "2024-01-01T00:00:00Z",
      },
      {
        id:         CANDIDATE_VER3,
        catalog_id: MULTI_ID,
        status:     "candidate",
        public_url: "https://cdn.example.com/candidate3.png",
        created_at: "2024-01-02T00:00:00Z",
      },
    ],
    stamp_admin_audit_log: [],
    user_stamps:           [],
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

describe("Candidate artwork versions are archived after regenerate", () => {

  it("baseline: detail returns candidate version with status 'candidate' before regenerate", async () => {
    const { status, body } = await get(`/admin/stamps/catalog/${CATALOG_ID}`);

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.versions), "versions must be an array");

    const candidate = body.versions.find((v: any) => v.id === CANDIDATE_VER);
    assert.ok(
      candidate,
      `candidate version ${CANDIDATE_VER} must appear in detail before regenerate`,
    );
    assert.equal(
      candidate.status,
      "candidate",
      "candidate version must have status 'candidate' before regenerate",
    );
  });

  it("after POST regenerate: candidate version has status 'archived' in detail response", async () => {
    // ── Pre-condition ──────────────────────────────────────────────────────────
    const before = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(before.status, 200);
    const candidateBefore = before.body.versions.find((v: any) => v.id === CANDIDATE_VER);
    assert.ok(candidateBefore, "candidate version must be present before regenerate");
    assert.equal(candidateBefore.status, "candidate");

    // ── Action ────────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── Verify the DB row was mutated directly ─────────────────────────────────
    const dbRow = db.stamp_artwork_versions.find((v) => v.id === CANDIDATE_VER);
    assert.ok(dbRow, "candidate version row must still exist in DB after regenerate");
    assert.equal(
      dbRow.status,
      "archived",
      "regenerate must set candidate version status to 'archived' in the DB",
    );

    // ── GET detail must reflect the archived status ────────────────────────────
    const after = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(after.status, 200, `detail GET must return 200 after regenerate`);
    assert.ok(Array.isArray(after.body.versions), "versions must still be an array");

    const candidateAfter = after.body.versions.find((v: any) => v.id === CANDIDATE_VER);
    assert.ok(
      candidateAfter,
      "candidate version must still appear in detail response after regenerate (not deleted)",
    );
    assert.equal(
      candidateAfter.status,
      "archived",
      "candidate version status must be 'archived' in the detail response after regenerate",
    );
  });

  it("active version is NOT archived — regenerate only targets candidate rows", async () => {
    // The active version (ACTIVE_VER) must survive the regenerate unchanged.
    const regen = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );

    const after = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(after.status, 200);

    const activeAfter = after.body.versions.find((v: any) => v.id === ACTIVE_VER);
    assert.ok(activeAfter, "active version must still appear in detail after regenerate");
    assert.equal(
      activeAfter.status,
      "active",
      "active version status must remain 'active' — regenerate must not archive it",
    );
  });

  it("regenerate does not archive candidate versions belonging to a different catalog entry", async () => {
    // CATALOG_ID has CANDIDATE_VER; MULTI_ID has CANDIDATE_VER2 and CANDIDATE_VER3.
    // Regenerating only CATALOG_ID must leave MULTI_ID's candidates untouched.

    // ── Pre-condition: both catalog entries have candidate versions ─────────────
    const beforeMulti = await get(`/admin/stamps/catalog/${MULTI_ID}`);
    assert.equal(beforeMulti.status, 200);
    const candidatesBeforeMulti = beforeMulti.body.versions.filter(
      (v: any) => v.status === "candidate",
    );
    assert.equal(
      candidatesBeforeMulti.length,
      2,
      `expected 2 candidate versions on MULTI_ID before regenerate, got ${candidatesBeforeMulti.length}`,
    );

    // ── Action: regenerate only CATALOG_ID ───────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${CATALOG_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );
    assert.deepEqual(regen.body, { ok: true });

    // ── CATALOG_ID's candidate must be archived ───────────────────────────────
    const afterCatalog = await get(`/admin/stamps/catalog/${CATALOG_ID}`);
    assert.equal(afterCatalog.status, 200);
    const catalogCandidate = afterCatalog.body.versions.find(
      (v: any) => v.id === CANDIDATE_VER,
    );
    assert.ok(catalogCandidate, "CATALOG_ID candidate version must still appear in detail");
    assert.equal(
      catalogCandidate.status,
      "archived",
      "CATALOG_ID candidate version must be archived after its regenerate",
    );

    // ── MULTI_ID's candidates must remain "candidate" ─────────────────────────
    const afterMulti = await get(`/admin/stamps/catalog/${MULTI_ID}`);
    assert.equal(
      afterMulti.status, 200,
      `GET detail for MULTI_ID must return 200, got ${afterMulti.status}`,
    );

    for (const id of [CANDIDATE_VER2, CANDIDATE_VER3]) {
      const ver = afterMulti.body.versions.find((v: any) => v.id === id);
      assert.ok(
        ver,
        `MULTI_ID version ${id} must still appear in detail after CATALOG_ID regenerate`,
      );
      assert.equal(
        ver.status,
        "candidate",
        `MULTI_ID version ${id} must remain 'candidate' — regenerating a different catalog entry must not archive it`,
      );
    }
  });

  it("multiple candidate versions for the same catalog entry are all archived in one regenerate", async () => {
    // MULTI_ID has two candidate versions: CANDIDATE_VER2 and CANDIDATE_VER3.
    const before = await get(`/admin/stamps/catalog/${MULTI_ID}`);
    assert.equal(before.status, 200);

    const candidatesBefore = before.body.versions.filter(
      (v: any) => v.status === "candidate",
    );
    assert.equal(
      candidatesBefore.length,
      2,
      `expected 2 candidate versions before regenerate, got ${candidatesBefore.length}`,
    );

    // ── Action ────────────────────────────────────────────────────────────────
    const regen = await post(`/admin/stamps/catalog/${MULTI_ID}/regenerate`);
    assert.equal(
      regen.status, 200,
      `regenerate must return 200, got ${regen.status}: ${JSON.stringify(regen.body)}`,
    );

    // ── All candidates must be archived ───────────────────────────────────────
    const after = await get(`/admin/stamps/catalog/${MULTI_ID}`);
    assert.equal(after.status, 200);

    const stillCandidate = after.body.versions.filter(
      (v: any) => v.status === "candidate",
    );
    assert.equal(
      stillCandidate.length,
      0,
      `no versions must remain in 'candidate' status after regenerate — found: ${JSON.stringify(stillCandidate)}`,
    );

    const nowArchived = after.body.versions.filter(
      (v: any) => v.status === "archived",
    );
    assert.equal(
      nowArchived.length,
      2,
      `both candidate versions must be 'archived' after regenerate — found: ${JSON.stringify(nowArchived)}`,
    );

    // Each of the original candidate IDs must be present as archived
    for (const id of [CANDIDATE_VER2, CANDIDATE_VER3]) {
      const ver = after.body.versions.find((v: any) => v.id === id);
      assert.ok(ver, `version ${id} must appear in detail after regenerate`);
      assert.equal(
        ver.status,
        "archived",
        `version ${id} must have status 'archived' after regenerate`,
      );
    }
  });
});
