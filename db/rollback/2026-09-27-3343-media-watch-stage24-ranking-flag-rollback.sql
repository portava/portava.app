-- Rollback for 3343_media_watch_stage24_ranking_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3343 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('MEDIA_WATCH_STAGE24_RANKING_ENABLED', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. An absent row and a FALSE
-- row read the same to every reader (fail-closed), so deleting a FALSE row
-- changes nothing a user sees. If it reads TRUE, the owner has retired the legacy Watch ranker (F2); deleting the row would silently put the watch-time multipliers back, which is a product
-- change made by a script. It raises instead and the operator decides.
-- The flag's readers stay in the code; with the row gone they read false, which
-- is the behaviour before 3343 (census-media §34).

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_STAGE24_RANKING_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: MEDIA_WATCH_STAGE24_RANKING_ENABLED is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'MEDIA_WATCH_STAGE24_RANKING_ENABLED' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_STAGE24_RANKING_ENABLED';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_STAGE24_RANKING_ENABLED still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
