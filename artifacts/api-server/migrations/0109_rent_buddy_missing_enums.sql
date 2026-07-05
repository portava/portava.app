-- Migration 0109: Add missing spec enum types for Rent-a-Buddy
-- Adds: rent_buddy_verification_status, rent_buddy_change_request_status,
--       rent_buddy_payment_status

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_verification_status') THEN
    CREATE TYPE rent_buddy_verification_status AS ENUM (
      'unverified',
      'id_submitted',
      'in_review',
      'verified',
      'rejected'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_change_request_status') THEN
    CREATE TYPE rent_buddy_change_request_status AS ENUM (
      'pending',
      'approved',
      'declined',
      'expired'
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rent_buddy_payment_status') THEN
    CREATE TYPE rent_buddy_payment_status AS ENUM (
      'pending',
      'authorized',
      'captured',
      'partial',
      'refunded',
      'failed'
    );
  END IF;
END $$;

-- Add verification_status column to rent_buddy_profiles if it doesn't exist yet.
-- Existing 'verified BOOLEAN' column is preserved; this adds a richer status field.
ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS verification_status rent_buddy_verification_status
    NOT NULL DEFAULT 'unverified';

-- Keep verification_status in sync with existing verified boolean via trigger.
CREATE OR REPLACE FUNCTION sync_buddy_verification_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verified = TRUE AND NEW.verification_status = 'unverified' THEN
    NEW.verification_status := 'verified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_buddy_verification_status ON rent_buddy_profiles;
CREATE TRIGGER trg_sync_buddy_verification_status
  BEFORE INSERT OR UPDATE OF verified ON rent_buddy_profiles
  FOR EACH ROW EXECUTE FUNCTION sync_buddy_verification_status();

-- Backfill verification_status for already-verified rows
UPDATE rent_buddy_profiles
  SET verification_status = 'verified'
  WHERE verified = TRUE AND verification_status = 'unverified';
