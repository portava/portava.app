-- 3340_media_tab_world_default_flag.sql
-- Media — the owner's surface decision F1 as ONE flag, seeded OFF
-- (census-media §34: MD1, MD3, MD11, MD29, MD87, MD286, MD402, MD419, MD425,
-- MD427).
--
-- Additive + idempotent. Safe to re-run. SCREAMING_CASE like the rest of the
-- MEDIA_* family; a CAPABILITY: `true` = the Media tab opens on the World shell.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- Read ONLY in the mobile app, through FeatureFlagsContext.isEnabled, which is
-- `flags[key] === true` — an absent row, an unfetched flag set and a failed
-- fetch all read false:
--   * app/(tabs)/media.tsx — the Media tab's mode list gains a first entry,
--     `world`, when this AND MEDIA_WORLD_SHELL_ENABLED (2300) are both on. The
--     tab's opening mode is the first enabled mode, so the tab then opens on
--     the World shell (src/features/media/screens/MediaWorldTabSurface.tsx),
--     with Watch · Grid · Gems one tap away under the World header. The tab
--     opens there on every launch: a mode persisted from an earlier session is
--     not restored over it (src/stores/mediaStore.ts `openOnDefault`), because
--     MD427 is "no full-screen stranger video immediately on Media open".
--   * src/features/media/state/mediaSurfaceFlags.ts — the pure resolver both
--     readers share; `worldDefault` requires MEDIA_WORLD_SHELL_ENABLED.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3340 and an applied one behave alike:
-- the tab lists Watch · Grid · Gems and opens on the first of them, exactly as
-- before. Turning it ON is the owner's F1 decision and changes what users see;
-- it is not this migration's to take.
--
-- ── WHAT ALSO HAS TO BE TRUE FOR A USER TO SEE IT ───────────────────────────
-- MEDIA_WORLD_SHELL_ENABLED (2300) must be ON, or this flag has no effect, and
-- MEDIA_TAB_ENABLED (2037) must be ON, or there is no Media tab in the nav bar
-- at all. The NOTICE below reports both on the database it runs against.
--
-- Rollback: db/rollback/2026-09-27-3340-media-tab-world-default-flag-rollback.sql
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
    'MEDIA_TAB_WORLD_DEFAULT_ENABLED',
    false,
    'Media (census-media §34, owner decision F1): the Media tab opens on the World shell. Read ONLY in the mobile app through FeatureFlagsContext.isEnabled (fail-closed): app/(tabs)/media.tsx and src/features/media/state/mediaSurfaceFlags.ts. ON, and only while MEDIA_WORLD_SHELL_ENABLED is also ON: the tab lists World first and opens on it on every launch, with Watch, Grid and Gems one tap away under the World header; the World entry pill is dropped because World is then a mode. OFF / absent / unfetched (the seed): the tab lists Watch, Grid and Gems and opens on the first enabled one, exactly as before.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int; shell_on int; tab_on int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected MEDIA_TAB_WORLD_DEFAULT_ENABLED present, found %', present;
  END IF;

  -- Tell the applier what flipping it ON would do on THIS database.
  SELECT count(*) INTO shell_on FROM public.feature_flags
    WHERE flag = 'MEDIA_WORLD_SHELL_ENABLED' AND enabled = TRUE;
  SELECT count(*) INTO tab_on FROM public.feature_flags
    WHERE flag = 'MEDIA_TAB_ENABLED' AND enabled = TRUE;
  RAISE NOTICE '3340: MEDIA_TAB_WORLD_DEFAULT_ENABLED seeded/kept. On this database MEDIA_WORLD_SHELL_ENABLED is % and MEDIA_TAB_ENABLED is %; flipping 3340 ON changes nothing a user sees unless both are ON.',
    CASE WHEN shell_on = 1 THEN 'ON' ELSE 'OFF/absent' END,
    CASE WHEN tab_on = 1 THEN 'ON' ELSE 'OFF/absent' END;

  -- Seeded ON would mean this migration took the F1 decision.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'MEDIA_TAB_WORLD_DEFAULT_ENABLED' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: MEDIA_TAB_WORLD_DEFAULT_ENABLED is ON — making the World shell the Media tab''s default is the owner''s F1 decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
