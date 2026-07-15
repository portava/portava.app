/**
 * Unit tests for dailyBriefCleanup.ts
 *
 * Covers:
 *   G1–G8:   parseRetentionDays — default fallback, valid overrides, edge cases
 *   G9–G16:  parseIntervalHours — default fallback, fractional values, edge cases
 *   G17–G24: purgeOldBriefs — fake Supabase client, cutoff date math, error handling
 *   G25–G30: startDailyBriefCleanup — scheduler timing wiring via fake timers
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/dailyBriefCleanup.test.ts
 */
import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseRetentionDays,
  parseIntervalHours,
  purgeOldBriefs,
  computeCleanupStatus,
  getCleanupStatus,
  queryCleanupHealth,
  _setTestJobHealthClient,
} from "../lib/dailyBriefCleanup.js";

// Namespace import so we can read live bindings (_purgeCallCount is a `let`
// that increments on every purgeOldBriefs call; the namespace always reflects
// the current value, which is what the scheduler tests need).
import * as cleanup from "../lib/dailyBriefCleanup.js";

const { startDailyBriefCleanup, STARTUP_DELAY_MS, INTERVAL_MS } = cleanup;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake Supabase client that records the `lt` filter value
 * passed to daily_briefs delete and returns a configurable result.
 */
