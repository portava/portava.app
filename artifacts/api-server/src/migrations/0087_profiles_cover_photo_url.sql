-- 0087_profiles_cover_photo_url.sql
-- Adds cover_photo_url TEXT column to the profiles table.
--
-- Multiple API routes (GET/PATCH /me/profile, /users/:username/profile,
-- /users/:username/passport, admin) SELECT or UPDATE this column.  Without
-- this column PostgREST raises PGRST204 (unknown column) errors that surface
-- as an error banner on the Edit Profile screen and prevent profile saves.
--
-- Also: both PGRST204 fallback guards in profile.ts (GET line ~200 and
-- PATCH line ~384) previously only caught PostgreSQL error code 42703
-- (column does not exist) and silently ignored the PostgREST-level
-- PGRST204 variant.  Apply this migration to make the column unconditionally
-- present so neither guard is needed as a runtime fallback.
--
-- ADD COLUMN IF NOT EXISTS is idempotent — safe to run even if a previous
-- manual ALTER TABLE already added the column.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
