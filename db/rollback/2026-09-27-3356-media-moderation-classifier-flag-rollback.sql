-- Rollback for 3356_media_moderation_classifier_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3356 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('media_moderation_classifier_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no function, no grant.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned the safety-moderation stage on since 3356 was applied;
-- deleting the row would silently turn it off (an absent row reads false) and
-- new uploads would distribute without a decision again — a SAFETY change made
-- by a script. It raises instead and the operator decides.
--
-- NOTE: files already held while the stage was on (post_media 'flagged',
-- media_assets 'limited') stay held after the flag is gone. Releasing them is
-- a moderator's decision (POST /admin/media/:id/moderate), not a rollback's.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_moderation_classifier_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED: media_moderation_classifier_enabled is TRUE. The owner has turned the safety-moderation stage on since 3356 was applied; deleting the row would silently let new uploads distribute undecided. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
  WHERE flag = 'media_moderation_classifier_enabled' AND enabled = FALSE;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_moderation_classifier_enabled';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_moderation_classifier_enabled still present after rollback (% row(s))', present;
  END IF;
END $$;

COMMIT;
