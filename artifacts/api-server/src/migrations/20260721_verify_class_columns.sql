-- Task: verify-class schema audit fixes (Section D)
-- Adds columns the API intentionally writes/reads but that were missing live.

-- Passport postcards: pinning (one-per-user, enforced in code) and owner note.
ALTER TABLE public.passport_postcards
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS note text;

-- Rent-a-Buddy applications: admin limit/suspend state written by the
-- admin adminStatus-only update flow (audited via rent_buddy_admin_actions).
ALTER TABLE public.rent_buddy_applications
  ADD COLUMN IF NOT EXISTS admin_status text;

-- Compass preferences: user-authored interests written by
-- PATCH /compass/me/preferences.
ALTER TABLE public.compass_user_preferences
  ADD COLUMN IF NOT EXISTS interests text[];
