/**
 * Memory deletion redrive scheduler — the driver's LIFECYCLE (census H193).
 *
 * The pass is proved in memoryDeletionEvidencePurge.test.ts. This file proves
 * the loop around it: the first pass waits for its delay, a pass is followed by
 * another (it re-arms), a pass that THROWS still re-arms, and stop() ends the
 * loop — including a stop() that lands while a pass is in flight, which is the
 * re-arm-after-stop defect #627 fixed in this file's siblings.
 *
 * TIMERS ARE REAL, ONLY `Date` IS MOCKED. Mocking setTimeout has hung whole
 * suite runs in two sibling timing tests (RULES addendum 1); the scheduler takes
 * millisecond overrides instead, so real timers finish in tens of milliseconds.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startMemoryDeletionRedriveScheduler,
  stopMemoryDeletionRedriveScheduler,
} from "../lib/memoryDeletionRedriveScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

/** Counts flag reads — one per pass while the flag is off. `throwOnFrom` makes the pass itself throw. */
function stubClient(opts: { throwOnFrom?: boolean; holdMs?: number } = {}) {
  const state = { flagReads: 0 };
  const client = {
    from(_t: string) {
      state.flagReads += 1;
      if (opts.throwOnFrom) throw new Error("client exploded");
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => new Promise((r) => setTimeout(() => r({ data: { enabled: false }, error: null }), opts.holdMs ?? 0)),
      };
      return b;
    },
  } as any;
  return { client, state };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2000) {
  // performance.now(), not Date.now(): Date is mocked (frozen) in this file.
  const end = performance.now() + ms;
  while (!pred()) {
    if (performance.now() > end) throw new Error("condition not reached");
    await sleep(2);
  }
}

beforeEach(() => { mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-07T12:00:00.000Z").getTime() }); });
afterEach(() => {
  stopMemoryDeletionRedriveScheduler();
  mock.timers.reset();
  _setTestServiceClient(null as any);
});

describe("memory deletion redrive scheduler", () => {
  it("waits for its startup delay, then keeps running — a pass is followed by another", async () => {
    const { client, state } = stubClient(); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 60, intervalMs: 5 });
    await sleep(15);
    assert.equal(state.flagReads, 0, "no pass before the startup delay");
    await until(() => state.flagReads >= 3);
  });

  it("a pass whose client fails still re-arms (the failure is a closed flag, not a dead loop)", async () => {
    const { client, state } = stubClient({ throwOnFrom: true }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 2);
  });

  it("stop() ends the loop, even when it lands while a pass is in flight", async () => {
    const { client, state } = stubClient({ holdMs: 30 }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 1); // the first pass is now waiting on its flag read
    stopMemoryDeletionRedriveScheduler();
    const frozen = state.flagReads;
    await sleep(120);
    assert.equal(state.flagReads, frozen, "no pass after stop(): the in-flight pass did not re-arm");
  });

  it("stop() then start() while a pass is in flight runs ONE loop, not the old one beside the new", async () => {
    const { client, state } = stubClient({ holdMs: 25 }); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 5 });
    await until(() => state.flagReads >= 1); // pass 1 of the OLD loop is in flight; if it re-armed, its next pass is 5 ms after it settles
    stopMemoryDeletionRedriveScheduler();
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1000, intervalMs: 1000 }); // the new loop's first pass is 1 s away
    await sleep(120); // the old pass settles inside this window
    assert.equal(state.flagReads, 1, "the old loop's in-flight pass did not re-arm itself beside the new loop");
  });

  it("starting twice installs one loop: one stop() ends it", async () => {
    const { client, state } = stubClient(); _setTestServiceClient(client);
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 40, intervalMs: 40 });
    startMemoryDeletionRedriveScheduler({ startupDelayMs: 1, intervalMs: 1 });
    await sleep(20);
    assert.equal(state.flagReads, 0, "the second start was ignored: its 1 ms delay never ran");
    stopMemoryDeletionRedriveScheduler();
    await sleep(80);
    assert.equal(state.flagReads, 0);
  });
});
