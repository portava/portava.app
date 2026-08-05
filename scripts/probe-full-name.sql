-- ============================================================================
-- probe-full-name.sql — does profiles.full_name exist in the live database?
-- (Audit Wave 2 probe kit. Run against the Supabase Postgres instance, e.g.
--  via the Supabase SQL editor or psql.)
--
-- Context: 11 server files select profiles.full_name. The generated live-
-- column snapshot (artifacts/api-server/src/test/generated/liveColumns.json)
-- says the column exists, but database.types.ts does NOT list it — this probe
-- confirms the live truth.
-- ============================================================================

-- 1) Does the column exist?
SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'profiles'
      AND column_name  = 'full_name'
  ) AS profiles_full_name_exists;

-- 2) Column details (empty result = column absent)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'profiles'
  AND column_name  = 'full_name';

-- 3) If it exists: how populated is it vs the sibling name columns?
--    (Uncomment after step 1 returns true.)
-- SELECT
--   count(*)                                  AS total_profiles,
--   count(full_name)                          AS with_full_name,
--   count(display_name)                       AS with_display_name,
--   count(name)                               AS with_name
-- FROM public.profiles;

-- ============================================================================
-- IF profiles.full_name DOES NOT EXIST, these are the server files/lines that
-- select or read it (grepped 2026-08-04, artifacts/api-server/src, excluding
-- tests) — every one of these selects would fail with
-- "column profiles.full_name does not exist":
--
--   1. src/services/tripCrew/TripCrewLocationService.ts:81   .select("id, full_name, username, avatar_url")  (read at :168)
--   2. src/lib/mediaFeedItem.ts:323, :618                    submitterProfile?.full_name / profile?.full_name fallbacks
--   3. src/lib/publicIdentity.ts:24, :76, :98                full_name in PublicIdentityRow type + name fallback + nulling
--   4. src/routes/airport.ts:1483                            profiles!author_id(id, username, full_name, avatar_url)  (read at :1512)
--   5. src/routes/messaging.ts:58, :509, :1419, :2213        PROFILE_PUBLIC constant + three selects (reads at :530, :1207, :1429, :1467, :2221)
--   6. src/routes/featured.ts:35, :38, :84, :218             resolvePortavaProfile select + embedded profile selects (reads at :140, :254, :269)
--   7. src/routes/profile.ts:350                             .select("id, username, full_name, avatar_url, is_official")  (read at :365)
--   8. src/routes/mediaFeed.ts:149, :161, :168, :401         AUTHOR/HOST/OWNER profile column constants (reads at :288, :327)
--   9. src/routes/trips-expansion.ts:1034                    .select("id, full_name, username, avatar_url")  (read at :1041)
--  10. src/routes/pulse.ts:156                               profiles!author_id(id, username, full_name, avatar_url, ...)  (read at :343)
--  11. src/routes/posts.ts:1007, :2193                       two profile selects including full_name  (reads at :1078, :2209)
--
-- REMEDIATION OPTIONS (pick one):
--   a) Add the column (safest, zero code churn):
--        ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name text;
--      Optionally backfill from display_name/name:
--        UPDATE public.profiles SET full_name = COALESCE(full_name, display_name, name);
--   b) Remove full_name from the 11 files above and rely on the existing
--      display_name / name columns (lib/publicIdentity.ts already implements
--      the display_name ?? name ?? full_name fallback chain — extend its use).
--   c) Create a generated column or view aliasing display_name as full_name
--      (only if a and b are both blocked; PostgREST embedded selects need the
--      column on the base table, so prefer (a)).
-- ============================================================================
