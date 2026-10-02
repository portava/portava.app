-- 3341_media_watch_context_overlay_flag.sql
-- Media — the overlay half of the owner's surface decision F2 as ONE flag,
-- seeded OFF (census-media §34: MD215, MD408, MD412, MD424; MD87's Watch opens).
--
-- Additive + idempotent. Safe to re-run. SCREAMING_CASE like the rest of the
-- MEDIA_* family; a CAPABILITY: `true` = the context-first Watch overlay.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- Read ONLY in the mobile app, through FeatureFlagsContext.isEnabled
-- (`flags[key] === true`, so absent / unfetched / failed reads false), in
-- src/features/media/state/mediaSurfaceFlags.ts, which
-- src/components/media/WatchItemOverlay.tsx reads through
-- src/features/media/hooks/useMediaSurfaceDecisions.ts. ON:
--   * the action rail LEADS with Ask Compass — the first and largest control,
--     handing the media id to Compass exactly as the §15 rail does;
--   * Stamp, comment and save keep their controls and lose their counts, and
--     the Stamp It count under the Stamp is not drawn;
--   * the left column opens on the PLACE: a header naming it that opens the
--     place's other perspectives through the §14 entry context (the
--     contextual viewer), falling back to the place screen when the place
--     has no perspectives to stage. The creator row follows it.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same: the overlay renders byte-for-byte the rail it renders
-- today (Stamp first, counts under Stamp, comment and save). Turning it ON is
-- the owner's F2 decision.
--
-- Rollback: db/rollback/2026-09-27-3341-media-watch-context-overlay-flag-rollback.sql
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
    'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED',
    false,
    'Media (census-media §34, owner decision F2): the context-first Watch overlay. Read ONLY in the mobile app through FeatureFlagsContext.isEnabled (fail-closed): src/features/media/state/mediaSurfaceFlags.ts, for src/components/media/WatchItemOverlay.tsx. ON: Ask Compass leads the action rail as its first and largest control; Stamp, comment and save show no counts and the Stamp It count is not drawn; the left column opens on the place, which opens that place''s perspectives through the §14 entry context. OFF / absent / unfetched (the seed): the overlay is exactly today''s, Stamp first with its count.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED present, found %', present;
  END IF;

  -- Seeded ON would mean this migration took the F2 decision.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED is ON — demoting the Stamp/count rail is the owner''s F2 decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
