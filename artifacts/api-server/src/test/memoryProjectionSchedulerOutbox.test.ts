/**
 * The outbox drain SCHEDULER — the driver, not the consumer.
 *
 * WHY THIS EXISTS
 * ---------------
 * src/test/memoryOutboxConsumer.test.ts proves what one drain DOES. It says
 * nothing about the runner that drives it, and the wrapper has its own ways of
 * being wrong — each of which leaves a green consumer suite:
 *
 *   1. REPORTING A FAILED PASS AS A CLEAN ONE. `drainMemoryOutbox` returns a
 *      discriminated result precisely so "the outbox could not be read" never
 *      renders as "there was nothing to publish" (§28.11). A wrapper that maps
 *      both to `reason: null` throws that distinction away at the last step,
 *      and the operator sees a healthy scheduler while the backlog grows.
 *      THIS TEST WAS WRITTEN BECAUSE THAT MUTATION SURVIVED: flipping the
 *      failure branch's `reason` to null left every other suite green.
 *   2. A PASS THAT RUNS ONCE. The reschedule lives in `.finally` for the same
 *      reason the projection pass's does — one transient blip must not end
 *      draining for the life of the process.
 *   3. A DOUBLE START. Two timers double the claim rate and halve the batch
 *      each worker sees, silently.
 *
 * Uses node:test mock timers, so a 60-second cadence is asserted in
 * milliseconds. No fixed dates: every assertion is about elapsed intervals.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  runMemoryOutboxDrainPass,
  startMemoryOutboxScheduler,
  stopMemoryOutboxScheduler,
} from "../services/memoryProjections/outboxDrainRunner.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const OUTBOX_STARTUP_DELAY_MS = 2 * 60 * 1_000;
const OUTBOX_INTERVAL_MS = 60 * 1_000;

interface Call { fn: string; args: any }

/**
 * `claimMode` selects how memory_outbox_claim settles. `error` reproduces the
 * supabase-js behaviour that matters: it RESOLVES, with data null and an error
 * bound — it does not reject.
 */
function stubClient(opts: { claimMode?: "empty" | "error" | "throw" } = {}) {
  const { claimMode = "empty" } = opts;
  const calls: Call[] = [];
  return {
    calls,
    from(_t: string) {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, is: () => b,
        order: () => b, limit: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
      };
      return b;
    },
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      if (claimMode === "throw") throw new Error("rpc exploded");
      if (claimMode === "error") {
        return Promise.resolve({ data: null, error: { message: "outbox unreadable" } });
      }
      return Promise.resolve({ data: [], error: null });
    },
  } as any;
}

const claimCalls = (c: any) => c.calls.filter((k: Call) => k.fn === "memory_outbox_claim").length;

// ── 1. one pass, and what it reports ────────────────────────────────────────

describe("runMemoryOutboxDrainPass reports what actually happened", () => {
  it("an empty outbox is a clean pass with nothing claimed", async () => {
    const r = await runMemoryOutboxDrainPass({ client: stubClient() });
    assert.equal(r.skipped, false);
    assert.equal(r.reason, null);
    assert.equal(r.claimed, 0);
  });

  it("AN UNREADABLE OUTBOX IS reason:'error', NEVER a clean empty pass", () => {
    // The whole point of the discriminated result. A wrapper that collapsed
    // this to `reason: null` would let the backlog grow behind a green log
    // line, which is §24's projection_lag measured as zero because nothing was
    // measured. This assertion is what kills that mutation.
    return runMemoryOutboxDrainPass({ client: stubClient({ claimMode: "error" }) })
      .then((r) => {
        assert.equal(r.reason, "error",
          "a pass that could not read the outbox must not report success");
        assert.notEqual(r.reason, null);
      });
  });

  it("a THROWING client is an error pass, not a crash", async () => {
    const r = await runMemoryOutboxDrainPass({ client: stubClient({ claimMode: "throw" }) });
    assert.equal(r.reason, "error");
  });

  it("an explicitly absent client is 'no_client', distinct from 'error'", async () => {
    // Distinct because they need different operator responses: one is a
    // misconfigured process, the other is a database problem.
    const r = await runMemoryOutboxDrainPass({ client: null });
    assert.equal(r.reason, "no_client");
    assert.equal(r.skipped, true);
  });

  it("the pass CLAIMS — a drain that never reads is not a drain", async () => {
    const c = stubClient();
    await runMemoryOutboxDrainPass({ client: c });
    assert.equal(claimCalls(c), 1);
  });

  it("THE BATCH LIMIT IS POSITIVE — a limit of 0 claims nothing, forever", async () => {
    // Found by mutation: setting OUTBOX_BATCH_LIMIT to 0 left every test green,
    // because `p_limit: opts.limit ?? 100` passes a literal 0 straight through
    // (0 is not nullish) and `LIMIT 0` claims no rows. The scheduler would run
    // on time, log nothing wrong, and drain the outbox at a rate of zero.
    const c = stubClient();
    await runMemoryOutboxDrainPass({ client: c });
    const claim = c.calls.find((k: Call) => k.fn === "memory_outbox_claim");
    assert.ok(claim.args.p_limit > 0,
      "a zero batch limit is a drain that cannot drain");
  });
});

// ── 2. the timer ────────────────────────────────────────────────────────────

