-- =============================================================================
-- 0078_trip_members_expansion.sql
-- Expand trip_members: co_host + viewer roles, status column, permissions, joined_at
-- =============================================================================

-- Extend member_role enum
DO $$ BEGIN
  ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'co_host' AFTER 'owner';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'viewer'  AFTER 'member';
EXCEPTION WHEN others THEN NULL; END $$;

-- New columns on trip_members
ALTER TABLE trip_members
  ADD COLUMN IF NOT EXISTS status      TEXT         NOT NULL DEFAULT 'accepted'
      CHECK (status IN ('invited','accepted','declined','removed','left')),
  ADD COLUMN IF NOT EXISTS permissions JSONB,
  ADD COLUMN IF NOT EXISTS joined_at   TIMESTAMPTZ;

-- Backfill existing rows
UPDATE trip_members SET status = 'invited'  WHERE role = 'invited'  AND status = 'accepted';
UPDATE trip_members SET joined_at = created_at
  WHERE (role IN ('owner','member','co_host')) AND joined_at IS NULL;
