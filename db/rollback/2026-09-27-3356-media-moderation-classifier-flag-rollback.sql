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

-- Only the row 3356 wrote (W10-F, census-discovery §87). 3356 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3356's seed text byte for
-- byte (the md5 below) was not written by 3356, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'media_moderation_classifier_enabled' AND md5(coalesce(description, '')) <> '5e42c51daf46fc6b37c1253295d5249a') THEN
    RAISE NOTICE '3356 rollback: media_moderation_classifier_enabled was not written by 3356 (its description is not 3356''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'media_moderation_classifier_enabled' AND enabled = FALSE;
  END IF;
END $$;

DO $$
DECLARE present int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_moderation_classifier_enabled' AND md5(coalesce(description, '')) = '5e42c51daf46fc6b37c1253295d5249a';
  IF present <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_moderation_classifier_enabled (the row 3356 wrote) still present after rollback (% row(s))', present;
  END IF;
END $$;

-- The applier wrote 3356's ledger row in 3356's own transaction; without
-- this delete it would take 3356 as still applied and never re-apply it.
DELETE FROM public.schema_migration_ledger
 WHERE filename = '3356_media_moderation_classifier_flag.sql';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3356_media_moderation_classifier_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the ledger still records 3356 as applied after rollback.';
  END IF;
END $$;

COMMIT;
