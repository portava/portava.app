-- 2072_track_profiles_full_name.sql
-- Bring public.profiles.full_name into the canonical migration chain.
--
-- Why this exists
-- ───────────────
-- Live probe against production (project ajrurzioarfkagpuxfnb, 2026-08-04):
--
--   select column_name, data_type, is_nullable from information_schema.columns
--   where table_schema='public' and table_name='profiles'
--     and column_name='full_name';
--   -- full_name | text | YES        (present)
--
-- The column IS present in the live database, but NO migration in
-- artifacts/api-server/src/migrations/ or migrations/ ever creates it — it was
-- added out-of-band. Ten server files select it (routes/airport.ts,
-- routes/trips-expansion.ts, routes/featured.ts, routes/pulse.ts,
-- routes/profile.ts, routes/posts.ts, routes/mediaFeed.ts, routes/messaging.ts,
-- lib/publicIdentity.ts, lib/mediaFeedItem.ts), so a rebuild-from-migrations
-- would produce a schema those files cannot query. This migration closes that
-- gap so the chain matches reality.
--
-- IF NOT EXISTS makes it a no-op against the live DB and a correct create
-- against any environment rebuilt from migrations.
--
-- ⚠ IMPORTANT — the column is EMPTY in production
-- ───────────────────────────────────────────────
--   select count(*) total, count(full_name) with_full_name,
--          count(display_name) with_display_name, count(name) with_name
--   from public.profiles;
--   -- total=53, with_full_name=0, with_display_name=40, with_name=53
--
-- All 53 rows have full_name IS NULL. Real display data lives in `name`
-- (NOT NULL, 53/53) and `display_name` (40/53). Call sites that read
-- full_name FIRST therefore always fall through or return null:
--
--   routes/featured.ts:140   profile.full_name ?? profile.username
--                            → always shows @username, never the real name
--   routes/posts.ts:2209     (p as any)?.full_name ?? null
--                            → post-saver name is always null
--
-- Sites that read it LAST are unaffected and correct as-is, e.g.
--   lib/publicIdentity.ts:76 display_name ?? name ?? full_name
--   routes/posts.ts:1078     pr.name ?? pr.full_name
--
-- STATUS UPDATE (audit fix wave 1): a full audit found 13 such degraded
-- read-full_name-first call sites, not the 2 originally noted above:
--   routes/airport.ts, routes/featured.ts (×3), routes/mediaFeed.ts (×2),
--   routes/posts.ts, routes/profile.ts, routes/pulse.ts,
--   routes/trips-expansion.ts, lib/mediaFeedItem.ts (×2),
--   services/tripCrew/TripCrewLocationService.ts
-- All 13 now resolve through presentedName() in lib/publicIdentity.ts
-- (display_name ?? name ?? full_name), and each corresponding SELECT was
-- widened to fetch display_name + name. full_name is retained as the last
-- fallback, so this migration is still required for a from-scratch rebuild.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name text;

COMMENT ON COLUMN public.profiles.full_name IS
  'Legacy display-name column. Empty in production (0/53 rows as of 2026-08-04); '
  'prefer display_name, then name. Tracked by migration 2072 so the schema can '
  'be rebuilt from the migration chain.';