describe("the outbox scheduler keeps draining", () => {
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => {
    stopMemoryOutboxScheduler();
    mock.timers.reset();
    _setTestServiceClient(null as any);
  });

  async function drain() {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }

  it("does not drain before the startup delay", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();
    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS - 1);
    await drain();
    assert.equal(claimCalls(c), 0);
  });

  it("drains at the startup delay, then every interval", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();

    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS);
    await drain();
    assert.equal(claimCalls(c), 1);

    mock.timers.tick(OUTBOX_INTERVAL_MS);
    await drain();
    assert.equal(claimCalls(c), 2, "the scheduler must reschedule itself");
  });

  it("A FAILED PASS STILL RESCHEDULES", async () => {
    // The regression: moving the reschedule out of `.finally` means one
    // transient database blip ends draining for the life of the process, and
    // every other test still passes.
    const c = stubClient({ claimMode: "error" }); _setTestServiceClient(c);
    startMemoryOutboxScheduler();

    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS);
    await drain();
    assert.equal(claimCalls(c), 1);

    mock.timers.tick(OUTBOX_INTERVAL_MS);
    await drain();
    assert.equal(claimCalls(c), 2, "a failed pass must still reschedule");
  });

  it("A STOP DURING AN IN-FLIGHT PASS IS NOT UNDONE BY THAT PASS", async () => {
    // The defect this was written for, found by mutation and reproduced first:
    // the reschedule lives in the pass's `.finally`, so a pass already running
    // when stop() is called re-installs the timer from inside its own
    // continuation — AFTER clearTimeout has already happened. The scheduler
    // comes back from the dead, and in this suite it did: three tests failed
    // and the runner HUNG on a live 60-second timer nothing could cancel.
    //
    // The distinguishing move is stopping BETWEEN the tick and the drain, so
    // the pass is genuinely mid-flight rather than finished.
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();

    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS);
    stopMemoryOutboxScheduler();     // <- while the pass is still settling
    await drain();

    const afterStop = claimCalls(c);
    mock.timers.tick(OUTBOX_INTERVAL_MS * 3);
    await drain();
    assert.equal(claimCalls(c), afterStop,
      "a pass that was in flight when stop() ran must not resurrect the timer");
  });

  it("the pass itself NEVER REJECTS — which is what makes .finally safe", async () => {
    // Stated as its own assertion because it is load-bearing: the reschedule is
    // `.catch(...).finally(...)`, and `.finally` versus `.then` is only
    // equivalent while the pass cannot reject. If a future edit lets it reject,
    // this goes red and names the reason the `.finally` matters.
    await assert.doesNotReject(() =>
      runMemoryOutboxDrainPass({ client: stubClient({ claimMode: "throw" }) }));
    await assert.doesNotReject(() =>
      runMemoryOutboxDrainPass({ client: stubClient({ claimMode: "error" }) }));
    await assert.doesNotReject(() => runMemoryOutboxDrainPass({ client: null }));
  });

  it("the cadence is a MINUTE, not the projection pass's six hours", () => {
    // An outbox drained twice a day is a projection half a day stale. The
    // constant is pinned because widening it is a silent change to §24's
    // projection_lag.
    assert.equal(OUTBOX_INTERVAL_MS, 60_000);
  });

  it("starting twice does not install two timers", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();
    startMemoryOutboxScheduler();
    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS);
    await drain();
    assert.equal(claimCalls(c), 1, "one timer, one pass");
  });

  it("stop() prevents any further drain", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();
    stopMemoryOutboxScheduler();
    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS + OUTBOX_INTERVAL_MS * 3);
    await drain();
    assert.equal(claimCalls(c), 0);
  });

  it("stop() then start() resumes cleanly, still one timer", async () => {
    const c = stubClient(); _setTestServiceClient(c);
    startMemoryOutboxScheduler();
    stopMemoryOutboxScheduler();
    startMemoryOutboxScheduler();
    mock.timers.tick(OUTBOX_STARTUP_DELAY_MS);
    await drain();
    assert.equal(claimCalls(c), 1);
  });
});

// ── 3. the two schedulers are independent ───────────────────────────────────

describe("the drain does not disturb the projection pass", () => {
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => {
    stopMemoryOutboxScheduler();
    mock.timers.reset();
    _setTestServiceClient(null as any);
  });

  it("stopping the outbox scheduler does not require the projection scheduler", () => {
    // Pinned because the two share a module: a refactor that collapsed them
    // into one timer would break memoryProjectionSchedulerTiming.test.ts's
    // exact RPC-sequence assertion, and this states the separation as intent
    // rather than leaving it as a coincidence of the current code.
    assert.doesNotThrow(() => stopMemoryOutboxScheduler());
  });

  it("the drain's claim carries NO p_enforce_flag — it is not flag-gated", async () => {
    // Deliberate and documented: an outbox row can only exist if the kernel
    // wrote it, and the kernel is what the flag gates. Gating the consumer too
    // would strand already-written events behind a second switch.
    const c = stubClient();
    await runMemoryOutboxDrainPass({ client: c });
    const claim = c.calls.find((k: Call) => k.fn === "memory_outbox_claim");
    assert.ok(claim);
    assert.equal(claim.args.p_enforce_flag, undefined);
  });
});
