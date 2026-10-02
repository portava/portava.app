-- Rollback for 3456_discovery_cache_a_ranked_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3456 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('discovery_cache_a_ranked_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned it on since 3456 was applied; deleting the row would
-- silently turn it off again (an absent row reads false) with no record that
-- the owner's decision was reversed. It raises instead and the operator
-- decides. The flag writes no row of its own, so there is nothing else to
-- remove. It then deletes 3456's schema_migration_ledger row, so a later run
-- of scripts/src/apply-migrations.ts re-applies 3456. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_cache_a_ranked_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3456): discovery_cache_a_ranked_enabled is TRUE. The owner has turned it on since 3456 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'discovery_cache_a_ranked_enabled' AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3456_discovery_cache_a_ranked_flag.sql';

COMMIT;

-- ── Postconditions: the row is gone, and so is the ledger row ───────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_cache_a_ranked_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3456 rollback): discovery_cache_a_ranked_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3456_discovery_cache_a_ranked_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3456 rollback): the ledger still records 3456 as applied.';
  END IF;
END $post$;
