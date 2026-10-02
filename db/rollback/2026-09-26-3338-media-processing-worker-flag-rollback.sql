-- Rollback for 3338_media_processing_worker_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3338 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_processing_worker_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has started the processing worker since 3338 was applied; deleting the
-- row would silently stop it (an absent row reads false) and make the owner
-- retry refuse again, which is a product change made by a script. It raises
-- instead and the operator decides.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_processing_worker_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_processing_worker_enabled is TRUE. The owner has started the processing worker since 3338 was applied; deleting the row would silently stop it. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3338 wrote (W10-F, census-discovery §87). 3338 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3338's seed text byte for
-- byte (the md5 below) was not written by 3338, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_processing_worker_enabled' AND md5(coalesce(description, '')) <> 'e6c71a1032647d74ee54c277ec54e37a') THEN
    RAISE NOTICE '3338 rollback: media_processing_worker_enabled was not written by 3338 (its description is not 3338''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_processing_worker_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_processing_worker_enabled' AND md5(coalesce(description, '')) = 'e6c71a1032647d74ee54c277ec54e37a';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_processing_worker_enabled (the row 3338 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3338's ledger row in 3338's own transaction; without
-- this delete it would take 3338 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3338_media_processing_worker_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3338_media_processing_worker_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3338 as applied after rollback.';
  END IF;
END $$;

COMMIT;
