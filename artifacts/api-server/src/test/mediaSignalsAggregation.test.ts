/**
 * mediaSignalsAggregation.test.ts
 *
 * Unit tests for loadMediaSignals — confirms that per-item
 * watchCompletionRate and rewatchRate are correctly aggregated from
 * rank_events rows.
 *
 * Run: node --import tsx/esm --test src/test/mediaSignalsAggregation.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadMediaSignals } from "../services/ranking/MediaFeedRankingService.js";

// ── Fake Supabase client builder ──────────────────────────────────────────────

/**
 * Builds a minimal fake SupabaseClient that returns the given rows when
 * .from("rank_events").select(...).in(...).in(...) is called.
 */
function fakeDb(rows: { item_id: string; event_type: string }[]): any {
  const builder = {
    _rows: rows,
    select(_cols: string) { return this; },
    in(_col: string, _vals: string[]) { return this; },
    then(resolve: (v: any) => any) {
      return Promise.resolve(resolve({ data: this._rows, error: null }));
    },
  };
  return {
    from(_table: string) { return builder; },
  };
}

/** Fake DB that simulates a Supabase error response. */
function errorDb(): any {
  const builder = {
    select(_cols: string) { return this; },
    in(_col: string, _vals: string[]) { return this; },
    then(resolve: (v: any) => any) {
      return Promise.resolve(resolve({ data: null, error: new Error("db error") }));
    },
  };
  return { from(_table: string) { return builder; } };
}

/** Fake DB that throws synchronously inside the query chain. */
function throwingDb(): any {
  return {
    from(_table: string): any {
      throw new Error("network failure");
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const POST_A = "aaaaaaaa-0000-4000-a000-000000000001";
const POST_B = "bbbbbbbb-0000-4000-a000-000000000002";
const POST_C = "cccccccc-0000-4000-a000-000000000003";

describe("loadMediaSignals — rank_events aggregation", () => {
  // ── Null / empty guard ────────────────────────────────────────────────────

  it("returns empty map when db is null", async () => {
    const result = await loadMediaSignals(null, [POST_A]);
    assert.equal(result.size, 0);
  });

  it("returns empty map when postIds is empty", async () => {
    const db = fakeDb([]);
    const result = await loadMediaSignals(db, []);
    assert.equal(result.size, 0);
  });

  // ── Basic rate calculations ───────────────────────────────────────────────

  it("computes correct watchCompletionRate and rewatchRate for a single post", async () => {
    // POST_A: 3 qualified views, 2 completions, 1 rewatch
    const rows = [
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_rewatch" },
    ];
    const db = fakeDb(rows);
    const result = await loadMediaSignals(db, [POST_A]);

    const signals = result.get(POST_A);
    assert.ok(signals, "signals should be set for POST_A");
    assert.ok(
      Math.abs((signals.watchCompletionRate ?? -1) - 2 / 3) < 1e-10,
      `watchCompletionRate should be 2/3, got ${signals.watchCompletionRate}`,
    );
    assert.ok(
      Math.abs((signals.rewatchRate ?? -1) - 1 / 3) < 1e-10,
      `rewatchRate should be 1/3, got ${signals.rewatchRate}`,
    );
  });

  it("computes rates independently for multiple posts", async () => {
    // POST_A: 4 qualified views, 4 completions, 0 rewatches  → 1.0, 0.0
    // POST_B: 2 qualified views, 1 completion,  2 rewatches  → 0.5, 1.0
    const rows = [
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_B, event_type: "watch_qualified_view" },
      { item_id: POST_B, event_type: "watch_qualified_view" },
      { item_id: POST_B, event_type: "watch_completion" },
      { item_id: POST_B, event_type: "watch_rewatch" },
      { item_id: POST_B, event_type: "watch_rewatch" },
    ];
    const db = fakeDb(rows);
    const result = await loadMediaSignals(db, [POST_A, POST_B, POST_C]);

    const a = result.get(POST_A);
    assert.ok(a, "should have signals for POST_A");
    assert.ok(Math.abs((a.watchCompletionRate ?? -1) - 1.0) < 1e-10, "POST_A completionRate should be 1.0");
    assert.ok(Math.abs((a.rewatchRate ?? -1) - 0.0) < 1e-10, "POST_A rewatchRate should be 0.0");

    const b = result.get(POST_B);
    assert.ok(b, "should have signals for POST_B");
    assert.ok(Math.abs((b.watchCompletionRate ?? -1) - 0.5) < 1e-10, "POST_B completionRate should be 0.5");
    assert.ok(Math.abs((b.rewatchRate ?? -1) - 1.0) < 1e-10, "POST_B rewatchRate should be 1.0");

    // POST_C has no events — should not appear in the result
    assert.equal(result.has(POST_C), false, "POST_C should not appear in result");
  });

  // ── No qualified-view anchor ──────────────────────────────────────────────

  it("sets null rates when there are completion rows but no qualified-view rows", async () => {
    // Completion rows exist but no watch_qualified_view → cannot compute rate
    const rows = [
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_rewatch" },
    ];
    const db = fakeDb(rows);
    const result = await loadMediaSignals(db, [POST_A]);

    const signals = result.get(POST_A);
    assert.ok(signals, "entry should still be set");
    assert.equal(signals.watchCompletionRate, null, "watchCompletionRate should be null");
    assert.equal(signals.rewatchRate, null, "rewatchRate should be null");
  });

  // ── Empty result set from DB ──────────────────────────────────────────────

  it("returns empty map when rank_events has no rows for the given postIds", async () => {
    const db = fakeDb([]);
    const result = await loadMediaSignals(db, [POST_A, POST_B]);
    assert.equal(result.size, 0);
  });

  // ── Error resilience ──────────────────────────────────────────────────────

  it("returns empty map and does not throw on a DB error response", async () => {
    const result = await loadMediaSignals(errorDb(), [POST_A]);
    assert.equal(result.size, 0);
  });

  it("returns empty map and does not throw when the DB client throws", async () => {
    const result = await loadMediaSignals(throwingDb(), [POST_A]);
    assert.equal(result.size, 0);
  });

  // ── Batch with a mix of zero and non-zero signals ─────────────────────────

  it("handles a three-item batch where one post has all three event types, one only qualified views, one nothing", async () => {
    // POST_A: 5 qualified, 3 completions, 2 rewatches
    // POST_B: 1 qualified, 0 completions, 0 rewatches → rates are 0/1 and 0/1
    // POST_C: no events
    const rows = [
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_qualified_view" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_completion" },
      { item_id: POST_A, event_type: "watch_rewatch" },
      { item_id: POST_A, event_type: "watch_rewatch" },
      { item_id: POST_B, event_type: "watch_qualified_view" },
    ];
    const db = fakeDb(rows);
    const result = await loadMediaSignals(db, [POST_A, POST_B, POST_C]);

    assert.equal(result.size, 2, "only posts with events should be in the map");

    const a = result.get(POST_A)!;
    assert.ok(Math.abs((a.watchCompletionRate ?? -1) - 3 / 5) < 1e-10);
    assert.ok(Math.abs((a.rewatchRate ?? -1) - 2 / 5) < 1e-10);

    const b = result.get(POST_B)!;
    assert.ok(Math.abs((b.watchCompletionRate ?? -1) - 0) < 1e-10);
    assert.ok(Math.abs((b.rewatchRate ?? -1) - 0) < 1e-10);

    assert.equal(result.has(POST_C), false);
  });
});
