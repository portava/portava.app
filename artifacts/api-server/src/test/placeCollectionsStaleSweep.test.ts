/**
 * census-highlights-memories (wave 5, 2026-10-17) — the hourly stale-cache sweep
 * re-queues busy places, counted from posts.
 *
 * Run: node --import tsx/esm --test src/test/placeCollectionsStaleSweep.test.ts
 *
 * THE DEFECT. runStaleSweep (lib/places/placeCollectionsWorker.ts) read
 * `place_living_cache.select("place_id, places!inner(post_count)")` and
 * filtered `.gt("places.post_count", 20)`. `places` has no post_count — no SQL
 * in the repository declares one, and production does not have one — so
 * PostgREST failed the read with 42703 and the sweep re-queued NOTHING, every
 * hour the worker ran (PLACE_COLLECTIONS_WORKER_ENABLED=true). A busy place's
 * living page went stale between invalidations. Found by
 * test/schemaColumnProductionScan.test.ts (class A).
 *
 * THE FIX. The activity signal is read from posts with the predicate the worker
 * already counts a place's posts by (canonical_place_id, status = 'active'), at
 * most 21 ids per place. Proven on schemaStrictSupabase, whose tables are the
 * live schema's:
 *   1. a stale cache row of a place with MORE than 20 active posts is re-queued
 *      (pending); 20 exactly is not; non-active posts do not count;
 *   2. a fresh cache row is not examined;
 *   3. no statement names a column the live schema lacks;
 *   4. a place whose activity cannot be read is skipped, never re-queued on a guess;
 *   5. the most recently stale rows are examined first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeSchemaStrictClient, type Seed, type Row } from "./helpers/schemaStrictSupabase.js";
import { runStaleSweep } from "../lib/places/placeCollectionsWorker.js";

const BUSY = "a1000000-0000-4000-a000-000000000001";
const EDGE = "a2000000-0000-4000-a000-000000000002";
const QUIET = "a3000000-0000-4000-a000-000000000003";
const FRESH_BUSY = "a4000000-0000-4000-a000-000000000004";
const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function posts(placeId: string, n: number, status = "active"): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${placeId}-${status}-${i}`, canonical_place_id: placeId, status }));
}

function world(): Seed {
  return {
    place_living_cache: [
      { place_id: BUSY, payload: {}, cached_at: ago(7), sparse: false },
      { place_id: EDGE, payload: {}, cached_at: ago(8), sparse: false },
      { place_id: QUIET, payload: {}, cached_at: ago(9), sparse: false },
      { place_id: FRESH_BUSY, payload: {}, cached_at: ago(1), sparse: false },
    ],
    posts: [
      ...posts(BUSY, 21),
      ...posts(EDGE, 20),
      ...posts(QUIET, 3), ...posts(QUIET, 40, "deleted"),
      ...posts(FRESH_BUSY, 50),
    ],
    place_cache_invalidation_queue: [],
  };
}

const queued = (strict: ReturnType<typeof makeSchemaStrictClient>) =>
  strict.writes.filter((w) => w.table === "place_cache_invalidation_queue").flatMap((w) => w.rows);

describe("schema-strict: runStaleSweep re-queues stale caches of places with more than 20 active posts", () => {
  it("re-queues the busy place only, as pending (the 42703 re-queued nothing)", async () => {
    const strict = makeSchemaStrictClient(world());
    const r = await runStaleSweep(strict);
    assert.equal(r.requeued, 1);
    assert.deepEqual(queued(strict).map((q) => [q.place_id, q.status]), [[BUSY, "pending"]]);
  });

  it("20 active posts is not more than 20; 40 deleted posts do not make a place busy; a fresh cache is not examined", async () => {
    const strict = makeSchemaStrictClient(world());
    await runStaleSweep(strict);
    const ids = queued(strict).map((q) => q.place_id);
    assert.ok(!ids.includes(EDGE), "exactly 20");
    assert.ok(!ids.includes(QUIET), "3 active + 40 deleted");
    assert.ok(!ids.includes(FRESH_BUSY), "cached an hour ago");
  });

  it("names no column the live schema lacks", async () => {
    const strict = makeSchemaStrictClient(world());
    await runStaleSweep(strict);
    assert.deepEqual(strict.deadColumnErrors, []);
  });

  it("a place whose activity cannot be read is skipped, not re-queued", async () => {
    const strict = makeSchemaStrictClient(world());
    const failingPosts = {
      from: (t: string) => (t === "posts"
        ? { select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) }) }) }) }
        : strict.from(t)),
    };
    const r = await runStaleSweep(failingPosts);
    assert.equal(r.requeued, 0);
    assert.deepEqual(queued(strict), []);
  });

  it("examines the most recently stale rows first (a quiet place stuck stale cannot hold the batch)", async () => {
    const seed = world();
    // 200 quiet places that went stale long ago, older than every row above.
    for (let i = 0; i < 200; i++) {
      seed.place_living_cache!.push({ place_id: `q${String(i).padStart(3, "0")}`, payload: {}, cached_at: ago(100 + i), sparse: false });
    }
    const strict = makeSchemaStrictClient(seed);
    const r = await runStaleSweep(strict);
    assert.equal(r.requeued, 1, "the busy place is still in the batch");
    assert.deepEqual(queued(strict).map((q) => q.place_id), [BUSY]);
  });
});
