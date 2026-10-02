-- 3342_media_watch_tap_to_play_flag.sql
-- Media — the autoplay half of the owner's surface decision F2 as ONE flag,
-- seeded OFF (census-media §34: MD402, MD425; MD286 and MD419 on Watch itself).
--
-- Additive + idempotent. Safe to re-run. SCREAMING_CASE like the rest of the
-- MEDIA_* family; a CAPABILITY: `true` = the Watch feed never starts a video
-- without a tap.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- Read ONLY in the mobile app, through FeatureFlagsContext.isEnabled
-- (`flags[key] === true`, so absent / unfetched / failed reads false), in
-- src/features/media/state/mediaSurfaceFlags.ts, for
-- src/components/media/WatchFeedList.tsx and src/hooks/useWatchPlayback.ts. ON:
--   * a cell that scrolls into view is PAUSED with a "Tap to play" mark, and
--     the same single tap that pauses today is what starts it;
--   * the playback manager no longer calls playAsync on the item that became
--     visible, on tab refocus or on return to the foreground;
--   * leaving the tab or the app returns the cell to "Tap to play", so the
--     paused state the viewer sees is the state the player is in;
--   * a long press still pauses while held and restores the state it found.
-- Paging stays: this retires autoplay as the navigation, not the list.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same: a cell plays as soon as it is the viewable one, exactly
-- as today. Turning it ON is the owner's F2 decision.
--
-- Rollback: db/rollback/2026-09-27-3342-media-watch-tap-to-play-flag-rollback.sql
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
    'MEDIA_WATCH_TAP_TO_PLAY_ENABLED',
    false,
    'Media (census-media §34, owner decision F2): the Watch feed never starts a video without a tap. Read ONLY in the mobile app through FeatureFlagsContext.isEnabled (fail-closed): src/features/media/state/mediaSurfaceFlags.ts, for src/components/media/WatchFeedList.tsx and src/hooks/useWatchPlayback.ts. ON: a cell that becomes the viewable one waits paused under a Tap to play mark; the playback manager starts nothing on scroll, refocus or foreground; leaving the tab or the app returns the cell to Tap to play. OFF / absent / unfetched (the seed): the viewable cell plays at once, exactly as today.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected MEDIA_WATCH_TAP_TO_PLAY_ENABLED present, found %', present;
  END IF;

  -- Seeded ON would mean this migration took the F2 decision.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_TAP_TO_PLAY_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_TAP_TO_PLAY_ENABLED is ON — retiring autoplay-on-viewability is the owner''s F2 decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
