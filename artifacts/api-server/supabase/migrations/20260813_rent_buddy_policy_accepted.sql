-- Add policy_accepted column to rent_buddy_profiles.
-- This column is read by the buddy-spec checklist (rentABuddySpec.ts) and
-- was previously causing silent PGRST100 failures on every spec query.
ALTER TABLE rent_buddy_profiles
  ADD COLUMN IF NOT EXISTS policy_accepted BOOLEAN NOT NULL DEFAULT FALSE;
