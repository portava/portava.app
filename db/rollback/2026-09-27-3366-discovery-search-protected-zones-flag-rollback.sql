-- Rollback for 3366_discovery_search_protected_zones_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3366 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('discovery_search_protected_zones_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the search §24 pass on since 3366 was applied; deleting the
-- row would silently turn it off again (an absent row reads false) and put
-- protected places back on the search surface at full precision. It raises
-- instead and the operator decides.
--
-- It then deletes 3366's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3366. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_search_protected_zones_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3366): discovery_search_protected_zones_enabled is TRUE. The owner has turned the search protected-place pass on since 3366 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3366 wrote (W10-F, census-discovery §87). 3366 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3366's seed text byte for
-- byte (the md5 below) was not written by 3366, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_search_protected_zones_enabled' AND md5(coalesce(description, '')) <> '5f2db1c757a31a601ac7b11174352ef5') THEN
    RAISE NOTICE '3366 rollback: discovery_search_protected_zones_enabled was not written by 3366 (its description is not 3366''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'discovery_search_protected_zones_enabled' AND enabled = FALSE;
  END IF;
END $$;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3366_discovery_search_protected_zones_flag.sql';

COMMIT;

-- ── Postconditions: the row is gone, and so is the ledger row ───────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_search_protected_zones_enabled'
                AND md5(coalesce(description, '')) = '5f2db1c757a31a601ac7b11174352ef5') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3366 rollback): discovery_search_protected_zones_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3366_discovery_search_protected_zones_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3366 rollback): the ledger still records 3366 as applied.';
  END IF;
END $post$;
