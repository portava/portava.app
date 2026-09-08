/**
 * tripCrewLiveShareScheduler — a failed sweep must not look like an idle one.
 *
 * WHAT WAS WRONG
 * --------------
 * `sweepExpiredLiveShares` CHECKS its `.error` and returns 0; it does not
 * throw. The scheduler's only failure handling was a try/catch, so on the most
 * likely failures — a renamed column, an RLS or grant change, an unreachable
 * database — the catch never fired. The try path ran, `expired === 0` so
 * nothing was logged, and the `job_health` row was stamped `last_run_at = now`.
 *
 * An operator watching job_health therefore saw a job running exactly on time
 * while live location shares stayed ACTIVE past their expiry indefinitely. This
 * is a privacy control, and it had a mode in which it stopped working and
 * reported that it was working.
 *
 * The sweep's own file is not this lane's to change, so the outcome is made
 * measurable from outside it: a bounded probe with a CHECKED `.error` runs
 * first, and its answer separates the three cases the sweep's return value
 * cannot — unreadable, genuinely empty, and a backlog the sweep failed to clear.
 *
 * Also pinned here: the scheduler is idempotent to start, is stoppable, and
 * reschedules itself rather than firing on a fixed `setInterval` (which
 * overlapped a slow sweep with the next one).
 *
 * HOW IT IS MEASURED
 * ------------------
 * A thenable stub that records a query only when it SETTLES, so "the sweep was
 * not attempted" is a counted absence of a request rather than an inference —
 * PostgrestBuilder is a thenable and an un-awaited builder issues nothing at
 * all. Each test asserts a non-zero count of the queries it means to drive.
 *
 * Runtime: node:test + node:assert/strict (NOT vitest).
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/schedulerLiveShareSweep.test.ts
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  runLiveShareSweep,
  tickOnce,
  startTripCrewLiveShareScheduler,
  stopTripCrewLiveShareScheduler,
  getLiveShareSweepStatus,
  _resetLiveShareStatus,
  SWEEP_INTERVAL_MS,
  STARTUP_DELAY_MS,
} from "../lib/tripCrewLiveShareScheduler.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const DB_ERROR = { message: "permission denied for table", code: "42501" };
const SESSIONS = "trip_crew_location_sessions";

interface Settled { table: string; ops: string[]; payload: any }

type Resolver = (q: Settled) => { data: any; error: any } | null;

function stubClient(resolve: Resolver) {
  const settled: Settled[] = [];

  function builder(table: string, ops: string[], payload: any): any {
    const b: any = {};
    for (const op of ["select", "eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "limit", "order"]) {
      b[op] = (...args: any[]) =>
        builder(table, [...ops, typeof args[0] === "string" ? `${op}:${args[0]}` : op], payload);
    }
    for (const op of ["insert", "update", "upsert", "delete"]) {
      b[op] = (body: any) => builder(table, [...ops, op], body ?? payload);
    }
    const settle = (single: boolean) => (onOk: any, onErr: any) => {
      const q: Settled = { table, ops: [...ops], payload };
      settled.push(q);
      const r = resolve(q);
      return Promise.resolve({ count: null, ...(r ?? { data: single ? null : [], error: null }) })
        .then(onOk, onErr);
    };
    b.maybeSingle = () => ({ then: settle(true) });
    b.single = () => ({ then: settle(true) });
    b.then = settle(false);
    return b;
  }

  return {
    settled,
    /** The probe: a bounded SELECT, no update verb. */
    probes() {
      return settled.filter((s) => s.table === SESSIONS && !s.ops.includes("update")).length;
    },
    /** The sweep itself: the conditional UPDATE. */
    sweeps() {
      return settled.filter((s) => s.table === SESSIONS && s.ops.includes("update")).length;
    },
    healthWrites() {
      return settled.filter((s) => s.table === "job_health").length;
    },
    from(table: string) {
      return builder(table, [], null);
    },
  } as any;
}

/** A stub whose probe and sweep answers are chosen per test. */
function sessionsStub(opts: {
  probe: { data: any; error: any };
  sweep?: { data: any; error: any };
}) {
  return stubClient((q) => {
    if (q.table === SESSIONS && q.ops.includes("update")) {
      return opts.sweep ?? { data: [], error: null };
    }
    if (q.table === SESSIONS) return opts.probe;
    return null;
  });
}

beforeEach(() => {
  _resetLiveShareStatus();
});

afterEach(() => {
  stopTripCrewLiveShareScheduler();
  _setTestServiceClient(null as any);
  _resetLiveShareStatus();
});

// ═══════════════════════════════════════════════════════════════════════════

