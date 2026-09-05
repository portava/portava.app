/**
 * Tests for the place collections precompute worker.
 *
 * Covers:
 *   A. placePostScore — engagement formula weights.
 *   B. runCollectionsTick — queue claim + release cycle (fake client).
 *      Queue key is place_id (PK), not a separate id column.
 *   C. runCollectionsTick — stale-lock sweeper does not crash with no stuck rows.
 *   D. Contributor stamp threshold logic — fires for each threshold crossed,
 *      uses contribution_count (canonical field name), stamp failure is non-fatal.
 *   E. runStaleSweep — re-queues stale living-cache rows.
 *   F. runCollectionsTick — empty queue is a no-op.
 *
 * Run: node --import tsx/esm --test src/test/placeCollectionsWorker.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { placePostScore } from "../lib/places/placeCollections.js";
import {
  runCollectionsTick,
  runStaleSweep,
  _setTestAwardStamp,
} from "../lib/places/placeCollectionsWorker.js";

// ── A. placePostScore ─────────────────────────────────────────────────────────

describe("A. placePostScore — engagement formula", () => {
  it("returns 0 for all-null post", () => {
    assert.strictEqual(placePostScore({}), 0);
  });

  it("applies correct weights for each field", () => {
    assert.strictEqual(placePostScore({ like_count: 100 }),           35);  // ×0.35
    assert.strictEqual(placePostScore({ save_count: 100 }),           30);  // ×0.30
    assert.strictEqual(placePostScore({ share_count: 100 }),          20);  // ×0.20
    assert.strictEqual(placePostScore({ view_count: 100 }),           10);  // ×0.10
    assert.strictEqual(placePostScore({ qualified_view_count: 100 }), 5);   // ×0.05
  });

  it("sums all fields correctly (100 each → score 100)", () => {
    const score = placePostScore({
      like_count: 100, save_count: 100, share_count: 100,
      view_count: 100, qualified_view_count: 100,
    });
    assert.strictEqual(score, 100);
  });

  it("treats null values as 0", () => {
    // share_count 10 × 0.20 = 2
    assert.strictEqual(placePostScore({ like_count: null, save_count: null, share_count: 10 }), 2);
  });

  it("likes score higher than equal view count", () => {
    const byLike = placePostScore({ like_count: 10 });
    const byView = placePostScore({ view_count: 10 });
    assert.ok(byLike > byView, `expected ${byLike} > ${byView}`);
  });
});

// ── Fake client ───────────────────────────────────────────────────────────────

const PLACE_ID = "aaaaaaaa-0000-0000-0000-000000000001";

interface FakeRow { [key: string]: any }

/**
 * Minimal fake Supabase client for worker tests.
 *
 * Queue rows use place_id as primary key (matches 2047 canonical schema).
 * The fake mutates currentQueueRows when update/in/eq calls are applied.
 *
 * Supports the PostgREST filter operators used by the worker:
 *   .eq()    — exact match
 *   .in()    — set membership
 *   .or()    — currently: parses "locked_until.is.null,locked_until.lt.X" for
 *              the lock-expiry guard; unknown .or() strings are treated as pass-all
 *   .lt()    — less-than (for stale-lock timestamps)
 *   .select() after .update() — RETURNING simulation (returns matched rows)
 */
