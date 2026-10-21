-- 3902_place_best_of_updated_at_index.sql
-- The place stale sweep's walk gets the index it orders by (census-highlights-
-- memories, the place-collection refresh ruling: "place_best_of has no index on
-- updated_at, so the count and each page scan a table with one row per
-- precomputed place"). POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999
-- band, gap number 3902; docs/ops/wave5-owner-decisions-20261018.md
-- "Migrations").
--
-- WRITTEN, NOT APPLIED. Additive: one plain btree index. No table, column, row,
-- grant, policy or flag. Behaviour is unchanged; only the plan of four reads is.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE READS IT SERVES (lib/places/placeCollectionsWorker.ts, runStaleSweep)
-- ══════════════════════════════════════════════════════════════════════════════
--   1. the backlog count   SELECT count  WHERE updated_at < cutoff
--   2. the first page      WHERE updated_at < cutoff
--                          ORDER BY updated_at, place_id LIMIT 100
--   3. a page's ties       WHERE updated_at = X AND place_id > Y
--                          ORDER BY place_id LIMIT n
--   4. the next page       WHERE updated_at < cutoff AND updated_at > X
--                          ORDER BY updated_at, place_id LIMIT n
-- The walk's stable key is (updated_at, place_id), so the index is that key:
-- every WHERE is a range or equality on its leading column, every ORDER BY is
-- its column order, so a page is read in index order and stops at its LIMIT
-- instead of sorting every overdue row. The count is a range scan of the same
-- index. place_id is the primary key, so (updated_at, place_id) is unique.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (a gap number: applied at 3902 on a fresh replay, after 3999
-- on portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends only on public.place_best_of (baseline; 2047). Of the files from 2093
-- onwards, only 2293 (comments) and 3504 (client privileges) name
-- place_best_of, both below 3902; none above 3902 names it, and no index of this
-- name exists anywhere in the chain.
--
-- LOCK. A plain CREATE INDEX (the applier wraps each file and its ledger row in
-- one transaction, which the online variant cannot run in) holds a SHARE lock on
-- place_best_of while it builds: the collections worker's upsert waits. The table
-- holds one row per precomputed place.
--
-- ROLLBACK (nothing depends on the index; the sweep's reads then scan as before):
--   BEGIN;
--   DROP INDEX IF EXISTS public.place_best_of_updated_at_place_id_idx;
--   DELETE FROM public.schema_migration_ledger WHERE filename = '3902_place_best_of_updated_at_index.sql';
--   COMMIT;

BEGIN;

DO $pre$
DECLARE
  v_idx regclass := to_regclass('public.place_best_of_updated_at_place_id_idx');
BEGIN
  IF to_regclass('public.place_best_of') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3902): public.place_best_of does not exist.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.place_best_of'::regclass AND attnum > 0 AND NOT attisdropped
         AND ((attname = 'place_id' AND atttypid = 'uuid'::regtype)
           OR (attname = 'updated_at' AND atttypid = 'timestamptz'::regtype))) <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3902): public.place_best_of must carry place_id uuid and updated_at timestamptz.';
  END IF;
  -- An index of this name must already be exactly this one (a re-run), or absent.
  IF v_idx IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.place_best_of'::regclass
       AND NOT i.indisunique
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'updated_at'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'place_id'
       AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3902): an index named place_best_of_updated_at_place_id_idx exists but is not this one: %. Refusing to build on it.', pg_get_indexdef(v_idx);
  END IF;
END $pre$;

CREATE INDEX IF NOT EXISTS place_best_of_updated_at_place_id_idx
  ON public.place_best_of (updated_at, place_id);

COMMENT ON INDEX public.place_best_of_updated_at_place_id_idx IS
  '3902: the place stale sweep''s walk key (updated_at, place_id), oldest first (lib/places/placeCollectionsWorker.ts runStaleSweep). Serves the backlog count (updated_at < cutoff) and every keyset page, which read in index order and stop at their LIMIT.';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
DECLARE
  v_idx regclass := to_regclass('public.place_best_of_updated_at_place_id_idx');
BEGIN
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3902): place_best_of_updated_at_place_id_idx does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.place_best_of'::regclass
       AND am.amname = 'btree'
       AND NOT i.indisunique AND i.indisvalid AND i.indisready
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'updated_at'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'place_id'
       AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3902): place_best_of_updated_at_place_id_idx is not a valid btree (updated_at, place_id): %', pg_get_indexdef(v_idx);
  END IF;
  IF obj_description(v_idx, 'pg_class') IS NULL OR position('runStaleSweep' IN obj_description(v_idx, 'pg_class')) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3902): the index comment does not name the sweep.';
  END IF;
END $post$;
