-- Rollback for 3341_media_watch_context_overlay_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3341 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. An absent row and a FALSE
-- row read the same to every reader (fail-closed), so deleting a FALSE row
-- changes nothing a user sees. If it reads TRUE, the owner has demoted the Stamp/count rail (F2); deleting the row would silently restore Stamp and its counts as the primary overlay, which is a product
-- change made by a script. It raises instead and the operator decides.
-- The flag's readers stay in the code; with the row gone they read false, which
-- is the behaviour before 3341 (census-media §34).

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3341 wrote (W10-F, census-discovery §87). 3341 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3341's seed text byte for
-- byte (the md5 below) was not written by 3341, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED' AND md5(coalesce(description, '')) <> '31a110c638a712114fd560c774d2718e') THEN
    RAISE NOTICE '3341 rollback: MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED was not written by 3341 (its description is not 3341''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED' AND md5(coalesce(description, '')) = '31a110c638a712114fd560c774d2718e';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED (the row 3341 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3341's ledger row in 3341's own transaction; without
-- this delete it would take 3341 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3341_media_watch_context_overlay_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3341_media_watch_context_overlay_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3341 as applied after rollback.';
  END IF;
END $$;

COMMIT;
