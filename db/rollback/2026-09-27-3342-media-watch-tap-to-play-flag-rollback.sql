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

DELETE FROM public.feature_flags
  WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_TAP_TO_PLAY_ENABLED still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
