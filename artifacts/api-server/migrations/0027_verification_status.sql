-- Migration: add verification_status and related fields to profiles
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS verification_method text NULL,
  ADD COLUMN IF NOT EXISTS verification_expires_at timestamptz NULL;

-- Seed from existing boolean: users already marked verified keep that status
UPDATE profiles SET
  verification_status = 'verified',
  verified_at = COALESCE(updated_at, created_at)
WHERE verified = true AND verification_status = 'unverified';

-- Add a check constraint for the enum
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_verification_status_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_verification_status_check
  CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected', 'expired'));

-- Index for quick lookup (e.g. admin tools, discovery filtering)
CREATE INDEX IF NOT EXISTS profiles_verification_status_idx ON profiles (verification_status);
