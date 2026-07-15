-- Migration 0033: location_sessions
-- Timed location session records per user (live-share, check-in, auto).

CREATE TABLE IF NOT EXISTS location_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_type     text        NOT NULL
                   CHECK (session_type IN ('live_share', 'trip_check_in', 'auto')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  resolved_city    text,
  resolved_country text,
  trip_id          uuid        REFERENCES trips(id) ON DELETE SET NULL,
  plan_item_id     uuid        REFERENCES trip_plan_items(id) ON DELETE SET NULL,
  metadata         jsonb
);

ALTER TABLE location_sessions ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS location_sessions_user_idx ON location_sessions(user_id);
CREATE INDEX IF NOT EXISTS location_sessions_trip_idx ON location_sessions(trip_id);

CREATE POLICY "location_sessions_own" ON location_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "location_sessions_service" ON location_sessions
  FOR ALL TO service_role USING (true);
