/**
 * Lock-timing regression test for runGenerationCycle.
 *
 * Guards against the split-clock refactor accidentally deriving the
 * pessimistic lock (`locked_until`) from a timestamp captured at CYCLE start.
 * The pre-lock sweeps (auto-requeue / stale-artwork) can be slow; the lock
 * window must be ~full LOCK_DURATION from lock ACQUISITION, not shortened by
 * pre-lock elapsed time.
 *
 * Simulates a slow auto-requeue sweep (artificial delay in the
 * retryable_failed select) and asserts the acquired lock expiry is
 * approximately acquisitionTime + 5 minutes.
 *
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampGenerationLockTiming.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// Must be set before the worker module is imported (read at module load):
// - enable the auto-requeue sweep so it runs before lock acquisition
// - disable the stale-artwork sweep to keep the fake client simple
process.env.STAMP_FAILED_REQUEUE_HOURS = "6";
process.env.STAMP_STALE_SWEEP_INTERVAL_MINUTES = "0";

const { runGenerationCycle } = await import("../lib/stamps/generationWorker.js");
const { _setTestServiceClient } = await import("../lib/supabase.js");

const LOCK_DURATION_MS = 5 * 60 * 1_000; // mirrors generationWorker.ts
const PRE_LOCK_DELAY_MS = 150;           // simulated slow sweep
const TOLERANCE_MS = 75;                 // scheduling jitter allowance

const JOB = {
  id: "job-lock-1",
  catalog_id: "cat-lock-1",
  attempts: 0,
  max_attempts: 3,
  triggered_by_action: "test",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface LockCapture {
  lockedUntil: string | null;
  capturedAtMs: number | null;
}

/**
 * Minimal thenable query-builder fake covering the chains runGenerationCycle
 * uses up to (and just past) lock acquisition:
 *  1. requeue sweep select on stamp_generation_queue  → delayed empty result
 *  2. queued-job poll (maybeSingle)                    → JOB
 *  3. lock update (.update().eq().eq().select())       → capture payload + time
 *  4. catalog fetch (maybeSingle)                      → error (ends the cycle)
 *  5. anything else                                    → generic ok
 */
function makeFakeClient(capture: LockCapture) {
  let queueSelectCount = 0;

  function builder(table: string, op: { kind: "select" | "update" | "insert"; payload?: any }) {
    const chain: any = {
      _isMaybeSingle: false,
      select(this: any) { return chain; },
      eq() { return chain; },
      or() { return chain; },
      lt() { return chain; },
      in() { return chain; },
      not() { return chain; },
      is() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() { chain._isMaybeSingle = true; return chain; },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        return resolveChain().then(resolve, reject);
      },
    };

    async function resolveChain(): Promise<any> {
      if (table === "stamp_generation_queue" && op.kind === "select") {
        queueSelectCount += 1;
        if (queueSelectCount === 1) {
          // Auto-requeue sweep — simulate a slow DB round-trip.
          await sleep(PRE_LOCK_DELAY_MS);
          return { data: [], error: null };
        }
        // Job poll
        return { data: JOB, error: null };
      }
      if (table === "stamp_generation_queue" && op.kind === "update") {
        if (op.payload?.locked_until !== undefined && capture.lockedUntil === null) {
          capture.lockedUntil = op.payload.locked_until;
          capture.capturedAtMs = Date.now();
          return { data: [{ id: JOB.id }], error: null };
        }
        return { data: [], error: null };
      }
      if (table === "universal_stamp_catalog") {
        // End the cycle right after lock acquisition.
        return { data: null, error: { message: "catalog fetch stubbed out" } };
      }
      return { data: chain._isMaybeSingle ? null : [], error: null };
    }

    return chain;
  }

  return {
    from(table: string) {
      return {
        select: (_cols?: string) => builder(table, { kind: "select" }),
        update: (payload: any) => builder(table, { kind: "update", payload }),
        insert: (rows: any) => builder(table, { kind: "insert", payload: rows }),
      };
    },
    storage: { from: () => ({ upload: async () => ({ data: null, error: null }), remove: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

describe("runGenerationCycle lock timing", () => {
  afterEach(() => {
    _setTestServiceClient(null);
  });

  it("lock expiry is ~LOCK_DURATION from acquisition, not from cycle start", async () => {
    const capture: LockCapture = { lockedUntil: null, capturedAtMs: null };
    _setTestServiceClient(makeFakeClient(capture) as any);

    const cycleStartMs = Date.now();
    await runGenerationCycle();

    assert.ok(capture.lockedUntil, "lock update was never issued");
    assert.ok(capture.capturedAtMs, "lock acquisition time was never captured");

    const lockUntilMs = new Date(capture.lockedUntil!).getTime();
    const remainingFromAcquisition = lockUntilMs - capture.capturedAtMs!;

    // Full window from acquisition (within jitter tolerance).
    assert.ok(
      Math.abs(remainingFromAcquisition - LOCK_DURATION_MS) <= TOLERANCE_MS,
      `lock window from acquisition was ${remainingFromAcquisition}ms; expected ~${LOCK_DURATION_MS}ms`,
    );

    // And specifically NOT anchored to cycle start: the acquisition happened
    // at least PRE_LOCK_DELAY_MS after cycle start, so a cycle-start-anchored
    // lock would expire measurably earlier than acquisition + LOCK_DURATION.
    assert.ok(
      capture.capturedAtMs! - cycleStartMs >= PRE_LOCK_DELAY_MS - 5,
      "test setup: pre-lock sweep delay did not occur before lock acquisition",
    );
    assert.ok(
      lockUntilMs >= capture.capturedAtMs! + LOCK_DURATION_MS - TOLERANCE_MS,
      "lock expiry is anchored to cycle start (shortened by pre-lock sweep time)",
    );
  });
});
