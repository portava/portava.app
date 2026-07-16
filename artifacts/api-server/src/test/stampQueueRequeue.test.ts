/**
 * Stamp generation queue — auto-requeue of stale retryable_failed jobs,
 * with a cap on auto-requeue rounds (STAMP_FAILED_REQUEUE_MAX_ROUNDS, default 3):
 * jobs at/over the cap move to terminal `permanently_failed` instead of retrying.
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampQueueRequeue.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { requeueStaleFailedJobs } from "../lib/stamps/generationWorker.js";

/**
 * Fake Supabase client:
 * - select-chains (from().select().eq().lt().limit()) resolve with `selectResult`
 * - update-chains (from().update().in().eq()[.select()]) are recorded in
 *   `updateCalls` and resolve with { data: <the ids filtered by .in()>, error: null }
 */
function makeFakeClient(selectResult: { data: any; error: any }) {
  const updateCalls: Array<{
    table: string;
    payload: any;
    inFilter?: [string, any[]];
    eqFilters: Array<[string, any]>;
  }> = [];

  const sc = {
    from(table: string) {
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
          const call: (typeof updateCalls)[number] = { table, payload, eqFilters: [] };
          updateCalls.push(call);
          const rows = () => (call.inFilter?.[1] ?? []).map((id: any) => ({ id }));
          const updBuilder: any = {
            in(col: string, vals: any[]) { call.inFilter = [col, vals]; return updBuilder; },
            eq(col: string, val: any) { call.eqFilters.push([col, val]); return updBuilder; },
            select(_c: string) { return Promise.resolve({ data: rows(), error: null }); },
            then(resolve: any, reject: any) {
              return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
            },
          };
          return updBuilder;
        },
      };
    },
  };

  return { sc, updateCalls };
}

describe("requeueStaleFailedJobs", () => {
  it("resets stale retryable_failed jobs to queued, incrementing requeue_count", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [
        { id: "a", requeue_count: 0 },
        { id: "b", requeue_count: 0 },
      ],
      error: null,
    });

    const count = await requeueStaleFailedJobs(sc);

    assert.equal(count, 2);
    assert.equal(updateCalls.length, 1);
    const call = updateCalls[0];
    assert.equal(call.table, "stamp_generation_queue");
    assert.equal(call.payload.status, "queued");
    assert.equal(call.payload.attempts, 0);
    assert.equal(call.payload.last_error, null);
    assert.equal(call.payload.locked_until, null);
    assert.equal(call.payload.locked_by, null);
    assert.equal(call.payload.requeue_count, 1, "requeue_count must increment");
    assert.deepEqual(call.inFilter, ["id", ["a", "b"]]);
    assert.deepEqual(call.eqFilters, [["status", "retryable_failed"]]);
  });

  it("moves jobs at the auto-requeue cap to permanently_failed instead of retrying", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [
        { id: "capped", requeue_count: 3 }, // default cap = 3
        { id: "fresh", requeue_count: 1 },
      ],
      error: null,
    });

    const count = await requeueStaleFailedJobs(sc);

    // Only the under-cap job is re-queued
    assert.equal(count, 1);

    const permCall = updateCalls.find((c) => c.payload.status === "permanently_failed");
    assert.ok(permCall, "must mark capped job permanently_failed");
    assert.deepEqual(permCall!.inFilter, ["id", ["capped"]]);
    assert.deepEqual(permCall!.eqFilters, [["status", "retryable_failed"]]);
    // last_error is preserved (not cleared) for admin visibility
    assert.equal("last_error" in permCall!.payload, false);

    const requeueCall = updateCalls.find((c) => c.payload.status === "queued");
    assert.ok(requeueCall, "must re-queue the under-cap job");
    assert.deepEqual(requeueCall!.inFilter, ["id", ["fresh"]]);
    assert.equal(requeueCall!.payload.requeue_count, 2);
  });

  it("never re-queues a job more times than the cap allows", async () => {
    const { sc, updateCalls } = makeFakeClient({
      data: [{ id: "way-over", requeue_count: 99 }],
      error: null,
    });

    assert.equal(await requeueStaleFailedJobs(sc), 0);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].payload.status, "permanently_failed");
  });

  it("returns 0 when no rows match", async () => {
    const { sc, updateCalls } = makeFakeClient({ data: [], error: null });
    assert.equal(await requeueStaleFailedJobs(sc), 0);
    assert.equal(updateCalls.length, 0);
  });

  it("returns 0 and does not throw on DB error", async () => {
    const { sc } = makeFakeClient({ data: null, error: { message: "boom" } });
    assert.equal(await requeueStaleFailedJobs(sc), 0);
  });
});
