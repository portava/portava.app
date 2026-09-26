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

DELETE FROM public.feature_flags
  WHERE flag = 'media_processing_worker_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_processing_worker_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_processing_worker_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
