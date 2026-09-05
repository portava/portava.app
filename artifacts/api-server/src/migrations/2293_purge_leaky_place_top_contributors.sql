-- 2293_purge_leaky_place_top_contributors.sql
-- Places — purge the derived caches that were baked from PRIVATE posts, and
-- re-queue the affected places so the fixed worker rebuilds them.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2293.
--
-- Idempotent + additive to schema (it creates and alters nothing). Safe to
-- re-run: a second run finds the caches already empty, deletes nothing more,
-- and re-queues nothing.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--
-- lib/places/placeCollectionsWorker.computeContributors counted EVERY post with
-- `status = 'active'` at a place — regardless of `visibility` or `post_status` —
-- and upserted the top three authors into `place_top_contributors`.
-- routes/placeLiving then serves that row as `topContributor { userId,
-- displayName, avatarUrl, contributionCount }` on the ANONYMOUS living page. A
-- user whose only posts at a venue were `private`, or still
-- `pending_location_exit` (a delayed geotag whose author has not left yet), was
-- therefore publicly named as that venue's top contributor: the exact "this
-- person is at this place" disclosure the visibility tiers and delayed
-- geotagging exist to prevent.
--
-- The code fix (this migration's companion change) gates the rail on the
-- stranger-readable subset and prunes rows the gated recompute no longer
-- credits. But the code fix only reaches a place when the worker next processes
-- it, and:
--
--   • routes/placeLiving reads `place_top_contributors` with NO staleness check
--     at all (unlike place_best_of's 6 h check in placeCollections.getBestOf),
--     so an already-baked leaky row is served indefinitely; and
--   • the worker only processes places sitting in
--     `place_cache_invalidation_queue`, so a place nobody re-queues is never
--     revisited.
--
--   • `place_living_cache.payload` embeds the assembled `topContributor` block
--     and is served for up to the 24 h sparse TTL (routes/placeLiving:39,
--     470-490), so purging only the contributor table would still leave the
--     leaked name in the cached payload.
--
-- Nothing in the running system purges either. This migration does.
--
-- ── WHAT IT DOES ─────────────────────────────────────────────────────────────
--
--   1. Records which places have a cached contributor row or living payload.
--   2. DELETEs every `place_top_contributors` row and every
--      `place_living_cache` row. Both are PURE DERIVED CACHES — every value in
--      them is recomputed from `posts` — so this destroys no source data and is
--      fully rebuildable. Full purge rather than a targeted one because the
--      leak is not identifiable from the cache row alone (the row records a
--      count, not which posts produced it), and an empty rail is correct where
--      a leaky rail is not.
--   3. Re-queues the recorded places as 'pending' in
--      `place_cache_invalidation_queue` so the fixed worker rebuilds both, this
--      time from the visibility-gated set.
--
-- ── RUNTIME EFFECT ───────────────────────────────────────────────────────────
--
-- Until a rebuild lands, GET /api/places/:id/living returns `topContributor:
-- null` — an already-supported payload shape (routes/placeLiving initialises it
-- to null and only fills it when a row exists) — and takes a cache MISS, which
-- rebuilds the rest of the payload synchronously on the request path. No
-- endpoint changes shape and no request fails.
--
-- The contributor rail's rebuild does depend on the precompute worker
-- (PLACE_COLLECTIONS_WORKER_ENABLED). If that worker is off the rail simply
-- stays empty, which is the intended trade: empty is correct, leaky is not.
--
-- The place_contributor STAMP is untouched. Stamps live in the passport tables,
-- are awarded from the full active post set, and are not read from or written
-- by anything below.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.place_top_contributors') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.place_top_contributors does not exist.';
  END IF;
  IF to_regclass('public.place_living_cache') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.place_living_cache does not exist.';
  END IF;
  IF to_regclass('public.place_cache_invalidation_queue') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.place_cache_invalidation_queue does not exist.';
  END IF;
END $$;

-- ── Purge + re-queue ─────────────────────────────────────────────────────────
--
-- One statement, so the place ids are captured from the same snapshot the
-- DELETEs act on: every CTE here sees the pre-DELETE state, and a data-modifying
-- CTE runs exactly once and to completion whether or not the primary query reads
-- its output. The queue insert is filtered against public.places because
-- place_cache_invalidation_queue.place_id is a FK to it — a cache row for a
-- since-deleted place must not resurrect a queue row.
WITH affected AS (
  SELECT place_id FROM public.place_top_contributors
  UNION
  SELECT place_id FROM public.place_living_cache
),
purged_contributors AS (
  DELETE FROM public.place_top_contributors RETURNING place_id
),
purged_living AS (
  DELETE FROM public.place_living_cache RETURNING place_id
)
INSERT INTO public.place_cache_invalidation_queue (place_id, queued_at, status)
SELECT a.place_id, NOW(), 'pending'
  FROM affected a
  JOIN public.places p ON p.id = a.place_id
ON CONFLICT (place_id) DO UPDATE
  SET queued_at    = EXCLUDED.queued_at,
      status       = 'pending',
      locked_until = NULL,
      locked_by    = NULL;

-- ── Postconditions ───────────────────────────────────────────────────────────
--
-- Scoped to rows that PREDATE this transaction, which is exactly what the
-- migration promises: no cache row baked under the old, ungated rule survives.
-- A row written after `now()` (transaction start) is a rebuild by the fixed
-- worker or by a living-page cache miss racing this migration — correct by
-- construction, and not something to fail on.
DO $$
DECLARE contrib_left int; living_left int;
BEGIN
  SELECT count(*) INTO contrib_left
    FROM public.place_top_contributors WHERE updated_at < now();
  IF contrib_left <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: place_top_contributors still holds % pre-existing row(s) — the leaky cache was not purged', contrib_left;
  END IF;
  SELECT count(*) INTO living_left
    FROM public.place_living_cache WHERE cached_at < now();
  IF living_left <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: place_living_cache still holds % pre-existing row(s) — the cached topContributor block was not purged', living_left;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual): none is possible and none is wanted. Both tables are
-- derived caches with no independent source of truth; the purged rows are
-- exactly the rows that must not exist. The worker (and, for
-- place_living_cache, the next living-page request) rebuilds them from `posts`
-- under the fixed, visibility-gated rules.
