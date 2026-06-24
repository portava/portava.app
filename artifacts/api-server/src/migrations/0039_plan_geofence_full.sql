-- Migration: 0039_plan_geofence_full.sql
-- Expands plan_geofences and adds plan_checkins, plan_attendance_events,
-- and geofence_admin_settings tables.

-- Expand plan_geofences
ALTER TABLE plan_geofences
  ADD COLUMN IF NOT EXISTS public_preview_level    text,
  ADD COLUMN IF NOT EXISTS exact_visibility        text,
  ADD COLUMN IF NOT EXISTS check_in_required       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS window_start            timestamptz,
  ADD COLUMN IF NOT EXISTS window_end              timestamptz,
  ADD COLUMN IF NOT EXISTS arrival_status_visible  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS no_show_affects_reliability boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS location_name           text,
  ADD COLUMN IF NOT EXISTS city                    text,
  ADD COLUMN IF NOT EXISTS neighborhood            text,
  ADD COLUMN IF NOT EXISTS venue_name              text,
  ADD COLUMN IF NOT EXISTS host_revealed           boolean NOT NULL DEFAULT false;

-- Per-member attendance status (upsert)
CREATE TABLE IF NOT EXISTS plan_checkins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_item_id  uuid NOT NULL REFERENCES trip_plan_items(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',
  checked_in_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_checkins_unique UNIQUE (plan_item_id, user_id)
);

ALTER TABLE plan_checkins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trip_members_view_checkins" ON plan_checkins
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "users_manage_own_checkin" ON plan_checkins
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Attendance audit log
CREATE TABLE IF NOT EXISTS plan_attendance_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_item_id  uuid NOT NULL REFERENCES trip_plan_items(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_attendance_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "attendance_events_trip_members" ON plan_attendance_events
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Geofence admin global settings (single row)
CREATE TABLE IF NOT EXISTS geofence_admin_settings (
  id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_radius double precision NOT NULL DEFAULT 150,
  min_radius     double precision NOT NULL DEFAULT 50,
  max_radius     double precision NOT NULL DEFAULT 1000,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO geofence_admin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
