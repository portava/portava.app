-- Migration 0111: Rent a Buddy — onboarding acknowledgment timestamps
--
-- Adds two acknowledgment columns to rent_buddy_profiles:
--   safety_acknowledged_at     — buddy confirmed they read the safety policy
--   boundaries_acknowledged_at — buddy confirmed the conduct/boundaries policy
--
-- Both are checked by the POST /me/profile/submit gate (returns 422 if null).

ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS safety_acknowledged_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS boundaries_acknowledged_at TIMESTAMPTZ;
