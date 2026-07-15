-- Find Your Circle — Migration 0118
-- Immutable check-in event log per user per context.
-- Each check-in action (arrived, with_group, leaving, safe, needs_help) appends a row.
-- The presence snapshot (0117) is updated alongside; this table is the audit trail.

CREATE TABLE IF NOT EXISTS circle_checkins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  checkin_type      TEXT NOT NULL
                    CHECK (checkin_type IN ('arrived','with_group','leaving','safe','needs_help')),
  note              TEXT,
  venue_label       TEXT,
  approximate_label TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ccin_user_context_idx
  ON circle_checkins (user_id, context_type, context_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ccin_context_idx
  ON circle_checkins (context_type, context_id, created_at DESC);

ALTER TABLE circle_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccin_owner_read ON circle_checkins;
CREATE POLICY ccin_owner_read ON circle_checkins
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_owner_insert ON circle_checkins;
CREATE POLICY ccin_owner_insert ON circle_checkins
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_service_all ON circle_checkins;
CREATE POLICY ccin_service_all ON circle_checkins
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
