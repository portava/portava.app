-- Migration 0114: add max_members to trips
--
-- Adds a nullable integer cap on trip membership.  NULL means no limit.
-- When set, the invite-link accept handler blocks new joins once the
-- accepted-member count reaches this value.
--
-- Apply:
--   Run this SQL in the Supabase SQL editor or via psql against the project DB.
--
-- Verify:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'max_members';
--
-- Expected: one row with data_type = 'integer', is_nullable = 'YES'.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS max_members INTEGER NULL;
