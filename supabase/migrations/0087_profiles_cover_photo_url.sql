-- 0087_profiles_cover_photo_url.sql
--
-- Adds the cover_photo_url column to the profiles table.
--
-- Multiple API server routes (GET /me/profile, PATCH /me/profile, passport
-- routes, admin routes) select or update this column.  If the column is absent
-- PostgREST returns "Could not find the 'cover_photo_url' column of 'profiles'
-- in the schema cache" (PGRST204), which surfaces as an error banner on the
-- Edit Profile screen and prevents profile saves.
--
-- Uses ADD COLUMN IF NOT EXISTS so this migration is safe to re-run and
-- harmless on databases where the column already exists.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
