-- 2300_phantom_feature_flag_rows.sql
-- Seed the five feature-flag rows that live code READS but no migration ever
-- created — "phantom flags". All five OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2300.
-- (2290-2297 are taken across origin branches; 2298/2299 left clear.)
--
-- Additive + idempotent (ON CONFLICT DO NOTHING). Safe to re-run.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT A PHANTOM FLAG IS, AND WHY THIS IS NOT A NO-OP
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every reader below is fail-closed: isFlagEnabled returns false when the row
-- is missing, compass/flags.ts isEnabled returns `flags[name] ?? false`, and
-- the ranking service's `.in(...)` select simply never sees the name and keeps
-- its `false` default. So each of these gates has been permanently CLOSED since
-- the day it was written — not "off", but UNFLIPPABLE. The admin flag list did
-- not show them, because there was nothing to show.
--
-- RUNTIME EFFECT OF THIS MIGRATION: NONE. Every row is seeded false, which is
-- the exact value each reader was already resolving to. What changes is that
-- an operator can now turn them on. That is the whole point: MEDIA_WORLD_SHELL
-- gates the entire Media v2 client shell, and without this row it could not be
-- enabled at all without shipping a new migration first.
--
-- Verified absent before writing this (2026-09-05): `grep -rn` over
-- src/migrations/, migrations/, supabase/migrations/ and
-- artifacts/api-server/supabase/migrations/, plus a live SELECT against both
-- the CI project and the production project — no row in either database.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIVE ROWS
-- ─────────────────────────────────────────────────────────────────────────────
--
--   MEDIA_WORLD_SHELL_ENABLED
--     Read ONLY in the app tree: travel-buddy-standalone/app/(tabs)/media.tsx
--     (the "World" entry pill) and app/media-viewer/[id].tsx. The app's
--     FeatureFlagsContext.isEnabled is `flags[key] === true`, so an absent row
--     is false. The /media-world route exists and is reachable by nothing.
--     The most consequential of the five: the entire Media v2 surface was
--     un-flippable without a migration.
--
--   MEDIA_HIDDEN_GEMS_NEARBY_ENABLED
--     Read at routes/mediaFeed.ts (the `near_me` area mode of GET
--     /api/media/gems-feed, which returns `feature_disabled` today) and passed
--     as GemsFeed's `nearMeEnabled` prop in the app. Two readers, one row.
--
--   PORTAVA_PUBLISHER_BOOST_ENABLED
--     Read at routes/pulse.ts (isFlagEnabled) and in
--     services/ranking/MediaFeedRankingService.ts loadMediaRankingFlags (a
--     direct `.in(...)` select). NOTE: a seed for this name DOES exist in the
--     repo, at artifacts/api-server/supabase/migrations/
--     20260809_portava_publisher_boost_flag.sql — but that tree is a FROZEN,
--     never-applied archival root (see src/scripts/frozenMigrationRoots.ts:
--     "never audited or documented as a tree"), and the row is absent from both
--     live databases. A seed in a directory nothing runs is not a seed.
--     Seeded false here, matching that file's own stated default.
--
--   PORTAVA_FEATURED_BOOST_ENABLED
--     Read in the same `.in(...)` select; consumed at
--     MediaFeedRankingService.ts (featuredAt boost) and routes/mediaFeed.ts.
--     Never seeded anywhere at all.
--
--   COMPASS_TELEGRAPH
--     Read at routes/compass.ts via compass/flags.ts isEnabled, whose loader is
--     a `LIKE 'COMPASS_%'` bulk select — so the name matches the loader's shape
--     and still resolves to nothing. GET /api/compass/telegraph has answered
--     `feature_disabled` for every request since it shipped. This one was
--     already recorded in check-flag-polarity.mjs's own CLASSIFIED entry ("NOT
--     SEEDED by any migration... permanently false and indistinguishable from
--     deliberately-off"); recording it was not fixing it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY *NOT* SEEDED HERE
-- ─────────────────────────────────────────────────────────────────────────────
--
--   MEDIA_SHARING_ENABLED — not a missing row, a misspelling. The row the
--     reader wanted is MEDIA_SHARES_ENABLED, seeded false by
--     2038_media_admin_flags.sql:47. Fixed in code (routes/mediaFeed.ts), not
--     here; seeding the misspelling would have created a second row for one
--     capability and left the operator two switches for one door.
--
--   SEARCH_SIGNAL_DECAY_DAYS — a CONFIG row read as
--     `.select("enabled, numeric_value")`. feature_flags has NO numeric_value
--     column in either live database (columns are flag, enabled, description,
--     updated_at, metadata), so that select returns 42703 and the reader falls
--     back to its compiled-in `{ enabled: true, halfLifeDays: 7 }`. Seeding the
--     row alone would NOT make the read resolve — it would only add a row an
--     operator can toggle that still changes nothing, which is worse than an
--     absent one. Adding the column would additionally make search-signal decay
--     disableable for the first time. Left for an owner decision and recorded
--     in check-flag-polarity.mjs UNSEEDED_READS.
--
--   place_provenance_stamping_enabled — unseeded ON PURPOSE. lib/
--     placeProvenance.ts says so in its own header: "Off by default (an absent
--     flag reads false), which is also the only safe state on any database
--     where 2101's source_id column does not yet exist: stamping a column that
--     is not there would fail the write." Seeding it would hand an operator a
--     switch that breaks place writes. Recorded, not seeded.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags does not exist.';
  END IF;
