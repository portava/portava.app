-- 3357_media_transcoder_flag.sql
-- Media — ONE capability flag for the TRANSCODE stage (census-media §37: MD277
-- adaptive playback), seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- POST /media/upload's ingestion stage (lib/media/vendors/mediaVendorStages
-- runMediaVendorIngest) hands each new VIDEO's canonical asset to the
-- configured transcoder (MEDIA_TRANSCODER) through
-- lib/media/vendors/mediaTranscoder.submitForTranscode. No transcoder adapter
-- is implemented, so ON answers `not_configured`, logged, and nothing is sent.
-- Nothing is served from this stage yet: the playback API waits on the
-- vendor's playback-authorisation model (census-media §37).
--
-- ── WHAT FLIPPING IT ON DOES, ON A DATABASE AS IT STANDS ────────────────────
-- With no adapter: nothing but a log line per video upload. With one: every
-- new video is sent to that vendor, which is a cost decision.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3357 and an applied one behave alike.
-- Reader: lib/media/vendors/mediaVendorStages.isMediaTranscodeStageEnabled.
-- Rollback: db/rollback/2026-09-27-3357-media-transcoder-flag-rollback.sql
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
    'media_transcoder_enabled',
    false,
    'Media (census-media §37: MD277): the transcode stage. ON: POST /media/upload submits each new video''s canonical asset to the configured transcoder (MEDIA_TRANSCODER); a ladder is accepted only with an https .m3u8/.mpd manifest and at least two distinct renditions. Nothing is served from it yet. OFF / absent / unreadable (the seed): no video is sent anywhere, and playback stays progressive.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_transcoder_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_transcoder_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_transcoder_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_transcoder_enabled is ON — sending videos to a transcoder is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