function makeFakeSc(opts: {
  queueRows?:       FakeRow[];
  postRows?:        FakeRow[];
  staleCacheRows?:  FakeRow[];
  capturedUpserts?: Array<{ table: string; row: any }>;
  capturedUpdates?: Array<{ table: string; patch: any }>;
}) {
  const postRows        = opts.postRows       ?? [];
  const staleCacheRows  = opts.staleCacheRows ?? [];
  const capturedUpserts = opts.capturedUpserts ?? [];
  const capturedUpdates = opts.capturedUpdates ?? [];

  // Mutable queue state so claim/done transitions are observable.
  let currentQueueRows: FakeRow[] = [...(opts.queueRows ?? [])];

  return {
    // Expose queue state so tests can inspect it mid-run.
    _getQueueRows() { return currentQueueRows; },

    from(table: string) {
      let _patch: any   = null;
      let _filters: Array<(r: any) => boolean> = [];
      let _statusEq: string | undefined;
      let _wantsSelect = false;
      let _isDelete = false;

      const builder: any = {
        select(_cols?: string) {
          if (_patch != null) _wantsSelect = true; // RETURNING mode
          return builder;
        },
        upsert(row: any, _opts?: any) {
          capturedUpserts.push({ table, row });
          if (table === "place_cache_invalidation_queue") {
            const idx = currentQueueRows.findIndex((r) => r.place_id === row.place_id);
            if (idx >= 0) { currentQueueRows[idx] = { ...currentQueueRows[idx], ...row }; }
            else          { currentQueueRows.push({ ...row }); }
          }
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: any) { _patch = patch; return builder; },
        // computeContributors prunes place_top_contributors rows the gated
        // recompute no longer credits: .delete().eq(place_id).not(user_id,in,…).
        // Recorded, not applied — this file asserts on the upserts.
        delete() { _isDelete = true; return builder; },
        not(_col: string, _op: string, _val: any) { return builder; },
        eq(col: string, val: any) {
          if (col === "status") _statusEq = val;
          _filters.push((r: any) => r[col] === val);
          return builder;
        },
        in(_col: string, vals: any[]) {
          _filters.push((r: any) => vals.includes(r[_col]));
          return builder;
        },
        // Parse the lock-expiry .or() used by the claim query:
        //   "locked_until.is.null,locked_until.lt.<iso>"
        // Rows with null locked_until OR expired locked_until pass the filter.
        or(expr: string) {
          if (expr.includes("locked_until.is.null")) {
            const ltMatch = expr.match(/locked_until\.lt\.([^\s,]+)/);
            const cutoff  = ltMatch ? ltMatch[1] : null;
            _filters.push((r: any) =>
              r.locked_until == null ||
              (cutoff != null && r.locked_until < cutoff),
            );
          }
          // Unknown .or() expressions are treated as pass-all (no filter added).
          return builder;
        },
        lt(col: string, val: any) {
          _filters.push((r: any) => r[col] != null && r[col] < val);
          return builder;
        },
        gt()    { return builder; },
        gte()   { return builder; },
        order() { return builder; },
        limit(n: number) {
          if (table === "place_cache_invalidation_queue") {
            // For the claim SELECT: apply all accumulated filters.
            const filtered = currentQueueRows.filter((r) => _filters.every((f) => f(r)));
            return Promise.resolve({ data: filtered.slice(0, n), error: null });
          }
          if (table === "posts") {
            return Promise.resolve({ data: postRows, error: null });
          }
          if (table === "place_living_cache") {
            return Promise.resolve({ data: staleCacheRows, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        // Resolves UPDATE chains (with or without .select() RETURNING).
        then(resolve: (v: any) => any) {
          if (_isDelete) return resolve({ data: null, error: null });
          if (table === "place_cache_invalidation_queue" && _patch) {
            // Identify rows matching all filters before mutation.
            const matched = currentQueueRows.filter((r) => _filters.every((f) => f(r)));
            // Apply the patch in-place.
            currentQueueRows = currentQueueRows.map((r) =>
              _filters.every((f) => f(r)) ? { ...r, ..._patch } : r,
            );
            capturedUpdates.push({ table, patch: _patch });

            if (_wantsSelect) {
              // RETURNING: matched rows with patch applied.
              return resolve({ data: matched.map((r) => ({ ...r, ..._patch })), error: null });
            }
          }
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

// ── B. runCollectionsTick — queue claim + release ─────────────────────────────

describe("B. runCollectionsTick — queue claim + release", () => {
  beforeEach(() => {
    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));
  });
  afterEach(() => { _setTestAwardStamp(null); });

  it("claims a pending row and upserts place_best_of", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending", queued_at: new Date().toISOString() }],
      postRows:  [{ id: "p1", author_id: "u1", media_type: "photo", like_count: 5,
                    save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
                    post_buckets: [], content: null }],
      capturedUpserts,
    });

    const result = await runCollectionsTick(sc);

    assert.strictEqual(result.claimed,   1);
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.errors,    0);

    const bestOf = capturedUpserts.find((u) => u.table === "place_best_of");
    assert.ok(bestOf, "Expected place_best_of upsert");
    assert.strictEqual(bestOf.row.place_id, PLACE_ID);
  });

  it("returns zero claimed when queue is empty", async () => {
    const sc = makeFakeSc({ queueRows: [] });
    const result = await runCollectionsTick(sc);
    assert.strictEqual(result.claimed,   0);
    assert.strictEqual(result.processed, 0);
  });

  it("categorizes video posts into top_videos", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows:  [{ id: "v1", author_id: "u1", media_type: "video", like_count: 10,
                    save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
                    post_buckets: [], content: null }],
      capturedUpserts,
    });

    await runCollectionsTick(sc);

    const bestOf = capturedUpserts.find((u) => u.table === "place_best_of");
    assert.ok(bestOf);
    assert.strictEqual(bestOf.row.top_videos.length, 1);
    assert.strictEqual(bestOf.row.top_photos.length, 0);
  });

  it("categorizes hidden_angles bucket posts into top_viewpoints", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows:  [{ id: "vp1", author_id: "u1", media_type: "photo", like_count: 5,
                    post_buckets: ["hidden_angles"], save_count: 0, share_count: 0,
                    view_count: 0, qualified_view_count: 0, content: null }],
      capturedUpserts,
    });

    await runCollectionsTick(sc);

    const bestOf = capturedUpserts.find((u) => u.table === "place_best_of");
    assert.ok(bestOf);
    assert.strictEqual(bestOf.row.top_viewpoints.length, 1);
    assert.strictEqual(bestOf.row.top_photos.length,     0);
  });
});

