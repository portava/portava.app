-- Rollback for 3491_discovery_recommendations_output_kinds_serve_point.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3491 DID
-- =============
--   * Replaced public.recommendations' recommendations_serve_point_check
--     (serve_point BETWEEN 1 AND 12, from 3376) with BETWEEN 1 AND 13, validated.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores BETWEEN 1 AND 12 and deletes 3491's ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3491.
--
-- ⚠ IT REFUSES WHILE ANY ROW CARRIES SERVE POINT 13. Those rows are the only
-- per-request record of those serves; narrowing the constraint would require
-- deleting them, and how long serve records are kept is a retention decision
-- (W10D-C8), not a rollback's. Turn discovery_output_kinds_enabled off first,
-- decide what happens to those rows, then re-run. The writer degrades on its
-- own if a 13 row is refused (it reports the rejection and serves anyway).
-- If 3376 was rolled back first (the table is gone), this only clears the
-- ledger row.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.recommendations') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.recommendations WHERE serve_point = 13;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3491): % recommendations row(s) carry serve point 13, the only record of those serves. Decide their fate first (retention: W10D-C8), then re-run.', n;
    END IF;
    ALTER TABLE public.recommendations DROP CONSTRAINT IF EXISTS recommendations_serve_point_check;
    ALTER TABLE public.recommendations
      ADD CONSTRAINT recommendations_serve_point_check CHECK (serve_point BETWEEN 1 AND 12);
  END IF;
END $$;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3491_discovery_recommendations_output_kinds_serve_point.sql';

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE def text;
BEGIN
  IF to_regclass('public.recommendations') IS NOT NULL THEN
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
     WHERE conrelid = 'public.recommendations'::regclass AND conname = 'recommendations_serve_point_check';
    IF def IS NULL OR def LIKE '%13%' THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3491 rollback): recommendations_serve_point_check is not back to 1–12: %', def;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3491_discovery_recommendations_output_kinds_serve_point.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3491 rollback): the ledger still records 3491 as applied.';
  END IF;
END $post$;
