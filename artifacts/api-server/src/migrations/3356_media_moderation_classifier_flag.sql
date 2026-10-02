-- 3356_media_moderation_classifier_flag.sql
-- Media — ONE capability flag for the §36 SAFETY MODERATION stage (census-media
-- §37: MD269 every media file, MD283 video), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- lib/media/vendors/mediaModerationClassifier.decidePreDistribution: the
-- decision that stands between upload and distribution. Three callers
-- (lib/media/vendors/mediaVendorStages):
--   • POST /postcards/:id/media/:mediaId/complete writes post_media's
--     moderation_status from it. OFF: 'approved' — exactly what /complete wrote
--     before this stage existed. ON: approve → 'approved', a classifier's
--     restrict or ANY hold → 'flagged', block → 'rejected'.
--   • POST /media/upload applies it to the canonical media_assets row through
--     MediaModerationService (approve → active, hold → limited, block →
--     rejected), where the §36 CHECK exists (2250/2470; the service refuses the
--     schema otherwise and says so).
--   • POST /media/upload/poster lets a frame-capable classifier REJECT a video
--     from its stored frame; one frame never approves a clip.
--
-- ── WHAT FLIPPING IT ON DOES, ON A DATABASE AS IT STANDS ────────────────────
-- No classifier adapter is implemented (MEDIA_MODERATION_CLASSIFIER names
-- nothing), so ON = a STAFFED HOLD: every new postcard file completes
-- 'flagged' and every new canonical upload is 'limited' — non-distributable —
-- until a moderator approves it with the existing POST /admin/media/:id/moderate.
-- That is the operator alternative census-media MD269 names, and it makes every
-- new upload wait for a person. Before flipping it, read census-media §37's
-- activation list: the postcard media count and passport cover ignore
-- moderation (routes/postcards.ts refreshMediaCounts), and a general post's
-- legacy read path gates on posts.post_status, which this stage does not reach.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3356 and an applied one behave alike.
-- Reader: lib/media/vendors/mediaVendorStages.isMediaModerationStageEnabled.
-- Rollback: db/rollback/2026-09-27-3356-media-moderation-classifier-flag-rollback.sql
-- NOT applied to any database by the lane that wrote it.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_moderation_classifier_enabled',
    false,
    'Media (census-media §37: MD269, MD283): the §36 safety-moderation stage between upload and distribution. ON: the configured classifier (MEDIA_MODERATION_CLASSIFIER) decides each new file; with no classifier, or on any refusal, error, timeout or malformed answer, the file is HELD (post_media flagged / canonical limited) for staffed review via POST /admin/media/:id/moderate. A single video frame can reject or hold a clip, never approve it. OFF / absent / unreadable (the seed): postcard files complete approved and canonical rows keep processing, as before.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_moderation_classifier_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_moderation_classifier_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_moderation_classifier_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_moderation_classifier_enabled is ON — holding every upload for review is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
