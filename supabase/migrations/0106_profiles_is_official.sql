-- Migration 0106: Add is_official column to profiles
-- The @Portava official publisher account uses this flag to distinguish
-- the curated-content identity from normal user profiles.
--
-- Security model: only the service role may set is_official = true.
-- A trigger raises an exception for any non-service-role attempt to
-- elevate this flag, making the badge architecturally counterfeit-proof.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Trigger guard: only service_role may set is_official = true ───────────────

CREATE OR REPLACE FUNCTION enforce_is_official_service_role()
RETURNS TRIGGER AS $$
BEGIN
  -- If the new row has is_official = true and it wasn't already true,
  -- reject any caller that is not the service role.
  IF NEW.is_official = TRUE AND (OLD IS NULL OR OLD.is_official = FALSE) THEN
    IF current_setting('role', true) NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'is_official can only be set by the service role';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS enforce_is_official_trigger ON profiles;

CREATE TRIGGER enforce_is_official_trigger
  BEFORE INSERT OR UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_is_official_service_role();

-- Index: cheap lookup for "find all official accounts" without a full scan.
CREATE INDEX IF NOT EXISTS idx_profiles_is_official ON profiles (is_official)
  WHERE is_official = TRUE;
