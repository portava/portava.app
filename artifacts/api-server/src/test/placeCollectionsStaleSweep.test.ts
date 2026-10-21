/**
 * census-highlights-memories (wave 5, 2026-10-17) — the hourly overdue sweep,
 * on the live schema.
 *
 * Run: node --import tsx/esm --test src/test/placeCollectionsStaleSweep.test.ts
 *
 * HISTORY. runStaleSweep (lib/places/placeCollectionsWorker.ts) first read
 * `place_living_cache.select("place_id, places!inner(post_count)")`. `places`
 * has no post_count, so PostgREST failed the read with 42703 and the sweep
 * re-queued nothing (found by test/schemaColumnProductionScan.test.ts, class A).
 * The fix read activity from posts and examined the 200 most recently stale
 * living caches. The owner then ruled (2026-10-17, "Place-collection refresh
 * limit") that the longest-waiting places go first, in paginated batches, busy
 * ones first without starving quiet ones. The sweep now walks place_best_of
 * — the collections it refreshes — oldest-first in keyset pages; why that table
 * and not place_living_cache is in the worker's sweep header.
 *
 * THIS FILE proves the sweep on schemaStrictSupabase, whose tables are the live
 * schema's: no statement names a column production lacks, on every query the
 * walk makes (the count, the first page, and a second page's tie and later
 * reads). Behaviour in depth — key order, lanes, bounds, drain, metrics — is in
 * placeCollectionsBacklogSweep.test.ts, on a database that models ordering on
 * two keys. This double keeps only the LAST order key, so the ids below sort
 * the same way as their ages.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeSchemaStrictClient, type Seed, type Row } from "./helpers/schemaStrictSupabase.js";
import { runStaleSweep } from "../lib/places/placeCollectionsWorker.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();
// Older place ⇒ smaller id, so the double's one-key order agrees with the age order.
const pid = (i: number) => `a${String(i).padStart(7, "0")}-0000-4000-a000-000000000000`;

function posts(placeId: string, n: number, status = "active"): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${placeId}-${status}-${i}`, canonical_place_id: placeId, status }));
}

const BUSY = pid(1);
const QUIET = pid(2);
const FRESH_BUSY = pid(9_000_000);

function world(extraOverdue = 0): Seed {
  return {
    place_best_of: [
      { place_id: BUSY, updated_at: ago(9) },
      { place_id: QUIET, updated_at: ago(8) },
      ...Array.from({ length: extraOverdue }, (_, i) => ({ place_id: pid(10 + i), updated_at: ago(7.5 - i / 10_000) })),
      { place_id: FRESH_BUSY, updated_at: ago(1) },
    ],
    posts: [...posts(BUSY, 21), ...posts(QUIET, 3), ...posts(QUIET, 40, "deleted"), ...posts(FRESH_BUSY, 50)],
    place_cache_invalidation_queue: [],
  };
}

const queued = (strict: ReturnType<typeof makeSchemaStrictClient>) =>
  strict.writes.filter((w) => w.table === "place_cache_invalidation_queue").flatMap((w) => w.rows);

describe("schema-strict: runStaleSweep walks overdue place collections", () => {
  it("re-queues every overdue place, busy and quiet, as pending; a fresh one is not examined", async () => {
    const strict = makeSchemaStrictClient(world());
    const r = await runStaleSweep(strict, { now: NOW });
    assert.equal(r.backlog, 2);
    assert.equal(r.requeued, 2);
    assert.deepEqual(queued(strict).map((q) => [q.place_id, q.status]), [[BUSY, "pending"], [QUIET, "pending"]]);
    assert.ok(!queued(strict).some((q) => q.place_id === FRESH_BUSY), "rebuilt an hour ago");
  });

  it("names no column the live schema lacks — the count, the first page and a second page's tie and later reads", async () => {
    const strict = makeSchemaStrictClient(world(150));
    const r = await runStaleSweep(strict, { now: NOW });
    assert.ok(r.pagesRead >= 2, `a second keyset page was read (${r.pagesRead})`);
    assert.equal(r.requeued, 152);
    assert.deepEqual(strict.deadColumnErrors, []);
  });

  it("a place whose activity cannot be read is counted and ranked with the quiet ones, never promoted", async () => {
    const strict = makeSchemaStrictClient(world(150));
    const failingPosts = {
      from: (t: string) => (t === "posts"
        ? { select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) }) }) }) }
        : strict.from(t)),
    };
    const r = await runStaleSweep(failingPosts, { now: NOW });
    // Budget 200, aging lane 100: the other 52 are traffic candidates whose activity is unreadable.
    assert.equal(r.failures.activityUnreadable, 52);
    assert.equal(r.selected.filter((s) => s.lane === "traffic").length, 0);
    assert.equal(r.requeued, 152, "quiet places are refreshed too, so nothing waits on the unreadable signal");
  });

  it("a place already pending or processing is left to the drain", async () => {
    const seed = world();
    seed.place_cache_invalidation_queue = [
      { place_id: BUSY, status: "processing", queued_at: ago(0.1), locked_until: ago(-0.05), locked_by: "w" },
    ];
    const strict = makeSchemaStrictClient(seed);
    const r = await runStaleSweep(strict, { now: NOW });
    assert.equal(r.inFlight, 1);
    assert.deepEqual(queued(strict).map((q) => q.place_id), [QUIET]);
  });

  it("the longest-waiting places go first: of 702 overdue, the newest 102 wait for the next run", async () => {
    const strict = makeSchemaStrictClient(world(700));
    const r = await runStaleSweep(strict, { now: NOW });
    assert.equal(r.requeued, 600);
    const ids = queued(strict).map((q) => q.place_id);
    assert.ok(ids.includes(BUSY) && ids.includes(QUIET), "the two oldest");
    assert.ok(!ids.includes(pid(10 + 699)), "the newest");
    assert.equal(r.backlogRemains, true);
  });
});
