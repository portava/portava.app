/**
 * Reconciler run-summary auditability tests.
 *
 * Every execution of runReconciliation() must leave exactly ONE run-summary
 * row in stamp_reconciliation_log (source_table = "reconciliation_run",
 * needs_admin_review = false, counts JSON in review_reason):
 *   1. Zero-work run (no stamps at all) still writes exactly one summary row.
 *   2. A run that does real work writes exactly one summary row with counts.
 *   3. A fatal error (user_stamps read fails) still best-effort writes the
 *      summary row (with fatal_error) before the error propagates.
 *   4. Admin-review rows are untouched: summary rows never have
 *      needs_admin_review = true.
 *
 * Run: node --import tsx/esm --test src/test/reconcileRunSummary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runReconciliation,
  RUN_SUMMARY_SOURCE_TABLE,
} from "../scripts/reconcileStampCatalog.js";

interface FakeOpts {
  userStamps?: any[];
  userStampsError?: { message: string } | null;
  passportStamps?: any[];
  existingCatalogId?: string | null;
}

function makeFakeClient(opts: FakeOpts = {}) {
  const logInserts: any[] = [];
  const queueInserts: any[] = [];

  function builder(table: string): any {
    let _insert: any = null;
    let _isFilters = 0;

    const b: any = {
      select: () => b,
      insert: (row: any) => {
        _insert = row;
        if (table === "stamp_reconciliation_log") logInserts.push(row);
        if (table === "stamp_generation_queue") queueInserts.push(row);
        return b;
      },
      update: () => b,
      upsert: () => b,
      delete: () => b,
      eq: () => b,
      neq: () => b,
      in: () => b,
      is: () => { _isFilters++; return b; },
      or: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (table === "universal_stamp_catalog") {
          return Promise.resolve({
            data: opts.existingCatalogId ? { id: opts.existingCatalogId } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (_insert && table === "universal_stamp_catalog") {
          return Promise.resolve({ data: { id: "new-cat-1" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: any, onR: any) => {
        let out: any = { data: [], error: null };
        if (_insert) {
          out = { data: null, error: null };
        } else if (table === "user_stamps") {
          if (opts.userStampsError) {
            out = { data: null, error: opts.userStampsError };
          } else if (_isFilters >= 3) {
            // location-less read (catalog_id/country/city all .is(null))
            out = { data: [], error: null };
          } else {
            out = { data: opts.userStamps ?? [], error: null };
          }
        } else if (table === "passport_stamps") {
          out = { data: opts.passportStamps ?? [], error: null };
        }
        return Promise.resolve(out).then(onF, onR);
      },
    };
    return b;
  }

  return {
    from: (table: string) => builder(table),
    __logInserts: logInserts,
    __queueInserts: queueInserts,
  };
}

function summaryRows(client: any) {
  return client.__logInserts.filter(
    (r: any) => r.source_table === RUN_SUMMARY_SOURCE_TABLE,
  );
}

describe("reconciler run-summary row", () => {
  it("zero-work run writes exactly one summary row with zero counts", async () => {
    const client = makeFakeClient();
    const stats = await runReconciliation(client as any);

    const rows = summaryRows(client);
    assert.equal(rows.length, 1, "exactly one summary row must be written");
    const row = rows[0];
    assert.equal(row.needs_admin_review, false, "summary row must NOT need admin review");
    assert.ok(row.source_id, "summary row carries a generated run id");
    const counts = JSON.parse(row.review_reason);
    assert.deepEqual(
      { resolved: counts.resolved, flagged: counts.flagged, skipped: counts.skipped, enqueued: counts.enqueued, combos: counts.combos },
      { resolved: 0, flagged: 0, skipped: 0, enqueued: 0, combos: 0 },
    );
    assert.equal(counts.fatal_error, undefined);
    assert.deepEqual(stats, { resolved: 0, flagged: 0, skipped: 0, enqueued: 0, combos: 0 });
  });

  it("a real-work run writes exactly one summary row carrying its counts", async () => {
    const client = makeFakeClient({
      userStamps: [
        {
          stamp_definition_id: "def-1",
          country: "Japan",
          city: "Tokyo",
          stamp_definitions: { stamp_type: "city" },
        },
      ],
    });
    const stats = await runReconciliation(client as any);

    assert.equal(stats.resolved, 1);
    assert.equal(stats.combos, 1);
    assert.equal(stats.enqueued, 1, "new catalog entry enqueues a generation job");

    const rows = summaryRows(client);
    assert.equal(rows.length, 1, "exactly one summary row must be written");
    const counts = JSON.parse(rows[0].review_reason);
    assert.equal(counts.resolved, 1);
    assert.equal(counts.combos, 1);
    assert.equal(counts.enqueued, 1);
  });

  it("fatal error still writes exactly one best-effort summary row with fatal_error", async () => {
    const client = makeFakeClient({ userStampsError: { message: "boom: connection reset" } });

    await assert.rejects(
      () => runReconciliation(client as any),
      /boom: connection reset/,
      "fatal error must propagate",
    );

    const rows = summaryRows(client);
    assert.equal(rows.length, 1, "exactly one summary row even on fatal error");
    assert.equal(rows[0].needs_admin_review, false);
    const counts = JSON.parse(rows[0].review_reason);
    assert.ok(String(counts.fatal_error).includes("boom"), "summary carries the fatal error");
  });

  it("summary rows never pollute admin-review queries (needs_admin_review stays false)", async () => {
    const client = makeFakeClient();
    await runReconciliation(client as any);
    const reviewRows = client.__logInserts.filter((r: any) => r.needs_admin_review === true);
    assert.equal(reviewRows.length, 0, "no admin-review rows from a clean run");
  });
});
