-- Find Your Circle — Migration 0120
-- Meeting point shared by a trip/event host with the circle.
-- One active meeting point per context at a time (enforced at the API layer).

CREATE TABLE IF NOT EXISTS circle_meeting_points (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  host_user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  venue_label     TEXT,
  approximate_label TEXT,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmp_context_active_idx
  ON circle_meeting_points (context_type, context_id, is_active);

ALTER TABLE circle_meeting_points ENABLE ROW LEVEL SECURITY;

-- All DB-level access is service-role only.
-- Circle membership + activity status are enforced at the API layer, which
-- uses the service-role client.  No direct user read access is granted at
-- the RLS level to avoid bypassing the membership gate.
DROP POLICY IF EXISTS cmp_public_read ON circle_meeting_points;

DROP POLICY IF EXISTS cmp_service_all ON circle_meeting_points;
CREATE POLICY cmp_service_all ON circle_meeting_points
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
