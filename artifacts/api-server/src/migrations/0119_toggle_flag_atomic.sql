-- Migration 0119: Atomic feature-flag toggle function
-- Creates a plpgsql function that updates feature_flags AND inserts into
-- feature_flag_audit_log in a single transaction, so every committed toggle
-- always has a corresponding audit row (or the whole thing rolls back).

CREATE OR REPLACE FUNCTION toggle_feature_flag_with_audit(
  p_flag          TEXT,
  p_new_enabled   BOOLEAN,
  p_changed_by_id UUID
)
RETURNS TABLE(
  flag        TEXT,
  enabled     BOOLEAN,
  description TEXT,
  updated_at  TIMESTAMPTZ,
  old_enabled BOOLEAN,
  changed_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_enabled BOOLEAN;
  v_now         TIMESTAMPTZ := NOW();
BEGIN
  -- Lock the row and read the current value atomically.
  SELECT ff.enabled INTO v_old_enabled
  FROM feature_flags ff
  WHERE ff.flag = p_flag
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Flag not found: %', p_flag USING ERRCODE = 'P0002';
  END IF;

  -- Update the flag value.
  UPDATE feature_flags
  SET enabled = p_new_enabled, updated_at = v_now
  WHERE feature_flags.flag = p_flag;

  -- Write the audit log row in the same transaction.
  INSERT INTO feature_flag_audit_log(flag, changed_by_user_id, old_enabled, new_enabled, changed_at)
  VALUES (p_flag, p_changed_by_id, v_old_enabled, p_new_enabled, v_now);

  -- Return the updated flag row plus the audit metadata.
  RETURN QUERY
    SELECT ff.flag, ff.enabled, ff.description, ff.updated_at, v_old_enabled AS old_enabled, v_now AS changed_at
    FROM feature_flags ff
    WHERE ff.flag = p_flag;
END;
$$;

-- Restrict execution to the service role only.
-- Non-admin clients (anon, authenticated JWT) must not call this function directly —
-- admin authorization is enforced at the API layer by requireAdmin middleware.
REVOKE ALL ON FUNCTION public.toggle_feature_flag_with_audit(text, boolean, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.toggle_feature_flag_with_audit(text, boolean, uuid)
  TO service_role;
