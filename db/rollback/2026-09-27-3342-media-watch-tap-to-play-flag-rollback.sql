-- Rollback for 3342_media_watch_tap_to_play_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3342 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('MEDIA_WATCH_TAP_TO_PLAY_ENABLED', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. An absent row and a FALSE
-- row read the same to every reader (fail-closed), so deleting a FALSE row
-- changes nothing a user sees. If it reads TRUE, the owner has retired autoplay-on-viewability (F2); deleting the row would silently restart autoplay, which is a product
-- change made by a script. It raises instead and the operator decides.
-- The flag's readers stay in the code; with the row gone they read false, which
-- is the behaviour before 3342 (census-media §34).

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: MEDIA_WATCH_TAP_TO_PLAY_ENABLED is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3342 wrote (W10-F, census-discovery §87). 3342 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3342's seed text byte for
-- byte (the md5 below) was not written by 3342, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND md5(coalesce(description, '')) <> '2ee615f4f77d400fb977a7a03c828a68') THEN
    RAISE NOTICE '3342 rollback: MEDIA_WATCH_TAP_TO_PLAY_ENABLED was not written by 3342 (its description is not 3342''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND md5(coalesce(description, '')) = '2ee615f4f77d400fb977a7a03c828a68';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_TAP_TO_PLAY_ENABLED (the row 3342 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3342's ledger row in 3342's own transaction; without
-- this delete it would take 3342 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3342_media_watch_tap_to_play_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3342_media_watch_tap_to_play_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3342 as applied after rollback.';
  END IF;
END $$;

COMMIT;
