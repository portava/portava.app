/**
 * IntelligenceGraphScheduler tests.
 *
 * Verifies the scheduled job:
 *   1. invokes the intelligence-graph rebuild with the service client,
 *   2. survives a rebuild/DB failure without throwing (fail-soft) and
 *      recovers on the next run,
 *   3. skips overlapping runs while a rebuild is in flight,
 *   4. skips gracefully when no service client is configured,
 *   5. survives a hard DB failure through the REAL rebuild engine.
 *
 * Run: node --import tsx/esm --test src/test/intelligenceGraphScheduler.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestServiceClient } from "../lib/supabase.js";
import {
  runIntelligenceGraphRebuildOnce,
  _setTestRebuild,
  _setTestGetClient,
  _setTestSweep,
  getLastRebuildInfo,
  _resetLastRebuildInfo,
} from "../lib/intelligenceGraphScheduler.js";

const FAKE_REPORT = {
  nodesUpserted: 3,
  edgesUpserted: 5,
  // A rebuild now reports rejected chunks separately. Before these existed a
  // wholly broken write path and an empty graph both reported
  // `nodesUpserted: 0`, so the scheduler's recorded outcome could not tell
  // them apart — see CompassGraphEngine.buildGraphFromSources.
  nodesFailed: 0,
  edgesFailed: 0,
  citiesModeled: 1,
  citiesScored: 1,
  strongestCity: "Cebu",
};

describe("IntelligenceGraphScheduler", () => {
  afterEach(() => {
    _setTestRebuild(null);
    _setTestGetClient(null);
    _setTestSweep(null);
    _setTestServiceClient(null);
    _resetLastRebuildInfo();
  });

  it("records lastRebuildAt / lastOutcome after a successful run", async () => {
    _setTestServiceClient({} as any);
    _setTestRebuild(async () => FAKE_REPORT);

    // Before any run: nothing recorded.
    const before = getLastRebuildInfo();
    assert.equal(before.lastRebuildAt, null);
    assert.equal(before.lastOutcome, null);

    const t0 = Date.now();
    await runIntelligenceGraphRebuildOnce();

    const info = getLastRebuildInfo();
    assert.equal(info.lastOutcome, "completed");
    assert.ok(info.lastRebuildAt, "lastRebuildAt must be set after a run");
    const at = Date.parse(info.lastRebuildAt!);
    assert.ok(at >= t0 - 1000 && at <= Date.now() + 1000, "timestamp is current");
    assert.deepEqual(info.lastReport, FAKE_REPORT);
  });

  it("records a failed outcome and keeps the previous successful report", async () => {
    _setTestServiceClient({} as any);

    let calls = 0;
    _setTestRebuild(async () => {
      calls++;
      if (calls === 2) throw new Error("db down");
      return FAKE_REPORT;
    });

    await runIntelligenceGraphRebuildOnce();
    await runIntelligenceGraphRebuildOnce();

    const info = getLastRebuildInfo();
    assert.equal(info.lastOutcome, "failed");
    assert.ok(info.lastRebuildAt);
    // The report from the last successful run is retained.
    assert.deepEqual(info.lastReport, FAKE_REPORT);
  });

  it("does not update the last-run record on a skipped run", async () => {
    _setTestGetClient(() => null);
    await runIntelligenceGraphRebuildOnce();
    const info = getLastRebuildInfo();
    assert.equal(info.lastRebuildAt, null);
    assert.equal(info.lastOutcome, null);
  });

  it("invokes the rebuild with the service client and reports completion", async () => {
    const fakeClient = { __tag: "fake-service-client" } as any;
    _setTestServiceClient(fakeClient);

    let calls = 0;
    let seenDb: unknown = null;
    _setTestRebuild(async (db) => {
      calls++;
      seenDb = db;
      return FAKE_REPORT;
    });

    const result = await runIntelligenceGraphRebuildOnce();
    assert.equal(calls, 1);
    assert.equal(seenDb, fakeClient);
    assert.equal(result.status, "completed");
    assert.deepEqual((result as any).report, FAKE_REPORT);
  });

  it("survives a rebuild DB failure without throwing, then recovers on the next run", async () => {
    _setTestServiceClient({} as any);

    let calls = 0;
    _setTestRebuild(async () => {
      calls++;
      if (calls === 1) throw new Error("db connection refused");
      return FAKE_REPORT;
    });

    // First run: DB failure — must resolve (not reject) as "failed".
    const first = await runIntelligenceGraphRebuildOnce();
    assert.equal(first.status, "failed");

    // The overlap guard must have been released: the next run proceeds.
    const second = await runIntelligenceGraphRebuildOnce();
    assert.equal(second.status, "completed");
    assert.equal(calls, 2);
  });

  it("skips an overlapping run while a rebuild is still in flight", async () => {
    _setTestServiceClient({} as any);

    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    _setTestRebuild(async () => {
      calls++;
      await gate;
      return FAKE_REPORT;
    });

    const firstRun = runIntelligenceGraphRebuildOnce();
    // Let the first run enter the rebuild before firing the second tick.
    await new Promise((r) => setImmediate(r));

    const overlapping = await runIntelligenceGraphRebuildOnce();
    assert.equal(overlapping.status, "skipped");
    assert.equal((overlapping as any).reason, "overlap");
    assert.equal(calls, 1, "overlapping tick must not start a second rebuild");

    release();
    const first = await firstRun;
    assert.equal(first.status, "completed");

    // After completion the guard is released again.
    const next = await runIntelligenceGraphRebuildOnce();
    assert.equal(next.status, "completed");
    assert.equal(calls, 2);
  });

  it("skips gracefully when no service client is configured", async () => {
    // The workspace env may carry real Supabase creds, so force the getter
    // to return null instead of relying on _setTestServiceClient(null).
    _setTestGetClient(() => null);
    let calls = 0;
    _setTestRebuild(async () => { calls++; return FAKE_REPORT; });

    const result = await runIntelligenceGraphRebuildOnce();
    assert.equal(result.status, "skipped");
    assert.equal((result as any).reason, "no_service_client");
    assert.equal(calls, 0);
  });

  it("runs the city_timezones sweep with the service client after a successful rebuild", async () => {
    const fakeClient = { __tag: "fake-service-client" } as any;
    _setTestServiceClient(fakeClient);
    _setTestRebuild(async () => FAKE_REPORT);

    let sweepCalls = 0;
    let sweepDb: unknown = null;
    _setTestSweep(async (db) => { sweepCalls++; sweepDb = db; return 3; });

    const result = await runIntelligenceGraphRebuildOnce();
    assert.equal(result.status, "completed");
    assert.equal(sweepCalls, 1);
    assert.equal(sweepDb, fakeClient);
  });

  it("a sweep failure never turns a completed rebuild into a failed run", async () => {
    _setTestServiceClient({} as any);
    _setTestRebuild(async () => FAKE_REPORT);
    _setTestSweep(async () => { throw new Error("sweep exploded"); });

    const result = await runIntelligenceGraphRebuildOnce();
    assert.equal(result.status, "completed");
    assert.equal(getLastRebuildInfo().lastOutcome, "completed");
  });

  it("skips the sweep when the rebuild itself fails", async () => {
    _setTestServiceClient({} as any);
    _setTestRebuild(async () => { throw new Error("db down"); });
    let sweepCalls = 0;
    _setTestSweep(async () => { sweepCalls++; return 0; });

    const result = await runIntelligenceGraphRebuildOnce();
    assert.equal(result.status, "failed");
    assert.equal(sweepCalls, 0);
  });

  it("survives a hard DB failure through the real rebuild engine", async () => {
    // No injected rebuild: the real rebuildIntelligenceGraph runs against a
    // client whose every query throws — the scheduler must still not throw.
    const throwingClient = {
      from() {
        throw new Error("database is down");
      },
    } as any;
    _setTestServiceClient(throwingClient);
    _setTestRebuild(null);

    const result = await runIntelligenceGraphRebuildOnce();
    // buildGraphFromSources is internally fail-soft, but downstream steps may
    // surface the failure — either way the scheduler resolves without throwing.
    assert.ok(result.status === "failed" || result.status === "completed");
  });
});
