-- Rollback for 3355_media_vision_provider_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3355 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_vision_provider_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the vision stage on since 3355 was applied; deleting the row
-- would silently turn it off (an absent row reads false), which is a product
-- change made by a script. It raises instead and the operator decides.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_vision_provider_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_vision_provider_enabled is TRUE. The owner has turned the vision stage on since 3355 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3355 wrote (W10-F, census-discovery §87). 3355 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3355's seed text byte for
-- byte (the md5 below) was not written by 3355, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_vision_provider_enabled' AND md5(coalesce(description, '')) <> 'fbb0a8181f7f7be931f21c75a192d290') THEN
    RAISE NOTICE '3355 rollback: media_vision_provider_enabled was not written by 3355 (its description is not 3355''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_vision_provider_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_vision_provider_enabled' AND md5(coalesce(description, '')) = 'fbb0a8181f7f7be931f21c75a192d290';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_vision_provider_enabled (the row 3355 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3355's ledger row in 3355's own transaction; without
-- this delete it would take 3355 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3355_media_vision_provider_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3355_media_vision_provider_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3355 as applied after rollback.';
  END IF;
END $$;

COMMIT;