describe("an unreadable sessions table", () => {
  it("FAILS the tick and does NOT attempt the sweep", async () => {
    const c = sessionsStub({ probe: { data: null, error: DB_ERROR } });

    const r = await runLiveShareSweep({ client: c });

    assert.equal(r.probeReadable, false);
    assert.equal(r.ok, false, "a sweep that could not read the table is not a successful sweep");
    assert.ok(r.failures.includes("sessions_unreadable"), r.failures.join(","));
    assert.equal(c.probes(), 1, "vacuity check: the probe must have been issued");
    assert.equal(c.sweeps(), 0, "the UPDATE must not run against a table we could not read");
  });

  it("still records the attempt in job_health, so a stalled job stays detectable", async () => {
    const c = sessionsStub({ probe: { data: null, error: DB_ERROR } });
    await runLiveShareSweep({ client: c });
    assert.equal(c.healthWrites(), 1);
  });
});

describe("a genuinely idle sweep", () => {
  it("no expired session → expired 0 is a REAL answer and the tick succeeds", async () => {
    const c = sessionsStub({ probe: { data: [], error: null } });

    const r = await runLiveShareSweep({ client: c });

    assert.equal(r.backlogSeen, false);
    assert.equal(r.expired, 0);
    assert.equal(r.ok, true);
    assert.equal(c.probes(), 1);
  });
});

describe("a backlog the sweep did not clear", () => {
  it("probe sees an expired session, sweep expires 0 → FAILURE, not an idle tick", async () => {
    // This is the shape the old code reported as a healthy on-time run.
    const c = sessionsStub({
      probe: { data: [{ id: "s1" }], error: null },
      sweep: { data: null, error: DB_ERROR },
    });

    const r = await runLiveShareSweep({ client: c });

    assert.equal(r.backlogSeen, true);
    assert.equal(r.expired, 0);
    assert.equal(r.ok, false);
    assert.ok(r.failures.includes("sweep_zero_despite_backlog"), r.failures.join(","));
    assert.equal(c.sweeps(), 1, "the sweep WAS attempted");
  });

  it("CONTROL: a backlog the sweep actually cleared is a success", async () => {
    const c = sessionsStub({
      probe: { data: [{ id: "s1" }], error: null },
      sweep: { data: [{ id: "s1", trip_id: "t1", user_id: "u1" }], error: null },
    });

    const r = await runLiveShareSweep({ client: c });

    assert.equal(r.expired, 1);
    assert.equal(r.ok, true);
  });
});

describe("failure counters", () => {
  it("climb across failing ticks and reset only on a genuine success", async () => {
    let broken = true;
    const c = stubClient((q) => {
      if (q.table === SESSIONS && q.ops.includes("update")) return { data: [], error: null };
      if (q.table === SESSIONS) return broken ? { data: null, error: DB_ERROR } : { data: [], error: null };
      return null;
    });
    _setTestServiceClient(c);

    await tickOnce();
    await tickOnce();
    assert.equal(getLiveShareSweepStatus().consecutiveFailures, 2);
    assert.equal(getLiveShareSweepStatus().lastSuccessAt, null);

    broken = false;
    await tickOnce();
    const s = getLiveShareSweepStatus();
    assert.equal(s.consecutiveFailures, 0);
    assert.notEqual(s.lastSuccessAt, null);
  });

  it("no service client is a failure, not a quiet tick", async () => {
    // `client: null` explicitly: the suite runs with SUPABASE_URL and a service
    // key set, so clearing the injected client would build a REAL one.
    await tickOnce({ client: null });
    const s = getLiveShareSweepStatus();
    assert.equal(s.consecutiveFailures, 1);
    assert.deepEqual(s.lastFailures, ["no_service_client"]);
  });
});

describe("scheduler lifecycle", () => {
  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => { stopTripCrewLiveShareScheduler(); mock.timers.reset(); });

  async function drain() {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }

  it("waits for the startup delay, then keeps running", async () => {
    const c = sessionsStub({ probe: { data: [], error: null } });
    _setTestServiceClient(c);

    startTripCrewLiveShareScheduler();
    mock.timers.tick(STARTUP_DELAY_MS - 1);
    await drain();
    assert.equal(c.probes(), 0, "nothing may sweep before the startup delay");

    mock.timers.tick(1);
    await drain();
    assert.equal(c.probes(), 1);

    mock.timers.tick(SWEEP_INTERVAL_MS);
    await drain();
    assert.equal(
      c.probes(),
      2,
      "the tick must reschedule itself — one sweep per process start is not a scheduler",
    );
  });

  it("starting twice does not install two timers", async () => {
    const c = sessionsStub({ probe: { data: [], error: null } });
    _setTestServiceClient(c);

    startTripCrewLiveShareScheduler();
    startTripCrewLiveShareScheduler();
    mock.timers.tick(STARTUP_DELAY_MS);
    await drain();

    assert.equal(c.probes(), 1, "one sweep, not two");
  });
});
