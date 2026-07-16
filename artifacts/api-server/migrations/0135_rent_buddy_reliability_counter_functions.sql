-- Migration 0135: atomic reliability counter functions for rent_buddy_profiles
--
-- Buddy reliability counters (completed_count, cancel_count, no_show_count,
-- favorites_count) feed search ranking and public profiles. Route handlers
-- previously used read-modify-write updates, which can lose increments under
-- concurrent requests. These functions perform the update atomically in a
-- single statement.

-- Atomically adjust one reliability counter, clamped at >= 0.
-- p_column is whitelisted to prevent SQL injection via dynamic SQL.
CREATE OR REPLACE FUNCTION rb_adjust_buddy_counter(
  p_buddy_id UUID,
  p_column   TEXT,
  p_delta    INT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_column NOT IN ('completed_count', 'cancel_count', 'no_show_count') THEN
    RAISE EXCEPTION 'rb_adjust_buddy_counter: invalid column %', p_column;
  END IF;
  EXECUTE format(
    'UPDATE rent_buddy_profiles SET %I = GREATEST(0, COALESCE(%I, 0) + $1), updated_at = NOW() WHERE id = $2',
    p_column, p_column
  ) USING p_delta, p_buddy_id;
END;
$$;

-- Atomically recompute favorites_count from rent_buddy_saved.
-- A recount (rather than +/-1) keeps save/unsave idempotent.
CREATE OR REPLACE FUNCTION rb_sync_favorites_count(
  p_buddy_id UUID
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE rent_buddy_profiles
  SET favorites_count = (
        SELECT COUNT(*) FROM rent_buddy_saved WHERE buddy_id = p_buddy_id
      ),
      updated_at = NOW()
  WHERE id = p_buddy_id;
$$;

REVOKE EXECUTE ON FUNCTION rb_adjust_buddy_counter(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION rb_sync_favorites_count(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rb_adjust_buddy_counter(UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION rb_sync_favorites_count(UUID) TO service_role;
