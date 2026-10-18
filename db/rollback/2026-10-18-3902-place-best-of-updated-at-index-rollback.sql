-- Rollback for 3902_place_best_of_updated_at_index.sql (census-highlights-memories, the place-collection
-- refresh ruling; wave 5, docs/ops/wave5-owner-decisions-20261018.md "Migrations").
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3902 DID: created ONE plain btree index and its COMMENT,
--   public.place_best_of_updated_at_place_id_idx ON public.place_best_of (updated_at, place_id)
-- the place stale sweep's walk key (lib/places/placeCollectionsWorker.ts runStaleSweep). Nothing else: no table,
-- column, row, grant, policy or flag. The only row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: drops that index (its comment goes with it) and deletes 3902's ledger row, so the runner
-- re-applies 3902 later. Nothing depends on the index. Behaviour is unchanged: the sweep's backlog count and
-- keyset pages return the same rows, and go back to scanning and sorting place_best_of as they did before 3902.
--
-- Refuses unless an index of that name, if present, is exactly the one 3902 built (the comparison 3902's own
-- $pre$ and $post$ make, so wherever 3902 applied it matches). It never drops a same-named index someone else
-- made. A second run finds no index and clears only the (already absent) ledger row.
--
-- LOCK: DROP INDEX takes ACCESS EXCLUSIVE on public.place_best_of until the COMMIT. It is a catalog change
-- (no scan), so the lock is brief, but the collections worker's reads and upserts wait for it.

BEGIN;

DO $pre$
DECLARE
  v_idx regclass := to_regclass('public.place_best_of_updated_at_place_id_idx');
BEGIN
  IF to_regclass('public.place_best_of') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3902 rollback): public.place_best_of does not exist.';
  END IF;
  IF v_idx IS NULL THEN
    RAISE NOTICE '3902 rollback: place_best_of_updated_at_place_id_idx is absent; only the ledger row is cleared.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = v_idx
       AND i.indrelid = 'public.place_best_of'::regclass
       AND NOT i.indisunique
       AND i.indnkeyatts = 2
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'updated_at'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'place_id'
       AND i.indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3902): an index named place_best_of_updated_at_place_id_idx exists but is not the one 3902 built: %. Nothing was dropped.', pg_get_indexdef(v_idx);
  END IF;
END $pre$;

DROP INDEX IF EXISTS public.place_best_of_updated_at_place_id_idx;
DELETE FROM public.schema_migration_ledger WHERE filename = '3902_place_best_of_updated_at_index.sql';

COMMIT;

-- ── Postconditions — assertion-only, recomputed from the catalog ──────────────
DO $post$
BEGIN
  IF to_regclass('public.place_best_of_updated_at_place_id_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3902): place_best_of_updated_at_place_id_idx still exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3902_place_best_of_updated_at_index.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3902): the ledger still records 3902 as applied.';
  END IF;
END $post$;
