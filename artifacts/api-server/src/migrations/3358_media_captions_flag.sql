-- 3358_media_captions_flag.sql
-- Media — ONE capability flag for the CAPTIONS stage (census-media §37: MD280),
-- seeded OFF.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- POST /media/upload's ingestion stage (lib/media/vendors/mediaVendorStages
-- runMediaVendorIngest) asks the configured caption source
-- (MEDIA_CAPTION_SOURCE) for a WebVTT track of each new VIDEO. A track is kept
-- only if lib/media/vendors/mediaCaptionSource.parseWebVtt accepts it whole,
-- and is stored at the derived path `<storage_path>.captions.vtt` with
-- upsert:false. No caption-source adapter is implemented, so ON answers
-- `not_configured`, logged, and nothing is sent or stored. A stored track is
-- not yet served to anyone (census-media §37).
--
-- ── WHAT FLIPPING IT ON DOES, ON A DATABASE AS IT STANDS ────────────────────
-- With no adapter: a log line per video upload. With one: every new video's
-- audio goes to that ASR vendor — a data-protection decision about users'
-- speech, made by the owner.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3358 and an applied one behave alike.
-- Reader: lib/media/vendors/mediaVendorStages.isMediaCaptionsStageEnabled.
-- Rollback: db/rollback/2026-09-27-3358-media-captions-flag-rollback.sql
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
    'media_captions_enabled',
    false,
    'Media (census-media §37: MD280): the captions stage. ON: POST /media/upload asks the configured caption source (MEDIA_CAPTION_SOURCE) for a WebVTT track of each new video, keeps it only if it validates whole, and stores it at <storage_path>.captions.vtt (never overwritten). Nothing serves the track yet. OFF / absent / unreadable (the seed): no audio is sent anywhere and nothing is stored.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_captions_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_captions_enabled present, found %', present;
  END IF;
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_captions_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_captions_enabled is ON — sending users'' audio to an ASR vendor is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