END $$;

-- ── Seed (all CAPABILITY, all OFF) ───────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'MEDIA_WORLD_SHELL_ENABLED',
    false,
    'Media v2: show the World entry pill on the Media tab and the World shell affordances in the media viewer, opening the /media-world surface. Read ONLY in the mobile app (app/(tabs)/media.tsx, app/media-viewer/[id].tsx) through FeatureFlagsContext.isEnabled, which is fail-closed (flags[key] === true). OFF (the seed): the Media tab behaves exactly as it does today — Watch/Grid/Gems unchanged, no World pill, /media-world unreachable. Until this row existed the surface could not be enabled at all.'
  ),
  (
    'MEDIA_HIDDEN_GEMS_NEARBY_ENABLED',
    false,
    'Media Gems: allow the "Near Me" area mode, which ranks hidden gems by proximity to viewer-supplied X-User-Lat/X-User-Lng headers. Read server-side at routes/mediaFeed.ts (GET /api/media/gems-feed, areaMode=near_me) via isFlagEnabled, and client-side as GemsFeed''s nearMeEnabled prop. OFF (the seed): near_me returns feature_disabled and the app hides the Near Me filter, exactly as today. Location-adjacent, so it stays off until deliberately enabled.'
  ),
  (
    'PORTAVA_PUBLISHER_BOOST_ENABLED',
    false,
    'Applies a 1.2x score multiplier to posts authored by the @Portava official publisher account and exempts them from per-creator frequency caps in the Pulse and Roam (media) feeds. Read at routes/pulse.ts via isFlagEnabled and in services/ranking/MediaFeedRankingService.ts loadMediaRankingFlags. OFF (the seed): no boost, no cap exemption; ranking is byte-for-byte what it is today. A seed for this name exists in the frozen, never-applied artifacts/api-server/supabase/migrations tree; this is the first one in the canonical chain.'
  ),
  (
    'PORTAVA_FEATURED_BOOST_ENABLED',
    false,
    'Applies the editorial featured-content boost to media items carrying a featuredAt timestamp. Read in services/ranking/MediaFeedRankingService.ts loadMediaRankingFlags and consumed by the media feed scorer and routes/mediaFeed.ts. OFF (the seed): featuredAt is ignored by ranking, exactly as today.'
  ),
  (
    'COMPASS_TELEGRAPH',
    false,
    'Capability gate for the Compass telegraph surface (GET /api/compass/telegraph). Read via compass/flags.ts isEnabled, whose loader bulk-selects LIKE ''COMPASS_%'' and returns `?? false` for an unknown name. OFF (the seed): the endpoint answers feature_disabled, exactly as it has since it shipped. Note the name has no _ENABLED suffix, so check-flag-polarity classifies it explicitly rather than by convention.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── Postconditions ───────────────────────────────────────────────────────────
-- Present, and every one of them OFF. Both clauses are scoped to exactly the
-- five names this migration owns: an unscoped count would be satisfied by the
-- other 189 rows and could never fail.
DO $$
DECLARE
  wanted text[] := ARRAY[
    'MEDIA_WORLD_SHELL_ENABLED',
    'MEDIA_HIDDEN_GEMS_NEARBY_ENABLED',
    'PORTAVA_PUBLISHER_BOOST_ENABLED',
    'PORTAVA_FEATURED_BOOST_ENABLED',
    'COMPASS_TELEGRAPH'
  ];
  present int;
  on_count int;
BEGIN
  SELECT count(*) INTO present
    FROM public.feature_flags WHERE flag = ANY(wanted);
  IF present <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 5 of the phantom flag rows present, found %', present;
  END IF;

  SELECT count(*) INTO on_count
    FROM public.feature_flags WHERE flag = ANY(wanted) AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % of the phantom flag rows are ON; all five must ship OFF', on_count;
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual):
--   DELETE FROM public.feature_flags
--    WHERE flag IN ('MEDIA_WORLD_SHELL_ENABLED','MEDIA_HIDDEN_GEMS_NEARBY_ENABLED',
--                   'PORTAVA_PUBLISHER_BOOST_ENABLED','PORTAVA_FEATURED_BOOST_ENABLED',
--                   'COMPASS_TELEGRAPH');
-- The reversal removes five disabled capability rows and returns each gate to
-- being permanently closed and un-flippable. No served data changes either way.
-- Do NOT reverse without first reverting check-flag-polarity's R9, which will
-- fail the build on a read with no seed.
