/**
 * Stamp generation queue — auto-requeue of stale retryable_failed jobs.
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampQueueRequeue.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requeueStaleFailedJobs } from "../lib/stamps/generationWorker.js";

/**
 * Minimal fake Supabase client that records the update payload and filters,
 * and resolves with the provided rows.
 */
function makeFakeClient(result: { data: any; error: any }) {
  const calls: {
    table?: string;
    updatePayload?: any;
    eqFilters: Array<[string, any]>;
    ltFilters: Array<[string, any]>;
  } = { eqFilters: [], ltFilters: [] };

  const builder: any = {
    update(payload: any) { calls.updatePayload = payload; return builder; },
    eq(col: string, val: any) { calls.eqFilters.push([col, val]); return builder; },
    lt(col: string, val: any) { calls.ltFilters.push([col, val]); return builder; },
    select(_cols: string) { return Promise.resolve(result); },
  };

  const sc = {
    from(table: string) { calls.table = table; return builder; },
  };

  return { sc, calls };
}

describe("requeueStaleFailedJobs", () => {
  it("resets stale retryable_failed jobs to queued with attempts 0", async () => {
    const { sc, calls } = makeFakeClient({ data: [{ id: "a" }, { id: "b" }], error: null });

    const count = await requeueStaleFailedJobs(sc);

    assert.equal(count, 2);
    assert.equal(calls.table, "stamp_generation_queue");
    assert.equal(calls.updatePayload.status, "queued");
    assert.equal(calls.updatePayload.attempts, 0);
    assert.equal(calls.updatePayload.last_error, null);
    assert.equal(calls.updatePayload.locked_until, null);
    assert.equal(calls.updatePayload.locked_by, null);

    // Only rows currently in retryable_failed are touched
    assert.deepEqual(calls.eqFilters, [["status", "retryable_failed"]]);

    // Only rows older than the cutoff are touched
    assert.equal(calls.ltFilters.length, 1);
    assert.equal(calls.ltFilters[0][0], "updated_at");
    const cutoff = new Date(calls.ltFilters[0][1]).getTime();
    assert.ok(cutoff < Date.now(), "cutoff must be in the past");
  });

  it("returns 0 when no rows match", async () => {
    const { sc } = makeFakeClient({ data: [], error: null });
    assert.equal(await requeueStaleFailedJobs(sc), 0);
  });

  it("returns 0 and does not throw on DB error", async () => {
    const { sc } = makeFakeClient({ data: null, error: { message: "boom" } });
    assert.equal(await requeueStaleFailedJobs(sc), 0);
  });
});
