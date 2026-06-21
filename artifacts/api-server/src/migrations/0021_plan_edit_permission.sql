-- Migration: plan_edit_permission
-- Adds trip-level plan editing permissions.
-- Direction: up only.

-- 1. Add plan_edit_permission column to trips
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS plan_edit_permission TEXT NOT NULL DEFAULT 'all_members'
  CHECK (plan_edit_permission IN ('owner_only', 'all_members', 'specific_members'));

-- 2. Create plan_editors join table for 'specific_members' mode
CREATE TABLE IF NOT EXISTS plan_editors (
  trip_id  UUID NOT NULL REFERENCES trips(id)      ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, user_id)
);

ALTER TABLE plan_editors ENABLE ROW LEVEL SECURITY;

-- Accepted trip members can read the plan_editors list (needed for UI display)
CREATE POLICY "plan_editors_select" ON plan_editors
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM trip_members tm
      WHERE tm.trip_id = plan_editors.trip_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Only the trip owner can manage plan_editors rows (via service role from API server)
-- No client-side insert/update/delete policies — all mutations go through the API.