function makeFakeClient(opts: {
  count?: number;
  error?: { message: string } | null;
  throwOnDelete?: boolean;
} = {}) {
  const calls: { table: string; ltValue?: string }[] = [];
  // Capture the lt value only for the daily_briefs table so secondary
  // cleanup calls (e.g. suggestion-seen) don't overwrite it.
  let capturedLtValue: string | undefined;

  function from(table: string) {
    const isBriefs = table === "daily_briefs";
    const builder: any = {
      delete(_opts?: any) { return builder; },
      lt(_col: string, val: string) {
        if (isBriefs) capturedLtValue = val;
        calls.push({ table, ltValue: val });
        return builder;
      },
      then(onF: any, onR: any) {
        if (isBriefs && opts.throwOnDelete) {
          return Promise.reject(new Error("DB connection lost")).then(onF, onR);
        }
        return Promise.resolve({
          // Secondary cleanup tables always return 0 so they don't affect
          // the count assertions for the primary daily_briefs purge.
          count: isBriefs ? (opts.count ?? 0) : 0,
          error: isBriefs ? (opts.error ?? null) : null,
        }).then(onF, onR);
      },
    };
    return builder;
  }

  return {
    from,
    getCalls: () => calls,
    getCapturedLtValue: () => capturedLtValue,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// G1–G8: parseRetentionDays
// ══════════════════════════════════════════════════════════════════════════════

describe("G — parseRetentionDays", () => {
  it("G1: undefined input returns default 60", () => {
    assert.equal(parseRetentionDays(undefined), 60);
  });

  it("G2: empty string returns default 60", () => {
    assert.equal(parseRetentionDays(""), 60);
  });

  it("G3: non-numeric string returns default 60", () => {
    assert.equal(parseRetentionDays("abc"), 60);
  });

  it("G4: zero returns default 60", () => {
    assert.equal(parseRetentionDays("0"), 60);
  });

  it("G5: negative number returns default 60", () => {
    assert.equal(parseRetentionDays("-10"), 60);
  });

  it("G6: valid positive integer is honoured", () => {
    assert.equal(parseRetentionDays("30"), 30);
  });

  it("G7: large valid value is honoured", () => {
    assert.equal(parseRetentionDays("365"), 365);
  });

  it("G8: float string is truncated by parseInt (e.g. '45.9' → 45)", () => {
    assert.equal(parseRetentionDays("45.9"), 45);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G9–G16: parseIntervalHours
// ══════════════════════════════════════════════════════════════════════════════

describe("G — parseIntervalHours", () => {
  it("G9: undefined input returns default 24", () => {
    assert.equal(parseIntervalHours(undefined), 24);
  });

  it("G10: empty string returns default 24", () => {
    assert.equal(parseIntervalHours(""), 24);
  });

  it("G11: non-numeric string returns default 24", () => {
    assert.equal(parseIntervalHours("never"), 24);
  });

  it("G12: zero returns default 24", () => {
    assert.equal(parseIntervalHours("0"), 24);
  });

  it("G13: negative number returns default 24", () => {
    assert.equal(parseIntervalHours("-1"), 24);
  });

  it("G14: valid whole-number hours are honoured", () => {
    assert.equal(parseIntervalHours("12"), 12);
  });

  it("G15: fractional hours are preserved (0.5 → every 30 min)", () => {
    assert.equal(parseIntervalHours("0.5"), 0.5);
  });

  it("G16: fractional hours with multiple decimal places are preserved", () => {
    assert.equal(parseIntervalHours("1.25"), 1.25);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G17–G24: purgeOldBriefs
// ══════════════════════════════════════════════════════════════════════════════

describe("G — purgeOldBriefs", () => {
  it("G17: explicit null client returns { deleted: null, error: null } (skip path)", async () => {
    const result = await purgeOldBriefs({ client: null, retentionDays: 60 });
    assert.equal(result.deleted, null);
    assert.equal(result.error, null);
  });

  it("G18: successful delete returns correct deleted count", async () => {
    const client = makeFakeClient({ count: 7 });
    const result = await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(result.deleted, 7);
    assert.equal(result.error, null);
  });

  it("G19: zero deleted rows is reported correctly", async () => {
    const client = makeFakeClient({ count: 0 });
    const result = await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(result.deleted, 0);
    assert.equal(result.error, null);
  });

  it("G20: DB error is returned, not thrown", async () => {
    const client = makeFakeClient({ error: { message: "relation does not exist" } });
    const result = await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(result.deleted, null);
    assert.ok(result.error !== null);
  });

  it("G21: unexpected throw is caught and returned as error", async () => {
    const client = makeFakeClient({ throwOnDelete: true });
    const result = await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(result.deleted, null);
    assert.ok(result.error instanceof Error);
  });

  it("G22: cutoff date is N days before today (retention=1 → yesterday)", async () => {
    const client = makeFakeClient({ count: 0 });
    const before = new Date();
    before.setUTCDate(before.getUTCDate() - 1);
    const expectedCutoff = before.toISOString().slice(0, 10);

    await purgeOldBriefs({ client, retentionDays: 1 });

    const ltValue = client.getCapturedLtValue();
    assert.equal(ltValue, expectedCutoff);
  });

  it("G23: cutoff date respects custom retention of 30 days", async () => {
    const client = makeFakeClient({ count: 3 });
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 30);
    const expectedCutoff = cutoff.toISOString().slice(0, 10);

    const result = await purgeOldBriefs({ client, retentionDays: 30 });
    assert.equal(result.deleted, 3);
    assert.equal(client.getCapturedLtValue(), expectedCutoff);
  });

  it("G24: delete is called on the daily_briefs table", async () => {
    const client = makeFakeClient({ count: 1 });
    await purgeOldBriefs({ client, retentionDays: 60 });
    const calls = client.getCalls();
    assert.ok(calls.some((c) => c.table === "daily_briefs"));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G25–G30: startDailyBriefCleanup — scheduler timing wiring
//
// Uses node:test fake timers to control setTimeout/setInterval without real
// delays. The key invariant: purgeOldBriefs increments _purgeCallCount
// synchronously before any await, so ticking a fake timer immediately updates
// the counter with no additional await needed.
//
// In the test environment SUPABASE_URL/SERVICE_ROLE_KEY are unset, so every
// purgeOldBriefs call skips immediately (no network I/O) — the tests are
// purely about whether the scheduler wires up the timers correctly.
// ══════════════════════════════════════════════════════════════════════════════

describe("G — startDailyBriefCleanup scheduler", () => {
  let handle: ReturnType<typeof setInterval>;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  });

  afterEach(() => {
    clearInterval(handle);
    mock.timers.reset();
  });

  it("G25: returns a clearable interval handle", () => {
    handle = startDailyBriefCleanup();
    assert.doesNotThrow(() => clearInterval(handle));
  });

  it("G26: purge does not fire before STARTUP_DELAY_MS elapses", () => {
    const before = cleanup._purgeCallCount;
    handle = startDailyBriefCleanup();
    mock.timers.tick(STARTUP_DELAY_MS - 1);
    assert.equal(cleanup._purgeCallCount, before);
  });

  it("G27: initial purge fires exactly once after STARTUP_DELAY_MS", () => {
    const before = cleanup._purgeCallCount;
    handle = startDailyBriefCleanup();
    mock.timers.tick(STARTUP_DELAY_MS);
    assert.equal(cleanup._purgeCallCount, before + 1);
  });

  it("G28: interval fires once more after STARTUP_DELAY_MS + INTERVAL_MS", () => {
    const before = cleanup._purgeCallCount;
    handle = startDailyBriefCleanup();
    // Tick past the initial delay and one full interval period.
    // Expected: initial timeout (1) + first interval tick (1) = 2 additional calls.
    mock.timers.tick(STARTUP_DELAY_MS + INTERVAL_MS);
    assert.equal(cleanup._purgeCallCount, before + 2);
  });

  it("G29: interval fires again after a second INTERVAL_MS", () => {
    const before = cleanup._purgeCallCount;
    handle = startDailyBriefCleanup();
    // Tick past the initial delay and two full interval periods.
    // Expected: initial timeout (1) + two interval ticks (2) = 3 additional calls.
    mock.timers.tick(STARTUP_DELAY_MS + INTERVAL_MS * 2);
    assert.equal(cleanup._purgeCallCount, before + 3);
  });

  it("G30: clearing the returned handle stops further interval fires", () => {
    handle = startDailyBriefCleanup();
    // Fire the initial delayed purge.
    mock.timers.tick(STARTUP_DELAY_MS);
    const afterInitial = cleanup._purgeCallCount;
    // Cancel the repeating interval.
    clearInterval(handle);
    // Tick through multiple interval periods — interval must not fire.
    mock.timers.tick(INTERVAL_MS * 3);
    assert.equal(cleanup._purgeCallCount, afterInitial);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G31–G35: computeCleanupStatus — threshold boundary classification
//
// INTERVAL_MS defaults to 24 h (86_400_000 ms) in test env.
// overdueMs  = INTERVAL_MS + 3_600_000  = 25 h (90_000_000 ms)
// criticalMs = 2 × INTERVAL_MS          = 48 h (172_800_000 ms)
//
// Timestamps are expressed as "N ms ago" relative to now to avoid relying on
// wall-clock dates in assertions.
// ══════════════════════════════════════════════════════════════════════════════

describe("G — computeCleanupStatus", () => {
  function minsAgo(mins: number): string {
    return new Date(Date.now() - mins * 60_000).toISOString();
  }

  it("G31: null lastRunAt → critical (job has never run)", () => {
    assert.equal(computeCleanupStatus(null), "critical");
  });

  it("G32: ran 1 h ago → ok (well within window)", () => {
    assert.equal(computeCleanupStatus(minsAgo(60)), "ok");
  });

  it("G33: ran 24 h 58 min ago → ok (just inside overdue boundary)", () => {
    assert.equal(computeCleanupStatus(minsAgo(24 * 60 + 58)), "ok");
  });

  it("G34: ran 26 h ago → overdue (past interval+grace, before 2×interval)", () => {
    assert.equal(computeCleanupStatus(minsAgo(26 * 60)), "overdue");
  });

  it("G35: ran 49 h ago → critical (past 2×interval)", () => {
    assert.equal(computeCleanupStatus(minsAgo(49 * 60)), "critical");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G36–G38: failure counter — increment on error, accumulate, reset on success
//
// Uses getCleanupStatus() to observe the in-memory _status object.
// Tests check deltas (before/after) rather than absolute values so they are
// order-independent within the suite.
// ══════════════════════════════════════════════════════════════════════════════

describe("G — failure counter", () => {
  it("G36: consecutiveFailures increments by 1 on each DB error", async () => {
    const before = getCleanupStatus().consecutiveFailures;
    const client = makeFakeClient({ error: { message: "timeout" } });
    await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(getCleanupStatus().consecutiveFailures, before + 1);
  });

  it("G37: consecutiveFailures accumulates across multiple consecutive errors", async () => {
    const before = getCleanupStatus().consecutiveFailures;
    const client = makeFakeClient({ error: { message: "timeout" } });
    await purgeOldBriefs({ client, retentionDays: 60 });
    await purgeOldBriefs({ client, retentionDays: 60 });
    assert.equal(getCleanupStatus().consecutiveFailures, before + 2);
  });

  it("G38: consecutiveFailures resets to 0 after a successful purge", async () => {
    // First cause at least one error to ensure counter > 0.
    const errClient = makeFakeClient({ error: { message: "fail" } });
    await purgeOldBriefs({ client: errClient, retentionDays: 60 });
    assert.ok(getCleanupStatus().consecutiveFailures > 0);

    // Now run a successful purge.
    const okClient = makeFakeClient({ count: 3 });
    await purgeOldBriefs({ client: okClient, retentionDays: 60 });
    assert.equal(getCleanupStatus().consecutiveFailures, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// G39–G43: queryCleanupHealth — classifies DB-backed timestamps correctly
//
// Uses _setTestJobHealthClient to inject a fake job_health table so the
// function can be tested without a live Supabase connection.
// ══════════════════════════════════════════════════════════════════════════════

describe("G — queryCleanupHealth", () => {
  function makeJobHealthClient(minsAgo: number | null) {
    return {
      from(_table: string) {
        const builder: any = {
          select() { return builder; },
          eq() { return builder; },
          maybeSingle() {
            if (minsAgo === null) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({
              data: { last_run_at: new Date(Date.now() - minsAgo * 60_000).toISOString() },
              error: null,
            });
          },
        };
        return builder;
      },
    };
  }

  afterEach(() => {
    _setTestJobHealthClient(null);
  });

  it("G39: no job_health row → cleanupStatus = 'critical', lastRunAt = null", async () => {
    _setTestJobHealthClient(makeJobHealthClient(null));
    const result = await queryCleanupHealth();
    assert.equal(result.cleanupStatus, "critical");
    assert.equal(result.lastRunAt, null);
  });

  it("G40: last_run_at 1 h ago → cleanupStatus = 'ok'", async () => {
    _setTestJobHealthClient(makeJobHealthClient(60));
    const result = await queryCleanupHealth();
    assert.equal(result.cleanupStatus, "ok");
    assert.ok(result.lastRunAt !== null);
  });

  it("G41: last_run_at 30 h ago → cleanupStatus = 'overdue'", async () => {
    _setTestJobHealthClient(makeJobHealthClient(30 * 60));
    const result = await queryCleanupHealth();
    assert.equal(result.cleanupStatus, "overdue");
  });

  it("G42: last_run_at 55 h ago → cleanupStatus = 'critical'", async () => {
    _setTestJobHealthClient(makeJobHealthClient(55 * 60));
    const result = await queryCleanupHealth();
    assert.equal(result.cleanupStatus, "critical");
  });

  it("G43: DB error → falls back to cleanupStatus = 'critical', lastRunAt = null", async () => {
    _setTestJobHealthClient({
      from(_table: string) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: null, error: { message: "permission denied" } }); },
        };
      },
    });
    const result = await queryCleanupHealth();
    assert.equal(result.cleanupStatus, "critical");
    assert.equal(result.lastRunAt, null);
  });
});
