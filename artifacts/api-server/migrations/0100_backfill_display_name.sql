-- Migration 0100: backfill display_name from name for existing profile rows
-- Copies name → display_name for every profile row where display_name IS NULL
-- and name IS NOT NULL.  Safe to re-run: the WHERE clause is a no-op on rows
-- that already have display_name set.

UPDATE public.profiles
SET display_name = name
WHERE display_name IS NULL
  AND name IS NOT NULL;
