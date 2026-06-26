-- ============================================================================
-- Migration 0051: trip_members_user_role_idx
-- Composite index on trip_members(user_id, role) to speed up the
-- shared-destination caller query fired by GET /users/search and
-- GET /users/suggestions on every request.
--
-- The query pattern is:
--   SELECT trip_id FROM trip_members
--   WHERE user_id = $1 AND role IN ('owner','member')
--
-- Without this index Postgres must seq-scan the full trip_members table.
-- With it the planner can seek directly to the caller's rows.
-- ============================================================================

CREATE INDEX IF NOT EXISTS trip_members_user_role_idx
  ON trip_members (user_id, role);
