-- Migration: 0033_location_sessions.sql
-- Creates location_sessions table for timed location sharing sessions.

CREATE TYPE IF NOT EXISTS location_session_type AS ENUM (
  'manual', 'trip_arrival', 'plan_checkin', 'safe_return'
);

CREATE TABLE IF NOT EXISTS location_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_type     location_session_type NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  resolved_city    text,
  resolved_country text,
  trip_id          uuid REFERENCES trips(id) ON DELETE SET NULL,
  plan_item_id     uuid REFERENCES trip_plan_items(id) ON DELETE SET NULL,
  metadata         jsonb
);

CREATE INDEX IF NOT EXISTS location_sessions_user_idx ON location_sessions(user_id, started_at DESC);

ALTER TABLE location_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_location_sessions" ON location_sessions
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
