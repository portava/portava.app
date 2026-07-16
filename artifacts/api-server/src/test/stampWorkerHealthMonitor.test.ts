/**
 * Unit tests for the periodic stamp-worker health monitor
 * (evaluateWorkerHealth + runHealthMonitorTick in lib/stamps/generationWorker.ts).
 *
 * Covers:
 *   M1: no warnings for a healthy snapshot
 *   M2: stuck_jobs warning when jobs sit in `generating` past lock expiry
 *   M3: backlog_growing warning when queued count grows while worker enabled
 *   M4: no backlog warning on the first tick (no previous depth to compare)
 *   M5: no backlog warning when the worker is disabled
 *   M6: warnings are rate-limited — same warning within the cooldown is suppressed
 *   M7: warning fires again once the cooldown has elapsed
 *   M8: tick is a no-op when health query returns null (no service client)
 *
 * Run: node --import tsx/esm --test src/test/stampWorkerHealthMonitor.test.ts
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWorkerHealth,
  evaluateCurrentWorkerHealth,
  runHealthMonitorTick,
  resetHealthMonitorState,
  type StampWorkerHealth,
} from "../lib/stamps/generationWorker.js";

function makeHealth(overrides: Partial<StampWorkerHealth> = {}): StampWorkerHealth {
  return {
    worker_enabled: true,
    worker_running: true,
    worker_id: "worker-test",
    last_success_at: null,
    queue_depth: {},
    stuck_jobs: [],
    ...overrides,
  };
}

function makeLogger() {
  const warnings: Array<{ details: Record<string, unknown>; msg: string }> = [];
  return {
    warnings,
    warn: (details: Record<string, unknown>, msg: string) => {
      warnings.push({ details, msg });
    },
  };
}

beforeEach(() => resetHealthMonitorState());

test("M1: healthy snapshot produces no warnings", () => {
  const w = evaluateWorkerHealth(makeHealth({ queue_depth: { queued: 2 } }), 2);
  assert.equal(w.length, 0);
});

test("M2: stuck jobs produce a stuck_jobs warning", () => {
  const health = makeHealth({
    stuck_jobs: [
      { id: "j1", catalog_id: "c1", locked_by: "w-old", locked_until: "2026-01-01T00:00:00Z", updated_at: null },
    ],
  });
  const w = evaluateWorkerHealth(health, null);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.key, "stuck_jobs");
  assert.equal(w[0]!.details["stuck_count"], 1);
});

test("M3: growing queued backlog while enabled produces backlog_growing", () => {
  const w = evaluateWorkerHealth(makeHealth({ queue_depth: { queued: 5 } }), 3);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.key, "backlog_growing");
  assert.equal(w[0]!.details["queued"], 5);
  assert.equal(w[0]!.details["previous_queued"], 3);
});

test("M4: no backlog warning when there is no previous depth", () => {
  const w = evaluateWorkerHealth(makeHealth({ queue_depth: { queued: 5 } }), null);
  assert.equal(w.length, 0);
});

test("M5: no backlog warning when the worker is disabled", () => {
  const w = evaluateWorkerHealth(
    makeHealth({ worker_enabled: false, queue_depth: { queued: 5 } }),
    3,
  );
  assert.equal(w.length, 0);
});

test("M6: repeated stuck-job warnings within the cooldown are suppressed", async () => {
  const log = makeLogger();
  const health = makeHealth({
    stuck_jobs: [
      { id: "j1", catalog_id: "c1", locked_by: null, locked_until: null, updated_at: null },
    ],
  });
  let clock = 1_000_000;
  const now = () => clock;

  const first = await runHealthMonitorTick(log, async () => health, now);
  assert.equal(first.length, 1);

  clock += 10 * 60 * 1_000; // 10 min later — inside the 1 h cooldown
  const second = await runHealthMonitorTick(log, async () => health, now);
  assert.equal(second.length, 0);
  assert.equal(log.warnings.length, 1);
});

test("M7: warning fires again after the cooldown elapses", async () => {
  const log = makeLogger();
  const health = makeHealth({
    stuck_jobs: [
      { id: "j1", catalog_id: "c1", locked_by: null, locked_until: null, updated_at: null },
    ],
  });
  let clock = 1_000_000;
  const now = () => clock;

  await runHealthMonitorTick(log, async () => health, now);
  clock += 61 * 60 * 1_000; // past the 1 h cooldown
  const again = await runHealthMonitorTick(log, async () => health, now);
  assert.equal(again.length, 1);
  assert.equal(log.warnings.length, 2);
});

test("M8: tick is a no-op when health query returns null", async () => {
  const log = makeLogger();
  const emitted = await runHealthMonitorTick(log, async () => null, () => 0);
  assert.equal(emitted.length, 0);
  assert.equal(log.warnings.length, 0);
});

test("backlog detection across ticks: second tick with higher queued warns", async () => {
  const log = makeLogger();
  let clock = 1_000_000;
  const now = () => clock;

  await runHealthMonitorTick(log, async () => makeHealth({ queue_depth: { queued: 3 } }), now);
  assert.equal(log.warnings.length, 0);

  clock += 15 * 60 * 1_000;
  const emitted = await runHealthMonitorTick(
    log,
    async () => makeHealth({ queue_depth: { queued: 7 } }),
    now,
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.key, "backlog_growing");
});

test("M9: evaluateCurrentWorkerHealth uses monitor baseline without mutating it", async () => {
  const log = makeLogger();
  // Before any tick, there is no baseline → no backlog warning.
  let w = evaluateCurrentWorkerHealth(makeHealth({ queue_depth: { queued: 9 } }));
  assert.equal(w.length, 0);

  // One tick establishes queued=3 as the baseline.
  await runHealthMonitorTick(log, async () => makeHealth({ queue_depth: { queued: 3 } }), () => 0);

  w = evaluateCurrentWorkerHealth(makeHealth({ queue_depth: { queued: 9 } }));
  assert.equal(w.length, 1);
  assert.equal(w[0]!.key, "backlog_growing");

  // Calling it again yields the same result — baseline was not consumed.
  w = evaluateCurrentWorkerHealth(makeHealth({ queue_depth: { queued: 9 } }));
  assert.equal(w.length, 1);

  // Stuck jobs always warn regardless of baseline.
  w = evaluateCurrentWorkerHealth(makeHealth({
    stuck_jobs: [{ id: "j1", catalog_id: "c1", locked_by: null, locked_until: null, updated_at: null }],
  }));
  assert.equal(w[0]!.key, "stuck_jobs");
});
