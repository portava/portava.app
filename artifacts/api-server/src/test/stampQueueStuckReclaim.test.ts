/**
 * requeueStuckGeneratingJobs — timeout-based reclaim of `generating` jobs whose
 * pessimistic lock has expired (crashed worker), audit STAMP·H4.
 *
 * runGenerationCycle only ever claims `queued` rows, and the partial unique
 * index treats `generating` as active, so a stuck `generating` row is both
 * un-processed AND holds the catalog entry's only active-job slot forever. This
 * sweep moves those rows back to `queued` (or `retryable_failed` once attempts
 * are exhausted, so a poison job can't livelock the sweep), clearing the lock.
 *
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampQueueStuckReclaim.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  requeueStuckGeneratingJobs,
  STUCK_GENERATING_RECLAIM_ERROR,
} from "../lib/stamps/generationWorker.js";

/**
 * Fake Supabase client:
 * - select-chain: from().select().eq().lt().limit() resolves with `selectResult`.
 * - update-chain: from().update().eq().eq().lt().select() is recorded in
 *   `updateCalls`; each resolves with the row identified by its `.eq("id", …)`
 *   filter, unless that id is in `guardMisses` (models the status/lock guard
 *   matching zero rows because a live worker re-claimed the row first).
 */
function makeFakeClient(
  selectResult: { data: any; error: any },
  opts: { guardMisses?: Set<string>; updateError?: any } = {},
) {
  const updateCalls: Array<{
    payload: any;
    eqFilters: Array<[string, any]>;
    ltFilters: Array<[string, any]>;
  }> = [];

  const sc = {
    from(_table: string) {
      return {
        select(_cols: string) {
          const selBuilder: any = {
            eq() { return selBuilder; },
            lt() { return selBuilder; },
            limit() { return Promise.resolve(selectResult); },
          };
          return selBuilder;
        },
        update(payload: any) {
          const call = { payload, eqFilters: [] as Array<[string, any]>, ltFilters: [] as Array<[string, any]> };
          updateCalls.push(call);
          const updBuilder: any = {
            eq(col: string, val: any) { call.eqFilters.push([col, val]); return updBuilder; },
            lt(col: string, val: any) { call.ltFilters.push([col, val]); return updBuilder; },
            select() {
              if (opts.updateError) return Promise.resolve({ data: null, error: opts.updateError });
              const idFilter = call.eqFilters.find(([c]) => c === "id");
              const id = idFilter?.[1];
              const rows = id && !opts.guardMisses?.has(id) ? [{ id }] : [];
              return Promise.resolve({ data: rows, error: null });
            },
          };
          return updBuilder;
        },
      };
    },
  };

  return { sc, updateCalls };
}

describe("requeueStuckGeneratingJobs", () => {
  it("resets a stuck generating job under the attempt cap back to queued, clearing the lock", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [{ id: "stuck-a", attempts: 0, max_attempts: 3 }],
      error: null,
    });

    const count = await requeueStuckGeneratingJobs(sc);

    assert.equal(count, 1);
    assert.equal(updateCalls.length, 1);
    const call = updateCalls[0];
    assert.equal(call.payload.status, "queued", "under-cap crash must return to queued");
    assert.equal(call.payload.attempts, 1, "the crashed run counts as an attempt");
    assert.equal(call.payload.locked_until, null, "lock must be released");
    assert.equal(call.payload.locked_by, null);
    assert.equal(call.payload.last_error, STUCK_GENERATING_RECLAIM_ERROR);
  });

  it("moves a stuck job that has exhausted its attempts to retryable_failed, not queued", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [{ id: "poison", attempts: 2, max_attempts: 3 }], // 2 + 1 === 3 === cap
      error: null,
    });

    const count = await requeueStuckGeneratingJobs(sc);

    assert.equal(count, 1);
    assert.equal(updateCalls[0].payload.status, "retryable_failed",
      "a job at the attempt cap must not be re-queued — it would livelock the sweep");
    assert.equal(updateCalls[0].payload.attempts, 3);
  });

  it("guards every UPDATE on status='generating' AND an expired lock so a freshly re-claimed row is never clobbered", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [{ id: "stuck-a", attempts: 0, max_attempts: 3 }],
      error: null,
    });

    await requeueStuckGeneratingJobs(sc);

    const call = updateCalls[0];
    assert.deepEqual(call.eqFilters, [["id", "stuck-a"], ["status", "generating"]],
      "must filter on id and status='generating'");
    assert.equal(call.ltFilters.length, 1, "must also guard on an expired locked_until");
    assert.equal(call.ltFilters[0][0], "locked_until");
  });

  it("counts only rows the guarded UPDATE actually changed (a re-claimed row updates zero rows)", async () => {
    const { sc } = makeFakeClient(
      {
        data: [
          { id: "still-stuck", attempts: 0, max_attempts: 3 },
          { id: "reclaimed-by-worker", attempts: 0, max_attempts: 3 },
        ],
        error: null,
      },
      { guardMisses: new Set(["reclaimed-by-worker"]) },
    );

    const count = await requeueStuckGeneratingJobs(sc);
    assert.equal(count, 1, "only the row whose guard matched should be counted");
  });

  it("returns 0 when there are no stuck generating rows", async () => {
    const { sc, updateCalls } = makeFakeClient({ data: [], error: null });
    assert.equal(await requeueStuckGeneratingJobs(sc), 0);
    assert.equal(updateCalls.length, 0);
  });

  it("returns 0 and does not throw when the query errors", async () => {
    const { sc } = makeFakeClient({ data: null, error: { message: "boom" } });
    assert.equal(await requeueStuckGeneratingJobs(sc), 0);
  });

  it("does not count a row when its UPDATE errors, and does not throw", async () => {
    const { sc } = makeFakeClient(
      { data: [{ id: "stuck-a", attempts: 0, max_attempts: 3 }], error: null },
      { updateError: { message: "update failed" } },
    );
    assert.equal(await requeueStuckGeneratingJobs(sc), 0);
  });
});
