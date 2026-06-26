-- 0051_route_plan_members.sql
-- Per-user participation (join/leave) for route plans.
-- Checkpoint_status remains shared per-stop; this table tracks who is "on" the route.

CREATE TABLE IF NOT EXISTS route_plan_members (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  route_plan_id uuid        NOT NULL REFERENCES route_plans(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_plan_id, user_id)
);

ALTER TABLE route_plan_members ENABLE ROW LEVEL SECURITY;

-- Each member can see their own membership
CREATE POLICY "rpm_select_own"
  ON route_plan_members FOR SELECT
  USING (user_id = auth.uid());

-- Members of the linked trip can see all memberships on that plan
CREATE POLICY "rpm_select_trip"
  ON route_plan_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM route_plans rp
      JOIN trip_members tm ON tm.trip_id = rp.trip_id
      WHERE rp.id = route_plan_members.route_plan_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'member')
    )
  );

-- Insert: must be joining as yourself AND the route must be accessible:
--   • trip-linked routes  → caller must be a member of that trip
--   • private routes      → only the plan owner can self-insert
--   (The API layer applies the same logic; this policy closes direct-PostgREST access.)
CREATE POLICY "rpm_insert_own"
  ON route_plan_members FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (
      -- Trip-linked: caller is a trip member
      EXISTS (
        SELECT 1 FROM route_plans rp
        JOIN trip_members tm ON tm.trip_id = rp.trip_id
        WHERE rp.id = route_plan_members.route_plan_id
          AND tm.user_id = auth.uid()
          AND tm.role IN ('owner', 'member')
      )
      OR
      -- Private route: caller is the plan owner
      EXISTS (
        SELECT 1 FROM route_plans rp
        WHERE rp.id = route_plan_members.route_plan_id
          AND rp.owner_user_id = auth.uid()
          AND rp.trip_id IS NULL
      )
    )
  );

-- Users can only remove themselves
CREATE POLICY "rpm_delete_own"
  ON route_plan_members FOR DELETE
  USING (user_id = auth.uid());

-- Index for fast member lookups per plan
CREATE INDEX IF NOT EXISTS route_plan_members_plan_idx
  ON route_plan_members (route_plan_id);
