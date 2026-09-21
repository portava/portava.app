/**
 * notificationMaintenanceScheduler — TIMING and LIFECYCLE of the driver itself.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * notificationMaintenanceScheduler.test.ts proves what ONE pass does and that
 * src/index.ts really starts the scheduler. It does not touch the driver: it
 * asserts nothing about whether the first pass waits for the startup delay,
 * whether a SECOND pass is ever scheduled, whether a THROWN or failing pass
 * still reschedules, or whether starting twice installs two timers.
 *
 * That gap is the one that matters most for a self-rescheduling `setTimeout`.
 * If the reschedule were dropped — by moving it out of `.finally`, say — the
 * digest and the expiry would run exactly once per process start and then stop
 * for ever, and every test in the sibling file would still be green. "It ran"
 * and "it keeps running" are different claims. Same split, for the same reason,
 * as memoryProjectionScheduler.test.ts / memoryProjectionSchedulerTiming.test.ts.
 *
 * The split is also load-bearing mechanically: node:test mock timers and the
 * sibling file's suites together left the process alive after all 21 subtests
 * had passed, so the FILE result was a timeout while every assertion was green
 * — a false red that would have been just as easy to misread as a false green.
 * One timer regime per file, enabled in a top-level hook, exits in under a
 * second.
 *
 * Uses node:test mock timers, so an hourly cadence is asserted in milliseconds
 * without waiting for one. A test that starts a scheduler and never advances
 * time proves nothing, and one that asserts on a timer handle proves less; the
 * assertions below are all COUNTS OF QUERIES THAT ACTUALLY SETTLED.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/notificationMaintenanceSchedulerTiming.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  startNotificationMaintenanceScheduler,
  stopNotificationMaintenanceScheduler,
  getNotificationMaintenanceStatus,
  _resetStatus,
  NOTIFICATION_MAINTENANCE_INTERVAL_MS,
  NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS,
} from "../lib/notificationMaintenanceScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── Stub client: counts SETTLED queries, models data AND error ───────────────
// PostgrestBuilder is a THENABLE, so a builder nobody awaits issues no request
// at all. Recording in `then()` is what makes "no pass ran" a counted fact
// rather than an inference.

interface Settled {
  table: string;
  ops: string[];
}

type Resolver = (table: string, ops: string[]) => { data: any; error: any; count?: number | null };

function stubClient(resolve: Resolver) {
  const settled: Settled[] = [];

  function builder(table: string, ops: string[]): any {
    const b: any = {};
    for (const op of [
      "select", "insert", "update", "delete", "upsert",
      "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order", "not",
    ]) {
      b[op] = (...args: any[]) => {
        const label = op === "select" && args[1]?.count ? "select:count" : op;
        return builder(table, [...ops, label]);
      };
    }
    b.maybeSingle = () => builder(table, [...ops, "maybeSingle"]);
    b.single = () => builder(table, [...ops, "single"]);
    b.then = (onOk: any, onErr: any) => {
      settled.push({ table, ops: [...ops] });
      const r = resolve(table, ops);
      return Promise.resolve({ count: null, ...r }).then(onOk, onErr);
    };
    return b;
  }

  return {
    settled,
    countFor(table: string, opIncludes: string) {
      return settled.filter((s) => s.table === table && s.ops.includes(opIncludes)).length;
    },
    from(table: string) {
      return builder(table, []);
    },
    rpc() {
      throw new Error("no notification maintenance path may call rpc()");
    },
  } as any;
}

/** Let queued microtasks (the async pass) settle after advancing timers. */
async function drain() {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

const DB_ERROR = { message: "relation does not exist", code: "42P01" };

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  _resetStatus();
  delete process.env["NOTIFICATION_MAINTENANCE_DISABLED"];
});

afterEach(() => {
  stopNotificationMaintenanceScheduler();
  mock.timers.reset();
  _setTestServiceClient(null as any);
  _resetStatus();
  delete process.env["NOTIFICATION_MAINTENANCE_DISABLED"];
});


describe("scheduler lifecycle", () => {
  it("does NOT run a pass before the startup delay elapses", async () => {
    const c = stubClient(() => ({ data: [], error: null }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS - 1);
    await drain();

    assert.equal(c.settled.length, 0, "nothing may query before the startup delay");
  });

  it("runs a pass once the startup delay elapses", async () => {
    const c = stubClient(() => ({ data: [], error: null }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS);
    await drain();

    assert.ok(c.settled.length > 0, "the first pass must actually issue queries");
    assert.notEqual(getNotificationMaintenanceStatus().lastRunAt, null);
  });

  it("KEEPS running: a second pass is scheduled one interval later", async () => {
    const c = stubClient(() => ({ data: [], error: null }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS);
    await drain();
    const afterFirst = c.countFor("notifications", "limit");
    assert.equal(afterFirst, 1);

    mock.timers.tick(NOTIFICATION_MAINTENANCE_INTERVAL_MS);
    await drain();
    assert.equal(
      c.countFor("notifications", "limit"),
      2,
      "the pass must reschedule itself — one pass per process is not a scheduler",
    );
  });

  it("a pass that fails still reschedules", async () => {
    const c = stubClient(() => ({ data: null, error: DB_ERROR }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS);
    await drain();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_INTERVAL_MS);
    await drain();

    assert.equal(getNotificationMaintenanceStatus().consecutiveFailures, 2);
  });

  it("starting twice does not install two timers", async () => {
    const c = stubClient(() => ({ data: [], error: null }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS);
    await drain();

    assert.equal(c.countFor("notifications", "limit"), 1, "one probe, not two");
  });

  it("NOTIFICATION_MAINTENANCE_DISABLED=1 makes it an inert heartbeat", async () => {
    process.env["NOTIFICATION_MAINTENANCE_DISABLED"] = "1";
    const c = stubClient(() => ({ data: [], error: null }));
    _setTestServiceClient(c);

    startNotificationMaintenanceScheduler();
    mock.timers.tick(NOTIFICATION_MAINTENANCE_STARTUP_DELAY_MS * 4);
    await drain();

    assert.equal(c.settled.length, 0, "an opted-out instance must issue no queries");
  });
});
