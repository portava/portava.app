/**
 * A scheduler stopped while its pass is still running must not re-arm itself.
 *
 * Every in-process scheduler here is a self-rescheduling `setTimeout`: the tick
 * runs the pass and, in a `.finally`, arms the next timer. `stop()` cleared the
 * CURRENT handle only, so a stop that landed while a pass was in flight was
 * followed by the pass's own `.finally` arming a fresh timer. Two consequences,
 * both measured on 2026-10-06:
 *
 *   1. In the full suite, a timing test stops the scheduler and then restores
 *      real timers (`mock.timers.reset()`); under load the in-flight pass
 *      settled AFTER that, so the re-arm was a REAL multi-hour timer, the test
 *      worker could never exit, and three files "hung" for 35–43 minutes at 0 %
 *      CPU (notificationMaintenanceSchedulerTiming, memoryProjectionSchedulerTiming,
 *      memoryProjectionSchedulerOutbox).
 *   2. In production, a stopped scheduler could keep running one more interval.
 *
 * The fix is the same one line in all 21 schedulers: the `.finally` re-arms only
 * while `_timer` is still non-null, which `stop()` makes false. This file pins
 * it on the two schedulers that hung, in both directions: with mocked timers
 * (no second pass after stop) and with real timers (no live timer handle left
 * behind after the in-flight pass settles).
 */
import { describe, it, before, afterEach, mock } from "node:test";
import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";
import assert from "node:assert/strict";
import { startMemoryProjectionScheduler, stopMemoryProjectionScheduler } from "../lib/memoryProjectionScheduler.js";
import {
  startNotificationMaintenanceScheduler,
  stopNotificationMaintenanceScheduler,
  _resetStatus,
  NOTIFICATION_MAINTENANCE_INTERVAL_MS,
  NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS,
} from "../lib/notificationMaintenanceScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const STARTUP_DELAY_MS = 5 * 60 * 1_000;
const INTERVAL_MS = 6 * 60 * 60 * 1_000;

async function drain() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/** A memory-projection client whose pass does not settle until the test says so. */
function pendingMemoryClient() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let passes = 0;
  const client = {
    from() {
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve({ data: { enabled: true }, error: null }) };
      return b;
    },
    rpc(fn: string) {
      if (fn === "project_all_memory") { passes += 1; return gate.then(() => ({ data: 0, error: null })); }
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
  return { client, release, passes: () => passes };
}

/** A notification-maintenance client whose first settled query blocks until released. */
function pendingNotificationClient() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let settled = 0;
  function builder(): any {
    const b: any = {};
    for (const op of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not"]) b[op] = () => builder();
    b.maybeSingle = () => builder(); b.single = () => builder();
    b.then = (onOk: any, onErr: any) => { settled += 1; return gate.then(() => ({ data: [], error: null, count: 0 })).then(onOk, onErr); };
    return b;
  }
  return { client: { from: () => builder(), rpc() { throw new Error("no rpc"); } } as any, release, settled: () => settled };
}

const liveTimeouts = () => (process as any).getActiveResourcesInfo().filter((r: string) => r === "Timeout").length;

afterEach(() => {
  stopMemoryProjectionScheduler();
  stopNotificationMaintenanceScheduler();
  _resetStatus();
  mock.timers.reset();
  _setTestServiceClient(null as any);
});

// The logger's pino transport becomes READY through a poll on the GLOBAL
// setTimeout; with setTimeout mocked below, a slow (loaded) worker would never
// report ready and this file's process would never exit after its tests pass.
// Made ready in real time first — helpers/loggerTransportReady.ts has the why.
before(async () => {
  await awaitLoggerTransportReady();
});

describe("a scheduler stopped mid-pass does not re-arm (memory projection)", () => {
  it("mocked timers: no second pass after stop(), however long the clock runs", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = pendingMemoryClient(); _setTestServiceClient(c.client);
    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS); await drain();
    assert.equal(c.passes(), 1, "the first pass is in flight");
    stopMemoryProjectionScheduler();
    c.release(); await drain();
    mock.timers.tick(INTERVAL_MS * 3); await drain();
    assert.equal(c.passes(), 1, "a pass that settled after stop() must not schedule another");
  });

  it("real timers restored before the pass settles: no live timer is left behind (the hang)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = pendingMemoryClient(); _setTestServiceClient(c.client);
    startMemoryProjectionScheduler();
    mock.timers.tick(STARTUP_DELAY_MS); await drain();
    assert.equal(c.passes(), 1);
    stopMemoryProjectionScheduler();
    mock.timers.reset();                       // what every timing test's afterEach does
    const before = liveTimeouts();
    c.release(); await drain();                // the in-flight pass settles AFTER real timers are back
    assert.equal(liveTimeouts(), before, "the settled pass must not arm a real timer — that handle is what kept the worker alive");
  });
});

describe("a scheduler stopped mid-pass does not re-arm (notification maintenance)", () => {
  it("mocked timers: no second settled query after stop()", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = pendingNotificationClient(); _setTestServiceClient(c.client);
    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS); await drain();
    assert.ok(c.settled() >= 1, "the first pass is in flight");
    stopNotificationMaintenanceScheduler();
    c.release(); await drain();                // the in-flight pass finishes its remaining queries
    const afterSettle = c.settled();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_INTERVAL_MS * 3); await drain();
    assert.equal(c.settled(), afterSettle, "no further pass after stop(): the clock ran three intervals and nothing was queried");
  });

  it("real timers restored before the pass settles: no live timer is left behind", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const c = pendingNotificationClient(); _setTestServiceClient(c.client);
    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS); await drain();
    stopNotificationMaintenanceScheduler();
    mock.timers.reset();
    const before = liveTimeouts();
    c.release(); await drain();
    assert.equal(liveTimeouts(), before);
  });
});
