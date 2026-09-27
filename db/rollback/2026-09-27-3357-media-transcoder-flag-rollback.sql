-- Rollback for 3357_media_transcoder_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3357 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_transcoder_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the transcode stage on since 3357 was applied; deleting the
-- row would silently turn it off (an absent row reads false). It raises instead
-- and the operator decides.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_transcoder_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_transcoder_enabled is TRUE. The owner has turned the transcode stage on since 3357 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'media_transcoder_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_transcoder_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_transcoder_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
