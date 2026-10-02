-- Rollback for 3351_media_find_busier_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3351 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_find_busier_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has offered Find Busier since 3351 was applied; deleting the row would
-- silently withdraw the action from every rail (an absent row reads false).
-- It raises instead and the operator decides.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_find_busier_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_find_busier_enabled is TRUE. The owner has offered Find Busier since 3351 was applied; deleting the row would silently withdraw it. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3351 wrote (W10-F, census-discovery §87). 3351 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3351's seed text byte for
-- byte (the md5 below) was not written by 3351, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_find_busier_enabled' AND md5(coalesce(description, '')) <> '9a5e2bb99e4f50d975af8a2c479c45d0') THEN
    RAISE NOTICE '3351 rollback: media_find_busier_enabled was not written by 3351 (its description is not 3351''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_find_busier_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_find_busier_enabled' AND md5(coalesce(description, '')) = '9a5e2bb99e4f50d975af8a2c479c45d0';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_find_busier_enabled (the row 3351 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3351's ledger row in 3351's own transaction; without
-- this delete it would take 3351 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3351_media_find_busier_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3351_media_find_busier_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3351 as applied after rollback.';
  END IF;
END $$;

COMMIT;
