-- Rollback for 3790_airport_timing_aggregates.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3790 DID: created airport_timing_aggregates (identifier-free timing bands,
-- distinct_observers >= 10), the function airport_timing_fold_commit, and the flag
-- airport_timing_aggregate_enabled seeded FALSE.
-- WHAT THIS ROLLBACK DOES: drops the function and the table, deletes the FALSE flag
-- row, and deletes 3790's ledger row so the applier can re-apply it.
--
-- IT REFUSES, rather than destroying something it cannot give back:
--   * while airport_timing_aggregate_enabled is TRUE — the owner turned folding on;
--     turn it off deliberately first;
--   * while ANY aggregate row exists — each one summarises raw observations that
--     were deleted in the same transaction that wrote it, so it cannot be
--     re-derived. Deleting them is a decision for a person, not a side effect of
--     a schema rollback.
-- ORDER MATTERS: revert the scheduler code that calls airport_timing_fold_commit
-- first, or a pass with the flag ON would fail (and, by design, delete nothing).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'airport_timing_aggregate_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3790): airport_timing_aggregate_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
  -- Nested, not AND-ed: PL/pgSQL plans the whole condition, so a reference to an
  -- absent table must sit in a statement that only runs when the table exists
  -- (a re-run after a completed rollback is a no-op, not a 42P01).
  IF to_regclass('public.airport_timing_aggregates') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.airport_timing_aggregates) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3790): airport_timing_aggregates holds rows whose raw observations are already deleted; they cannot be re-derived. Decide their fate deliberately first.';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz);
DROP TABLE IF EXISTS public.airport_timing_aggregates;
DELETE FROM public.feature_flags WHERE flag = 'airport_timing_aggregate_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3790_airport_timing_aggregates.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.airport_timing_aggregates') IS NOT NULL
     OR to_regprocedure('public.airport_timing_fold_commit(jsonb, jsonb, uuid[], timestamptz)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'airport_timing_aggregate_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3790 rollback): an object of 3790 is still present.';
  END IF;
END $post$;
