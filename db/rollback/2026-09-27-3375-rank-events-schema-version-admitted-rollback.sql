-- Rollback for 3375_rank_events_schema_version_admitted.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3375 DID
-- =============
--   * ADD CONSTRAINT rank_events_schema_version_check CHECK (schema_version IN (1)).
--     No row, column, index, grant or policy was touched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops that one CHECK and deletes 3375's schema_migration_ledger row, so a
-- later run of scripts/src/apply-migrations.ts re-applies 3375. Free and
-- lossless: a dropped CHECK rejects nothing and deletes nothing. What it gives
-- up is the refusal: rank_events.schema_version again admits any smallint, so a
-- writer that bumps its version with no reader lands rows nobody can interpret
-- (census-discovery DV-38).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3375 rollback): public.rank_events does not exist.';
  END IF;
END $$;

ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_schema_version_check;

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3375_rank_events_schema_version_admitted.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.rank_events'::regclass
                AND conname = 'rank_events_schema_version_check') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375 rollback): rank_events_schema_version_check still exists.';
  END IF;
  -- The column itself is 2890's and must survive.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'schema_version') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375 rollback): rank_events.schema_version is gone; this rollback must not touch 2890.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3375_rank_events_schema_version_admitted.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3375 rollback): the ledger still records 3375 as applied.';
  END IF;
END $post$;
