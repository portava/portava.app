/**
 * tripRetentionScheduler — the fail-closed contract of an irreversible sweep
 * (census-trips TR100, TR387, TR403). Nothing is pruned or forgotten unless
 * trip_retention_sweep_enabled reads TRUE; each SQL policy function is called
 * by name and on its own; disabled, no client and a failure are reported apart.
 *
 * Run: node --import tsx/esm --test src/test/tripRetentionScheduler.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  runTripRetentionSweep, startTripRetentionScheduler, stopTripRetentionScheduler, _tripRetentionSchedulerArmed,
  TRIP_RETENTION_FLAG, TRIP_ACTIVITY_LOG_PRUNE_RPC, TRIP_RESERVATION_FORGET_RPC,
} from "../lib/tripRetentionScheduler.js";

function client(opts: { flag: boolean | null; pruned?: unknown; forgotten?: unknown; fail?: string[] }) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      if (table !== "feature_flags") throw new Error(`unexpected table ${table}`);
      return { select: () => ({ eq: (_c: string, flag: string) => ({ maybeSingle: async () => {
        assert.equal(flag, TRIP_RETENTION_FLAG);
        return { data: opts.flag === null ? null : { enabled: opts.flag }, error: null };
      } }) }) };
    },
    rpc: async (name: string) => {
      calls.push(name);
      if (opts.fail?.includes(name)) return { data: null, error: { message: "boom" } };
      if (name === TRIP_ACTIVITY_LOG_PRUNE_RPC) return { data: { ok: true, pruned: opts.pruned ?? 0 }, error: null };
      if (name === TRIP_RESERVATION_FORGET_RPC) return { data: { ok: true, forgotten: opts.forgotten ?? 0 }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };
}

describe("trip retention sweep — fail-closed", () => {
  it("no flag row: skipped as disabled, and NO function is called", async () => {
    const c = client({ flag: null, pruned: 9 });
    const r = await runTripRetentionSweep({ client: c });
    assert.equal(r.skipped, true); assert.equal(r.reason, "disabled");
    assert.deepEqual(c.calls, []);
  });
  it("flag false: the same", async () => {
    const c = client({ flag: false, pruned: 9 });
    assert.equal((await runTripRetentionSweep({ client: c })).reason, "disabled");
    assert.deepEqual(c.calls, []);
  });
  it("no client: no_client, distinct from disabled", async () => {
    assert.equal((await runTripRetentionSweep({ client: null })).reason, "no_client");
  });
  it("flag true: BOTH policy functions are called by name and their counts reported", async () => {
    const c = client({ flag: true, pruned: 3, forgotten: "2" });
    const r = await runTripRetentionSweep({ client: c });
    assert.equal(r.skipped, false); assert.equal(r.reason, null);
    assert.deepEqual(c.calls, [TRIP_ACTIVITY_LOG_PRUNE_RPC, TRIP_RESERVATION_FORGET_RPC]);
    assert.equal(r.activityLogPruned, 3);
    assert.equal(r.reservationsForgotten, 2, "a count arriving as a string is still a count");
    assert.deepEqual(r.failed, []);
  });
  it("one function failing does not stop the other, and the result names which failed", async () => {
    const c = client({ flag: true, pruned: 1, forgotten: 1, fail: [TRIP_ACTIVITY_LOG_PRUNE_RPC] });
    const r = await runTripRetentionSweep({ client: c });
    assert.equal(r.reason, "error");
    assert.equal(r.activityLogPruned, null);
    assert.equal(r.reservationsForgotten, 1);
    assert.deepEqual(r.failed, [TRIP_ACTIVITY_LOG_PRUNE_RPC]);
    assert.deepEqual(c.calls, [TRIP_ACTIVITY_LOG_PRUNE_RPC, TRIP_RESERVATION_FORGET_RPC]);
  });
  it("the functions are 2789's and 2791's, by name", () => {
    assert.equal(TRIP_ACTIVITY_LOG_PRUNE_RPC, "trip_activity_log_prune");
    assert.equal(TRIP_RESERVATION_FORGET_RPC, "trip_reservations_forget_raw_text");
    assert.equal(TRIP_RETENTION_FLAG, "trip_retention_sweep_enabled");
  });
});

describe("trip retention scheduler — start/stop", () => {
  afterEach(() => stopTripRetentionScheduler());
  it("starting twice installs one timer; stop clears it; start again re-arms", () => {
    assert.equal(_tripRetentionSchedulerArmed(), false);
    startTripRetentionScheduler(); startTripRetentionScheduler();
    assert.equal(_tripRetentionSchedulerArmed(), true);
    stopTripRetentionScheduler();
    assert.equal(_tripRetentionSchedulerArmed(), false);
    startTripRetentionScheduler();
    assert.equal(_tripRetentionSchedulerArmed(), true);
  });
});
