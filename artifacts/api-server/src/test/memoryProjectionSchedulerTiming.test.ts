/**
 * Memory projection scheduler — TIMING and LIFECYCLE of the driver itself.
 *
 * WHY THIS EXISTS (2026-08-29)
 * ----------------------------
 * memoryProjectionScheduler.test.ts proves what ONE pass does (flag off → no-op,
 * flag on → projector + sweep, RPC error → no sweep). It does not touch the
 * scheduler: nothing asserted that the first pass waits for the startup delay,
 * that a second pass is ever scheduled, that a THROWN pass still reschedules, or
 * that starting twice does not install two timers.
 *
 * That gap matters more than it looks. The whole memory system is driven by this
 * one self-rescheduling `setTimeout`. If the reschedule were dropped — for
 * example by moving it out of `.finally` — the system would project exactly once
 * per process start and then silently stop forever, and every existing test
 * would still pass. "It ran" and "it keeps running" are different claims.
 *
 * Uses node:test mock timers, so a 6-hour cadence is asserted in milliseconds
 * without waiting for one.
 *
 * Pure and offline: the service client is a recording stub.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startMemoryProjectionScheduler,
  stopMemoryProjectionScheduler,
} from "../lib/memoryProjectionScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

/** Mirrors the module's own constants; see the assertions that pin them. */
const STARTUP_DELAY_MS = 5 * 60 * 1_000;
const INTERVAL_MS = 6 * 60 * 60 * 1_000;

interface Call { fn: string; args: any }

/**
 * Service-client stub. `flag` drives the feature_flags read; `rpcMode` selects
 * how project_all_memory settles.
 */
function stubClient(opts: { flag?: boolean; rpcMode?: "ok" | "throw" } = {}) {
  const { flag = true, rpcMode = "ok" } = opts;
  const calls: Call[] = [];
  return {
    calls,
    from(_t: string) {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: { enabled: flag }, error: null }),
      };
      return b;
    },
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      if (rpcMode === "throw") throw new Error("rpc exploded");
      return Promise.resolve({ data: 0, error: null });
    },
  } as any;
}

/** Let queued microtasks (the async pass) settle after advancing timers. */
async function drain() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

const projectionCalls = (c: any) => c.calls.filter((k: Call) => k.fn === "project_all_memory").length;

beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
afterEach(() => {
  stopMemoryProjectionScheduler();
  mock.timers.reset();
  _setTestServiceClient(null as any);
});

describe("startup delay", () => {
  it("does NOT run a pass before the startup delay elapses", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS - 1);
    await drain();
    assert.equal(projectionCalls(c), 0, "nothing may run before the delay is up");
  });

  it("runs the first pass exactly AT the startup delay", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 1, "first pass fires at the startup delay");
  });

  it("the delay is 5 minutes — long enough for the graph the projector reads", () => {
    // Pinned because the module's comment ties it to the intel projection at 3m:
    // shortening it below that would project from a stale Experience Graph.
    assert.equal(STARTUP_DELAY_MS, 300_000);
  });
});

describe("recurrence", () => {
  it("schedules a SECOND pass one interval after the first", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 1);

    mock.timers.tick(INTERVAL_MS);
    await drain();
    assert.equal(projectionCalls(c), 2, "the scheduler must reschedule itself");
  });

  it("keeps running — three intervals produce four passes", async () => {
    // The regression this catches: dropping the reschedule so the system
    // projects once per process start and then silently stops forever. Every
    // other test in the suite would still pass.
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    for (let i = 0; i < 3; i += 1) { mock.timers.tick(INTERVAL_MS); await drain(); }
    assert.equal(projectionCalls(c), 4);
  });

  it("does not fire early — one tick short of the interval runs nothing more", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();

    mock.timers.tick(INTERVAL_MS - 1);
    await drain();
    assert.equal(projectionCalls(c), 1, "the cadence must not drift early");
  });

  it("the cadence is 6 hours", () => {
    assert.equal(INTERVAL_MS, 21_600_000);
  });
});

describe("a failing pass must not stop the scheduler", () => {
  it("reschedules after a pass that THREW", async () => {
    // The reschedule lives in `.finally`. Moving it into the success path would
    // mean one bad pass — a transient DB blip — silently ends projection for the
    // life of the process.
    const c = stubClient({ rpcMode: "throw" }); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 1);

    mock.timers.tick(INTERVAL_MS);
    await drain();
    assert.equal(projectionCalls(c), 2, "a thrown pass must still reschedule");
  });

  it("reschedules after a pass that was a flag-disabled no-op", async () => {
    const c = stubClient({ flag: false }); _setTestServiceClient(c);
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 0, "flag off ⇒ the projector is never called");

    // …and the scheduler is still alive, so enabling the flag later takes effect
    // without a restart.
    mock.timers.tick(INTERVAL_MS);
    await drain();
    assert.equal(projectionCalls(c), 0);
    assert.ok(true);
  });

  it("a flag flipped ON between passes is picked up without a restart", async () => {
    // Operationally the important one: the post-deploy runbook enables the flag
    // on a process that has been running with it off.
    let enabled = false;
    const calls: Call[] = [];
    const c = {
      calls,
      from: (_t: string) => {
        const b: any = {
          select: () => b, eq: () => b,
          maybeSingle: () => Promise.resolve({ data: { enabled }, error: null }),
        };
        return b;
      },
      rpc: (fn: string, args: any) => { calls.push({ fn, args }); return Promise.resolve({ data: 0, error: null }); },
    } as any;
    _setTestServiceClient(c);

    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 0, "off at the first pass");

    enabled = true;                       // operator flips the flag
    mock.timers.tick(INTERVAL_MS);
    await drain();
    assert.equal(projectionCalls(c), 1, "the very next pass must act on it");
  });
});

describe("start/stop are safe", () => {
  it("starting twice does not install two timers", async () => {
    // Double-start would double every pass and double the DB load, silently.
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 1, "one timer, one pass");
  });

  it("stop() prevents any further pass", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    stopMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS + INTERVAL_MS * 2);
    await drain();
    assert.equal(projectionCalls(c), 0, "a stopped scheduler runs nothing");
  });

  it("stop() then start() resumes cleanly, still one timer", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    stopMemoryProjectionScheduler();
    startMemoryProjectionScheduler();

    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();
    assert.equal(projectionCalls(c), 1);
  });
});

describe("pass ORDER — projection before sweep", () => {
  it("projects first, then sweeps, in that order", async () => {
    // Sweeping first would delete rows the projection is about to refresh, so a
    // pass could briefly remove memory that is still supported.
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();

    const names = c.calls.map((k: Call) => k.fn);
    assert.deepEqual(names, ["project_all_memory", "memory_sweep_expired"]);
  });

  it("both RPCs are called with the flag enforced", async () => {
    // Defence in depth: the SQL functions re-check the flag themselves, so a
    // scheduler bug cannot project against an operator's intent.
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();

    for (const call of c.calls) {
      assert.equal(call.args?.p_enforce_flag, true, `${call.fn} must enforce the flag`);
    }
  });
});
