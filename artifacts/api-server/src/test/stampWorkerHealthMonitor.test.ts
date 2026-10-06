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
 * And the monitor's DURABLE outcome (job_health, key `stamp_health_monitor`),
 * which is the only trace of this monitor anything outside the process can
 * read — it used to report to the logger only, and logs on this host are not
 * retained anywhere queryable. Each of these asserts the resulting ROW STATE,
 * not that the upsert was called (CONTRIBUTING.md:33-66):
 *
 *   H1: a pass that read and evaluated a snapshot stores last_run_at AND
 *       last_success_at, on the table and key /healthz and the admin panels read
 *   H2: a tick with no service client stores the ATTEMPT and no success at all
 *   H3: a tick whose health query THREW stores the attempt, no success, and
 *       still propagates the error so the loop logs as it always did
 *   H4: a failed pass after a successful one leaves the stored last_success_at
 *       where it was — the success column cannot be laundered forward
 *   H5: a pass that emitted warnings is still the monitor succeeding
 *   H6: a persistence failure is logged, not thrown, and not silently dropped
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
  HEALTH_MONITOR_JOB_KEY,
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

// ── The durable row ──────────────────────────────────────────────────────────

interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
  onConflict: string;
}

/**
 * A stand-in for the one thing persisting job health touches.
 *
 * `rows` MERGES each payload onto the stored row keyed by the conflict target,
 * which is what PostgREST's upsert does: a column absent from the payload keeps
 * whatever is stored. That behaviour is the whole point of omitting
 * `last_success_at` on a failed pass rather than writing a value for it, so the
 * fake has to reproduce it or H4 would prove nothing.
 */
function makeJobHealthDb(failure: { message?: string } | null = null) {
  const calls: UpsertCall[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    from(table: string) {
      return {
        async upsert(
          row: Record<string, unknown>,
          opts: { onConflict: string },
        ): Promise<{ error: { message?: string } | null }> {
          calls.push({ table, row: { ...row }, onConflict: opts.onConflict });
          if (failure) return { error: failure };
          const key = String(row[opts.onConflict]);
          rows.set(key, { ...(rows.get(key) ?? {}), ...row });
          return { error: null };
        },
      };
    },
  };
  return { db, calls, rows };
}

/** The stored row for this monitor, or undefined when nothing was stored. */
function storedRow(rows: Map<string, Record<string, unknown>>) {
  return rows.get(HEALTH_MONITOR_JOB_KEY);
}

test("H1: a completed pass stores last_run_at AND last_success_at", async () => {
  const log = makeLogger();
  const { db, calls, rows } = makeJobHealthDb();
  const at = Date.parse("2026-10-03T12:00:00.000Z");

  await runHealthMonitorTick(log, async () => makeHealth({ queue_depth: { queued: 1 } }), () => at, db);

  const row = storedRow(rows);
  assert.ok(row, "a completed pass must leave a durable row");
  assert.equal(row["last_run_at"], "2026-10-03T12:00:00.000Z");
  assert.equal(row["last_success_at"], "2026-10-03T12:00:00.000Z");
  // The surface an operator actually reads: public.job_health, keyed on `job`.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.table, "job_health");
  assert.equal(calls[0]!.onConflict, "job");
  assert.equal(calls[0]!.row["job"], "stamp_health_monitor");
});

test("H2: no service client stores the attempt and NO success", async () => {
  const log = makeLogger();
  const { db, rows } = makeJobHealthDb();
  const at = Date.parse("2026-10-03T12:15:00.000Z");

  const emitted = await runHealthMonitorTick(log, async () => null, () => at, db);
  assert.equal(emitted.length, 0);

  const row = storedRow(rows);
  assert.ok(row, "a tick that could not read a snapshot still attempted");
  assert.equal(row["last_run_at"], "2026-10-03T12:15:00.000Z");
  // Zero warnings here is NOT a clean pass, and must not be stored as one.
  assert.ok(
    !("last_success_at" in row),
    "a tick with no snapshot must never report success",
  );
});

test("H3: a thrown health query stores the attempt, no success, and rethrows", async () => {
  const log = makeLogger();
  const { db, rows } = makeJobHealthDb();
  const at = Date.parse("2026-10-03T12:30:00.000Z");

  await assert.rejects(
    () =>
      runHealthMonitorTick(
        log,
        async () => {
          throw new Error("worker_health_query_failed: boom");
        },
        () => at,
        db,
      ),
    /worker_health_query_failed/,
  );

  const row = storedRow(rows);
  assert.ok(row, "a failed pass is still an attempt and must be recorded");
  assert.equal(row["last_run_at"], "2026-10-03T12:30:00.000Z");
  assert.ok(
    !("last_success_at" in row),
    "a pass that threw must never report success",
  );
});

test("H4: a failed pass does not refresh a stored last_success_at", async () => {
  const log = makeLogger();
  const { db, rows } = makeJobHealthDb();
  const t1 = Date.parse("2026-10-03T13:00:00.000Z");
  const t2 = Date.parse("2026-10-03T13:15:00.000Z");

  await runHealthMonitorTick(log, async () => makeHealth(), () => t1, db);
  assert.equal(storedRow(rows)?.["last_success_at"], "2026-10-03T13:00:00.000Z");

  await runHealthMonitorTick(log, async () => null, () => t2, db);

  const row = storedRow(rows);
  assert.ok(row);
  // The attempt moved; the success did not. A monitor that stopped working
  // therefore ages out of "healthy" instead of renewing itself.
  assert.equal(row["last_run_at"], "2026-10-03T13:15:00.000Z");
  assert.equal(row["last_success_at"], "2026-10-03T13:00:00.000Z");
});

test("H5: a pass that emitted warnings is still the monitor succeeding", async () => {
  const log = makeLogger();
  const { db, rows } = makeJobHealthDb();
  const at = Date.parse("2026-10-03T14:00:00.000Z");
  const health = makeHealth({
    stuck_jobs: [
      { id: "j1", catalog_id: "c1", locked_by: null, locked_until: null, updated_at: null },
    ],
  });

  const emitted = await runHealthMonitorTick(log, async () => health, () => at, db);
  assert.equal(emitted.length, 1, "the finding itself is unchanged by this row");

  const row = storedRow(rows);
  assert.ok(row);
  // The warning is a finding about the WORKER. The monitor read and evaluated
  // the snapshot, so the monitor's own pass succeeded.
  assert.equal(row["last_success_at"], "2026-10-03T14:00:00.000Z");
});

test("H6: a persistence failure is logged, not thrown or dropped", async () => {
  const log = makeLogger();
  const { db, rows } = makeJobHealthDb({ message: "relation \"job_health\" does not exist" });
  const at = Date.parse("2026-10-03T15:00:00.000Z");

  const emitted = await runHealthMonitorTick(log, async () => makeHealth(), () => at, db);
  assert.equal(emitted.length, 0, "the pass itself still completes");
  assert.equal(storedRow(rows), undefined, "nothing was stored");
  // supabase-js RESOLVES on a database error. If the `{ error }` were not
  // inspected, the row would silently not exist and nothing would say so.
  const persistWarnings = log.warnings.filter((w) =>
    w.msg.includes("could not persist job health"),
  );
  assert.equal(persistWarnings.length, 1);
  assert.equal(persistWarnings[0]!.details["job"], "stamp_health_monitor");
  assert.match(String(persistWarnings[0]!.details["err"]), /job_health/);
});
