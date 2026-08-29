/**
 * Admin reconciler run-history endpoint tests.
 *
 * GET /admin/stamps/reconcile/runs surfaces the run-summary rows the
 * reconciler writes to stamp_reconciliation_log (source_table =
 * "reconciliation_run", counts JSON in review_reason):
 *   1. Returns recent runs newest-first with parsed counts.
 *   2. Only run-summary rows are returned — admin-review rows are excluded.
 *   3. A fatal-error run is surfaced with fatalError and ok:false.
 *   4. Malformed counts JSON doesn't break the endpoint (parseError flagged).
 *   5. limit query param is honored (clamped to 1..100).
 *   6. Non-admin callers get 403; DB errors surface as db_error.
 *
 * Run: node --import tsx/esm --test src/test/reconcileRunHistory.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import stampCatalogRouter from "../routes/stampCatalog.js";
import { RUN_SUMMARY_SOURCE_TABLE } from "../lib/stamps/reconcileStampCatalog.js";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_ID  = "bbbbbbbb-0000-4000-8000-000000000002";

// ── HTTP setup ────────────────────────────────────────────────────────────────

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
        headers:  { authorization: "Bearer fake-token" },
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

// ── Fake in-memory Supabase client ────────────────────────────────────────────

interface FakeOpts {
  userId?: string;
  role?: string;
  logRows?: any[];
  logError?: { message: string } | null;
}

function makeClient(opts: FakeOpts = {}) {
  const userId  = opts.userId ?? ADMIN_ID;
  const role    = opts.role ?? "admin";
  const logRows = opts.logRows ?? [];

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _order: { col: string; ascending: boolean } | null = null;
    let _limit: number | null = null;

    const b: any = {
      select: () => b,
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      order(col: string, o?: any) { _order = { col, ascending: o?.ascending !== false }; return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() {
        if (table === "profiles") {
          return Promise.resolve({ data: { id: userId, role }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        let out: any = { data: [], error: null };
        if (table === "stamp_reconciliation_log") {
          if (opts.logError) {
            out = { data: null, error: opts.logError };
          } else {
            let rows = logRows.filter((r) => filters.every((f) => f(r)));
            if (_order) {
              const { col, ascending } = _order;
              rows = [...rows].sort((a, b2) =>
                ascending
                  ? String(a[col]).localeCompare(String(b2[col]))
                  : String(b2[col]).localeCompare(String(a[col])),
              );
            }
            if (_limit != null) rows = rows.slice(0, _limit);
            out = { data: rows.map((r) => ({ ...r })), error: null };
          }
        }
        return Promise.resolve(out).then(onF, onR);
      },
    };
    return b;
  }

  return {
    from: (table: string) => chain(table),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
    },
  };
}

function summaryRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id:            overrides.id ?? "log-1",
    source_table:  RUN_SUMMARY_SOURCE_TABLE,
    source_id:     overrides.source_id ?? "run-1",
    needs_admin_review: false,
    review_reason: overrides.review_reason ??
      JSON.stringify({ resolved: 2, flagged: 1, skipped: 0, enqueued: 3, combos: 4 }),
    processed_at:  overrides.processed_at ?? "2026-07-19T10:00:00Z",
    ...overrides,
  };
}

function useClient(opts: FakeOpts = {}) {
  const client = makeClient(opts);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return client;
}

beforeEach(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/stamps/reconcile/runs", () => {
  it("returns recent runs newest-first with parsed counts", async () => {
    useClient({
      logRows: [
        summaryRow({ id: "log-old", source_id: "run-old", processed_at: "2026-07-18T10:00:00Z" }),
        summaryRow({
          id: "log-new", source_id: "run-new", processed_at: "2026-07-19T10:00:00Z",
          review_reason: JSON.stringify({ resolved: 5, flagged: 0, skipped: 1, enqueued: 2, combos: 6 }),
        }),
      ],
    });

    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.runs.length, 2);

    const [first, second] = res.body.runs;
    assert.equal(first.runId, "run-new", "newest run first");
    assert.equal(second.runId, "run-old");
    assert.deepEqual(
      { resolved: first.resolved, flagged: first.flagged, skipped: first.skipped, enqueued: first.enqueued, combos: first.combos },
      { resolved: 5, flagged: 0, skipped: 1, enqueued: 2, combos: 6 },
    );
    assert.equal(first.ranAt, "2026-07-19T10:00:00Z");
    assert.equal(first.fatalError, null);
    assert.equal(first.ok, true);
  });

  it("excludes admin-review rows — only run-summary rows are returned", async () => {
    useClient({
      logRows: [
        summaryRow(),
        {
          id: "review-1",
          source_table: "user_stamps",
          source_id: "stamp-1",
          needs_admin_review: true,
          review_reason: "location-less stamp: missing stamp_definition_id",
          processed_at: "2026-07-19T11:00:00Z",
        },
      ],
    });

    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 200);
    assert.equal(res.body.runs.length, 1, "admin-review rows must not appear");
    assert.equal(res.body.runs[0].runId, "run-1");
  });

  it("surfaces a fatal-error run with fatalError and ok:false", async () => {
    useClient({
      logRows: [
        summaryRow({
          review_reason: JSON.stringify({
            resolved: 0, flagged: 0, skipped: 0, enqueued: 0, combos: 0,
            fatal_error: "boom: connection reset",
          }),
        }),
      ],
    });

    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 200);
    const run = res.body.runs[0];
    assert.equal(run.fatalError, "boom: connection reset");
    assert.equal(run.ok, false);
  });

  it("malformed counts JSON doesn't break the endpoint — row flagged with parseError", async () => {
    useClient({
      logRows: [
        summaryRow({ id: "log-bad", source_id: "run-bad", review_reason: "not-json{{",
                     processed_at: "2026-07-19T12:00:00Z" }),
        summaryRow({ processed_at: "2026-07-18T10:00:00Z" }),
      ],
    });

    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 200);
    assert.equal(res.body.runs.length, 2, "good row still returned alongside bad one");
    const bad = res.body.runs.find((r: any) => r.runId === "run-bad");
    assert.equal(bad.parseError, true);
    assert.equal(bad.ok, false);
    assert.equal(bad.resolved, 0, "counts default to 0 when unparseable");
    const good = res.body.runs.find((r: any) => r.runId === "run-1");
    assert.equal(good.ok, true);
  });

  it("honors the limit query param", async () => {
    useClient({
      logRows: [
        summaryRow({ id: "l1", source_id: "r1", processed_at: "2026-07-19T10:00:00Z" }),
        summaryRow({ id: "l2", source_id: "r2", processed_at: "2026-07-18T10:00:00Z" }),
        summaryRow({ id: "l3", source_id: "r3", processed_at: "2026-07-17T10:00:00Z" }),
      ],
    });

    const res = await get("/admin/stamps/reconcile/runs?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.runs.length, 2);
    assert.deepEqual(res.body.runs.map((r: any) => r.runId), ["r1", "r2"], "newest two");
  });

  it("rejects non-admin callers with 403", async () => {
    useClient({ userId: USER_ID, role: "user" });
    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 403);
  });

  it("surfaces DB read errors as db_error", async () => {
    useClient({ logError: { message: "relation does not exist" } });
    const res = await get("/admin/stamps/reconcile/runs");
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "db_error");
  });
});
