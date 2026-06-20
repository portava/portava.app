-- ============================================================
-- Travel Buddy — Passport schema additions
-- Apply this migration against your Supabase project.
-- ============================================================

-- 1. Profiles: add passport columns (safe to run multiple times)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS username           TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS display_name       TEXT,
  ADD COLUMN IF NOT EXISTS passport_visibility TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS cover_photo_url     TEXT,
  ADD COLUMN IF NOT EXISTS username_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by          UUID REFERENCES auth.users(id);

-- Constraint: passport_visibility must be 'public' or 'private'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_passport_visibility_check'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_passport_visibility_check
      CHECK (passport_visibility IN ('public', 'private'));
  END IF;
END $$;

-- Index on username for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_idx ON profiles (username) WHERE username IS NOT NULL;

-- 2. passport_postcards: add note and pinned_at columns
ALTER TABLE passport_postcards
  ADD COLUMN IF NOT EXISTS note       TEXT,
  ADD COLUMN IF NOT EXISTS pinned_at  TIMESTAMPTZ;

-- Only one pinned postcard per user (soft enforced at API layer, but index helps queries)
CREATE INDEX IF NOT EXISTS passport_postcards_user_pinned_idx
  ON passport_postcards (user_id, pinned_at)
  WHERE pinned_at IS NOT NULL;

-- Extend status enum if needed (may already exist)
-- If status column is TEXT, the new value 'removed_from_passport' works without DDL.
-- If it's an ENUM, uncomment:
-- ALTER TYPE passport_postcard_status ADD VALUE IF NOT EXISTS 'removed_from_passport';

-- 3. Supabase Storage bucket for profile media (avatars)
-- Run in Supabase dashboard Storage section or via the management API:
-- Bucket name: profile-media
-- Public: true (avatars are public URLs)

-- 4. RLS policies for profiles
-- Allow users to read public profiles
DROP POLICY IF EXISTS "Public profiles are viewable" ON profiles;
CREATE POLICY "Public profiles are viewable" ON profiles
  FOR SELECT USING (
    passport_visibility = 'public' OR auth.uid() = id
  );

-- Allow users to update only their own profile
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- 5. RLS policies for passport_postcards
-- Owner can read/write their own postcards
DROP POLICY IF EXISTS "Owner can manage own postcards" ON passport_postcards;
CREATE POLICY "Owner can manage own postcards" ON passport_postcards
  FOR ALL USING (auth.uid() = user_id);

-- Public can read active public postcards of public passport owners
DROP POLICY IF EXISTS "Public postcards visible to all" ON passport_postcards;
CREATE POLICY "Public postcards visible to all" ON passport_postcards
  FOR SELECT USING (
    status = 'active'
    AND visibility = 'public'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = user_id AND p.passport_visibility = 'public'
    )
  );
