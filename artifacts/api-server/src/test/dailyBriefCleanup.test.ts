/**
 * Unit tests for dailyBriefCleanup.ts
 *
 * Covers:
 *   G1–G8:   parseRetentionDays — default fallback, valid overrides, edge cases
 *   G9–G16:  parseIntervalHours — default fallback, fractional values, edge cases
 *   G17–G24: purgeOldBriefs — fake Supabase client, cutoff date math, error handling
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/dailyBriefCleanup.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetentionDays, parseIntervalHours, purgeOldBriefs } from "../lib/dailyBriefCleanup.js";

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
  let capturedLtValue: string | undefined;

  function from(table: string) {
    const builder: any = {
      delete(_opts?: any) { return builder; },
      lt(col: string, val: string) {
        capturedLtValue = val;
        calls.push({ table, ltValue: val });
        return builder;
      },
      then(onF: any, onR: any) {
        if (opts.throwOnDelete) {
          return Promise.reject(new Error("DB connection lost")).then(onF, onR);
        }
        return Promise.resolve({
          count: opts.count ?? 0,
          error: opts.error ?? null,
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
  it("G17: no client provided returns { deleted: null, error: null }", async () => {
    const result = await purgeOldBriefs({ client: undefined, retentionDays: 60 });
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