// ── C. Stale-lock sweeper ─────────────────────────────────────────────────────

describe("C. runCollectionsTick — stale-lock sweeper runs before claiming", () => {
  beforeEach(() => {
    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));
  });
  afterEach(() => { _setTestAwardStamp(null); });

  it("does not crash when there are no stuck rows", async () => {
    const sc = makeFakeSc({ queueRows: [] });
    const result = await runCollectionsTick(sc);
    assert.strictEqual(result.errors, 0);
  });
});

// ── D. Contributor stamp threshold logic ──────────────────────────────────────

describe("D. Contributor stamp threshold logic", () => {
  afterEach(() => { _setTestAwardStamp(null); });

  it("writes contribution_count (not post_count) to place_top_contributors", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));

    const postRows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, author_id: "u1", media_type: "photo", like_count: 0,
      save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
      post_buckets: [], content: null,
    }));

    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows,
      capturedUpserts,
    });

    await runCollectionsTick(sc);

    const contrib = capturedUpserts.find((u) => u.table === "place_top_contributors");
    assert.ok(contrib, "Expected place_top_contributors upsert");
    // Must use canonical field name from 2047 schema
    assert.ok("contribution_count" in contrib.row, "Expected contribution_count field");
    assert.ok(!("post_count" in contrib.row),       "Must not write post_count (wrong field)");
    assert.ok(!("rank" in contrib.row),              "Must not write rank (no such column)");
  });

  it("calls awardStamp for each threshold a contributor has crossed", async () => {
    const awardCalls: Array<{ userId: string; threshold: number }> = [];
    _setTestAwardStamp(async (_sc, input) => {
      awardCalls.push({ userId: input.userId, threshold: input.metadata?.threshold as number });
      return { awarded: true, reason: "test" };
    });

    // 55 posts → crosses thresholds 10 and 50 (not 100)
    const postRows = Array.from({ length: 55 }, (_, i) => ({
      id: `p${i}`, author_id: "contributor-a", media_type: "photo", like_count: 1,
      save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
      post_buckets: [], content: null,
    }));

    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows,
    });

    await runCollectionsTick(sc);

    const thresholds = awardCalls.map((c) => c.threshold).sort((a, b) => a - b);
    assert.deepStrictEqual(thresholds, [10, 50]);
  });

  it("does not call awardStamp when contributor has fewer than 10 posts", async () => {
    const awardCalls: Array<any> = [];
    _setTestAwardStamp(async (_sc, input) => {
      awardCalls.push(input);
      return { awarded: false, reason: "test" };
    });

    const postRows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`, author_id: "contributor-low", media_type: "photo", like_count: 0,
      save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
      post_buckets: [], content: null,
    }));

    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows,
    });

    await runCollectionsTick(sc);
    assert.strictEqual(awardCalls.length, 0);
  });

  it("calls awardStamp for all three thresholds when contributor has 100+ posts", async () => {
    const awardCalls: Array<{ threshold: number }> = [];
    _setTestAwardStamp(async (_sc, input) => {
      awardCalls.push({ threshold: input.metadata?.threshold as number });
      return { awarded: true, reason: "test" };
    });

    const postRows = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`, author_id: "top-contributor", media_type: "photo", like_count: 1,
      save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
      post_buckets: [], content: null,
    }));

    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows,
    });

    await runCollectionsTick(sc);

    const thresholds = awardCalls.map((c) => c.threshold).sort((a, b) => a - b);
    assert.deepStrictEqual(thresholds, [10, 50, 100]);
  });

  it("stamp failure does not abort the best-of write", async () => {
    _setTestAwardStamp(async () => { throw new Error("stamp service unavailable"); });

    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const postRows = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`, author_id: "u-stamp-fail", media_type: "photo", like_count: 1,
      save_count: 0, share_count: 0, view_count: 0, qualified_view_count: 0,
      post_buckets: [], content: null,
    }));

    const sc = makeFakeSc({
      queueRows: [{ place_id: PLACE_ID, status: "pending" }],
      postRows,
      capturedUpserts,
    });

    const result = await runCollectionsTick(sc);

    assert.strictEqual(result.errors, 0, "stamp failure must not count as a tick error");
    const bestOf = capturedUpserts.find((u) => u.table === "place_best_of");
    assert.ok(bestOf, "place_best_of must still be written despite stamp failure");
  });
});

// ── E. runStaleSweep ──────────────────────────────────────────────────────────

describe("E. runStaleSweep — re-queues stale living-cache rows", () => {
  it("returns requeued=0 when no stale rows exist", async () => {
    const sc = makeFakeSc({ staleCacheRows: [] });
    const result = await runStaleSweep(sc);
    assert.strictEqual(result.requeued, 0);
  });

  it("upserts stale place_ids into the invalidation queue with status=pending", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({
      staleCacheRows: [{ place_id: PLACE_ID, cached_at: new Date(0).toISOString() }],
      capturedUpserts,
    });

    const result = await runStaleSweep(sc);

    assert.strictEqual(result.requeued, 1);
    const queued = capturedUpserts.find((u) => u.table === "place_cache_invalidation_queue");
    assert.ok(queued, "Expected place_cache_invalidation_queue upsert");
    assert.strictEqual(queued.row.place_id, PLACE_ID);
    assert.strictEqual(queued.row.status,   "pending");
  });
});

// ── F. runCollectionsTick — empty queue ──────────────────────────────────────

describe("F. runCollectionsTick — empty queue", () => {
  it("returns zeros and does not upsert anything", async () => {
    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({ queueRows: [], capturedUpserts });

    const result = await runCollectionsTick(sc);

    assert.strictEqual(result.claimed,         0);
    assert.strictEqual(result.processed,       0);
    assert.strictEqual(result.errors,          0);
    assert.strictEqual(capturedUpserts.length, 0);
  });
});

// ── G. Concurrency — two workers racing to claim the same row ─────────────────

describe("G. Concurrency — two workers race to claim the same pending row", () => {
  afterEach(() => { _setTestAwardStamp(null); });

  it("only the worker whose UPDATE ran first processes the row; the second processes nothing", async () => {
    // Shared mutable queue — both workers operate on the same rows array.
    // This simulates the serialization guarantee of a real DB: one UPDATE
    // wins the row (status transitions from 'pending' → 'processing'), and
    // the second UPDATE finds no matching 'pending' rows → RETURNING [].
    const sharedQueue: FakeRow[] = [
      { place_id: PLACE_ID, status: "pending", queued_at: new Date().toISOString() },
    ];

    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));

    // Build a fake client whose update-with-select (RETURNING) operates on
    // sharedQueue atomically: matched rows are patched in-place; the RETURNING
    // result reflects only those rows that were *actually* updated.
    function makeRacingClient(workerLabel: string) {
      const processed: string[] = [];

      const sc: any = {
        _processed: processed,
        from(table: string) {
          let _patch: any = null;
          let _filters: Array<(r: any) => boolean> = [];
          let _statusEq: string | undefined;
          let _wantsSelect = false;

          const builder: any = {
            select(_cols?: string) {
              if (_patch != null) _wantsSelect = true;
              return builder;
            },
            upsert() { return Promise.resolve({ data: null, error: null }); },
            update(patch: any) { _patch = patch; return builder; },
            eq(col: string, val: any) {
              if (col === "status") _statusEq = val;
              _filters.push((r: any) => r[col] === val);
              return builder;
            },
            in(_col: string, vals: any[]) {
              _filters.push((r: any) => vals.includes(r[_col]));
              return builder;
            },
            or(expr: string) {
              if (expr.includes("locked_until.is.null")) {
                const ltMatch = expr.match(/locked_until\.lt\.([^\s,]+)/);
                const cutoff  = ltMatch ? ltMatch[1] : null;
                _filters.push((r: any) =>
                  r.locked_until == null || (cutoff != null && r.locked_until < cutoff),
                );
              }
              return builder;
            },
            lt()    { return builder; },
            order() { return builder; },
            limit(n: number) {
              if (table === "place_cache_invalidation_queue") {
                const rows = sharedQueue.filter((r) => _filters.every((f) => f(r)));
                return Promise.resolve({ data: rows.slice(0, n), error: null });
              }
              if (table === "posts") {
                // Track that this worker reached the processing step.
                processed.push(workerLabel);
                return Promise.resolve({ data: [], error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
            then(resolve: (v: any) => any) {
              if (table === "place_cache_invalidation_queue" && _patch) {
                // Identify rows matching all filters (before mutation).
                const matched = sharedQueue.filter((r) => _filters.every((f) => f(r)));
                // Apply patch in-place (shared state — simulates DB atomicity).
                for (let i = 0; i < sharedQueue.length; i++) {
                  if (_filters.every((f) => f(sharedQueue[i]!))) {
                    sharedQueue[i] = { ...sharedQueue[i], ..._patch };
                  }
                }
                if (_wantsSelect) {
                  // RETURNING: only rows that matched at time of UPDATE.
                  const returned = matched.map((r) => ({ ...r, ..._patch }));
                  return resolve({ data: returned, error: null });
                }
              }
              return resolve({ data: null, error: null });
            },
          };
          return builder;
        },
      };
      return sc;
    }

    const scA = makeRacingClient("workerA");
    const scB = makeRacingClient("workerB");

    const [resultA, resultB] = await Promise.all([
      runCollectionsTick(scA),
      runCollectionsTick(scB),
    ]);

    const totalClaimed    = resultA.claimed   + resultB.claimed;
    const totalProcessed  = resultA.processed + resultB.processed;

    assert.strictEqual(totalClaimed,   1, `Expected exactly 1 claimed row, got A=${resultA.claimed} B=${resultB.claimed}`);
    assert.strictEqual(totalProcessed, 1, `Expected exactly 1 processed row, got A=${resultA.processed} B=${resultB.processed}`);

    // The queue row must end in 'done' — not stuck in 'processing'.
    const finalRow = sharedQueue.find((r) => r.place_id === PLACE_ID);
    assert.strictEqual(finalRow?.status, "done", "Queue row must be marked done by the winning worker");
  });
});

// ── H. Mid-flight invalidation — enqueue during processing ────────────────────

describe("H. Mid-flight invalidation: enqueue during processing preserves re-queue signal", () => {
  afterEach(() => { _setTestAwardStamp(null); });

  it("mark-done skips when queued_at changed mid-flight, leaving row pending for next tick", async () => {
    // The row starts as claimed (processing) with a specific queued_at.
    // During processing, a new invalidation arrives (simulated by the upsert
    // changing queued_at on the shared queue row).  The worker's mark-done
    // checks queued_at = claimedQueuedAt — the mismatch leaves the row pending.
    const ORIGINAL_QUEUED_AT = "2026-07-28T00:00:00.000Z";
    const NEW_QUEUED_AT      = "2026-07-28T00:05:00.000Z"; // arrived during processing

    // Queue row already in 'processing' state (simulates the moment after claim).
    // We pass it through runCollectionsTick which will re-claim nothing
    // (status=processing, not pending) — instead we directly test processPlace
    // by setting up a row that the claim UPDATE will return as claimed but
    // whose queued_at will be updated by an interleaved upsert.

    // Strategy: give the fake client a queue row that is 'pending' but whose
    // queued_at will be mutated by the upsert() call that fires when
    // enqueue() is called mid-processing (simulated by a custom postRows hook).
    const sharedQueue: FakeRow[] = [
      { place_id: PLACE_ID, status: "pending", queued_at: ORIGINAL_QUEUED_AT, locked_until: null, locked_by: null },
    ];

    let postsFetchCount = 0;

    // Build a client where fetching posts triggers a mid-flight enqueue (upsert
    // that changes queued_at), simulating a concurrent post-creation event.
    const sc: any = {
      from(table: string) {
        let _patch: any = null;
        let _filters: Array<(r: any) => boolean> = [];
        let _wantsSelect = false;

        const builder: any = {
          select(_cols?: string) { if (_patch != null) _wantsSelect = true; return builder; },
          upsert(row: any) {
            if (table === "place_cache_invalidation_queue") {
              const idx = sharedQueue.findIndex((r) => r.place_id === row.place_id);
              if (idx >= 0) sharedQueue[idx] = { ...sharedQueue[idx], ...row };
              else          sharedQueue.push({ ...row });
            }
            return Promise.resolve({ data: null, error: null });
          },
          update(patch: any) { _patch = patch; return builder; },
          eq(col: string, val: any) { _filters.push((r: any) => r[col] === val); return builder; },
          in(_col: string, vals: any[]) { _filters.push((r: any) => vals.includes(r[_col])); return builder; },
          or(expr: string) {
            if (expr.includes("locked_until.is.null")) {
              const ltMatch = expr.match(/locked_until\.lt\.([^\s,]+)/);
              const cutoff  = ltMatch ? ltMatch[1] : null;
              _filters.push((r: any) =>
                r.locked_until == null || (cutoff != null && r.locked_until < cutoff),
              );
            }
            return builder;
          },
          lt() { return builder; },
          order() { return builder; },
          limit(n: number) {
            if (table === "place_cache_invalidation_queue") {
              const matched = sharedQueue.filter((r) => _filters.every((f) => f(r)));
              return Promise.resolve({ data: matched.slice(0, n), error: null });
            }
            if (table === "posts") {
              postsFetchCount++;
              if (postsFetchCount === 1) {
                // Mid-flight: simulate a new post arriving — re-enqueue with fresh queued_at.
                const idx = sharedQueue.findIndex((r) => r.place_id === PLACE_ID);
                if (idx >= 0) sharedQueue[idx] = { ...sharedQueue[idx], queued_at: NEW_QUEUED_AT, status: "pending" };
              }
              return Promise.resolve({ data: [], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          },
          then(resolve: (v: any) => any) {
            if (table === "place_cache_invalidation_queue" && _patch) {
              const matched = sharedQueue.filter((r) => _filters.every((f) => f(r)));
              for (let i = 0; i < sharedQueue.length; i++) {
                if (_filters.every((f) => f(sharedQueue[i]!))) {
                  sharedQueue[i] = { ...sharedQueue[i], ..._patch };
                }
              }
              if (_wantsSelect) {
                return resolve({ data: matched.map((r) => ({ ...r, ..._patch })), error: null });
              }
            }
            return resolve({ data: null, error: null });
          },
        };
        return builder;
      },
    };

    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));

    await runCollectionsTick(sc);

    // The mid-flight upsert changed queued_at, so mark-done's queued_at check
    // found a mismatch. The row must NOT be 'done'; it stays 'pending' so the
    // next tick will re-process it (the new invalidation is preserved).
    const finalRow = sharedQueue.find((r) => r.place_id === PLACE_ID);
    assert.ok(finalRow, "Queue row must still exist");
    assert.notStrictEqual(finalRow?.status, "done",
      "Row must not be marked done when a mid-flight invalidation changed queued_at");
    assert.strictEqual(finalRow?.queued_at, NEW_QUEUED_AT,
      "Row must retain the new queued_at so the next tick re-processes it");
  });
});

// ── I. Sweep collides with processing — lock-expiry guard prevents re-claim ───

describe("I. Sweep collides with processing — lock guard blocks immediate re-claim", () => {
  afterEach(() => { _setTestAwardStamp(null); });

  it("a row reset to pending by the stale sweep while under an active lock is not re-claimed before the lock expires", async () => {
    // A row is 'processing' with a lock expiring in 5 minutes (active lock).
    // The stale sweep fires (triggered by a stale place_living_cache entry) and
    // unconditionally upserts status='pending' on the queue row.
    // The claim query must NOT pick it up because locked_until > now.

    const futurelock = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const queueRows: FakeRow[] = [
      {
        place_id:     PLACE_ID,
        status:       "processing",
        queued_at:    "2026-07-28T00:00:00.000Z",
        locked_until: futurelock,
        locked_by:    "other-worker",
      },
    ];

    // runStaleSweep scans place_living_cache for rows older than 6h, then upserts
    // those place_ids into the invalidation queue with status='pending'.
    // Provide a stale cache entry so the sweep actually fires the upsert.
    const staleCacheRows: FakeRow[] = [
      { place_id: PLACE_ID, cached_at: new Date(0).toISOString() },
    ];

    const capturedUpserts: Array<{ table: string; row: any }> = [];
    const sc = makeFakeSc({ queueRows, staleCacheRows, capturedUpserts });

    // Sweep detects the stale cache entry and re-queues it, overwriting the
    // processing row's status with 'pending'.
    await runStaleSweep(sc);

    const afterSweep = sc._getQueueRows().find((r: FakeRow) => r.place_id === PLACE_ID);
    assert.strictEqual(afterSweep?.status, "pending", "Sweep must set status=pending");

    // Now run a tick — the claim query filters locked_until IS NULL OR < now.
    // Since locked_until is in the future, the row must NOT be claimed.
    _setTestAwardStamp(() => Promise.resolve({ awarded: false, reason: "test" }));
    const result = await runCollectionsTick(sc);

    assert.strictEqual(result.claimed, 0,
      "Claim must not pick up a pending row whose lock has not yet expired");

    // The row must remain pending (not claimed, not processing again).
    const afterTick = sc._getQueueRows().find((r: FakeRow) => r.place_id === PLACE_ID);
    assert.strictEqual(afterTick?.status, "pending",
      "Row must stay pending until the lock expires and the stale-lock sweeper reclaims it");
  });
});
