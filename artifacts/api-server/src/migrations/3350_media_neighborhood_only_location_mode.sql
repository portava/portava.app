-- 3350_media_neighborhood_only_location_mode.sql
-- Media — spec §34 Delayed Publishing, "Show neighborhood only" (census-media
-- §36, MD262): one new owner location mode and ONE capability flag, seeded OFF.
--
-- ── WHAT THE SPEC SAYS, AND WHY THIS IS NOT AN INVENTION ────────────────────
-- §34 enumerates five choices a person makes when they post: Publish now ·
-- Publish after I leave · Hide exact place · Show neighborhood only · Show city
-- only. `posts.location_privacy_mode` (DB enum `post_location_privacy_mode`,
-- 0049) is where that choice is stored, and four of the five already have a
-- value there (none · delayed_until_exit · hidden · city_only). The fifth had
-- none. This migration adds it as `neighborhood_only`.
--
-- ── WHAT THE VALUE MEANS (enforced in code, not here) ──────────────────────
-- For every viewer except the author, a `neighborhood_only` post discloses its
-- place at NO FINER THAN §33 `neighborhood`:
--   * lib/mediaLocationVisibility.locationPrivacyModeToCeiling → 'neighborhood'
--     (every Media read: the World shell, the Wall's Quick Media, the action
--     rail, Compass media context, AND — from this lane — the Watch feed, grid
--     and single-item read, which did not read the mode at all before);
--   * lib/postSchemas.mapPublicPost nulls the venue name, exactly as for
--     city_only; safeLocationLabel stores a city/country public label.
--   The canonical place id is withheld (it is a place-level identifier), and a
--   place page never lists a post whose place it may not disclose.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `media_neighborhood_only_mode_enabled`. OFF / absent / unreadable (the seed):
-- POST /posts and PATCH /posts/:id/location-privacy REFUSE the value
-- (feature_disabled) and write nothing, and the composer does not offer it.
-- ON: a person may choose it. The READ side needs no flag and has none: every
-- reader above treats the value as at most 'neighborhood' whether or not the
-- flag is on, so turning the flag OFF again never widens a stored post.
--
-- ── RUNTIME EFFECT OF APPLYING: NONE, AND THAT IS CHECKED ──────────────────
-- An enum label nothing writes changes no row. The flag is seeded FALSE and the
-- postcondition refuses a seed that finds it ON. The value count is reported.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- db/rollback/2026-09-27-3350-media-neighborhood-only-location-mode-rollback.sql
-- PostgreSQL has no ALTER TYPE … DROP VALUE; the rollback removes the flag and
-- refuses while any post still carries the value. Read its header.
--
-- NOT applied to any database by the lane that wrote it.

-- ALTER TYPE … ADD VALUE is issued OUTSIDE the transaction below: before
-- PostgreSQL 12 it may not run inside one, and on any version a value added in
-- a transaction cannot be used until that transaction commits.
DO $$
BEGIN
  IF to_regtype('public.post_location_privacy_mode') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: type public.post_location_privacy_mode (0049) does not exist.';
  END IF;
END $$;

ALTER TYPE public.post_location_privacy_mode ADD VALUE IF NOT EXISTS 'neighborhood_only';

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'media_neighborhood_only_mode_enabled',
    false,
    'Media (census-media §36, MD262): the §34 "Show neighborhood only" choice. ON: POST /posts and PATCH /posts/:id/location-privacy accept location_privacy_mode = neighborhood_only and the composer offers it; every reader discloses such a post at no finer than §33 neighborhood (no venue name, no canonical place id, never on a place page) to anyone but its author. OFF / absent / unreadable (the seed): both writes refuse the value and write nothing. The read side is not gated: a stored neighborhood_only post is held at neighborhood whatever this flag says.'
  )
ON CONFLICT (flag) DO NOTHING;

DO $$
DECLARE present int; on_count int; labelled int; using_value bigint;
BEGIN
  SELECT count(*) INTO labelled FROM pg_enum
    WHERE enumtypid = 'public.post_location_privacy_mode'::regtype
      AND enumlabel = 'neighborhood_only';
  IF labelled <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: post_location_privacy_mode has % neighborhood_only label(s), expected 1', labelled;
  END IF;

  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'media_neighborhood_only_mode_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected media_neighborhood_only_mode_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO using_value FROM public.posts
    WHERE location_privacy_mode = 'neighborhood_only';
  RAISE NOTICE '3350: neighborhood_only label present; % post(s) carry it on this database (0 on a first apply).', using_value;

  -- Seeded ON would mean this migration took the decision to offer the choice.
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'media_neighborhood_only_mode_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: media_neighborhood_only_mode_enabled is ON — offering the choice is an owner decision and this must ship OFF';
  END IF;
END $$;

COMMIT;
