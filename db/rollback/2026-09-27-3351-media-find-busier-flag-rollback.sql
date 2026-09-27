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

DELETE FROM public.feature_flags
  WHERE flag = 'media_find_busier_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_find_busier_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_find_busier_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
